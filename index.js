require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Vercel's proxy so express-rate-limit can read X-Forwarded-For
app.set('trust proxy', 1);

// Suppress favicon requests (returns 204 No Content)
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.url}`);
  next();
});

const REQUIRED_ENV_VARS = [
  ['SUPABASE_URL', process.env.SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
  ['OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY],
];

let envOk = true;
for (const [name, value] of REQUIRED_ENV_VARS) {
  if (!value) {
    console.error(`CRITICAL: Missing Server Env Variable — ${name} is not set.`);
    envOk = false;
  }
}

let supabaseAdmin;
if (envOk) {
  try {
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  } catch (err) {
    console.error('CRITICAL: Failed to create Supabase client:', err.message);
    envOk = false;
  }
} else {
  console.error('CRITICAL: Server starting with missing environment variables. Configure .env file.');
}

app.use(express.json());

// CORS Configuration
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000'
)
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin "${origin}" not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

app.use('/api/', apiLimiter);

// Health Check Endpoints
app.get(['/', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'Pulse Backend API',
    timestamp: new Date().toISOString(),
    envOk,
  });
});

// Fallback AI Models for OpenRouter to ensure high availability
// All models are free-tier on OpenRouter
const FALLBACK_AI_MODELS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-20b:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-26b-a4b-it:free',
  'inclusionai/ling-3.0-flash:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
];


app.post('/api/generate-update', async (req, res) => {
  if (!envOk || !supabaseAdmin) {
    return res.status(500).json({ error: 'Backend configuration error. Check server environment variables.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Missing or invalid token.' });
  }

  const token = authHeader.split(' ')[1];
  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
  }

  const { boardText, today } = req.body;
  if (!boardText || !today) {
    return res.status(400).json({ error: 'Missing required fields: boardText and today.' });
  }

  const prompt = `You are an experienced chief of staff writing a concise, stakeholder-ready status update from a project's task board.

Today's date: ${today}

Board:
${boardText}

Reason about status labels, due dates, blockers, and notes. Not every Blocked task is necessarily "at risk" if it has a comfortable due date; not every overdue task is a crisis if it's nearly done. Use sharp judgment.

Respond with ONLY valid JSON and nothing else — no markdown, no code fences — matching exactly this shape:
{"summary": "2-3 sentence stakeholder-ready narrative paragraph on overall project health", "shipped": ["short clause per completed task"], "inProgress": ["short clause per in-progress task noting where it stands"], "atRisk": [{"title": "task title", "reasoning": "one sentence on why this is genuinely at risk"}]}`;

  let lastError = null;

  for (const model of FALLBACK_AI_MODELS) {
    try {
      console.log(`[AI Request] Attempting status generation with model: ${model}`);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': allowedOrigins[0] || 'http://localhost:5173',
          'X-Title': 'Pulse - AI Status & Risk Assistant',
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`OpenRouter API error with model ${model}:`, response.status, errText);
        lastError = `Model ${model} returned ${response.status}`;
        continue; // Try next model
      }

      const data = await response.json();
      if (data.error) {
        console.warn(`OpenRouter response error with model ${model}:`, data.error);
        lastError = data.error.message || `Model ${model} error`;
        continue; // Try next model
      }

      const textBlocks = (data.choices || []).map((c) => c.message?.content || '').join('\n');
      if (!textBlocks.trim()) {
        lastError = `Model ${model} returned empty content`;
        continue;
      }

      const startIdx = textBlocks.indexOf('{');
      const endIdx = textBlocks.lastIndexOf('}');
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        lastError = `Model ${model} returned invalid JSON`;
        continue;
      }

      const parsed = JSON.parse(textBlocks.slice(startIdx, endIdx + 1).trim());
      return res.json(parsed);
    } catch (err) {
      console.error(`Error trying model ${model}:`, err.message);
      lastError = err.message;
    }
  }

  return res.status(500).json({ error: `AI service temporarily unavailable. (${lastError})` });
});

// Start listener for standalone node process
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pulse backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;