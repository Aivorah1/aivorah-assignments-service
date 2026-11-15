// Prepare Worksheet → Assign, for a Word file with one picture holding six
// numbered figures (the "Perimeter Using Grids" report). Before: the picture
// never reached a question — the docx anchors had no task headings and the
// model left imageUrl empty — so the assignment showed a text description.
// Real Word export (worksheetDocx), real docx-to-pdf (mammoth + Chrome), real
// document model (pdfjs + Tesseract). Only the vision model's boxes, the AI
// quiz JSON and Cloudinary are stand-ins.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(() => ({})),
    uploader: { upload: jest.fn(async () => ({ secure_url: `https://res.cloudinary.test/docx_${Math.random().toString(36).slice(2, 8)}.png` })) },
  },
}));
const request = require('supertest');
const { Jimp } = require('jimp');
const app = require('../../index');
const { worksheetDocx } = require('../../services/worksheetHtml');
const { pngBuffer, jimpFromPng } = require('../../services/worksheet/pngImage');
const { buildDocumentModel } = require('../../services/worksheet/documentModel');
const { attachRegionCrops, resolvePictureRefs } = require('../../services/worksheet/regionCrops');
const { splitSharedFigures } = require('../../services/worksheet/figureSplit');
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');

const TITLE = 'Task 1: Find the area and perimeter of the given shapes in each grid';

// 400×600 sheet: six squares, 2 columns × 3 rows, each a different grey.
const SHADES = [0x202020ff, 0x404040ff, 0x606060ff, 0x303030ff, 0x505050ff, 0x101010ff];
function sheetPng() {
  const img = new Jimp({ width: 400, height: 600, color: 0xffffffff });
  SHADES.forEach((shade, i) => {
    const r = Math.floor(i / 2); const c = i % 2;
    for (let y = 50 + r * 200; y < 150 + r * 200; y++) for (let x = 50 + c * 200; x < 150 + c * 200; x++) img.setPixelColor(shade, x, y);
  });
  return pngBuffer(img);
}

// What the model returned live for this worksheet: per-question hasImage, no imageUrl.
function aiQuiz() {
  return {
    title: 'Perimeter Using Grids',
    subject: 'Mathematics',
    tasks: [{
      title: TITLE,
      layout: { type: 'two-column', columns: 2, columnGroups: [{ questionIds: ['1', '3', '5'] }, { questionIds: ['2', '4', '6'] }] },
      questions: [1, 2, 3, 4, 5, 6].map(n => ({
        id: String(n), type: 'numeric', unit: 'in', answer: 10 + n, hasImage: true,
        question: `Find the perimeter of shape ${n}.`, diagramDescription: `Shape ${n} on a grid`,
      })),
    }],
  };
}

describe('Word worksheet with one six-figure picture', () => {
  let structuredText; let doc;
  beforeAll(async () => {
    const html = `<p>Purpose: To apply the conceptual understanding of measurement.</p><p>${TITLE}</p>`
      + `<p><img src="data:image/png;base64,${sheetPng().toString('base64')}" width="300" height="450"></p>`;
    const docx = await worksheetDocx({ title: 'Perimeter Using Grids', html });
    const res = await request(app).post('/assignments/docx-to-pdf').send({ fileBase64: docx.toString('base64') });
    expect(res.status).toBe(200);
    structuredText = res.body.structuredText;
    doc = await buildDocumentModel({
      buffer: Buffer.from(res.body.pdfBase64, 'base64'), mime: 'application/pdf', structuredText,
      hostImages: async imgs => imgs.map(() => ({ url: 'https://img.test/should-not-be-rehosted.png' })),
    });
  }, 180000);

  test('the docx picture is hosted and becomes one picture id in the transcript', () => {
    const hosted = structuredText.match(/\[IMAGE: url=(https:\/\/res\.cloudinary\.test\/[^\]]+)\]/);
    expect(hosted).not.toBeNull();
    expect(doc.pictures).toHaveLength(1);
    expect(doc.pictures[0].url).toBe(hosted[1]);
    expect(doc.text.match(/\[IMAGE: url=/g)).toHaveLength(1);
    expect(doc.text).toContain(`[IMAGE: url=${doc.pictures[0].id}]`);
  });

  test('the task heading is an anchor even though the docx text already has it', () => {
    expect(doc.anchors.some(a => /perimeter of the given shapes/i.test(a.text))).toBe(true);
  });

  test('each question ends up with only its own figure', async () => {
    const quiz = aiQuiz();
    await attachRegionCrops(quiz, doc, async crops => crops.map(() => ({})));
    expect(quiz.tasks[0].questions[0].imageUrl).toBe(doc.pictures[0].id);

    // Boxes as Gemini gives them ([ymin,xmin,ymax,xmax] 0-1000), one per square.
    const detect = jest.fn(async (picture, qs) => qs.map((q, i) => {
      const r = Math.floor(i / 2); const c = i % 2;
      return { id: q.id, box: [r * 333 + 40, c * 500 + 60, r * 333 + 290, c * 500 + 440] };
    }));
    const hostImages = jest.fn(async crops => crops.map((c, i) => ({ url: `https://img.test/fig-${i + 1}.png` })));
    expect(await splitSharedFigures(quiz, doc, { detect, hostImages })).toBe(1);
    resolvePictureRefs(quiz, doc);

    const qs = quiz.tasks[0].questions;
    expect(qs.map(q => q.imageUrl)).toEqual([1, 2, 3, 4, 5, 6].map(n => `https://img.test/fig-${n}.png`));
    // Each crop holds its own square's grey, not a neighbour's.
    hostImages.mock.calls[0][0].forEach((crop, i) => {
      const img = jimpFromPng(crop.buffer);
      const centre = img.getPixelColor(Math.floor(img.bitmap.width / 2), Math.floor(img.bitmap.height / 2));
      expect(Math.abs(((centre >>> 24) & 0xff) - ((SHADES[i] >>> 24) & 0xff))).toBeLessThan(24);
    });

    const page = renderQuizHTML(quiz, {});
    for (let n = 1; n <= 6; n++) expect(page).toContain(`src="https://img.test/fig-${n}.png"`);
    expect(page).not.toMatch(/📐|could not be auto-cropped/);
  }, 60000);

  test('when the figures cannot be told apart the whole picture is shown once', async () => {
    const quiz = aiQuiz();
    await attachRegionCrops(quiz, doc, async crops => crops.map(() => ({})));
    await splitSharedFigures(quiz, doc, { detect: async () => [] });
    resolvePictureRefs(quiz, doc);
    const page = renderQuizHTML(quiz, {});
    expect(page.split(`src="${doc.pictures[0].url}"`)).toHaveLength(2);
    expect(page).not.toMatch(/📐|could not be auto-cropped/);
  }, 60000);
});
