// GET /quiz/providers and POST /quiz/grade-answer.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const mockGemini = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent: (...a) => mockGemini(...a) }) })),
}));
const mockGroq = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a) => mockGroq(...a) } } })));

const request = require('supertest');
const app = require('../../index');
const groqReply = obj => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }] });
const realFetch = global.fetch;

beforeEach(() => { mockGemini.mockReset(); mockGroq.mockReset(); });
afterEach(() => { global.fetch = realFetch; });
const isVision = (args) => Array.isArray(args.messages[0].content);

describe('GET /quiz/providers', () => {
  test('only Gemini and Groq are checked; a dead Gemini key with working Groq vision is "vision available", with the reason', async () => {
    process.env.GEMINI_API_KEY = 'test';
    process.env.GROQ_API_KEY = 'test';
    mockGemini.mockRejectedValue(new Error('429 Too Many Requests: GenerateRequestsPerDay quota exceeded'));
    mockGroq.mockResolvedValue(groqReply({ ok: true }));
    global.fetch = jest.fn().mockRejectedValue(new Error('no other AI service may be called'));

    const res = await request(app).get('/quiz/providers?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.providers.map(p => p.provider).sort()).toEqual(['gemini', 'groq', 'groq-vision']);
    const by = Object.fromEntries(res.body.providers.map(p => [p.provider, p]));
    expect(by.gemini.status).toBe('QUOTA_EXHAUSTED');
    expect(by.gemini.detail).toMatch(/PerDay/);
    expect(by['groq-vision'].status).toBe('OK');
    expect(by.groq.status).toBe('OK');
    expect(res.body.visionAvailable).toBe(true);
    expect(res.body.summary).toMatch(/groq-vision/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('no working vision provider is called out plainly', async () => {
    process.env.GEMINI_API_KEY = 'test';
    mockGemini.mockRejectedValue(new Error('403 API key not valid'));
    mockGroq.mockImplementation(async (args) => { if (isVision(args)) throw new Error('503 overloaded'); return groqReply({ ok: true }); });
    const res = await request(app).get('/quiz/providers?refresh=1');
    expect(res.body.visionAvailable).toBe(false);
    expect(res.body.summary).toMatch(/No vision provider is working/);
    expect(res.body.providers.find(p => p.provider === 'groq-vision').status).toBe('TEMPORARY_FAILURE');
  });
});

describe('POST /quiz/grade-answer', () => {
  const grade = body => request(app).post('/quiz/grade-answer').send(body);

  test('a Tamil answer to a Telugu question is incorrect without asking the model', async () => {
    const res = await grade({ expected: 'తామర పూలు', student: 'வணக்கம்', worksheetScript: 'Telugu' });
    expect(res.body.verdict).toBe('incorrect');
    expect(res.body.reason).toMatch(/Telugu/);
    expect(mockGroq).not.toHaveBeenCalled();
  });

  test('an exact answer (any accepted wording, punctuation ignored) is correct without the model', async () => {
    const res = await grade({ expected: 'తామర పూలు', acceptableAnswers: ['తామర పువ్వులు'], student: 'తామర పువ్వులు.' });
    expect(res.body.verdict).toBe('correct');
    expect(mockGroq).not.toHaveBeenCalled();
  });

  test('otherwise the model judges meaning, told the expected script', async () => {
    mockGroq.mockResolvedValue(groqReply({ verdict: 'partial', reason: 'సరస్సు సరైనదే' }));
    const res = await grade({ expected: 'సరస్సు వద్దకు', student: 'సరస్సుకు', question: 'రాణి, తాత ఎక్కడికి వెళ్ళారు?' });
    expect(res.body).toEqual({ verdict: 'partial', reason: 'సరస్సు సరైనదే' });
    const prompt = mockGroq.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Expected answer language/script: Telugu');
    expect(prompt).toContain('Student answer: సరస్సుకు');
  });

  test('grading unavailable → 503 with an incorrect verdict, never a false "correct"', async () => {
    mockGroq.mockRejectedValue(new Error('network'));
    const res = await grade({ expected: 'photosynthesis', student: 'plants make food' });
    expect(res.status).toBe(503);
    expect(res.body.verdict).toBe('incorrect');
  });

  test('requires a student answer', async () => {
    expect((await grade({ expected: 'x' })).status).toBe(400);
  });
});

describe('Groq vision request', () => {
  test('sends the prompt plus each page as an image, JSON mode, strips reasoning, and falls through a retired model', async () => {
    process.env.GROQ_API_KEY = 'test';
    let callGroqVision;
    jest.isolateModules(() => {
      process.env.GROQ_VISION_MODEL = 'old/retired-vision,qwen/qwen3.8-27b';
      ({ callGroqVision } = require('../../services/worksheet/providers'));
      delete process.env.GROQ_VISION_MODEL;
    });
    mockGroq
      .mockRejectedValueOnce(new Error('404 The model `old/retired-vision` has been decommissioned'))
      .mockResolvedValueOnce({ choices: [{ message: { content: '<think>reading</think>{"tasks":[]}' } }] });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
    const raw = await callGroqVision([{ buffer: jpeg, mime: 'image/jpeg' }, { buffer: jpeg, mime: 'image/jpeg' }], 'PROMPT', { json: true });
    expect(raw).toBe('{"tasks":[]}');
    const calls = mockGroq.mock.calls.map(c => c[0]);
    expect(calls.map(c => c.model)).toEqual(['old/retired-vision', 'qwen/qwen3.8-27b']);
    expect(calls[1].response_format).toEqual({ type: 'json_object' });
    const content = calls[1].messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'PROMPT' });
    expect(content.filter(c => c.type === 'image_url').map(c => c.image_url.url.slice(0, 23))).toEqual(['data:image/jpeg;base64,', 'data:image/jpeg;base64,']);
  });

  test('an auth error is not hidden by trying other models', async () => {
    process.env.GROQ_API_KEY = 'test';
    let callGroqVision;
    jest.isolateModules(() => {
      process.env.GROQ_VISION_MODEL = 'a/one,b/two';
      ({ callGroqVision } = require('../../services/worksheet/providers'));
      delete process.env.GROQ_VISION_MODEL;
    });
    mockGroq.mockRejectedValue(new Error('401 Invalid API Key'));
    await expect(callGroqVision([{ buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' }], 'P')).rejects.toThrow(/401/);
    expect(mockGroq).toHaveBeenCalledTimes(1);
  });
});
