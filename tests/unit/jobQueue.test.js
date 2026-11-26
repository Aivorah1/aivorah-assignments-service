// The job queue shares Supabase's upload_jobs table with the legacy monolith,
// whose drain claims ANY row in status 'pending'. These tests pin down that
// this service's jobs never sit in 'pending', that a stuck or orphaned job is
// failed with a clear message, and that only one drain runs at a time.

// In-memory upload_jobs with just the query shapes jobQueue.js uses.
const mockRows = new Map();
function mockQuery() {
  const filters = [];
  let patch = null;
  let types = null;
  const api = {
    insert(row) { mockRows.set(row.id, { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); return Promise.resolve({ error: null }); },
    update(p) { patch = p; return api; },
    select() { return api; },
    eq(k, v) { filters.push([k, v]); return api; },
    in(k, v) { types = [k, v]; return api; },
    order() { return api; },
    limit() { return api; },
    maybeSingle() { return Promise.resolve({ data: match()[0] || null }); },
    then(resolve) {
      const hit = match();
      if (patch) hit.forEach(r => Object.assign(r, patch));
      return Promise.resolve({ data: hit.map(r => ({ ...r })), error: null }).then(resolve);
    },
  };
  const match = () => [...mockRows.values()].filter(r => filters.every(([k, v]) => r[k] === v) && (!types || types[1].includes(r[types[0]])));
  return api;
}
jest.mock('../../services/supabase', () => ({ from: () => mockQuery() }));

process.env.JOB_TIMEOUT_MS = '200';
const jq = require('../../services/jobQueue');

beforeEach(() => mockRows.clear());

test('a new job waits under this service\'s own status, so the monolith\'s "pending" drain never sees it', async () => {
  const { jobId } = await jq.publishJob('quiz_generate', { a: 1 });
  expect(mockRows.get(jobId).status).toBe('pending_assignments');
  expect(jq.PENDING).toBe('pending_assignments');
  // Clients still see the usual word.
  expect((await jq.getJob(jobId)).status).toBe('pending');
});

test('the drain claims only this service\'s jobs, never a monolith "pending" row', async () => {
  const ran = [];
  jq.registerHandler('quiz_generate', async (p) => { ran.push(p.n); return { ok: p.n }; });
  mockRows.set('mono', { id: 'mono', type: 'quiz_generate', status: 'pending', payload: { n: 'mono' } });
  const { jobId } = await jq.publishJob('quiz_generate', { n: 'ours' });
  const out = await jq.runWorkerOnce(5);
  expect(out.processed).toBe(1);
  expect(ran).toEqual(['ours']);
  expect(mockRows.get(jobId)).toMatchObject({ status: 'done', result: { ok: 'ours' } });
  expect(mockRows.get('mono').status).toBe('pending');
});

test('a job that runs past JOB_TIMEOUT_MS is failed with a Retry message instead of hanging', async () => {
  jq.registerHandler('slow', () => new Promise(() => {}));
  const { jobId } = await jq.publishJob('slow', {});
  await jq.runWorkerOnce(1);
  expect(mockRows.get(jobId).status).toBe('failed');
  expect(mockRows.get(jobId).error).toMatch(/took too long.*Retry/);
});

test('a job left "processing" by a restart is failed when it is next polled', async () => {
  const old = new Date(Date.now() - jq.JOB_STALE_MS - 1000).toISOString();
  mockRows.set('orphan', { id: 'orphan', type: 'quiz_generate', status: 'processing', locked_at: old, updated_at: old, created_at: old });
  const job = await jq.getJob('orphan');
  expect(job.status).toBe('failed');
  expect(job.error).toMatch(/server restarted.*Retry/);
  expect(mockRows.get('orphan').status).toBe('failed');
});

test('a job still within its time is left alone', async () => {
  const recent = new Date().toISOString();
  mockRows.set('busy', { id: 'busy', type: 'quiz_generate', status: 'processing', locked_at: recent, updated_at: recent, created_at: recent });
  expect((await jq.getJob('busy')).status).toBe('processing');
});

test('only one drain runs at a time', async () => {
  let release;
  jq.registerHandler('gate', () => new Promise(r => { release = r; }));
  await jq.publishJob('gate', {});
  const first = jq.runWorkerOnce(1);
  await new Promise(r => setImmediate(r));
  expect(await jq.runWorkerOnce(1)).toMatchObject({ busy: true, claimed: 0 });
  release({ ok: true });
  await first;
});
