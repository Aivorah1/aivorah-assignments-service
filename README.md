# Aivorah Assignments Service

Standalone microservice for the **student-facing** Assignments flow — list,
quiz submission/grading, scaffolded task-step grading, worksheet-image
grading, quiz generation, and fill-blank validation — extracted from
`ai-mentor/server/routes/assignments.js`.

## Structure

```
routes/
  assignments.js   — the 6 student-facing endpoints (see below)
  worksheets.js    — Prepare Worksheet documents and sharing (see below)
services/
  supabase.js       — Supabase client
  embeddings.js      — local embedding model (Xenova/all-MiniLM-L6-v2)
  qdrant.js          — Qdrant client + textbook-grounding search
utils/
  quizHtmlRenderer.js — renderQuizHTML + its 4 direct helpers, copied
                        verbatim from ai-mentor/server/routes/quiz.js
                        (confirmed zero further requires — doesn't drag
                        in quiz.js's teacher-side generation pipeline)
```

## Why only 6 of the original 19 endpoints

`assignments.js` (3490 lines) mixes teacher-authoring endpoints (AI-generate,
generate-steps, generate-ibpyp, docx-to-pdf, extract-questions(-async), detect-meta,
pdf-to-quiz, upload-doc, `POST /`, `GET /:id/submissions`,
`PUT /:id/teacher-feedback`, `DELETE /:id`) with student-completion
endpoints. The teacher-side ones depend on `routes/quiz.js`'s generation
pipeline — Cloudinary, Gemini, puppeteer/mammoth doc conversion, the
vision-based upload-grading wizard — a much heavier and differently-shaped
dependency set than anything a student needs. Those stayed in the monolith.

The one student-facing exception that reaches into `quiz.js`: `GET /`
calls `normalise()`, which live-regenerates each assignment's interactive
quiz HTML via `renderQuizHTML` on every read (so template fixes propagate to
already-created assignments instead of only new ones). `renderQuizHTML` and
its 4 direct helpers were verified to have **zero further `require()`
calls** of their own, so copying them into `utils/quizHtmlRenderer.js` does
not pull in any of `quiz.js`'s teacher-side dependencies.

`GET /` still supports the `?teacherId=` query branch too (same handler the
not-yet-extracted teacher list also uses) — kept verbatim rather than split,
so the two callers can't silently drift apart.

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3015`).

## Endpoints

- `GET /assignments?studentId=` (or `?teacherId=`) — a student's (or
  teacher's) assignment list, merged with their own submission status/score.
- `POST /assignments/generate-quiz` — Qdrant-grounded MCQ/fill-blank/mixed
  quiz generation, with a deterministic offline fallback bank.
- `POST /assignments/:id/submit` — grades a submission (quiz answers,
  scaffolded task-step answers, worksheet text answers, or worksheet
  images) via Groq, records the result.
- `PUT /assignments/:id/complete` — records completion for the
  interactive-quiz (iframe) flow.
- `POST /assignments/:id/explain-question` — step-by-step AI explanation
  for a question the student got wrong.
- `POST /assignments/validate-fill-blank` — fuzzy-tolerant fill-blank
  answer validation (exact/numeric/decimal-equivalence/Levenshtein).
- `GET /assignments/library`, `GET /assignments/library/:id`,
  `DELETE /assignments/library/:id` — the signed-in teacher's **private
  assignment library** (table `teacher_assignment_library`, aivorah-db 0021).
  Every assignment a teacher creates via `POST /assignments` is kept there
  (one row per distinct content; the same content again bumps
  `times_assigned`). To assign an item again, the app POSTs its `content` to
  `/assignments` with a new `dueDate` / `studentId`. These routes need
  `Authorization: Bearer <Firebase ID token>`; the teacher is taken from the
  token, never from the request. Requires `FIREBASE_SERVICE_ACCOUNT_B64`
  (same value as the other services).
- `/worksheets` — **Prepare Worksheet** (Teacher Portal > Assignments > + New >
  Prepare Worksheet, and Library > Shared to you; tables `teacher_worksheets`
  and `teacher_worksheet_shares`, aivorah-db 0025). Same sign-in as the
  library (Bearer Firebase token; the teacher comes from the token).
  - `GET /worksheets`, `POST /worksheets` `{ title, html }` — my documents / save a new one.
  - `GET /worksheets/:id`, `PUT /worksheets/:id` `{ title?, html? }` — open (mine,
    or shared with me) / save again (owner only).
  - `GET /worksheets/teachers` — the other teachers of my school (Share box).
  - `POST /worksheets/:id/share` `{ teacherId }` — owner only, to a teacher of the
    same school only (checked here).
  - `GET /worksheets/shared` — documents shared with me by teachers of my school.
  - `GET /worksheets/:id/docx` — `{ fileName, mimeType, base64 }`, the Word file
    for Download and for Assign (the app feeds it to the Upload Worksheet flow:
    `docx-to-pdf`, `upload-doc`, `extract-questions-async`).
  Saved HTML is cleaned (`services/worksheetHtml.js`: no scripts, handlers or
  frames); pasted images are moved to Cloudinary on save; images from other
  websites are fetched (public addresses only) and embedded in the .docx.
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
