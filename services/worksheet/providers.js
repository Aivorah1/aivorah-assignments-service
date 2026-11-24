// AI providers for worksheet → quiz generation, beyond Gemini (quizVision.js).
// Only two AI accounts are used: Gemini and Groq (2026-11-24 decision —
// Mistral and Hugging Face/Qwen were removed).
//   - Groq vision (page images + transcript) — the second picture reader, so
//     a busy Gemini no longer drops every worksheet to text-only,
//   - picture hosting aligned with the document model's picture list,
//   - the shared transcript block every provider is given,
//   - a cached health check so a dead key shows up as a status, not as
//     silently degraded quizzes.
// Groq's vision model(s), tried in order. Llama-4 vision models are gone from Groq (404).
const GROQ_VISION_MODELS = (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b')
  .split(',').map(m => m.trim()).filter(Boolean);
const GROQ_MAX_IMAGES = 5; // Groq's per-request image limit
const GROQ_VISION_TIMEOUT_MS = parseInt(process.env.GROQ_VISION_TIMEOUT_MS || '120000', 10);

// Page renders / photos → JPEGs small enough for a vision request
// (≤1600px wide; Groq rejects base64 images over 4MB).
async function toVisionJpeg(buffer, mime) {
  const { jimpFromPng, isPng } = require('./pngImage');
  if (isPng(buffer)) {
    const img = jimpFromPng(buffer);
    if (img.bitmap.width > 1600) img.resize({ w: 1600 });
    return { buffer: await img.getBuffer('image/jpeg', { quality: 80 }), mime: 'image/jpeg' };
  }
  if (buffer.length <= 2.5 * 1024 * 1024) return { buffer, mime: mime || 'image/jpeg' }; // an uploaded photo: send as-is
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buffer);
  if (img.bitmap.width > 1600) img.resize({ w: 1600 });
  return { buffer: await img.getBuffer('image/jpeg', { quality: 80 }), mime: 'image/jpeg' };
}

let groqClient = null;
function groq() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  if (!groqClient) {
    const Groq = require('groq-sdk');
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

// Images + prompt → the model's text (reasoning tags stripped).
async function callGroqVision(pageImages, prompt, { json = false, maxTokens = 16000 } = {}) {
  if (!pageImages || !pageImages.length) throw new Error('Groq vision: no images');
  const client = groq();
  const images = [];
  for (const p of pageImages.slice(0, GROQ_MAX_IMAGES)) {
    const v = await toVisionJpeg(p.buffer, p.mime);
    images.push({ type: 'image_url', image_url: { url: `data:${v.mime};base64,${v.buffer.toString('base64')}` } });
  }
  let lastErr;
  for (const model of GROQ_VISION_MODELS) {
    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        max_completion_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }],
      }, { timeout: GROQ_VISION_TIMEOUT_MS });
      const content = completion.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Groq vision ${model}: empty response`);
      return String(content).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      lastErr = err;
      // A retired/unknown model or overload moves on to the next; auth/quota errors won't improve.
      if (!/404|400|invalid model|not found|decommissioned|429|503|overloaded|timeout|aborted/i.test(String(err.message))) throw err;
      console.log(`[groq-vision] ${model} unavailable (${String(err.message).slice(0, 120)}), trying next model`);
    }
  }
  throw lastErr;
}

// Uploads the document model's pictures, keeping their order (a failed
// upload leaves a gap so markers never point at the wrong picture).
async function hostPictures(pictures) {
  const cloudinary = require('cloudinary').v2;
  if (!cloudinary.config().cloud_name) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  if (!cloudinary.config().cloud_name) return pictures.map(() => ({}));
  const out = new Array(pictures.length).fill(null).map(() => ({}));
  let next = 0;
  async function worker() {
    while (next < pictures.length) {
      const i = next++;
      const img = pictures[i];
      try {
        const result = await cloudinary.uploader.upload(`data:${img.mime};base64,${img.buffer.toString('base64')}`, {
          folder: 'ai_mentor/worksheet_images',
          public_id: `ws_p${img.page}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          resource_type: 'image',
        });
        out[i] = { url: result.secure_url };
      } catch (err) {
        console.warn('[hostPictures] upload failed:', err.message);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// The transcript every provider receives. Vision providers still look at the
// pages; text providers rely on it entirely.
function transcriptBlock(transcript, { canSeePages }) {
  if (!transcript || !transcript.trim()) return '';
  return `

WORKSHEET TRANSCRIPT — machine-read from the uploaded document (PDF text layer + OCR), page by page in reading order.
- "   |   " separates things printed side by side on one row (table cells, a picture and the word next to it, two columns).
- "____" is a blank answer space printed on the worksheet.
- [IMAGE: url=...] is a REAL picture cut out of the document at exactly that position. "(text in picture: ...)" lists words/numbers printed inside it — use them (axis values, measurements, labels).
- ${canSeePages
    ? 'You can ALSO see the page images: use them for layout and for anything the transcript misses, and trust the image over the transcript when OCR spelling looks wrong.'
    : 'You cannot see the pages: this transcript is your only source. OCR can misspell a few words in non-Latin scripts — keep the worksheet\'s wording, fixing only obvious OCR slips. NEVER invent a number, fraction or word that is not in the transcript: if a value the student needs is missing or unreadable, write "?" in its place so the teacher can fill it in.'}

PICTURES: put a picture on the question it belongs to by copying its exact url into that question's "imageUrl" (never on the task). If one picture serves the whole task (a chart, a passage illustration), put it on the FIRST question of the task and set "sharedImage": true on the task. In matching tasks ("match the picture to the word"), each row "[IMAGE: url=A] | word" is one item: the question gets imageUrl A, and the options are all the words of that task. Skip purely decorative clip-art (borders, holly, snowmen) that no question refers to. Never invent a url and never describe a picture you were only given as a url.

${transcript.slice(0, 14000)}`;
}

// ── Provider health (GET /quiz/providers) ────────────────────────────────
let healthCache = null;
const HEALTH_TTL_MS = 5 * 60 * 1000;

async function probe(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { provider: name, status: 'OK', detail, ms: Date.now() - started };
  } catch (err) {
    const { classifyProviderError } = require('../quizVision');
    return { provider: name, status: classifyProviderError(name, err), detail: String(err.message || err).slice(0, 300), ms: Date.now() - started };
  }
}

async function checkProviders({ force = false } = {}) {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.result;
  const results = await Promise.all([
    probe('gemini', async () => {
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const { GEMINI_MODELS, shortProviderError } = require('../quizVision');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const errors = [];
      for (const model of GEMINI_MODELS) {
        const started = Date.now();
        try {
          await genAI.getGenerativeModel({ model }).generateContent('Reply with OK');
          return `model ${model} answered in ${Date.now() - started}ms${errors.length ? ` (before it: ${errors.join(' | ')})` : ''}`;
        } catch (err) { errors.push(`${model}: ${shortProviderError(err)}`); }
      }
      throw new Error(errors.join(' | '));
    }),
    probe('groq-vision', async () => {
      // A tiny real picture, so this checks the vision model itself.
      const { Jimp } = require('jimp');
      const img = new Jimp({ width: 64, height: 64, color: 0xffffffff });
      const buffer = await img.getBuffer('image/png');
      const started = Date.now();
      await callGroqVision([{ buffer, mime: 'image/png' }], 'Reply with OK', { maxTokens: 20 });
      return `model ${GROQ_VISION_MODELS[0]} answered in ${Date.now() - started}ms`;
    }),
    probe('groq', async () => {
      if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
      const Groq = require('groq-sdk');
      await new Groq({ apiKey: process.env.GROQ_API_KEY }).chat.completions.create({
        model: 'openai/gpt-oss-120b', max_tokens: 20, messages: [{ role: 'user', content: 'Reply with OK' }],
      });
      return 'text model answered';
    }),
  ]);
  // The pipeline skips a provider that is rate-limited / out of quota for a while.
  const { markProviderResult } = require('../quizVision');
  for (const r of results) if (r.status !== 'TEMPORARY_FAILURE') markProviderResult(r.provider, r.status);
  const vision = results.filter(r => ['gemini', 'groq-vision'].includes(r.provider) && r.status === 'OK').map(r => r.provider);
  const result = {
    checkedAt: new Date().toISOString(),
    visionAvailable: vision.length > 0,
    summary: vision.length
      ? `Worksheets are read with vision (${vision.join(', ')}).`
      : 'No vision provider is working: worksheets are converted from OCR text only, so picture-based questions cannot be answered automatically.',
    providers: results,
  };
  healthCache = { at: Date.now(), result };
  return result;
}

module.exports = { callGroqVision, toVisionJpeg, hostPictures, transcriptBlock, checkProviders, GROQ_VISION_MODELS };
