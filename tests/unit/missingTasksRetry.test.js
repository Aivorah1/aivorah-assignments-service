// Live 2026-11-26: Groq text returned only "Task 4" of MHLE-31's five tasks.
// The worksheet's own task headings are compared with the quiz, and the same
// engine is asked once for the missing ones, which go back in sheet order.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { retryMissingTasks, findMissingLabelledTasks, classifyProviderError, shortProviderError } = require('../../services/quizVision');

const TRANSCRIPT = [
  'Must Do',
  'Task 1: Find the area and perimeter of the given shapes in each grid.',
  '[IMAGE: url=img://p1-2]   |   [IMAGE: url=img://p1-3]',
  'Task 2: Measure the given angles using protractor and name the type of angle.',
  'Could do:',
  'Task 3: Match the length and width to the area and perimeter of each shape.',
  'Task 4: Find the area and perimeter of the given squares.',
  'Enrichment Task: Relationship of area and perimeter.',
].join('\n');
const q = (title, question) => ({ title, questions: [{ id: 'a', type: 'text', question, answer: 'x' }] });

test('only the missing labelled tasks are asked for, and they come back in worksheet order', async () => {
  const quiz = { tasks: [q('Task 4: Find the area and perimeter of the given squares.', 'Side 6 cm: perimeter?')] };
  expect(findMissingLabelledTasks(quiz, TRANSCRIPT).map(m => m.key)).toEqual(['task 1', 'task 2', 'task 3', expect.stringMatching(/^enrichment/)]);
  const retryFn = jest.fn().mockResolvedValue(JSON.stringify({ tasks: [
    q('Enrichment Task: Relationship of area and perimeter.', 'Draw a square'),
    q('Task 1: Find the area and perimeter of the given shapes in each grid.', 'Shape 1'),
    q('Task 3: Match the length and width.', 'Row 2'),
    q('Task 2: Measure the given angles.', 'Angle a'),
  ] }));
  const out = await retryMissingTasks(quiz, retryFn, TRANSCRIPT);
  const prompt = retryFn.mock.calls[0][0];
  expect(prompt).toContain('- Task 1: Find the area and perimeter');
  expect(prompt).not.toContain('- Task 4');
  expect(out.tasks.map(t => t.title.slice(0, 6))).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Enrich']);
});

test('a complete quiz asks nothing', async () => {
  const quiz = { tasks: ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Enrichment Task'].map(t => q(`${t}: x`, 'q')) };
  const retryFn = jest.fn();
  await retryMissingTasks(quiz, retryFn, TRANSCRIPT);
  expect(retryFn).not.toHaveBeenCalled();
});

test('a failed or empty retry keeps what was generated', async () => {
  const quiz = { tasks: [q('Task 4: Squares', 'q')] };
  await expect(retryMissingTasks(quiz, jest.fn().mockRejectedValue(new Error('429')), TRANSCRIPT)).resolves.toBe(quiz);
  const again = await retryMissingTasks(quiz, jest.fn().mockResolvedValue('{"tasks":[{"title":"Task 1","questions":[]}]}'), TRANSCRIPT);
  expect(again.tasks).toHaveLength(1);
});

test('"413 Request too large" is not a rate limit (no 10-minute skip); details keep the useful part', () => {
  expect(classifyProviderError('groq-vision', new Error('413 {"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `org_01abc` on tokens per minute (TPM): Limit 8000, Requested 12345"}}'))).toBe('UNSUPPORTED');
  const short = shortProviderError(new Error('413 Request too large for model in organization `org_01kq0668tze4qb713` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12345, please reduce your message size'));
  expect(short).toContain('Limit 8000, Requested 12345');
  expect(short).not.toMatch(/org_01/);
  expect(shortProviderError(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent: [429 Too Many Requests] quota'))).toBe('429 Too Many Requests quota');
});
