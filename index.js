require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

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
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
} else {
  console.error('CRITICAL: Server cannot start — one or more required environment variables are missing.');
}

app.use(express.json());

// ✅ FIX 1: CORS now reads from env var instead of hardcoded localhost
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin "${origin}" not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

app.use('/api/', apiLimiter);

app.post('/api/generate-update', async (req, res) => {
  console.log('OPENROUTER_API_KEY exists:', !!process.env.OPENROUTER_API_KEY);
  console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
  console.log('SUPABASE_SERVICE_ROLE_KEY exists:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!envOk || !supabaseAdmin) {
    return res.status(500).json({ error: 'Backend configuration error.' });
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

Reason about more than status labels and due dates alone — weigh whether blockers or notes make a task more urgent than its due date suggests, and whether dates have already passed. Not every Blocked task is necessarily "at risk" if it has a comfortable due date and no concerning note; not every overdue task is a crisis if it's nearly done. Use judgment, the way a sharp chief of staff would.

Respond with ONLY valid JSON and nothing else — no markdown, no code fences — matching exactly this shape:
{"summary": "2-3 sentence stakeholder-ready narrative paragraph on overall project health", "shipped": ["short clause per completed task"], "inProgress": ["short clause per in-progress task noting where it stands"], "atRisk": [{"title": "task title", "reasoning": "one sentence on why this is genuinely at risk"}]}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': allowedOrigins[0] || 'http://localhost:5173',
        'X-Title': 'Pulse - AI Status & Risk Assistant',
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter API error:', response.status, errText);
      return res.status(500).json({ error: 'AI service temporarily unavailable.' });
    }

    const data = await response.json();
    if (data.error) {
      console.error('OpenRouter error:', data.error);
      return res.status(500).json({ error: 'AI service temporarily unavailable.' });
    }

    const textBlocks = (data.choices || []).map((c) => c.message?.content || '').join('\n');
    if (!textBlocks.trim()) {
      return res.status(500).json({ error: 'AI returned an empty response.' });
    }

    const startIdx = textBlocks.indexOf('{');
    const endIdx = textBlocks.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      return res.status(500).json({ error: 'AI response was malformed.' });
    }

    const parsed = JSON.parse(textBlocks.slice(startIdx, endIdx + 1).trim());
    res.json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ✅ FIX 2: keep app.listen for local dev AND export for Vercel serverless
app.listen(PORT, () => {
  console.log(`Pulse backend running on http://localhost:${PORT}`);
});

module.exports = app;