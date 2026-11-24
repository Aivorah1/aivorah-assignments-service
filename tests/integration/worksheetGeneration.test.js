// Provider-agnostic worksheet → quiz (generateQuizFromDocument): every
// provider gets the document-model transcript; Gemini → Groq vision →
// Groq text. AI calls are mocked; the document model (pdfjs/Chrome/OCR) is real.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGemini = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: (...a) => mockGemini(...a) }),
  })),
}));
const mockGroq = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...a) => mockGroq(...a) } },
})));
const mockUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: () => ({ cloud_name: 'test' }), uploader: { upload: (...a) => mockUpload(...a) } },
}));

process.env.GEMINI_API_KEY = 'test';
process.env.GEMINI_TIMEOUT_WITH_FALLBACK_MS = '11000'; // Gemini's quick first try when Groq vision could take over
const fs = require('fs');
const path = require('path');
const { generateQuizFromDocument, resetProviderCooldowns } = require('../../services/quizVision');
const documentModel = require('../../services/worksheet/documentModel');

// The real document model, built once per fixture (it's slow under jest);
// picture URLs are re-hosted per call so each test sees its own uploads.
const realBuild = documentModel.buildDocumentModel;
const built = new Map();
jest.spyOn(documentModel, 'buildDocumentModel').mockImplementation(async (input) => {
  const key = input.buffer.length;
  if (!built.has(key)) built.set(key, realBuild({ ...input, hostImages: async imgs => imgs.map((img, i) => ({ url: `https://img.test/${i + 1}.png` })) }));
  return built.get(key);
});

const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures', name));
const groqReply = obj => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }] });
const realFetch = global.fetch;
let uploads = 0;

beforeEach(() => {
  // A permanent (per-day) quota error fails fast — no retry backoff.
  mockGemini.mockReset().mockRejectedValue(new Error('429 Too Many Requests: GenerateRequestsPerDay quota exceeded'));
  mockGroq.mockReset();
  uploads = 0;
  mockUpload.mockReset().mockImplementation(async () => ({ secure_url: `https://img.test/${++uploads}.png` }));
  resetProviderCooldowns();
});
afterEach(() => { global.fetch = realFetch; });

// Only Gemini and Groq are used. Groq is called for vision (an image in the
// message) and for text; tests mock the two apart.
const isVision = (args) => Array.isArray(args.messages[0].content);
const groqVisionCalls = () => mockGroq.mock.calls.map(c => c[0]).filter(isVision);
const groqTextCalls = () => mockGroq.mock.calls.map(c => c[0]).filter(a => !isVision(a));
const groqBy = ({ vision, text }) => async (args) => {
  const v = isVision(args) ? vision : text;
  if (v instanceof Error) throw v;
  if (v === undefined) throw new Error(`unexpected Groq ${isVision(args) ? 'vision' : 'text'} call`);
  return groqReply(v);
};
const RATE_LIMITED = () => new Error('429 Too Many Requests: rate limit reached');
// No other AI service may be called; real fetches (none expected) pass through.
const noOtherAi = () => {
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (/mistral|huggingface/i.test(String(url))) { calls.push(url); throw new Error('no other AI service may be called'); }
    return realFetch(url, opts);
  });
  return calls;
};

const TELUGU_QUIZ = {
  title: 'THLE-13', language: 'Telugu',
  tasks: [{ title: 'ఈ) కింది పేరా చదవండి. ప్రశ్నలకు జవాబులు రాయండి.', questions: [
    { id: 'a', type: 'text', question: 'రాణి సరస్సులో ఏమి చూసింది?', answer: 'తామర పూలు', hint: 'పేరా చూడండి', solution: 'తామర పూలు' },
  ] }],
};

test('Gemini down → Groq vision reads the page images with the transcript; vision counts as available', async () => {
  const otherAi = noOtherAi();
  mockGroq.mockImplementation(groqBy({ vision: TELUGU_QUIZ }));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf', subject: 'Language' });

  expect(quiz.provider).toBe('groq-vision');
  expect(quiz.visualUnderstandingAvailable).toBe(true);
  expect(quiz.tasks[0].questions[0].answer).toBe('తామర పూలు');
  const call = groqVisionCalls()[0];
  expect(call.model).toBe('qwen/qwen3.8-27b');
  expect(call.response_format).toEqual({ type: 'json_object' });
  const images = call.messages[0].content.filter(c => c.type === 'image_url');
  expect(images).toHaveLength(2); // one per page
  expect(images[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  const prompt = call.messages[0].content.find(c => c.type === 'text').text;
  expect(prompt).toContain('WORKSHEET TRANSCRIPT');
  expect(prompt).toContain('పాము పుట్ట');              // a question only present inside a screenshot
  expect(prompt).toContain('LANGUAGE (CRITICAL');
  expect(groqTextCalls()).toHaveLength(0);
  expect(otherAi).toHaveLength(0);
}, 180000);

test('no vision provider → Groq structures the OCR transcript (the questions are no longer lost)', async () => {
  mockGroq.mockImplementation(groqBy({ vision: RATE_LIMITED(), text: TELUGU_QUIZ }));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf' });

  expect(quiz.provider).toBe('groq-text');
  expect(quiz.visualUnderstandingAvailable).toBe(false);
  expect(quiz.language).toBe('Telugu');
  const prompt = groqTextCalls()[0].messages[0].content;
  expect(prompt).toContain('రాణి సరస్సులో');
  expect(prompt).toContain('తాత పూలను');
  expect(prompt).toMatch(/\[IMAGE: url=img:\/\/p\d+-\d+\]/);
  expect(quiz.documentDiagnostics.pages.map(p => p.source)).toEqual(['ocr', 'ocr']);
}, 180000);

test('pictures reach their tasks: model ids resolved, region pictures attached, else a page crop', async () => {
  const B05_QUIZ = ({
    title: 'MHLE 32', tasks: [
      { title: 'Task 1: Answer the following.', questions: [
        { id: 'a', type: 'numeric', question: 'Find the side of this regular polygon if its perimeter is 40 cm.', answer: 5, imageUrl: 'img://p1-2' },
        { id: 'b', type: 'text', question: 'Ghost picture', answer: 'x', imageUrl: 'img://p9-99' },
      ] },
      { title: 'Task 2: Find the perimeter of the L shaped polygon.', questions: [
        { id: 'a', type: 'numeric', question: 'Find the perimeter of the L shaped polygon.', answer: 28, solution: '5+6+8+3+...', hasImage: true },
      ] },
      { title: 'Task 3: Application of area and perimeter in real situations.', questions: [
        { id: 'a', type: 'numeric', question: 'A square playground has sides that are 65 m long. What is the area?', answer: 4225, solution: '65 × 65', hasImage: true },
      ] },
      { title: 'Enrichment Task:', questions: [
        { id: 'a', type: 'numeric', question: 'A rectangular room has a length of 120 m and a breadth of 80 m. How many 40 cm tiles cover it?', answer: 60000 },
      ] },
    ],
  });
  mockGroq.mockImplementation(groqBy({ vision: RATE_LIMITED(), text: B05_QUIZ }));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b05-area-perimeter-worksheet.pdf'), mime: 'application/pdf' });
  const [t1, t2, t3] = quiz.tasks;

  expect(t1.questions[0].imageUrl).toBe('https://img.test/2.png');      // id from the model → hosted url
  expect(t1.questions[1].imageUrl).toBeUndefined();                      // invented id dropped
  expect(t2.questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // L-shape picture found in its region
  expect(t2.regionCrop).toBeUndefined();
  expect(t3.regionCrop).toBe(true);                                       // no picture in its region → page crop
  expect(t3.questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//);
}, 180000);

// MHLE-31 (2026-11-24 report): Gemini was healthy but "high demand" for a
// moment; the job gave it 90s, the second provider was rate-limited, so the quiz came out
// text-only — picture tasks without answers, "roughly 19 sections" warning.
const MHLE31_QUIZ = {
  title: 'MHLE - 31', tasks: [
    { title: 'Task 1: Find the area and perimeter of the given shapes in each grid.', tier: 'MUST DO', questions: [
      { id: 'a', type: 'text', question: 'Shape 1: Perimeter = ___ units, Area = ___ sq units', answer: 'Perimeter = 16 units, Area = 12 sq units', imageUrl: 'img://p1-2' },
    ] },
    { title: 'Task 2: Measure the given angles using protractor and name the type of angle (acute/right/obtuse angled).', tier: 'MUST DO', questions: [
      { id: 'a', type: 'mcq', question: 'Angle a) measures 45°. What type of angle is it?', options: ['acute', 'right', 'obtuse'], answer: 'acute', imageUrl: 'img://p1-1' },
    ] },
    { title: 'Task 3: Match the length and width to the area and perimeter of each shape.', tier: 'COULD DO', questions: [
      { id: 'a', type: 'text', question: 'Length 3, width 2: Area = ?', answer: '6' },
    ] },
    { title: 'Task 4: Find the area and perimeter of the given squares with the following dimensions.', tier: 'COULD DO', questions: [
      { id: 'a', type: 'numeric', question: 'Side = 6 cm. Perimeter = ?', answer: 24, unit: 'cm' },
    ] },
    { title: 'Enrichment Task: Relationship of area and perimeter.', tier: 'ENRICHMENT', questions: [
      { id: 'a', type: 'text', question: 'Draw a square with the same area and perimeter. Label the sides.', answer: 'A square of side 4 units' },
    ] },
  ],
};
const geminiReply = obj => ({ response: { text: () => JSON.stringify(obj) } });
test('a busy Gemini is tried again after Groq vision is rate-limited, instead of settling for text only', async () => {
  const otherAi = noOtherAi();
  mockGroq.mockImplementation(groqBy({ vision: RATE_LIMITED() }));
  // Gemini's quick first try hangs past its window; Groq vision is rate-limited; Gemini answers on the second try.
  mockGemini.mockReset().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });

  expect(quiz.provider).toBe('gemini');
  expect(quiz.visualUnderstandingAvailable).toBe(true);
  expect(quiz.visionAttempts.map(a => `${a.provider}:${a.status}`)).toEqual(['gemini:TEMPORARY_FAILURE', 'groq-vision:RATE_LIMITED']);
  expect(quiz.tasks).toHaveLength(5);
  expect(quiz.tasks[1].questions[0].answer).toBe('acute');
  expect(quiz.tasks[0].questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // the grid picture, hosted
  expect(quiz.tasks[1].questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // the angles picture
  expect(quiz.conversionReport.sourceSectionEstimate).toBe(5);               // was "roughly 19"
  expect(quiz.conversionReport.taskCountWarning).toBeUndefined();
  expect(quiz.conversionReport.visionNote).toBeUndefined();
  expect(otherAi).toHaveLength(0);
}, 180000);

test('a rate-limited Groq vision is skipped on the next worksheet (cooldown), not called again', async () => {
  mockGroq.mockImplementation(groqBy({ vision: RATE_LIMITED() }));
  mockGemini.mockReset().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const first = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });
  expect(first.provider).toBe('gemini');
  const after = groqVisionCalls().length;
  expect(after).toBeGreaterThan(0);
  mockGemini.mockReset().mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });
  expect(quiz.provider).toBe('gemini');
  expect(groqVisionCalls().length).toBe(after);
}, 180000);

test('Groq vision that drops tasks is not trusted: Gemini is tried again, then Groq text', async () => {
  // Groq vision returns only 2 of the sheet's 5 labelled tasks.
  mockGroq.mockImplementation(groqBy({ vision: { title: 'x', tasks: MHLE31_QUIZ.tasks.slice(0, 2) }, text: MHLE31_QUIZ }));
  mockGemini.mockReset().mockRejectedValue(new Error('[503 Service Unavailable] high demand'));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 12000 });
  expect(quiz.provider).toBe('groq-text');
  expect(quiz.tasks).toHaveLength(5);
  const groqAttempt = quiz.visionAttempts.find(a => a.provider === 'groq-vision');
  expect(groqAttempt.detail).toMatch(/unusable reply \(2 tasks.*labels 5/);
}, 180000);

test('when no vision AI answers, the quiz says exactly why and offers a retry', async () => {
  mockGroq.mockImplementation(groqBy({ vision: RATE_LIMITED(), text: MHLE31_QUIZ }));
  mockGemini.mockReset().mockRejectedValue(new Error('[503 Service Unavailable] high demand'));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 12000 });

  expect(quiz.provider).toBe('groq-text');
  expect(quiz.visionUnavailableReason).toMatch(/Gemini was overloaded, timed out or gave an unusable answer; Groq vision is rate-limited/);
  expect(quiz.visionUnavailableReason).toMatch(/Retry/);
  expect(quiz.conversionReport.visionNote).toBe(quiz.visionUnavailableReason);
}, 180000);

test('a worksheet that yields no questions fails with a specific reason instead of an empty quiz', async () => {
  mockGroq.mockResolvedValue(groqReply({ title: 'MHLE - 31', tasks: [{ title: 'Task 1: Find the area', questions: [] }] }));
  await expect(generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 12000 }))
    .rejects.toMatchObject({ code: 'EMPTY_QUIZ', message: expect.stringMatching(/No questions could be read from this worksheet \(1 task heading/) });
}, 180000);
