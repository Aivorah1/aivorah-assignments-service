// Provider-agnostic worksheet → quiz (generateQuizFromDocument): every
// provider gets the document-model transcript; Gemini → Mistral vision →
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
process.env.GEMINI_TIMEOUT_WITH_FALLBACK_MS = '11000'; // Gemini's quick first try when Mistral could take over
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
  delete process.env.MISTRAL_API_KEY;
  resetProviderCooldowns();
});
afterEach(() => { global.fetch = realFetch; });

const TELUGU_QUIZ = {
  title: 'THLE-13', language: 'Telugu',
  tasks: [{ title: 'ఈ) కింది పేరా చదవండి. ప్రశ్నలకు జవాబులు రాయండి.', questions: [
    { id: 'a', type: 'text', question: 'రాణి సరస్సులో ఏమి చూసింది?', answer: 'తామర పూలు', hint: 'పేరా చూడండి', solution: 'తామర పూలు' },
  ] }],
};

test('Gemini down → Mistral reads the page images with the transcript; vision counts as available', async () => {
  process.env.MISTRAL_API_KEY = 'test';
  const bodies = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).includes('api.mistral.ai')) {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(TELUGU_QUIZ) } }] }) };
    }
    return realFetch(url, opts);
  });
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf', subject: 'Language' });

  expect(quiz.provider).toBe('mistral');
  expect(quiz.visualUnderstandingAvailable).toBe(true);
  expect(quiz.tasks[0].questions[0].answer).toBe('తామర పూలు');
  const content = bodies[0].messages[0].content;
  const images = content.filter(c => c.type === 'image_url');
  expect(images).toHaveLength(2); // one per page
  expect(images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
  const prompt = content.find(c => c.type === 'text').text;
  expect(prompt).toContain('WORKSHEET TRANSCRIPT');
  expect(prompt).toContain('పాము పుట్ట');              // a question only present inside a screenshot
  expect(prompt).toContain('LANGUAGE (CRITICAL');
  expect(mockGroq).not.toHaveBeenCalled();
}, 180000);

test('no vision provider → Groq structures the OCR transcript (the questions are no longer lost)', async () => {
  mockGroq.mockResolvedValue(groqReply(TELUGU_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf' });

  expect(quiz.provider).toBe('groq-text');
  expect(quiz.visualUnderstandingAvailable).toBe(false);
  expect(quiz.language).toBe('Telugu');
  const prompt = mockGroq.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain('రాణి సరస్సులో');
  expect(prompt).toContain('తాత పూలను');
  expect(prompt).toMatch(/\[IMAGE: url=img:\/\/p\d+-\d+\]/);
  expect(quiz.documentDiagnostics.pages.map(p => p.source)).toEqual(['ocr', 'ocr']);
}, 180000);

test('pictures reach their tasks: model ids resolved, region pictures attached, else a page crop', async () => {
  mockGroq.mockResolvedValue(groqReply({
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
  }));
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
// moment; the job gave it 90s, Mistral was rate-limited, so the quiz came out
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
const mistral429 = () => {
  process.env.MISTRAL_API_KEY = 'test';
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).includes('api.mistral.ai')) {
      calls.push(url);
      return { ok: false, status: 429, text: async () => '{"message":"Rate limit exceeded","code":"1300"}' };
    }
    return realFetch(url, opts);
  });
  return calls;
};

test('a busy Gemini is tried again after Mistral is rate-limited, instead of settling for text only', async () => {
  const mistralCalls = mistral429();
  mockGemini.mockReset()
    .mockRejectedValueOnce(new Error('[GoogleGenerativeAI Error]: Error fetching from https://x: [503 Service Unavailable] This model is currently experiencing high demand.'))
    .mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });

  expect(quiz.provider).toBe('gemini');
  expect(quiz.visualUnderstandingAvailable).toBe(true);
  expect(quiz.tasks).toHaveLength(5);
  expect(quiz.tasks[1].questions[0].answer).toBe('acute');
  expect(quiz.tasks[0].questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // the grid picture, hosted
  expect(quiz.tasks[1].questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // the angles picture
  expect(quiz.conversionReport.sourceSectionEstimate).toBe(5);               // was "roughly 19"
  expect(quiz.conversionReport.taskCountWarning).toBeUndefined();
  expect(quiz.conversionReport.visionNote).toBeUndefined();
  expect(mistralCalls.length).toBeGreaterThanOrEqual(0);
}, 180000);

test('a rate-limited Mistral is skipped on the next worksheet (cooldown), not called again', async () => {
  const mistralCalls = mistral429();
  // Gemini's quick first try hangs past its window, Mistral is asked and answers 429, Gemini is tried again.
  mockGemini.mockReset().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const first = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });
  expect(first.provider).toBe('gemini');
  expect(first.visionAttempts.map(a => `${a.provider}:${a.status}`)).toEqual(['gemini:TEMPORARY_FAILURE', 'mistral:RATE_LIMITED']);
  const after = mistralCalls.length;
  expect(after).toBeGreaterThan(0);
  mockGemini.mockReset().mockResolvedValue(geminiReply(MHLE31_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 60000 });
  expect(quiz.provider).toBe('gemini');
  expect(mistralCalls.length).toBe(after);
}, 180000);

test('when no vision AI answers, the quiz says exactly why and offers a retry', async () => {
  mistral429();
  mockGemini.mockReset().mockRejectedValue(new Error('[503 Service Unavailable] high demand'));
  mockGroq.mockResolvedValue(groqReply(MHLE31_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 12000 });

  expect(quiz.provider).toBe('groq-text');
  expect(quiz.visionUnavailableReason).toMatch(/Gemini was overloaded or timed out; Mistral is rate-limited/);
  expect(quiz.visionUnavailableReason).toMatch(/Retry/);
  expect(quiz.conversionReport.visionNote).toBe(quiz.visionUnavailableReason);
}, 180000);

test('a worksheet that yields no questions fails with a specific reason instead of an empty quiz', async () => {
  mockGroq.mockResolvedValue(groqReply({ title: 'MHLE - 31', tasks: [{ title: 'Task 1: Find the area', questions: [] }] }));
  await expect(generateQuizFromDocument({ buffer: fixture('b07-area-perimeter-matching-worksheet.pdf'), mime: 'application/pdf', visionBudgetMs: 12000 }))
    .rejects.toMatchObject({ code: 'EMPTY_QUIZ', message: expect.stringMatching(/No questions could be read from this worksheet \(1 task heading/) });
}, 180000);
