// Prepare Worksheet (/worksheets): a teacher's own documents, sharing only
// with teachers of the same school, "Shared to you", and the .docx used by
// Download and Assign. Runs the real sign-in check, routes and storage code on
// an in-memory database.
const { makeMemorySupabase } = require('../helpers/memorySupabase');

const mockDb = { current: null };
jest.mock('../../services/supabase', () => ({ from: (...args) => mockDb.current.supabase.from(...args) }));

// Token "<email>" signs in as that email.
jest.mock('../../services/firebaseAdmin', () => ({
  auth: () => ({ verifyIdToken: jest.fn(async (token) => ({ email: token })) }),
}));

const mockUpload = jest.fn(async () => ({ secure_url: 'https://res.cloudinary.com/demo/image/upload/pasted.png' }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: (...a) => mockUpload(...a) } } }));

const request = require('supertest');
const JSZip = require('jszip');
const app = require('../../index');

const SCHOOL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHOOL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const u = (n, extra) => ({ id: `1111111${n}-1111-4111-8111-111111111111`, status: 'active', ...extra });
const T1 = u(1, { email: 't1@a.test', name: 'Asha Rao', role: 'teacher', school_id: SCHOOL_A });
const T2 = u(2, { email: 't2@a.test', name: 'Bala K', role: 'teacher', school_id: SCHOOL_A });
const T3 = u(3, { email: 't3@b.test', name: 'Other School', role: 'teacher', school_id: SCHOOL_B });
const OLD = u(4, { email: 'old@a.test', name: 'Archived T', role: 'teacher', school_id: SCHOOL_A, status: 'archived' });
const STUDENT = u(5, { email: 's@a.test', name: 'Student', role: 'student', school_id: SCHOOL_A });
const LONER = u(6, { email: 'b2c@x.test', name: 'No School', role: 'teacher', school_id: null });

const as = (user) => ({ Authorization: `Bearer ${user.email}` });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function save(user, body = { title: 'Fractions practice', html: '<p>Fill in the blanks</p>' }) {
  const res = await request(app).post('/worksheets').set(as(user)).send(body);
  return res;
}

beforeEach(() => {
  mockDb.current = makeMemorySupabase({ users: [T1, T2, T3, OLD, STUDENT, LONER] });
  mockUpload.mockClear();
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
});

describe('sign-in', () => {
  test('no token is 401; a student is turned away', async () => {
    expect((await request(app).get('/worksheets')).status).toBe(401);
    expect((await request(app).get('/worksheets').set(as(STUDENT))).status).toBe(403);
  });
});

describe('my documents', () => {
  test('save, list (newest first) and open again', async () => {
    const first = await save(T1);
    expect(first.status).toBe(201);
    expect(first.body.item).toMatchObject({ title: 'Fractions practice' });
    const second = await save(T1, { title: '  Shapes   quiz ', html: '<h1>Shapes</h1>' });
    expect(second.body.item.title).toBe('Shapes quiz');
    // make the second one clearly newer
    mockDb.current.tables.teacher_worksheets[1].updated_at = '2099-01-01T00:00:00.000Z';

    const list = await request(app).get('/worksheets').set(as(T1));
    expect(list.body.items.map((i) => i.title)).toEqual(['Shapes quiz', 'Fractions practice']);
    expect(list.body.items[0]).toEqual(expect.objectContaining({ id: expect.any(String), updated_at: expect.any(String) }));

    const open = await request(app).get(`/worksheets/${first.body.item.id}`).set(as(T1));
    expect(open.body.item).toMatchObject({ title: 'Fractions practice', html: '<p>Fill in the blanks</p>', isOwner: true, sharedBy: null });
  });

  test('another teacher\'s documents are not listed', async () => {
    await save(T1);
    const list = await request(app).get('/worksheets').set(as(T2));
    expect(list.body.items).toEqual([]);
  });

  test('a file name is required and limited', async () => {
    expect((await save(T1, { title: '   ', html: '<p>x</p>' })).body.error).toBe('Enter a file name');
    expect((await save(T1, { title: 'x'.repeat(201), html: '' })).status).toBe(400);
    expect((await save(T1, { title: 'Big', html: 'x'.repeat(8 * 1024 * 1024 + 1) })).status).toBe(400);
  });

  test('scripts and event handlers are removed before saving; formatting stays', async () => {
    const res = await save(T1, {
      title: 'Unsafe',
      html: '<p style="color:#c00000;text-align:center" onclick="steal()">Hi<script>alert(1)</script></p><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil.test"></iframe>',
    });
    const stored = mockDb.current.tables.teacher_worksheets[0].content_html;
    expect(res.status).toBe(201);
    expect(stored).toContain('<p style="color:#c00000;text-align:center">Hi</p>');
    expect(stored).not.toMatch(/script|onclick|onerror|javascript:|iframe/i);
  });

  test('pasted images are moved to Cloudinary on save', async () => {
    await save(T1, { title: 'Pic', html: `<p><img src="${PNG}" /></p>` });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockDb.current.tables.teacher_worksheets[0].content_html).toContain('https://res.cloudinary.com/demo/image/upload/pasted.png');
  });

  test('saving again updates the same document; only the owner can', async () => {
    const { body } = await save(T1);
    const id = body.item.id;
    const upd = await request(app).put(`/worksheets/${id}`).set(as(T1)).send({ title: 'Renamed', html: '<p>v2</p>' });
    expect(upd.status).toBe(200);
    expect(upd.body.item.title).toBe('Renamed');
    expect(mockDb.current.tables.teacher_worksheets).toHaveLength(1);
    expect(mockDb.current.tables.teacher_worksheets[0].content_html).toBe('<p>v2</p>');

    // even after it is shared with them, another teacher cannot change it
    await request(app).post(`/worksheets/${id}/share`).set(as(T1)).send({ teacherId: T2.id });
    const theirs = await request(app).put(`/worksheets/${id}`).set(as(T2)).send({ html: '<p>hacked</p>' });
    expect(theirs.status).toBe(404);
    expect(mockDb.current.tables.teacher_worksheets[0].content_html).toBe('<p>v2</p>');
  });

  test('opening someone else\'s unshared document is 404', async () => {
    const { body } = await save(T1);
    expect((await request(app).get(`/worksheets/${body.item.id}`).set(as(T2))).status).toBe(404);
    expect((await request(app).get('/worksheets/not-a-uuid').set(as(T1))).status).toBe(404);
  });
});

describe('Share box: teachers of my school', () => {
  test('lists only other active teachers of the same school', async () => {
    const res = await request(app).get('/worksheets/teachers').set(as(T1));
    expect(res.body.teachers).toEqual([{ id: T2.id, name: 'Bala K', email: 't2@a.test' }]);
  });

  test('a teacher with no school sees nobody', async () => {
    const res = await request(app).get('/worksheets/teachers').set(as(LONER));
    expect(res.body.teachers).toEqual([]);
  });
});

describe('sharing', () => {
  test('shared document shows under "Shared to you" with who shared it and when', async () => {
    const { body } = await save(T1);
    const share = await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: T2.id });
    expect(share.body.sharedWith).toEqual({ id: T2.id, name: 'Bala K', email: 't2@a.test' });

    const shared = await request(app).get('/worksheets/shared').set(as(T2));
    expect(shared.body.items).toEqual([expect.objectContaining({
      id: body.item.id, title: 'Fractions practice', shared_by_name: 'Asha Rao', shared_at: expect.any(String),
    })]);
    // the sharer's own list is unchanged; nothing is shared back
    expect((await request(app).get('/worksheets/shared').set(as(T1))).body.items).toEqual([]);

    const open = await request(app).get(`/worksheets/${body.item.id}`).set(as(T2));
    expect(open.body.item).toMatchObject({ isOwner: false, sharedBy: { name: 'Asha Rao', email: 't1@a.test' } });
  });

  test('sharing twice keeps one entry', async () => {
    const { body } = await save(T1);
    await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: T2.id });
    await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: T2.id });
    expect(mockDb.current.tables.teacher_worksheet_shares).toHaveLength(1);
  });

  test('never with another school, a student, an archived teacher or yourself', async () => {
    const { body } = await save(T1);
    const shareTo = (id) => request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: id });
    expect((await shareTo(T3.id)).status).toBe(403);
    expect((await shareTo(STUDENT.id)).status).toBe(403);
    expect((await shareTo(OLD.id)).status).toBe(403);
    expect((await shareTo(T1.id)).status).toBe(400);
    expect((await shareTo('nobody')).status).toBe(400);
    expect(mockDb.current.tables.teacher_worksheet_shares || []).toHaveLength(0);
  });

  test('only the owner can share a document', async () => {
    const { body } = await save(T1);
    await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: T2.id });
    const reshare = await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T2)).send({ teacherId: T1.id });
    expect(reshare.status).toBe(404);
  });

  test('a teacher who moved to another school no longer sees what was shared', async () => {
    const { body } = await save(T1);
    await request(app).post(`/worksheets/${body.item.id}/share`).set(as(T1)).send({ teacherId: T2.id });
    mockDb.current.tables.users.find((x) => x.id === T2.id).school_id = SCHOOL_B;
    expect((await request(app).get('/worksheets/shared').set(as(T2))).body.items).toEqual([]);
    expect((await request(app).get(`/worksheets/${body.item.id}`).set(as(T2))).status).toBe(404);
  });
});

describe('Word file (Download / Assign)', () => {
  test('owner and the teacher it was shared with get a .docx; nobody else does', async () => {
    const { body } = await save(T1, { title: 'Fractions: practice/1', html: '<h1>Fractions</h1><p><strong>Q1.</strong> 1/2 + 1/4 = ?</p>' });
    const id = body.item.id;

    const mine = await request(app).get(`/worksheets/${id}/docx`).set(as(T1));
    expect(mine.status).toBe(200);
    expect(mine.body.fileName).toBe('Fractions practice 1.docx');
    expect(mine.body.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const zip = await JSZip.loadAsync(Buffer.from(mine.body.base64, 'base64'));
    const xml = await zip.file('word/document.xml').async('string');
    expect(xml).toContain('Q1.');
    expect(xml).toContain('<w:b/>');

    expect((await request(app).get(`/worksheets/${id}/docx`).set(as(T2))).status).toBe(404);
    await request(app).post(`/worksheets/${id}/share`).set(as(T1)).send({ teacherId: T2.id });
    expect((await request(app).get(`/worksheets/${id}/docx`).set(as(T2))).status).toBe(200);
    expect((await request(app).get(`/worksheets/${id}/docx`).set(as(T3))).status).toBe(404);
  }, 30000);
});
