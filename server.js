const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Read .env file
const envPath = path.join(__dirname, '.env');
const envVars = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (match) envVars[match[1]] = match[2].trim();
  });
}

const API_KEY = envVars.GEMINI_API_KEY || '';
const TWILIO_SID = envVars.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = envVars.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP = envVars.TWILIO_WHATSAPP_NUMBER || '';

if (!API_KEY || API_KEY === 'your-key-here') {
  console.error('ERROR: Set your GEMINI_API_KEY in the .env file');
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

// Inject the API key as a global variable right after <head>
const injected = html.replace(
  '<head>',
  `<head>\n  <script>window.AEGIS_API_KEY="${API_KEY}";</script>`
);

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

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Aegis running at http://localhost:${PORT}`);
  loadSchedules();
  console.log('');
});
