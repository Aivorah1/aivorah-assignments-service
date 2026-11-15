// One worksheet picture with several numbered figures → each question shows
// only its own figure; anything uncertain keeps the whole picture once.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { Jimp } = require('jimp');
const { pngBuffer, jimpFromPng } = require('../../services/worksheet/pngImage');
const {
  splitSharedFigures, sharedPictureRef, planSplit, normalizeBox, parseFigures, figurePrompt,
} = require('../../services/worksheet/figureSplit');
const { attachTranscriptPictures, resolvePictureRefs } = require('../../services/worksheet/regionCrops');
const { linkDocxPictures } = require('../../services/worksheet/documentModel');
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');

// 400×600 white picture with 6 black squares in a 2-column × 3-row grid.
function sixFigurePicture() {
  const img = new Jimp({ width: 400, height: 600, color: 0xffffffff });
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      for (let y = 50 + r * 200; y < 150 + r * 200; y++) for (let x = 50 + c * 200; x < 150 + c * 200; x++) img.setPixelColor(0x000000ff, x, y);
    }
  }
  return { id: 'img://p1-1', url: 'https://img.test/sheet.png', page: 1, buffer: pngBuffer(img), mime: 'image/png', bbox: { x: 50, y: 190, w: 300, h: 430 } };
}

// Boxes Gemini-style ([ymin,xmin,ymax,xmax], 0-1000) around each square, in question order 1..6.
const sixBoxes = () => [0, 1, 2].flatMap(r => [0, 1].map(c => [
  Math.round(((r * 200) / 600) * 1000), Math.round(((c * 200) / 400) * 1000),
  Math.round(((r * 200 + 200) / 600) * 1000), Math.round(((c * 200 + 200) / 400) * 1000),
]));

function perimeterTask(overrides = {}) {
  return {
    title: 'Task 1: Find the area and perimeter of the given shapes in each grid',
    sharedImage: true,
    sharedImageDescription: 'A grid worksheet showing six shapes drawn on 1 in x 1 in grid units',
    questions: ['H-shaped', 'square ring', 'U-shaped', 'T-shaped', 'rectangle', 'S-shaped'].map((s, i) => ({
      id: `q${i + 1}`, type: 'numeric', unit: 'in', answer: 10 + i, hint: 'Count the unit edges.',
      question: `Find the perimeter of shape ${i + 1} (${s} figure).`,
      ...(i === 0 ? { imageUrl: 'img://p1-1' } : {}),
    })),
    ...overrides,
  };
}

const figuresFor = (task, boxes = sixBoxes()) => task.questions.map((q, i) => ({ id: q.id, box: boxes[i] }));

describe('sharedPictureRef', () => {
  test('a shared picture on the first question is a split candidate', () => {
    expect(sharedPictureRef(perimeterTask())).toBe('img://p1-1');
  });

  test('every question carrying the same picture is a candidate too', () => {
    const task = perimeterTask({ sharedImage: false });
    task.questions.forEach((q) => { q.imageUrl = 'https://img.test/a.png'; });
    expect(sharedPictureRef(task)).toBe('https://img.test/a.png');
  });

  test('questions with their own pictures, a single question, matching tasks and teacher pictures are left alone', () => {
    const own = perimeterTask({ sharedImage: false });
    own.questions.forEach((q, i) => { q.imageUrl = `https://img.test/${i}.png`; });
    expect(sharedPictureRef(own)).toBeNull();
    expect(sharedPictureRef(perimeterTask({ questions: [perimeterTask().questions[0]] }))).toBeNull();
    const matching = perimeterTask();
    matching.questions[2].type = 'matching';
    expect(sharedPictureRef(matching)).toBeNull();
    expect(sharedPictureRef(perimeterTask({ sharedImageUrl: 'https://img.test/t.png' }))).toBeNull();
  });
});

describe('box checks', () => {
  test('normalizeBox clamps, orders, scales fractions and rejects slivers and whole-picture boxes', () => {
    expect(normalizeBox([10, 20, 300, 400])).toEqual([10, 20, 300, 400]);
    expect(normalizeBox([300, 400, 10, 20])).toEqual([10, 20, 300, 400]);
    expect(normalizeBox([0.1, 0.2, 0.3, 0.4])).toEqual([100, 200, 300, 400]);
    expect(normalizeBox([-5, 0, 1200, 500])).toEqual([0, 0, 1000, 500]);
    expect(normalizeBox([10, 10, 20, 500])).toBeNull();
    expect(normalizeBox([0, 0, 1000, 1000])).toBeNull();
    expect(normalizeBox([1, 2, 3])).toBeNull();
  });

  test('planSplit needs one distinct box for every question', () => {
    const task = perimeterTask();
    expect(planSplit(task.questions, figuresFor(task))).toHaveLength(6);
    expect(planSplit(task.questions, figuresFor(task).slice(0, 5))).toBeNull();
    const overlapping = figuresFor(task);
    overlapping[1].box = overlapping[0].box;
    expect(planSplit(task.questions, overlapping)).toBeNull();
  });

  test('parseFigures reads fenced JSON, bare arrays and box_2d', () => {
    expect(parseFigures('```json\n{"figures":[{"id":1,"box":[1,2,300,400]}]}\n```')).toEqual([{ id: '1', box: [1, 2, 300, 400] }]);
    expect(parseFigures('[{"id":"a","box_2d":[1,2,3,4]}]')).toEqual([{ id: 'a', box: [1, 2, 3, 4] }]);
    expect(parseFigures('not json')).toEqual([]);
  });

  test('the prompt lists every question id', () => {
    const p = figurePrompt(perimeterTask().questions);
    for (let i = 1; i <= 6; i++) expect(p).toContain(`id "q${i}"`);
  });
});

describe('splitSharedFigures', () => {
  test('each question gets its own crop; the task-level picture and description go', async () => {
    const pic = sixFigurePicture();
    const quiz = { tasks: [perimeterTask()] };
    const detect = jest.fn(async (picture, qs) => figuresFor({ questions: qs }));
    const hostImages = jest.fn(async crops => crops.map((c, i) => ({ url: `https://img.test/fig-${i + 1}.png` })));
    expect(await splitSharedFigures(quiz, { pictures: [pic] }, { detect, hostImages })).toBe(1);

    const task = quiz.tasks[0];
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0][0].buffer).toBe(pic.buffer);
    expect(task.questions.map(q => q.imageUrl)).toEqual([1, 2, 3, 4, 5, 6].map(i => `https://img.test/fig-${i}.png`));
    expect(task.sharedImage).toBe(false);
    expect(task.figuresSplit).toBe(true);
    expect(task.sharedImageDescription).toBeUndefined();

    // Every crop is one square: 200×200 plus a little padding, and dark in the middle.
    const crops = hostImages.mock.calls[0][0];
    expect(crops).toHaveLength(6);
    for (const c of crops) {
      expect(c.width).toBeGreaterThanOrEqual(200);
      expect(c.width).toBeLessThan(215);
      expect(c.height).toBeLessThan(220);
      const img = jimpFromPng(c.buffer);
      const mid = img.getPixelColor(Math.floor(img.bitmap.width / 2), Math.floor(img.bitmap.height / 2));
      expect(mid >>> 8).toBe(0); // black RGB
    }
  });

  test('without hosting the crops are inline images', async () => {
    const quiz = { tasks: [perimeterTask()] };
    await splitSharedFigures(quiz, { pictures: [sixFigurePicture()] }, { detect: async (p, qs) => figuresFor({ questions: qs }) });
    for (const q of quiz.tasks[0].questions) expect(q.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(new Set(quiz.tasks[0].questions.map(q => q.imageUrl)).size).toBe(6);
  });

  test('a picture given only as a url is loaded from that url', async () => {
    const pic = sixFigurePicture();
    const task = perimeterTask();
    task.questions[0].imageUrl = 'https://res.cloudinary.test/sheet.png';
    const load = jest.fn(async () => ({ buffer: pic.buffer, mime: 'image/png' }));
    await splitSharedFigures({ tasks: [task] }, null, { load, detect: async (p, qs) => figuresFor({ questions: qs }) });
    expect(load).toHaveBeenCalledWith('https://res.cloudinary.test/sheet.png', null);
    expect(task.figuresSplit).toBe(true);
  });

  test.each([
    ['the model finds no separate figures (one shared diagram)', async () => []],
    ['the model misses a question', async (p, qs) => figuresFor({ questions: qs }).slice(1)],
    ['the model fails', async () => { throw new Error('quota'); }],
  ])('%s → the whole picture stays, once, on the task', async (_, detect) => {
    const quiz = { tasks: [perimeterTask()] };
    expect(await splitSharedFigures(quiz, { pictures: [sixFigurePicture()] }, { detect })).toBe(0);
    const task = quiz.tasks[0];
    expect(task.sharedImage).toBe(true);
    expect(task.questions[0].imageUrl).toBe('img://p1-1');
    expect(task.questions.slice(1).every(q => !q.imageUrl)).toBe(true);
  });

  test('a picture repeated on every question falls back to one shared picture', async () => {
    const task = perimeterTask({ sharedImage: false });
    task.questions.forEach((q) => { q.imageUrl = 'img://p1-1'; });
    await splitSharedFigures({ tasks: [task] }, { pictures: [sixFigurePicture()] }, { detect: async () => [] });
    expect(task.sharedImage).toBe(true);
  });
});

describe('rendered assignment', () => {
  test('split: every question shows its own picture and there is no text placeholder', async () => {
    const quiz = { title: 'Perimeter Using Grids', subject: 'Mathematics', tasks: [perimeterTask()] };
    await splitSharedFigures(quiz, { pictures: [sixFigurePicture()] }, {
      detect: async (p, qs) => figuresFor({ questions: qs }),
      hostImages: async crops => crops.map((c, i) => ({ url: `https://img.test/fig-${i + 1}.png` })),
    });
    const html = renderQuizHTML(quiz, {});
    for (let i = 1; i <= 6; i++) expect(html).toContain(`src="https://img.test/fig-${i}.png"`);
    expect(html).not.toContain('six shapes drawn');
  });

  test('not split: the whole picture is shown once instead of the description', async () => {
    const pic = sixFigurePicture();
    const doc = { pictures: [pic] };
    const quiz = { title: 'Perimeter Using Grids', subject: 'Mathematics', tasks: [perimeterTask()] };
    await splitSharedFigures(quiz, doc, { detect: async () => [] });
    resolvePictureRefs(quiz, doc);
    const html = renderQuizHTML(quiz, {});
    expect(html.split('src="https://img.test/sheet.png"')).toHaveLength(2);
    // The description is only the picture's alt text, never a placeholder box.
    expect(html).not.toMatch(/📐|could not be auto-cropped/);
  });
});

describe('docx pictures', () => {
  test('linkDocxPictures pairs hosted docx images with the PDF pictures in reading order', () => {
    const a = { id: 'img://p1-1', page: 1, bbox: { x: 0, y: 400, w: 10, h: 10 } };
    const b = { id: 'img://p1-2', page: 1, bbox: { x: 0, y: 100, w: 10, h: 10 } };
    const text = 'Task 1\n[IMAGE: url=https://c.test/one.png]\nTask 2\n[IMAGE: url=https://c.test/two.png]';
    const links = linkDocxPictures(text, [a, b]);
    expect(links.get(b)).toBe('https://c.test/one.png');
    expect(links.get(a)).toBe('https://c.test/two.png');
    expect(b.url).toBe('https://c.test/one.png');
  });

  test('linkDocxPictures links nothing when the counts differ', () => {
    const a = { id: 'img://p1-1', page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    expect(linkDocxPictures('[IMAGE: url=https://c.test/1.png] [IMAGE: url=https://c.test/2.png]', [a]).size).toBe(0);
    expect(a.url).toBeUndefined();
  });

  test('attachTranscriptPictures gives a task the picture printed under its heading', () => {
    const doc = {
      text: 'Purpose: measurement.\n\nTask 1: Find the area and perimeter of the given shapes in each grid\n\n[IMAGE: url=img://p1-1]\n\nTask 2: Measure the angles\n[IMAGE: url=img://p1-2]',
      pictures: [{ id: 'img://p1-1' }, { id: 'img://p1-2' }],
    };
    const t1 = perimeterTask({ sharedImage: false });
    delete t1.questions[0].imageUrl;
    t1.questions.forEach((q) => { q.hasImage = true; });
    const t2 = { title: 'Task 2: Measure the angles', questions: [{ id: 'a', question: 'Measure angle A.', hasImage: true }] };
    expect(attachTranscriptPictures({ tasks: [t1, t2] }, doc)).toBe(2);
    expect(t1.questions[0].imageUrl).toBe('img://p1-1');
    expect(t1.sharedImage).toBe(true);
    expect(t2.questions[0].imageUrl).toBe('img://p1-2');
  });

  test('attachTranscriptPictures leaves tasks that need no picture', () => {
    const doc = { text: 'Task 1: Find the area and perimeter of the given shapes in each grid\n[IMAGE: url=img://p1-1]', pictures: [{ id: 'img://p1-1' }] };
    const task = perimeterTask({ sharedImage: false });
    delete task.questions[0].imageUrl;
    expect(attachTranscriptPictures({ tasks: [task] }, doc)).toBe(0);
  });
});
