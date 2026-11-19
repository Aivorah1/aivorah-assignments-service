// The teacher's "Why did you choose this?" setting (off / optional / required)
// is saved with the assignment and sent back to students; student reasons
// have no practical length limit.
const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockGroqCreate } } })));

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';
const MCQ_Q = { id: 'q1', question: 'What is 2+2?', type: 'mcq', options: ['Three', 'Four', 'Five', 'Six'], correct: 'Four' };

const ROW = {
  id: 'a1', title: 'Quiz', subject: 'Mathematics', chapter: '', due_date: '2099-09-01', type: 'quiz', note: '',
  student_id: STUDENT_UUID, created_by_id: TEACHER_UUID, created_by_role: 'teacher', created_by_name: 'Ms. Rao',
  grade: null, curriculum: null, questions: [], quiz_questions: [MCQ_Q], status: null, score: null,
  created_at: '2026-11-01T00:00:00.000Z', completed_at: null,
};

// Every row passed to supabase.from('assignments').insert(...) in this test.
function insertedAssignments() {
  return mockSb.supabase.from.mock.calls
    .map((c, i) => [c[0], mockSb.supabase.from.mock.results[i].value])
    .filter(([table]) => table === 'assignments')
    .flatMap(([, chain]) => chain.insert.mock.calls.map((args) => args[0]));
}

function create(body) {
  return request(app).post('/assignments').send({
    title: 'Quiz', dueDate: '2099-09-01', type: 'quiz', studentId: STUDENT_UUID, createdById: TEACHER_UUID,
    quizQuestions: [MCQ_Q], ...body,
  });
}

beforeEach(() => {
  mockSb.reset();
  mockSb.supabase.from.mockClear();
  mockGroqCreate.mockReset();
  mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao' }, error: null });
});

describe('POST /assignments saves the reasoning setting', () => {
  test.each([
    ['optional', 'optional'],
    ['required', 'required'],
    ['compulsory', 'required'],
    ['off', 'off'],
    [undefined, 'off'],
    ['nonsense', 'off'],
  ])('requireReasoning %p is stored as %p and returned', async (sent, stored) => {
    mockSb.setTable('assignments', { data: { ...ROW, require_reasoning: stored }, error: null });
    const res = await create(sent === undefined ? {} : { requireReasoning: sent });
    expect(res.status).toBe(200);
    expect(insertedAssignments()[0].require_reasoning).toBe(stored);
    expect(res.body.requireReasoning).toBe(stored);
  });

  test('a database without the require_reasoning column still publishes the assignment', async () => {
    mockSb.setTable('assignments', [
      { data: null, error: { message: "Could not find the 'require_reasoning' column of 'assignments' in the schema cache" } },
      { data: ROW, error: null },
    ]);
    const res = await create({ requireReasoning: 'optional' });
    expect(res.status).toBe(200);
    const [first, second] = insertedAssignments();
    expect(first.require_reasoning).toBe('optional');
    expect(second).not.toHaveProperty('require_reasoning');
    expect(res.body.requireReasoning).toBe('off');
  });
});

describe('submitting reasons', () => {
  function groqJson(obj) {
    return { choices: [{ message: { content: JSON.stringify(obj) } }] };
  }

  test('a long reason (far over 500 characters) is kept whole for the teacher', async () => {
    const row = { ...ROW, require_reasoning: 'optional' };
    mockSb.setTable('assignments', [{ data: row, error: null }, { data: row, error: null }]);
    mockSb.setTable('assignment_submissions', { data: {}, error: null });
    mockGroqCreate.mockResolvedValue(groqJson({ text: 'Well done!' }));
    const long = 'Two and two make four because I counted on my fingers. '.repeat(40);

    const res = await request(app).post('/assignments/a1/submit').send({
      studentId: STUDENT_UUID, quizQuestions: [MCQ_Q], quizAnswers: [{ answer: 'Four', reasoning: long }],
    });
    expect(res.status).toBe(200);
    expect(res.body.perQuestion[0].reasoning).toBe(long.trim());
    expect(long.length).toBeGreaterThan(2000);
  });
});
