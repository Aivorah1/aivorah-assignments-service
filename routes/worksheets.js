/**
 * /worksheets - Prepare Worksheet (Teacher Portal > Assignments > + New >
 * Prepare Worksheet, and Library > Shared to you). Who the teacher is comes
 * from their sign-in token (middleware/requireTeacher.js), never from the
 * request; services/teacherWorksheets.js only returns what they may see.
 *
 *   GET  /worksheets               -> { items }      my documents, last modified first
 *   POST /worksheets               -> { item }       save a new document { title, html }
 *   GET  /worksheets/shared        -> { items }      shared with me by teachers of my school
 *   GET  /worksheets/teachers      -> { teachers }   my school's other teachers (Share box)
 *   GET  /worksheets/:id           -> { item }       open (mine, or shared with me)
 *   PUT  /worksheets/:id           -> { item }       save again (owner only) { title?, html? }
 *   POST /worksheets/:id/share     -> { sharedWith } owner only { teacherId } (same school only)
 *   GET  /worksheets/:id/docx      -> { fileName, mimeType, base64 }  for Download and Assign
 */
const express = require('express');
const cloudinary = require('cloudinary').v2;
const { requireTeacher } = require('../middleware/requireTeacher');
const store = require('../services/teacherWorksheets');
const html = require('../services/worksheetHtml');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

router.use(requireTeacher);

function fail(res, where, err, message) {
  console.error(`[${where}]`, err.message);
  return res.status(500).json({ error: message });
}

async function uploadImage(dataUri) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: 'ai_mentor/worksheet_images',
    public_id: `prepared_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    resource_type: 'image',
  });
  return result.secure_url;
}

// Clean what the editor sent, then move pasted data: images to Cloudinary.
async function prepareHtml(raw) {
  return html.hostDataImages(html.sanitizeWorksheetHtml(raw), uploadImage);
}

router.get('/', async (req, res) => {
  try {
    res.json({ items: await store.listMine(req.user.id) });
  } catch (err) {
    fail(res, 'GET /worksheets', err, 'Could not load your documents');
  }
});

router.post('/', async (req, res) => {
  const problem = html.validateWorksheet({ title: req.body?.title, html: req.body?.html ?? '' });
  if (problem) return res.status(400).json({ error: problem });
  try {
    const item = await store.create(req.user, {
      title: html.normalizeTitle(req.body.title),
      html: await prepareHtml(req.body.html ?? ''),
    });
    res.status(201).json({ item });
  } catch (err) {
    fail(res, 'POST /worksheets', err, 'Could not save this document');
  }
});

router.get('/shared', async (req, res) => {
  try {
    res.json({ items: await store.listSharedWith(req.user) });
  } catch (err) {
    fail(res, 'GET /worksheets/shared', err, 'Could not load documents shared with you');
  }
});

router.get('/teachers', async (req, res) => {
  try {
    res.json({ teachers: await store.schoolTeachers(req.user) });
  } catch (err) {
    fail(res, 'GET /worksheets/teachers', err, 'Could not load the teachers of your school');
  }
});

router.get('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
  try {
    const found = await store.openFor(req.user, req.params.id);
    if (!found) return res.status(404).json({ error: 'Document not found' });
    const { doc } = found;
    res.json({
      item: {
        id: doc.id, title: doc.title, html: doc.content_html, created_at: doc.created_at, updated_at: doc.updated_at,
        isOwner: found.isOwner,
        sharedBy: found.isOwner ? null : found.sharedBy, sharedAt: found.isOwner ? null : found.sharedAt,
      },
    });
  } catch (err) {
    fail(res, 'GET /worksheets/:id', err, 'Could not open this document');
  }
});

router.put('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
  const { title, html: body } = req.body || {};
  if (title === undefined && body === undefined) return res.status(400).json({ error: 'Nothing to save' });
  const problem = html.validateWorksheet({ title, html: body }, { requireTitle: false });
  if (problem) return res.status(400).json({ error: problem });
  try {
    const item = await store.update(req.user.id, req.params.id, {
      title: title === undefined ? undefined : html.normalizeTitle(title),
      html: body === undefined ? undefined : await prepareHtml(body),
    });
    // Not found and "someone else's" look the same: no hint that the id exists.
    if (!item) return res.status(404).json({ error: 'Document not found' });
    res.json({ item });
  } catch (err) {
    fail(res, 'PUT /worksheets/:id', err, 'Could not save this document');
  }
});

router.post('/:id/share', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
  const teacherId = String(req.body?.teacherId || '');
  if (!UUID.test(teacherId)) return res.status(400).json({ error: 'Choose a teacher to share with' });
  try {
    const doc = await store.getRow(req.params.id);
    if (!doc || doc.owner_id !== req.user.id) return res.status(404).json({ error: 'Document not found' });
    if (!req.user.school_id) return res.status(403).json({ error: 'Your account is not linked to a school' });
    if (teacherId === req.user.id) return res.status(400).json({ error: 'You cannot share a document with yourself' });
    const to = await store.getUser(teacherId);
    if (!to || to.role !== 'teacher' || to.status === 'archived' || to.school_id !== req.user.school_id) {
      return res.status(403).json({ error: 'You can only share with teachers of your school' });
    }
    await store.upsertShare(doc.id, req.user.id, to.id);
    res.json({ sharedWith: { id: to.id, name: String(to.name || to.email || '').trim(), email: String(to.email || '').toLowerCase() } });
  } catch (err) {
    fail(res, 'POST /worksheets/:id/share', err, 'Could not share this document');
  }
});

router.get('/:id/docx', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Document not found' });
  try {
    const found = await store.openFor(req.user, req.params.id);
    if (!found) return res.status(404).json({ error: 'Document not found' });
    const buffer = await html.worksheetDocx({ title: found.doc.title, html: found.doc.content_html });
    res.json({ fileName: html.docxFileName(found.doc.title), mimeType: DOCX_MIME, base64: buffer.toString('base64') });
  } catch (err) {
    fail(res, 'GET /worksheets/:id/docx', err, 'Could not create the Word file');
  }
});

module.exports = router;
