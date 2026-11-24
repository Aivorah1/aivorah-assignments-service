process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-fake-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-fake-key';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-fake-key';
// Tests pin the Gemini model list themselves; the built-in extra models are
// covered by their own test (tests/unit/geminiModelFallback.test.js).
process.env.GEMINI_EXTRA_MODELS = process.env.GEMINI_EXTRA_MODELS ?? '';
