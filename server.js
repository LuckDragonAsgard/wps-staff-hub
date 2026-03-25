// WPS Staff Hub - Production Server (sql.js version)
require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wps-dev-secret-change-me';
const LIVE = process.env.NOTIFICATIONS_LIVE === 'true';
const DEMO = process.env.DEMO_MODE !== 'false'; // Demo auto-confirm ON by default

// ===== DATABASE =====
const DB_PATH = path.join(__dirname, 'wps-absence.db');
let db = null;

// sql.js helper functions to match the old better-sqlite3 API patterns
function dbRun(sql, params) {
  db.run(sql, params || []);
  saveDb();
}

function dbGet(sql, ...params) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, ...params) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbLastId() {
  return dbGet('SELECT last_insert_rowid() as id').id;
}

// Debounced save - writes to disk at most every 500ms
let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 500);
}

// Force immediate save (for shutdown)
function saveDbNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

// ===== NOTIFICATION SERVICES =====
let twilio = null;
let sgMail = null;

if (LIVE) {
  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH) {
      twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      console.log('Twilio SMS enabled');
    }
  } catch (e) { console.log('Twilio not configured:', e.message); }

  try {
    if (process.env.SENDGRID_KEY) {
      sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_KEY);
      console.log('SendGrid email enabled');
    }
  } catch (e) { console.log('SendGrid not configured:', e.message); }
}

async function sendSMS(to, message) {
  dbRun('INSERT INTO sms_log (to_phone, message, status) VALUES (?, ?, ?)', [to, message, LIVE ? 'sending' : 'simulated']);
  if (!LIVE || !twilio) {
    console.log(`[SMS SIM] To: ${to} | ${message}`);
    return { status: 'simulated' };
  }
  try {
    const result = await twilio.messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to: to.startsWith('+') ? to : '+61' + to.replace(/^0/, '').replace(/\s/g, ''),
    });
    dbRun('UPDATE sms_log SET status = ?, twilio_sid = ? WHERE id = (SELECT MAX(id) FROM sms_log WHERE to_phone = ?)', [
      'sent', result.sid, to
    ]);
    return { status: 'sent', sid: result.sid };
  } catch (err) {
    dbRun('UPDATE sms_log SET status = ? WHERE id = (SELECT MAX(id) FROM sms_log WHERE to_phone = ?)', [
      'failed: ' + err.message, to
    ]);
    console.error(`[SMS FAIL] ${to}: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

async function sendEmail(to, subject, html) {
  dbRun('INSERT INTO email_log (to_email, subject, body, status) VALUES (?, ?, ?, ?)', [to, subject, html, LIVE ? 'sending' : 'simulated']);
  if (!LIVE || !sgMail) {
    console.log(`[EMAIL SIM] To: ${to} | ${subject}`);
    return { status: 'simulated' };
  }
  try {
    await sgMail.send({ to, from: process.env.SENDGRID_FROM, subject, html });
    dbRun('UPDATE email_log SET status = ? WHERE id = (SELECT MAX(id) FROM email_log WHERE to_email = ?)', ['sent', to]);
    return { status: 'sent' };
  } catch (err) {
    dbRun('UPDATE email_log SET status = ? WHERE id = (SELECT MAX(id) FROM email_log WHERE to_email = ?)', [
      'failed: ' + err.message, to
    ]);
    console.error(`[EMAIL FAIL] ${to}: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Async error wrapper
function wrap(fn) {
  return function(req, res, next) {
    fn(req, res, next).catch(function(err) {
      console.error('Route error:', err);
      res.status(500).json({ error: 'Server error' });
    });
  };
}

// Simple rate limiter for login (max 10 attempts per IP per minute)
const loginAttempts = {};
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 60000);
  if (loginAttempts[ip].length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  loginAttempts[ip].push(now);
  next();
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Session expired. Please log in again.' }); }
}

function leaderOnly(req, res, next) {
  if (req.user.role !== 'leader' && req.user.role !== 'admin') return res.status(403).json({ error: 'Leaders only' });
  next();
}

function addNotification(message, type, forRoles, absenceId) {
  dbRun('INSERT INTO notifications (message, type, for_roles, related_absence_id) VALUES (?, ?, ?, ?)', [
    message, type || 'info', forRoles || 'leader', absenceId || null
  ]);
}

// ===== AUTH ENDPOINTS =====
app.post('/api/login', rateLimit, (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  const user = dbGet('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!bcrypt.compareSync(pin, user.pin_hash)) return res.status(401).json({ error: 'Wrong PIN' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, area: user.area }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, area: user.area, email: user.email, phone: user.phone } });
});

app.post('/api/login/crt', rateLimit, (req, res) => {
  const { crtId, pin } = req.body;
  const crt = dbGet('SELECT * FROM crts WHERE id = ? AND active = 1', crtId);
  if (!crt) return res.status(401).json({ error: 'CRT not found' });
  if (crt.pin_hash && pin) {
    if (!bcrypt.compareSync(pin, crt.pin_hash)) return res.status(401).json({ error: 'Wrong PIN' });
  }
  const token = jwt.sign({ id: crt.id, name: crt.name, role: 'crt', isCrt: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: crt.id, name: crt.name, role: 'crt', phone: crt.phone, email: crt.email, specialties: JSON.parse(crt.specialties || '[]') } });
});

// ===== USER ENDPOINTS =====
app.get('/api/users', (req, res) => {
  const users = dbAll('SELECT id, name, role, area FROM users WHERE active = 1');
  res.json(users);
});

// ===== CRT ENDPOINTS =====
app.get('/api/crts', (req, res) => {
  const crts = dbAll('SELECT id, name, phone, email, specialties, active FROM crts WHERE active = 1');
  res.json(crts.map(c => ({ ...c, specialties: JSON.parse(c.specialties || '[]') })));
});

app.get('/api/crts/:id/unavailable', auth, (req, res) => {
  const dates = dbAll('SELECT date, reason FROM crt_unavailable WHERE crt_id = ? AND date >= date("now")', parseInt(req.params.id));
  res.json(dates);
});

app.post('/api/crts/:id/unavailable', auth, (req, res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  try {
    dbRun('INSERT OR REPLACE INTO crt_unavailable (crt_id, date, reason) VALUES (?, ?, ?)', [parseInt(req.params.id), date, reason || null]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/crts/:id/unavailable/:date', auth, (req, res) => {
  dbRun('DELETE FROM crt_unavailable WHERE crt_id = ? AND date = ?', [parseInt(req.params.id), req.params.date]);
  res.json({ ok: true });
});

// ===== PREFERENCES ENDPOINTS =====
app.get('/api/preferences', (req, res) => {
  const prefs = dbAll(`
    SELECT cp.area, cp.crt_id, cp.priority, c.name as crt_name, c.specialties, c.phone
    FROM crt_preferences cp JOIN crts c ON cp.crt_id = c.id
    WHERE c.active = 1 ORDER BY cp.area, cp.priority
  `);
  const grouped = {};
  prefs.forEach(p => {
    if (!grouped[p.area]) grouped[p.area] = [];
    grouped[p.area].push({ ...p, specialties: JSON.parse(p.specialties || '[]') });
  });
  res.json(grouped);
});

app.put('/api/preferences/:area', auth, leaderOnly, (req, res) => {
  const area = decodeURIComponent(req.params.area);
  const { crtIds } = req.body;
  if (!Array.isArray(crtIds)) return res.status(400).json({ error: 'crtIds must be an array' });
  db.run('BEGIN TRANSACTION');
  try {
    dbRun('DELETE FROM crt_preferences WHERE area = ?', [area]);
    crtIds.forEach((crtId, idx) => {
      dbRun('INSERT INTO crt_preferences (area, crt_id, priority, set_by) VALUES (?, ?, ?, ?)', [area, crtId, idx + 1, req.user.id]);
    });
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true });
});

// ===== ABSENCE ENDPOINTS =====
app.get('/api/absences', auth, (req, res) => {
  const { date, staffId, limit, status } = req.query;
  let sql = 'SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE 1=1';
  const params = [];
  if (date) { sql += ' AND a.date_start <= ? AND a.date_end >= ?'; params.push(date, date); }
  if (staffId) { sql += ' AND a.staff_id = ?'; params.push(parseInt(staffId)); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += " AND a.status != 'cancelled'";
  sql += ' ORDER BY a.submitted_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
  res.json(dbAll(sql, ...params));
});

app.get('/api/absences/month/:year/:month', auth, (req, res) => {
  const y = parseInt(req.params.year);
  const m = parseInt(req.params.month);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const absences = dbAll(
    "SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start < ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.date_start",
    end, start
  );
  res.json(absences);
});

app.post('/api/absences', auth, wrap(async (req, res) => {
  const { dateStart, dateEnd, reason, classes, notes, halfDay } = req.body;
  const u = req.user;
  if (!dateStart || !reason) return res.status(400).json({ error: 'Date and reason required' });

  const recent = dbGet("SELECT 1 as found FROM absences WHERE staff_id = ? AND date_start = ? AND submitted_at > datetime('now', '-60 seconds') AND status != 'cancelled'", u.id, dateStart);
  if (recent) return res.status(409).json({ error: 'Absence already submitted for this date' });

  dbRun(
    'INSERT INTO absences (staff_id, staff_name, area, date_start, date_end, reason, classes, notes, half_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [u.id, u.name, u.area, dateStart, dateEnd || dateStart, reason, classes || '', notes || '', halfDay || 'full']
  );

  const absenceId = dbLastId();
  const absence = dbGet('SELECT * FROM absences WHERE id = ?', absenceId);
  const halfLabel = halfDay === 'am' ? ' (AM only)' : halfDay === 'pm' ? ' (PM only)' : '';

  addNotification(`New absence: ${u.name} (${u.area}) \u2013 ${reason}${halfLabel}`, 'urgent', 'leader', absenceId);

  const leaders = dbAll("SELECT * FROM users WHERE role = 'leader' AND active = 1");
  for (const leader of leaders) {
    if (leader.phone) {
      await sendSMS(leader.phone, `WPS ABSENCE: ${u.name} (${u.area}) is absent ${dateStart}${halfLabel}. Reason: ${reason}. CRT auto-booking in progress.`);
    }
    if (leader.email) {
      await sendEmail(leader.email, `Staff Absence: ${u.name}`,
        `<h2>New Staff Absence</h2><p><strong>${u.name}</strong> (${u.area}) has reported an absence.</p>
        <p>Date: ${dateStart}${dateEnd && dateEnd !== dateStart ? ' to ' + dateEnd : ''}${halfLabel}</p>
        <p>Reason: ${reason}</p>${classes ? '<p>Classes: ' + classes + '</p>' : ''}
        <p>CRT auto-booking is in progress.</p>`
      );
    }
  }

  const crtResult = await autoBookCRT(absence);
  res.json({ absence, crt: crtResult });
}));

app.put('/api/absences/:id/cancel', auth, wrap(async (req, res) => {
  const absence = dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'leader' && req.user.role !== 'admin' && absence.staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorised' });
  }
  dbRun("UPDATE absences SET status = 'cancelled' WHERE id = ?", [absence.id]);
  addNotification(`${absence.staff_name} CANCELLED their absence for ${absence.date_start}`, 'info', 'leader', absence.id);

  if (absence.assigned_crt_id) {
    const crt = dbGet('SELECT * FROM crts WHERE id = ?', absence.assigned_crt_id);
    if (crt) {
      await sendSMS(crt.phone, `WPS: Booking cancelled. ${absence.staff_name} no longer needs cover on ${absence.date_start}.`);
      if (crt.email) {
        await sendEmail(crt.email, `Booking Cancelled - ${absence.date_start}`,
          `<h2>Booking Cancelled</h2><p>${absence.staff_name} has cancelled their absence for ${absence.date_start}. You are no longer needed for this booking.</p>`
        );
      }
      addNotification(`${crt.name} notified of cancellation`, 'info', 'leader,crt', absence.id);
    }
  }
  res.json({ ok: true });
}));

app.put('/api/absences/:id/override', auth, leaderOnly, wrap(async (req, res) => {
  const { crtId } = req.body;
  const absence = dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Absence not found' });
  const crt = dbGet('SELECT * FROM crts WHERE id = ?', crtId);
  if (!crt) return res.status(404).json({ error: 'CRT not found' });

  dbRun('UPDATE absences SET assigned_crt_id = ?, status = ? WHERE id = ?', [crtId, 'contacting', absence.id]);
  addNotification(`Leader override: Contacting ${crt.name} for ${absence.staff_name}'s absence`, 'info', 'leader', absence.id);

  const msg = `WPS BOOKING: Can you cover ${absence.staff_name}'s ${absence.area} classes on ${absence.date_start}?${absence.classes ? ' Classes: ' + absence.classes : ''} Log in to confirm.`;
  await sendSMS(crt.phone, msg);
  if (crt.email) {
    await sendEmail(crt.email, `CRT Booking Request - ${absence.date_start}`,
      `<h2>Booking Request</h2><p>Can you cover <strong>${absence.staff_name}'s</strong> ${absence.area} classes?</p>
      <p>Date: ${absence.date_start}</p>${absence.classes ? '<p>Classes: ' + absence.classes + '</p>' : ''}
      <p>Please log into the WPS Staff Hub to confirm.</p>`
    );
  }

  if (DEMO) {
    const absId = absence.id;
    setTimeout(() => {
      const cur = dbGet('SELECT status FROM absences WHERE id = ?', absId);
      if (cur && cur.status === 'contacting') {
        dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absId]);
        addNotification(`${crt.name} CONFIRMED for ${absence.staff_name} (leader override)`, 'success', 'leader', absId);
      }
    }, 3000);
  }
  res.json({ ok: true, crt: crt.name });
}));

app.put('/api/absences/:id/confirm', auth, (req, res) => {
  const absence = dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absence.id]);
  const crt = dbGet('SELECT * FROM crts WHERE id = ?', absence.assigned_crt_id);
  addNotification(`${crt ? crt.name : 'CRT'} CONFIRMED for ${absence.staff_name} on ${absence.date_start}`, 'success', 'leader', absence.id);

  const staff = dbGet('SELECT * FROM users WHERE id = ?', absence.staff_id);
  if (staff && staff.phone) {
    sendSMS(staff.phone, `WPS: ${crt ? crt.name : 'A CRT'} is confirmed to cover your ${absence.area} classes on ${absence.date_start}.`);
  }
  res.json({ ok: true });
});

app.put('/api/absences/:id/decline', auth, wrap(async (req, res) => {
  const absence = dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  const declinedCrtId = absence.assigned_crt_id;
  const declinedCrt = dbGet('SELECT * FROM crts WHERE id = ?', declinedCrtId);
  addNotification(`${declinedCrt ? declinedCrt.name : 'CRT'} DECLINED for ${absence.staff_name}. Finding next CRT...`, 'urgent', 'leader', absence.id);
  dbRun('UPDATE absences SET assigned_crt_id = NULL, status = ? WHERE id = ?', ['pending', absence.id]);
  const updated = dbGet('SELECT * FROM absences WHERE id = ?', absence.id);
  const crtResult = await autoBookCRT(updated, declinedCrtId);
  res.json({ ok: true, nextCrt: crtResult });
}));

async function autoBookCRT(absence, skipCrtId) {
  const areaPrefs = dbAll('SELECT cp.crt_id, c.name, c.phone, c.email FROM crt_preferences cp JOIN crts c ON cp.crt_id = c.id WHERE cp.area = ? AND c.active = 1 ORDER BY cp.priority', absence.area);
  const allPrefs = areaPrefs.length > 0 ? areaPrefs :
    dbAll('SELECT cp.crt_id, c.name, c.phone, c.email FROM crt_preferences cp JOIN crts c ON cp.crt_id = c.id WHERE c.active = 1 ORDER BY cp.priority LIMIT 10');

  for (const pref of allPrefs) {
    if (skipCrtId && pref.crt_id === skipCrtId) continue;
    const unavail = dbGet('SELECT 1 as found FROM crt_unavailable WHERE crt_id = ? AND date = ?', pref.crt_id, absence.date_start);
    if (unavail) continue;
    const alreadyBooked = dbGet("SELECT 1 as found FROM absences WHERE assigned_crt_id = ? AND date_start <= ? AND date_end >= ? AND status IN ('contacting','booked')", pref.crt_id, absence.date_start, absence.date_start);
    if (alreadyBooked) continue;

    dbRun('UPDATE absences SET assigned_crt_id = ?, status = ? WHERE id = ?', [pref.crt_id, 'contacting', absence.id]);
    addNotification(`Auto-contacting ${pref.name} for ${absence.staff_name}'s absence (${absence.area})`, 'info', 'leader', absence.id);

    const msg = `WPS BOOKING: Can you cover ${absence.staff_name}'s ${absence.area} classes on ${absence.date_start}?${absence.classes ? ' Classes: ' + absence.classes : ''} Log in to confirm.`;
    await sendSMS(pref.phone, msg);
    if (pref.email) {
      await sendEmail(pref.email, `CRT Booking Request - ${absence.date_start}`,
        `<h2>Booking Request</h2><p>Can you cover <strong>${absence.staff_name}'s</strong> ${absence.area} classes?</p>
        <p>Date: ${absence.date_start}</p>${absence.classes ? '<p>Classes: ' + absence.classes + '</p>' : ''}
        <p>Please log in to confirm or decline.</p>`
      );
    }

    if (DEMO) {
      const absId = absence.id;
      const crtName = pref.name;
      const staffName = absence.staff_name;
      const dateStr = absence.date_start;
      setTimeout(() => {
        const cur = dbGet('SELECT status FROM absences WHERE id = ?', absId);
        if (cur && cur.status === 'contacting') {
          dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absId]);
          addNotification(`${crtName} CONFIRMED for ${staffName} on ${dateStr}`, 'success', 'leader', absId);
        }
      }, 5000);
    }

    return { crtId: pref.crt_id, name: pref.name, status: 'contacting' };
  }

  dbRun('UPDATE absences SET status = ? WHERE id = ?', ['nocrt', absence.id]);
  addNotification(`No preferred CRT available for ${absence.staff_name}. Manual booking needed.`, 'urgent', 'leader', absence.id);

  const leaders = dbAll("SELECT * FROM users WHERE role = 'leader' AND active = 1");
  for (const leader of leaders) {
    if (leader.phone) {
      await sendSMS(leader.phone, `WPS ALERT: No CRT available for ${absence.staff_name} (${absence.area}) on ${absence.date_start}. Manual booking required.`);
    }
  }
  return { crtId: null, name: null, status: 'nocrt' };
}

// ===== NOTIFICATIONS =====
app.get('/api/notifications', auth, (req, res) => {
  const { role, limit, since } = req.query;
  const r = role || (req.user.role === 'crt' ? 'crt' : 'leader');
  let sql = "SELECT * FROM notifications WHERE for_roles LIKE ?";
  const params = ['%' + r + '%'];
  if (since) { sql += ' AND created_at > ?'; params.push(since); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 50);
  res.json(dbAll(sql, ...params));
});

// ===== STATS =====
app.get('/api/stats', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayAbs = dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status != 'cancelled'", today, today);
  const booked = dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status = 'booked'", today, today);
  const needAction = dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status IN ('pending','nocrt')", today, today);
  const totalTerm = dbGet("SELECT COUNT(*) as c FROM absences WHERE status != 'cancelled'");
  res.json({ absentToday: todayAbs.c, crtsBooked: booked.c, needAction: needAction.c, totalTerm: totalTerm.c });
});

// ===== LOGS =====
app.get('/api/logs/sms', auth, leaderOnly, (req, res) => {
  res.json(dbAll('SELECT * FROM sms_log ORDER BY created_at DESC LIMIT 50'));
});
app.get('/api/logs/email', auth, leaderOnly, (req, res) => {
  res.json(dbAll('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 50'));
});

// ===== SERVE FRONTEND =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ===== STARTUP =====
async function start() {
  const SQL = await initSqlJs();

  // Load or create database
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing database');
  } else {
    console.log('Database not found. Running setup...');
    require('child_process').execSync('node setup-db.js', { cwd: __dirname, stdio: 'inherit' });
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  }

  // Ensure schema is up to date
  try { db.run('CREATE INDEX IF NOT EXISTS idx_absences_status ON absences(status)'); } catch(e) {}
  try { db.run("ALTER TABLE absences ADD COLUMN half_day TEXT DEFAULT 'full'"); } catch(e) {}
  try { db.run("ALTER TABLE crts ADD COLUMN pin_hash TEXT"); } catch(e) {}
  db.run('PRAGMA foreign_keys = ON');

  // Save on exit
  process.on('SIGINT', () => { saveDbNow(); process.exit(); });
  process.on('SIGTERM', () => { saveDbNow(); process.exit(); });

  app.listen(PORT, () => {
    console.log(`\n  WPS Staff Hub`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Notifications: ${LIVE ? 'LIVE' : 'SIMULATED'}`);
    console.log(`  Demo auto-confirm: ${DEMO ? 'ON' : 'OFF'}\n`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
