/**
 * Prepare Worksheet storage (tables teacher_worksheets and
 * teacher_worksheet_shares, aivorah-db 0025). Every function takes the
 * signed-in teacher from routes/worksheets.js and only returns what that
 * teacher may see:
 *   - their own documents (open, edit, download, assign, share);
 *   - documents another teacher of the same school shared with them (open,
 *     download, assign; never edit the owner's copy).
 */
const supabase = require('./supabase');

const SUMMARY = 'id, title, created_at, updated_at';
const norm = (v) => String(v || '').trim();

async function listMine(ownerId) {
  const { data, error } = await supabase
    .from('teacher_worksheets').select(SUMMARY)
    .eq('owner_id', ownerId).order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function create(owner, { title, html }) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('teacher_worksheets')
    .insert({ owner_id: owner.id, school_id: owner.school_id || null, title, content_html: html, created_at: now, updated_at: now })
    .select(SUMMARY).single();
  if (error) throw error;
  return data;
}

// Owner only. Returns the updated summary, or null when it is not theirs.
async function update(ownerId, id, { title, html }) {
  const patch = { updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title;
  if (html !== undefined) patch.content_html = html;
  const { data, error } = await supabase
    .from('teacher_worksheets').update(patch)
    .eq('id', id).eq('owner_id', ownerId)
    .select(SUMMARY).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getRow(id) {
  const { data, error } = await supabase
    .from('teacher_worksheets').select('id, owner_id, school_id, title, content_html, created_at, updated_at')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function shareRow(worksheetId, teacherId) {
  const { data, error } = await supabase
    .from('teacher_worksheet_shares').select('shared_by, shared_at')
    .eq('worksheet_id', worksheetId).eq('shared_with', teacherId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function userNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.from('users').select('id, name, email').in('id', unique);
  if (error) throw error;
  return new Map((data || []).map((u) => [u.id, { name: norm(u.name) || norm(u.email), email: norm(u.email) }]));
}

/**
 * The document if this teacher may open it: { doc, isOwner, sharedBy?, sharedAt? }.
 * A share only counts while sharer and recipient are still in the same school.
 */
async function openFor(teacher, id) {
  const row = await getRow(id);
  if (!row) return null;
  if (row.owner_id === teacher.id) return { doc: row, isOwner: true };
  const share = await shareRow(id, teacher.id);
  if (!share || !teacher.school_id || row.school_id !== teacher.school_id) return null;
  const names = await userNames([share.shared_by]);
  return { doc: row, isOwner: false, sharedBy: names.get(share.shared_by) || null, sharedAt: share.shared_at };
}

// "Shared to you": newest first, only from the recipient's own school.
async function listSharedWith(teacher) {
  if (!teacher.school_id) return [];
  const { data: shares, error } = await supabase
    .from('teacher_worksheet_shares').select('worksheet_id, shared_by, shared_at')
    .eq('shared_with', teacher.id).order('shared_at', { ascending: false });
  if (error) throw error;
  if (!shares?.length) return [];
  const { data: docs, error: docErr } = await supabase
    .from('teacher_worksheets').select(`${SUMMARY}, school_id`)
    .in('id', shares.map((s) => s.worksheet_id));
  if (docErr) throw docErr;
  const byId = new Map((docs || []).filter((d) => d.school_id === teacher.school_id).map((d) => [d.id, d]));
  const names = await userNames(shares.map((s) => s.shared_by));
  return shares
    .filter((s) => byId.has(s.worksheet_id))
    .map((s) => {
      const d = byId.get(s.worksheet_id);
      const by = names.get(s.shared_by);
      return {
        id: d.id, title: d.title, updated_at: d.updated_at,
        shared_at: s.shared_at, shared_by_name: by?.name || 'A teacher', shared_by_email: by?.email || null,
      };
    });
}

// Fellow teachers of the same school (never the teacher themself, never other schools).
async function schoolTeachers(teacher) {
  if (!teacher.school_id) return [];
  const { data, error } = await supabase
    .from('users').select('id, name, email, status')
    .eq('school_id', teacher.school_id).eq('role', 'teacher')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || [])
    .filter((u) => u.id !== teacher.id && u.status !== 'archived' && norm(u.email))
    .map((u) => ({ id: u.id, name: norm(u.name) || norm(u.email), email: norm(u.email).toLowerCase() }));
}

async function getUser(id) {
  const { data, error } = await supabase
    .from('users').select('id, name, email, role, school_id, status').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertShare(worksheetId, sharedBy, sharedWith) {
  const { error } = await supabase.from('teacher_worksheet_shares').upsert(
    { worksheet_id: worksheetId, shared_by: sharedBy, shared_with: sharedWith, shared_at: new Date().toISOString() },
    { onConflict: 'worksheet_id,shared_with' },
  );
  if (error) throw error;
}

module.exports = { listMine, create, update, getRow, openFor, listSharedWith, schoolTeachers, getUser, upsertShare };
