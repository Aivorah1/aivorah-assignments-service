// One picture, several numbered figures ("1) … 6)" on one grid sheet), each
// belonging to its own question: give every question only its own figure.
//   1. A vision model returns one bounding box per question.
//   2. The boxes are checked (inside the picture, big enough, not the whole
//      picture, not overlapping each other, one for EVERY question).
//   3. The picture is cropped here, the crops hosted (or inlined).
// Anything short of that keeps the whole picture, shown once for the task.
const { jimpFromPng, pngBuffer, isDecodable } = require('./pngImage');

const MAX_TASKS = 8;
const MAX_QUESTIONS = 24;
const MIN_SIDE = 30;          // per mille of the picture (3%)
const MAX_AREA = 0.85;        // a box this big is the whole picture, not one figure
const MAX_OVERLAP = 0.3;      // share of the smaller box inside another
const PAD = 12;               // per mille added on every side
const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const DETECT_TIMEOUT_MS = parseInt(process.env.FIGURE_SPLIT_TIMEOUT_MS || '45000', 10);

const SKIP_TYPES = new Set(['matching', 'venn', 'drawing']);

// The one picture a task's questions share, or null.
function sharedPictureRef(task) {
  const qs = task.questions || [];
  if (qs.length < 2 || qs.length > MAX_QUESTIONS) return null;
  if (task.diagramFillBlanks && task.diagramFillBlanks.length) return null;
  if (task.chart || task.table || task.tables) return null;
  if (qs.some(q => SKIP_TYPES.has(q.type))) return null;
  if (task.sharedImageUrl) return null; // the teacher chose it
  const urls = qs.map(q => q.imageUrl).filter(u => typeof u === 'string' && u);
  if (task.sharedImage && qs[0].imageUrl && urls.every(u => u === qs[0].imageUrl)) return qs[0].imageUrl;
  if (urls.length === qs.length && urls.every(u => u === urls[0])) return urls[0];
  return null;
}

function decodeDataUri(uri) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  return m ? { buffer: Buffer.from(m[2], 'base64'), mime: m[1] } : null;
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`picture ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FETCH_BYTES) throw new Error('picture too large');
  return { buffer, mime: res.headers.get('content-type') || 'image/png' };
}

// Picture bytes for a question's imageUrl: a document picture id or its
// hosted url, an inline image, or any other http(s) url.
async function loadPicture(ref, doc) {
  const pic = ((doc && doc.pictures) || []).find(p => p.id === ref || (p.url && p.url === ref));
  if (pic && pic.buffer) return { buffer: pic.buffer, mime: pic.mime || 'image/png' };
  if (ref.startsWith('data:')) return decodeDataUri(ref);
  if (/^https?:\/\//i.test(ref)) return fetchImage(ref);
  return null;
}

function figurePrompt(questions) {
  const list = questions.map(q => `- id "${q.id}": ${String(q.question || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  return `This picture is from a school worksheet. The questions below all refer to it.
For EACH question, find the figure in the picture that belongs only to that question. Usually it is marked with the question's number or letter ("1)", "Q2", "(b)", "Fig. 3") or it is the n-th figure in reading order for the n-th question.
Return its bounding box: the whole figure with its number label and any measurements or labels printed on or around it, but no neighbouring figure, no page heading and no answer line ("Perimeter = ____").
If the picture is ONE diagram that all the questions share (a single chart, map, table, shape or scene), return "figures": [].
Answer with JSON only: {"figures":[{"id":"<question id>","box":[ymin,xmin,ymax,xmax]}]}, coordinates as integers from 0 to 1000 relative to the picture's height (y) and width (x).

QUESTIONS:
${list}`;
}

function parseFigures(raw) {
  if (!raw) return [];
  let s = String(raw).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const first = s.search(/[[{]/);
  if (first > 0) s = s.slice(first);
  let data;
  try { data = JSON.parse(s); } catch { return []; }
  const list = Array.isArray(data) ? data : (data && (data.figures || data.boxes)) || [];
  return list.filter(f => f && Array.isArray(f.box || f.box_2d) && f.id != null)
    .map(f => ({ id: String(f.id), box: (f.box || f.box_2d).map(Number) }));
}

// Vision model → [{id, box:[ymin,xmin,ymax,xmax] 0-1000}]. Gemini first, Groq vision after.
async function detectFigures(picture, questions) {
  const prompt = figurePrompt(questions);
  const errors = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      const { geminiModel, geminiGenerate, geminiImageParts, withTimeout } = require('../quizVision');
      const model = geminiModel({ responseMimeType: 'application/json', temperature: 0 });
      const raw = await withTimeout(geminiGenerate(model, [...geminiImageParts([picture]), { text: prompt }]), DETECT_TIMEOUT_MS, 'figure-split');
      const figures = parseFigures(raw);
      if (figures.length) return figures;
      errors.push('gemini: no figures');
    } catch (err) { errors.push(`gemini: ${err.message}`); }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const { callGroqVision } = require('./providers');
      return parseFigures(await callGroqVision([picture], prompt, { json: true, maxTokens: 4000 }));
    } catch (err) { errors.push(`groq-vision: ${err.message}`); }
  }
  if (errors.length) console.warn('[figureSplit] detection failed:', errors.join('; '));
  return [];
}

// Boxes in 0-1000 (fractions 0-1 are scaled up), ordered and clamped; null if unusable.
function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(v))) return null;
  const scale = box.every(v => v >= 0 && v <= 1) ? 1000 : 1;
  let [y0, x0, y1, x1] = box.map(v => Math.min(1000, Math.max(0, v * scale)));
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 - y0 < MIN_SIDE || x1 - x0 < MIN_SIDE) return null;
  if (((y1 - y0) * (x1 - x0)) / 1e6 > MAX_AREA) return null;
  return [y0, x0, y1, x1];
}

function overlapShare(a, b) {
  const h = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const w = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = r => (r[2] - r[0]) * (r[3] - r[1]);
  return (h * w) / Math.min(area(a), area(b));
}

// Question id → box, only when every question has its own distinct figure.
function planSplit(questions, figures) {
  const byId = new Map();
  for (const f of figures) {
    const box = normalizeBox(f.box);
    if (box && !byId.has(f.id)) byId.set(f.id, box);
  }
  const boxes = questions.map(q => byId.get(String(q.id)));
  if (boxes.some(b => !b)) return null;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlapShare(boxes[i], boxes[j]) > MAX_OVERLAP) return null;
  }
  return boxes;
}

function cropFigure(picture, box) {
  const img = jimpFromPng(picture.buffer);
  const { width: W, height: H } = img.bitmap;
  const [y0, x0, y1, x1] = [box[0] - PAD, box[1] - PAD, box[2] + PAD, box[3] + PAD].map(v => Math.min(1000, Math.max(0, v)));
  const x = Math.floor((x0 / 1000) * W);
  const y = Math.floor((y0 / 1000) * H);
  const w = Math.max(1, Math.min(W - x, Math.ceil((x1 / 1000) * W) - x));
  const h = Math.max(1, Math.min(H - y, Math.ceil((y1 / 1000) * H) - y));
  img.crop({ x, y, w, h });
  return { buffer: pngBuffer(img), mime: 'image/png', page: 'fig', width: w, height: h };
}

const dataUri = p => `data:${p.mime};base64,${p.buffer.toString('base64')}`;

// The whole picture, once, above the task's questions.
function keepWholePicture(task, ref) {
  task.sharedImage = true;
  task.questions[0].imageUrl = ref;
}

/**
 * Splits every task's shared multi-figure picture into per-question crops.
 * Options (for tests): detect(picture, questions) → figures,
 * hostImages(crops) → [{url}], load(ref, doc) → {buffer, mime}.
 * Returns the number of tasks split.
 */
async function splitSharedFigures(quiz, doc, { detect = detectFigures, hostImages, load = loadPicture } = {}) {
  let split = 0;
  const tasks = (quiz.tasks || []).filter(t => sharedPictureRef(t)).slice(0, MAX_TASKS);
  for (const task of tasks) {
    const ref = sharedPictureRef(task);
    const qs = task.questions;
    try {
      const picture = await load(ref, doc);
      if (!picture || !isDecodable(picture.buffer)) { keepWholePicture(task, ref); continue; }
      const boxes = planSplit(qs, await detect(picture, qs));
      if (!boxes) { keepWholePicture(task, ref); continue; }
      const crops = boxes.map(b => cropFigure(picture, b));
      const hosted = hostImages ? await hostImages(crops).catch(() => []) : [];
      qs.forEach((q, i) => {
        q.imageUrl = (hosted[i] && hosted[i].url) || dataUri(crops[i]);
        q.hasImage = true;
        delete q._sharedImage;
      });
      task.sharedImage = false;
      task.figuresSplit = true;
      delete task.sharedImageDescription;
      split++;
    } catch (err) {
      console.warn('[figureSplit] task kept whole picture:', err.message);
      keepWholePicture(task, ref);
    }
  }
  return split;
}

module.exports = { splitSharedFigures, sharedPictureRef, planSplit, normalizeBox, parseFigures, cropFigure, figurePrompt, detectFigures, loadPicture };
