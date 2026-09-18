const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Load .env for local development only. Platforms like Railway inject variables
// directly into process.env — no .env file exists in that container at all — so
// this must merge into process.env rather than read into a separate object, and
// must never overwrite a value the platform already set.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim();
    }
  });
}

const API_KEY = process.env.GEMINI_API_KEY || '';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
// Which provider actually serves scan/chat/schedule requests. Configurable because
// we've hit provider-specific problems more than once (a deprecated Gemini model, a
// Gemini free-tier daily quota) — switching should be a .env edit, not a code change.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP = process.env.TWILIO_WHATSAPP_NUMBER || '';

if (AI_PROVIDER === 'grok') {
  if (!GROK_API_KEY || GROK_API_KEY === 'your-grok-key-here') {
    console.error('ERROR: AI_PROVIDER=grok but GROK_API_KEY is not set in the .env file');
    process.exit(1);
  }
} else if (!API_KEY || API_KEY === 'your-key-here') {
  console.error('ERROR: Set your GEMINI_API_KEY in the .env file (or set AI_PROVIDER=grok and GROK_API_KEY)');
  process.exit(1);
}

// Twilio client (lazy init)
let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!TWILIO_SID || TWILIO_SID === 'your_account_sid_here') return null;
  if (!TWILIO_TOKEN || TWILIO_TOKEN === 'your_auth_token_here') return null;
  try {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
    return twilioClient;
  } catch (err) {
    console.warn('Twilio init failed:', err.message);
    return null;
  }
}

// Scheduled jobs storage
const SCHEDULE_FILE = path.join(__dirname, 'scheduled-reminders.json');
let scheduledJobs = [];

function loadSchedules() {
  if (fs.existsSync(SCHEDULE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
      scheduledJobs = data;
      registerAllJobs();
      console.log(`  Loaded ${scheduledJobs.length} saved schedule(s)`);
    } catch (err) {
      console.warn('Failed to load schedules:', err.message);
      scheduledJobs = [];
    }
  }
}

function saveSchedules() {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduledJobs, null, 2));
}

function registerAllJobs() {
  scheduledJobs.forEach(schedule => {
    if (schedule.cancelled) return;
    registerCronJobs(schedule);
  });
}

function registerCronJobs(schedule) {
  schedule.slots.forEach((slot, idx) => {
    const [h, m] = (slot.time || '08:00').split(':').map(Number);
    const cronExpr = `${m} ${h} * * *`;
    const jobId = `${schedule.id}_${idx}`;

    if (cron.validate(cronExpr)) {
      const job = cron.schedule(cronExpr, () => {
        sendWhatsAppReminder(schedule.phoneNumber, slot, schedule.id);
      });
      schedule._jobs = schedule._jobs || {};
      schedule._jobs[jobId] = job;
      console.log(`  Cron registered: ${cronExpr} -> ${schedule.phoneNumber} (${slot.label || slot.period})`);
    }
  });
}

async function sendWhatsAppReminder(phoneNumber, slot, scheduleId) {
  const client = getTwilioClient();
  if (!client) {
    console.warn('Twilio not configured — skipping WhatsApp send');
    return;
  }

  const medLines = slot.medications.map(med => {
    let line = `- ${med.name}`;
    if (med.dosage) line += ` ${med.dosage}`;
    if (med.instruction) line += ` (${med.instruction})`;
    return line;
  }).join('\n');

  const body = `Aegis Reminder\n\nTime to take your medication:\n${medLines}\n\nStay healthy!`;

  try {
    await client.messages.create({
      from: TWILIO_WHATSAPP,
      to: `whatsapp:${phoneNumber}`,
      body: body
    });
    console.log(`  WhatsApp sent to ${phoneNumber} for ${slot.label || slot.period}`);
  } catch (err) {
    console.error(`  WhatsApp send failed to ${phoneNumber}:`, err.message);
  }
}

// Read HTML
const htmlPath = path.join(__dirname, 'aegis-preview.html');
let html = fs.readFileSync(htmlPath, 'utf-8');

// Reuse the exact reference drug dataset built for the medicine-validator Skill
// (Assessment 2) instead of duplicating it — single source of truth.
const REFERENCE_DRUGS_PATH = path.join(__dirname, '.claude', 'skills', 'medicine-validator', 'reference-drugs.json');
let referenceDrugsJson = '[]';
try {
  referenceDrugsJson = fs.readFileSync(REFERENCE_DRUGS_PATH, 'utf-8').trim();
} catch (err) {
  console.warn('  Could not load reference-drugs.json, prescription validation will be skipped:', err.message);
}

// NOTE: the real GEMINI_API_KEY is intentionally NOT injected into the page here.
// It never leaves this process — the browser calls POST /api/gemini instead, and
// this server makes the actual Gemini call. window.AEGIS_API_KEY is just a
// non-secret "is the app ready" flag the client already checks before scanning.
const injected = html.replace(
  '<head>',
  `<head>\n  <script>window.AEGIS_API_KEY="server-configured";window.AEGIS_REFERENCE_DRUGS=${referenceDrugsJson};</script>`
);

const AI_MODEL = 'gemini-3.6-flash';

// Gemini's vision endpoint is observed to fail intermittently with 503 "high demand"
// even when the service is otherwise healthy — retrying a couple of times with
// backoff clears most of these transient failures instead of surfacing them to the user.
const GEMINI_MAX_RETRIES = 2;
const GEMINI_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiServerSide(systemPrompt, contents, temperature, overrideKey) {
  const effectiveKey = overrideKey || API_KEY;
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${effectiveKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: contents,
            generationConfig: { temperature: temperature }
          })
        }
      );
    } catch (networkErr) {
      // fetch itself threw (e.g. connection reset) — treat like a retryable failure.
      if (attempt === GEMINI_MAX_RETRIES) throw new Error(`Gemini request failed: ${networkErr.message}`);
      console.warn(`  Gemini network error, retrying (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES}): ${networkErr.message}`);
      await delay(500 * Math.pow(2, attempt));
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('');
    }

    const errBody = await response.text();
    const isRetryable = GEMINI_RETRYABLE_STATUSES.has(response.status);
    if (!isRetryable || attempt === GEMINI_MAX_RETRIES) {
      throw new Error(`Gemini API error ${response.status}: ${errBody}`);
    }

    console.warn(`  Gemini call got ${response.status}, retrying (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES})...`);
    await delay(500 * Math.pow(2, attempt));
  }
}

const GROK_MODEL = 'grok-4.6';
const GROK_MAX_RETRIES = 2;
const GROK_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// The client always builds `contents` in Gemini's shape (role + parts, with
// inline_data for images) regardless of which provider is actually serving the
// request — this converts it to OpenAI-style messages for Grok's API, so nothing
// in aegis-preview.html needs to know or care which provider is active.
function geminiContentsToOpenAiMessages(contents) {
  return contents.map(c => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: c.parts.map(p => {
      if (p.text != null) return { type: 'text', text: p.text };
      if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
      return null;
    }).filter(Boolean)
  }));
}

async function callGrokServerSide(systemPrompt, contents, temperature, overrideKey) {
  const effectiveKey = overrideKey || GROK_API_KEY;
  const messages = [{ role: 'system', content: systemPrompt }, ...geminiContentsToOpenAiMessages(contents)];

  for (let attempt = 0; attempt <= GROK_MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveKey}`
        },
        body: JSON.stringify({ model: GROK_MODEL, messages, temperature })
      });
    } catch (networkErr) {
      if (attempt === GROK_MAX_RETRIES) throw new Error(`Grok request failed: ${networkErr.message}`);
      console.warn(`  Grok network error, retrying (attempt ${attempt + 1}/${GROK_MAX_RETRIES}): ${networkErr.message}`);
      await delay(500 * Math.pow(2, attempt));
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }

    const errBody = await response.text();
    const isRetryable = GROK_RETRYABLE_STATUSES.has(response.status);
    if (!isRetryable || attempt === GROK_MAX_RETRIES) {
      throw new Error(`Grok API error ${response.status}: ${errBody}`);
    }

    console.warn(`  Grok call got ${response.status}, retrying (attempt ${attempt + 1}/${GROK_MAX_RETRIES})...`);
    await delay(500 * Math.pow(2, attempt));
  }
}

async function callAIServerSide(systemPrompt, contents, temperature, overrideKey) {
  // A tester-supplied key always means "use it with whichever provider is
  // currently configured" — we don't ask the client to know or care about that.
  return AI_PROVIDER === 'grok'
    ? callGrokServerSide(systemPrompt, contents, temperature, overrideKey)
    : callGeminiServerSide(systemPrompt, contents, temperature, overrideKey);
}

// Parse JSON body helper
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // API: Proxy AI calls — keeps GEMINI_API_KEY/GROK_API_KEY server-side only, never
  // sent to the browser. Route name kept as /api/gemini for compatibility with the
  // existing client; which provider actually handles it is chosen by AI_PROVIDER.
  if (req.method === 'POST' && req.url === '/api/gemini') {
    try {
      const { systemPrompt, contents, temperature, userApiKey } = await parseBody(req);
      if (!systemPrompt || !Array.isArray(contents)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'systemPrompt and contents are required' }));
        return;
      }
      // userApiKey is optional and tester-supplied (bring-your-own-key from the
      // frontend) — used only for this one call, never logged or persisted.
      const text = await callAIServerSide(systemPrompt, contents, temperature ?? 0.3, userApiKey || null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      console.error(`${AI_PROVIDER} proxy error:`, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Schedule reminders
  if (req.method === 'POST' && req.url === '/api/schedule') {
    try {
      const { slots, phoneNumber } = await parseBody(req);

      if (!slots || !Array.isArray(slots) || slots.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No schedule slots provided' }));
        return;
      }

      if (!phoneNumber || !phoneNumber.match(/^\+\d{7,15}$/)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid phone number. Use format: +91XXXXXXXXXX' }));
        return;
      }

      const client = getTwilioClient();
      if (!client) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Twilio not configured. Set credentials in .env file.' }));
        return;
      }

      const scheduleId = 'sched_' + Date.now();
      const schedule = {
        id: scheduleId,
        slots: slots,
        phoneNumber: phoneNumber,
        createdAt: new Date().toISOString(),
        cancelled: false
      };

      // Register cron jobs
      registerCronJobs(schedule);

      scheduledJobs.push(schedule);
      saveSchedules();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        scheduleId: scheduleId,
        message: `Reminders scheduled for ${phoneNumber}. ${slots.length} time slot(s) registered.`
      }));
    } catch (err) {
      console.error('Schedule API error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // API: Cancel scheduled reminders
  if (req.method === 'POST' && req.url === '/api/schedule/cancel') {
    try {
      const { scheduleId } = await parseBody(req);

      const schedule = scheduledJobs.find(s => s.id === scheduleId);
      if (!schedule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Schedule not found' }));
        return;
      }

      // Stop all cron jobs for this schedule
      if (schedule._jobs) {
        Object.values(schedule._jobs).forEach(job => job.stop());
      }
      schedule.cancelled = true;
      saveSchedules();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Schedule cancelled' }));
    } catch (err) {
      console.error('Cancel API error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // API: Get scheduled reminders
  if (req.method === 'GET' && req.url === '/api/schedule') {
    const active = scheduledJobs.filter(s => !s.cancelled).map(s => ({
      id: s.id,
      slots: s.slots,
      phoneNumber: s.phoneNumber,
      createdAt: s.createdAt
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ schedules: active }));
    return;
  }

  // Serve HTML
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(injected);
});

// Railway (and most PaaS hosts) assign the port via env var and route traffic to it —
// the app must bind to that, not a hardcoded port.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Aegis running at http://localhost:${PORT}`);
  loadSchedules();
  console.log('');
});
