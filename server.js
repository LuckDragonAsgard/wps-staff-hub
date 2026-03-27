// WPS Staff Hub - Production Server v5.0 (Turso + sql.js fallback)
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wps-dev-secret-change-me';
const LIVE = process.env.NOTIFICATIONS_LIVE === 'true';
const DEMO = process.env.DEMO_MODE !== 'false';
// Turso cloud database credentials (env vars override these defaults)
const TURSO_URL = process.env.TURSO_URL || 'libsql://wps-staff-hub-paddygallivan.aws-us-east-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzQ0ODQ2MTUsImlkIjoiMDE5ZDI3ODYtNTQwMS03MzM4LWFhZTQtOWI5NThkMjNjYjYyIiwicmlkIjoiYjZmYjczYWYtYmE2MC00YjhmLTkyZDMtZGY4YmI0YzQzNWEzIn0.HbLxuuJ-xkOGrfZ_thQvU3njT499Ng2-GXtz1pwuwUQVexVydvWFaGah5bt5i65VAFUI74b0p4U2Ix6gXiX5DQ';
const USE_TURSO = !!(TURSO_URL && TURSO_TOKEN);

// ===== DATABASE ABSTRACTION =====
const DB_PATH = path.join(__dirname, 'wps-absence.db');
let _sqlDb = null;    // sql.js database instance (local fallback)
let _tursoDb = null;  // Turso client instance

// Debounced save for sql.js only
let saveTimer = null;
function saveLocalDb() {
  if (!_sqlDb || USE_TURSO) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = _sqlDb.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) { console.error('DB save error:', e.message); }
  }, 500);
}
function saveLocalDbNow() {
  if (!_sqlDb || USE_TURSO) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = _sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) { console.error('DB save error:', e.message); }
}

// Unified async database functions
async function dbRun(sql, params) {
  if (USE_TURSO) {
    await _tursoDb.execute({ sql, args: params || [] });
  } else {
    _sqlDb.run(sql, params || []);
    saveLocalDb();
  }
}

async function dbGet(sql, ...params) {
  if (USE_TURSO) {
    const result = await _tursoDb.execute({ sql, args: params });
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    // Convert Turso row to plain object
    const obj = {};
    result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  } else {
    const stmt = _sqlDb.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }
}

async function dbAll(sql, ...params) {
  if (USE_TURSO) {
    const result = await _tursoDb.execute({ sql, args: params });
    return result.rows.map(row => {
      const obj = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  } else {
    const stmt = _sqlDb.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

async function dbLastId() {
  const r = await dbGet('SELECT last_insert_rowid() as id');
  return r.id;
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
  await dbRun('INSERT INTO sms_log (to_phone, message, status) VALUES (?, ?, ?)', [to, message, LIVE ? 'sending' : 'simulated']);
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
    await dbRun('UPDATE sms_log SET status = ?, twilio_sid = ? WHERE id = (SELECT MAX(id) FROM sms_log WHERE to_phone = ?)', [
      'sent', result.sid, to
    ]);
    return { status: 'sent', sid: result.sid };
  } catch (err) {
    await dbRun('UPDATE sms_log SET status = ? WHERE id = (SELECT MAX(id) FROM sms_log WHERE to_phone = ?)', [
      'failed: ' + err.message, to
    ]);
    console.error(`[SMS FAIL] ${to}: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

async function sendEmail(to, subject, html) {
  await dbRun('INSERT INTO email_log (to_email, subject, body, status) VALUES (?, ?, ?, ?)', [to, subject, html, LIVE ? 'sending' : 'simulated']);
  if (!LIVE || !sgMail) {
    console.log(`[EMAIL SIM] To: ${to} | ${subject}`);
    return { status: 'simulated' };
  }
  try {
    await sgMail.send({ to, from: process.env.SENDGRID_FROM, subject, html });
    await dbRun('UPDATE email_log SET status = ? WHERE id = (SELECT MAX(id) FROM email_log WHERE to_email = ?)', ['sent', to]);
    return { status: 'sent' };
  } catch (err) {
    await dbRun('UPDATE email_log SET status = ? WHERE id = (SELECT MAX(id) FROM email_log WHERE to_email = ?)', [
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

function wrap(fn) {
  return function(req, res, next) {
    fn(req, res, next).catch(function(err) {
      console.error('Route error:', err);
      res.status(500).json({ error: 'Server error' });
    });
  };
}

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

async function addNotification(message, type, forRoles, absenceId) {
  await dbRun('INSERT INTO notifications (message, type, for_roles, related_absence_id) VALUES (?, ?, ?, ?)', [
    message, type || 'info', forRoles || 'leader', absenceId || null
  ]);
  // Send push notifications to all subscribed users of matching roles
  try {
    const roles = (forRoles || 'leader').split(',').map(r => r.trim());
    const pushTitle = type === 'urgent' ? '🚨 WPS Staff Hub' : 'WPS Staff Hub';
    for (const role of roles) {
      const userType = role === 'crt' ? 'crt' : 'staff';
      const subs = await dbAll('SELECT DISTINCT user_id FROM push_subscriptions WHERE user_type = ?', userType);
      for (const s of subs) {
        sendPushNotification(s.user_id, userType, pushTitle, message).catch(() => {});
      }
    }
  } catch (e) { /* push is best-effort */ }
}

// ===== HEALTH & VERSION =====
app.get('/api/health', wrap(async (req, res) => {
  try {
    await dbGet('SELECT 1 as ok');
    res.json({ status: 'ok', version: '5.0.0', database: USE_TURSO ? 'turso' : 'local', uptime: Math.floor(process.uptime()) });
  } catch (e) {
    res.status(503).json({ status: 'error', error: 'Database unreachable' });
  }
}));

app.get('/api/version', (req, res) => {
  res.json({ version: '5.0.0', features: ['daily-zap', 'yard-duty', 'calendar', 'timetables', 'push-notifications', 'crt-auto-booking', 'staff-management', 'dashboard', 'lessonlab', 'crt-portal', 'yard-duty-swaps', 'nft-tracking', 'specialist-alerts'] });
});

// ===== STAFF PROFILE =====
app.get('/api/staff/me', auth, wrap(async (req, res) => {
  const user = await dbGet('SELECT id, name, email, phone, role, area FROM users WHERE id = ?', req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Get absence stats for this user
  const totalAbsences = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status != 'cancelled'", user.id);
  const thisYear = new Date().getFullYear();
  const yearAbsences = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status != 'cancelled' AND date_start >= ?", user.id, `${thisYear}-01-01`);
  const pendingAbsences = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status IN ('pending','contacting') AND date_end >= date('now')", user.id);
  res.json({ ...user, stats: { total: totalAbsences?.c || 0, thisYear: yearAbsences?.c || 0, pending: pendingAbsences?.c || 0 } });
}));

app.put('/api/staff/me', auth, wrap(async (req, res) => {
  const { phone, email } = req.body;
  const updates = [];
  const params = [];
  if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.user.id);
  await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
}));

// ===== AUTH ENDPOINTS =====
app.post('/api/login', rateLimit, wrap(async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Name and PIN required' });
  const user = await dbGet('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!bcrypt.compareSync(pin, user.pin_hash)) return res.status(401).json({ error: 'Wrong PIN' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, area: user.area }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, area: user.area, email: user.email, phone: user.phone } });
}));

app.post('/api/login/crt', rateLimit, wrap(async (req, res) => {
  const { crtId, pin } = req.body;
  const crt = await dbGet('SELECT * FROM crts WHERE id = ? AND active = 1', crtId);
  if (!crt) return res.status(401).json({ error: 'CRT not found' });
  if (crt.pin_hash && pin) {
    if (!bcrypt.compareSync(pin, crt.pin_hash)) return res.status(401).json({ error: 'Wrong PIN' });
  }
  const token = jwt.sign({ id: crt.id, name: crt.name, role: 'crt', isCrt: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: crt.id, name: crt.name, role: 'crt', phone: crt.phone, email: crt.email, specialties: JSON.parse(crt.specialties || '[]') } });
}));

// ===== USER ENDPOINTS =====
app.get('/api/users', wrap(async (req, res) => {
  const users = await dbAll('SELECT id, name, role, area FROM users WHERE active = 1');
  res.json(users);
}));

// ===== STAFF MANAGEMENT (leaders) =====
app.get('/api/staff', auth, leaderOnly, wrap(async (req, res) => {
  const staff = await dbAll('SELECT id, name, email, phone, role, area, active FROM users ORDER BY name');
  res.json(staff);
}));

app.post('/api/staff', auth, leaderOnly, wrap(async (req, res) => {
  const { name, email, phone, role, area, pin } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const pinHash = bcrypt.hashSync(pin || '0000', 10);
  await dbRun('INSERT INTO users (name, email, phone, role, area, pin_hash, active) VALUES (?,?,?,?,?,?,1)',
    [name.trim(), email || '', phone || '', role || 'staff', area || '', pinHash]);
  const id = await dbLastId();
  await addNotification(`New staff added: ${name.trim()} (${area || 'no area'})`, 'info', 'leader');
  res.json({ ok: true, id });
}));

app.put('/api/staff/:id', auth, leaderOnly, wrap(async (req, res) => {
  const { name, email, phone, role, area, active, pin } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE id = ?', parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'Staff not found' });
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }
  if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role); }
  if (area !== undefined) { updates.push('area = ?'); params.push(area); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (pin) { updates.push('pin_hash = ?'); params.push(bcrypt.hashSync(pin, 10)); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(parseInt(req.params.id));
  await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
}));

// ===== CRT MANAGEMENT (leaders) =====
app.post('/api/crts', auth, leaderOnly, wrap(async (req, res) => {
  const { name, phone, email, specialties, pin } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : null;
  await dbRun('INSERT INTO crts (name, phone, email, specialties, pin_hash, active) VALUES (?,?,?,?,?,1)',
    [name.trim(), phone || '', email || '', JSON.stringify(specialties || []), pinHash]);
  const id = await dbLastId();
  await addNotification(`New CRT added: ${name.trim()}`, 'info', 'leader');
  res.json({ ok: true, id });
}));

app.put('/api/crts/:id', auth, leaderOnly, wrap(async (req, res) => {
  const { name, phone, email, specialties, active, pin } = req.body;
  const crt = await dbGet('SELECT * FROM crts WHERE id = ?', parseInt(req.params.id));
  if (!crt) return res.status(404).json({ error: 'CRT not found' });
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }
  if (specialties !== undefined) { updates.push('specialties = ?'); params.push(JSON.stringify(specialties)); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (pin) { updates.push('pin_hash = ?'); params.push(bcrypt.hashSync(pin, 10)); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(parseInt(req.params.id));
  await dbRun(`UPDATE crts SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
}));

// ===== CRT ENDPOINTS =====
app.get('/api/crts', wrap(async (req, res) => {
  const crts = await dbAll('SELECT id, name, phone, email, specialties, active FROM crts WHERE active = 1');
  res.json(crts.map(c => ({ ...c, specialties: JSON.parse(c.specialties || '[]') })));
}));

app.get('/api/crts/:id/unavailable', auth, wrap(async (req, res) => {
  const dates = await dbAll('SELECT date, reason FROM crt_unavailable WHERE crt_id = ? AND date >= date("now")', parseInt(req.params.id));
  res.json(dates);
}));

app.post('/api/crts/:id/unavailable', auth, wrap(async (req, res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  await dbRun('INSERT OR REPLACE INTO crt_unavailable (crt_id, date, reason) VALUES (?, ?, ?)', [parseInt(req.params.id), date, reason || null]);
  res.json({ ok: true });
}));

app.delete('/api/crts/:id/unavailable/:date', auth, wrap(async (req, res) => {
  await dbRun('DELETE FROM crt_unavailable WHERE crt_id = ? AND date = ?', [parseInt(req.params.id), req.params.date]);
  res.json({ ok: true });
}));

// ===== PREFERENCES ENDPOINTS =====
app.get('/api/preferences', wrap(async (req, res) => {
  const prefs = await dbAll(`
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
}));

app.put('/api/preferences/:area', auth, leaderOnly, wrap(async (req, res) => {
  const area = decodeURIComponent(req.params.area);
  const { crtIds } = req.body;
  if (!Array.isArray(crtIds)) return res.status(400).json({ error: 'crtIds must be an array' });
  await dbRun('DELETE FROM crt_preferences WHERE area = ?', [area]);
  for (let idx = 0; idx < crtIds.length; idx++) {
    await dbRun('INSERT INTO crt_preferences (area, crt_id, priority, set_by) VALUES (?, ?, ?, ?)', [area, crtIds[idx], idx + 1, req.user.id]);
  }
  res.json({ ok: true });
}));

// ===== ABSENCE QUICK STATS (for any staff) =====
app.get('/api/staff/:id/absence-stats', auth, wrap(async (req, res) => {
  const staffId = parseInt(req.params.id);
  const user = await dbGet('SELECT id, name, area FROM users WHERE id = ?', staffId);
  if (!user) return res.status(404).json({ error: 'Staff not found' });
  const thisYear = new Date().getFullYear();
  const total = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status != 'cancelled'", staffId);
  const yearTotal = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status != 'cancelled' AND date_start >= ?", staffId, `${thisYear}-01-01`);
  const lastAbsence = await dbGet("SELECT date_start, reason FROM absences WHERE staff_id = ? AND status != 'cancelled' ORDER BY date_start DESC LIMIT 1", staffId);
  res.json({ ...user, stats: { allTime: total?.c || 0, thisYear: yearTotal?.c || 0, lastAbsence: lastAbsence || null } });
}));

// ===== ABSENCE ENDPOINTS =====
app.get('/api/absences', auth, wrap(async (req, res) => {
  const { date, staffId, limit, status } = req.query;
  let sql = 'SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE 1=1';
  const params = [];
  if (date) { sql += ' AND a.date_start <= ? AND a.date_end >= ?'; params.push(date, date); }
  if (staffId) { sql += ' AND a.staff_id = ?'; params.push(parseInt(staffId)); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += " AND a.status != 'cancelled'";
  sql += ' ORDER BY a.submitted_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
  res.json(await dbAll(sql, ...params));
}));

app.get('/api/absences/month/:year/:month', auth, wrap(async (req, res) => {
  const y = parseInt(req.params.year);
  const m = parseInt(req.params.month);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  // Handle December -> January rollover correctly
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  const absences = await dbAll(
    "SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start < ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.date_start",
    end, start
  );
  res.json(absences);
}));

app.post('/api/absences', auth, wrap(async (req, res) => {
  const { dateStart, dateEnd, reason, classes, notes, halfDay, staffId } = req.body;
  const isLeader = req.user.role === 'leader' || req.user.role === 'admin';

  let staffUser = req.user;
  if (staffId && isLeader) {
    const target = await dbGet('SELECT * FROM users WHERE id = ? AND active = 1', parseInt(staffId));
    if (target) staffUser = { id: target.id, name: target.name, area: target.area };
  }

  if (!dateStart || !reason) return res.status(400).json({ error: 'Date and reason required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  if (dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) return res.status(400).json({ error: 'Invalid end date format. Use YYYY-MM-DD' });

  const recent = await dbGet("SELECT 1 as found FROM absences WHERE staff_id = ? AND date_start = ? AND submitted_at > datetime('now', '-60 seconds') AND status != 'cancelled'", staffUser.id, dateStart);
  if (recent) return res.status(409).json({ error: 'Absence already submitted for this date' });

  await dbRun(
    'INSERT INTO absences (staff_id, staff_name, area, date_start, date_end, reason, classes, notes, half_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [staffUser.id, staffUser.name, staffUser.area, dateStart, dateEnd || dateStart, reason, classes || '', notes || '', halfDay || 'full']
  );

  const absenceId = await dbLastId();
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', absenceId);
  const halfLabel = halfDay === 'am' ? ' (AM only)' : halfDay === 'pm' ? ' (PM only)' : '';
  const byLeader = staffUser.id !== req.user.id ? ` (lodged by ${req.user.name})` : '';

  // Check system settings for notification preferences
  const notifyLeaders = await getSettingBool('notify_leaders_absence', true);
  const leaderSms = await getSettingBool('leader_notify_sms', true);
  const leaderEmail = await getSettingBool('leader_notify_email', true);
  const leaderApp = await getSettingBool('leader_notify_app', true);
  const autoContact = await getSettingBool('auto_contact_crts', true);

  if (leaderApp) {
    await addNotification(`New absence: ${staffUser.name} (${staffUser.area}) \u2013 ${reason}${halfLabel}${byLeader}`, 'urgent', 'leader', absenceId);
  }

  if (notifyLeaders) {
    const leaders = await dbAll("SELECT * FROM users WHERE role = 'leader' AND active = 1");
    for (const leader of leaders) {
      if (leaderSms && leader.phone) {
        await sendSMS(leader.phone, `WPS ABSENCE: ${staffUser.name} (${staffUser.area}) is absent ${dateStart}${halfLabel}. Reason: ${reason}.${autoContact ? ' CRT auto-booking in progress.' : ' Manual CRT assignment needed.'}`);
      }
      if (leaderEmail && leader.email) {
        await sendEmail(leader.email, `Staff Absence: ${staffUser.name}`,
          `<h2>New Staff Absence</h2><p><strong>${staffUser.name}</strong> (${staffUser.area}) has reported an absence.</p>
          <p>Date: ${dateStart}${dateEnd && dateEnd !== dateStart ? ' to ' + dateEnd : ''}${halfLabel}</p>
          <p>Reason: ${reason}</p>${classes ? '<p>Classes: ' + classes + '</p>' : ''}
          <p>${autoContact ? 'CRT auto-booking is in progress.' : 'Manual CRT assignment needed.'}</p>`
        );
      }
    }
  }

  let crtResult = null;
  if (autoContact) {
    crtResult = await autoBookCRT(absence);
  } else {
    // Leave as pending for leadership to manually assign
    if (leaderApp) {
      await addNotification(`${staffUser.name}'s absence awaiting manual CRT assignment`, 'urgent', 'leader', absenceId);
    }
  }

  // Auto-cover yard duty for absent staff
  try { await autoYardDutyCover(dateStart); } catch(e) { console.log('Yard duty auto-cover skipped:', e.message); }

  // Auto-notify specialist teachers if their classes are affected
  try { await notifySpecialists(absence); } catch(e) { console.log('Specialist notify skipped:', e.message); }

  // Check if LessonLab has plans for this teacher — flag in response
  let lessonPlanCount = 0;
  try {
    const dd = new Date(dateStart + 'T12:00:00');
    const dn = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dd.getDay()];
    const planCheck = await dbGet(
      `SELECT COUNT(*) as c FROM lesson_plans WHERE teacher_id = ?
       AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))`,
      staffUser.id, dateStart, dn
    );
    lessonPlanCount = planCheck?.c || 0;
    if (lessonPlanCount > 0) {
      await addNotification(`📚 LessonLab: ${lessonPlanCount} lesson plan${lessonPlanCount > 1 ? 's' : ''} ready for ${staffUser.name}'s CRT`, 'success', 'leader', absenceId);
    }
  } catch(e) {}

  res.json({ absence, crt: crtResult, lessonPlans: lessonPlanCount });
}));

app.put('/api/absences/:id/cancel', auth, wrap(async (req, res) => {
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'leader' && req.user.role !== 'admin' && absence.staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorised' });
  }
  await dbRun("UPDATE absences SET status = 'cancelled' WHERE id = ?", [absence.id]);
  await addNotification(`${absence.staff_name} CANCELLED their absence for ${absence.date_start}`, 'info', 'leader', absence.id);

  if (absence.assigned_crt_id) {
    const crt = await dbGet('SELECT * FROM crts WHERE id = ?', absence.assigned_crt_id);
    if (crt) {
      await sendSMS(crt.phone, `WPS: Booking cancelled. ${absence.staff_name} no longer needs cover on ${absence.date_start}.`);
      if (crt.email) {
        await sendEmail(crt.email, `Booking Cancelled - ${absence.date_start}`,
          `<h2>Booking Cancelled</h2><p>${absence.staff_name} has cancelled their absence for ${absence.date_start}. You are no longer needed for this booking.</p>`
        );
      }
      await addNotification(`${crt.name} notified of cancellation`, 'info', 'leader,crt', absence.id);
    }
  }
  // Clean up specialist alerts for this cancelled absence
  try { await dbRun('DELETE FROM class_absence_alerts WHERE absence_id = ?', [absence.id]); } catch(e) {}
  res.json({ ok: true });
}));

app.put('/api/absences/:id/override', auth, leaderOnly, wrap(async (req, res) => {
  const { crtId } = req.body;
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Absence not found' });
  const crt = await dbGet('SELECT * FROM crts WHERE id = ?', crtId);
  if (!crt) return res.status(404).json({ error: 'CRT not found' });

  await dbRun('UPDATE absences SET assigned_crt_id = ?, status = ? WHERE id = ?', [crtId, 'contacting', absence.id]);
  await addNotification(`Leader override: Contacting ${crt.name} for ${absence.staff_name}'s absence`, 'info', 'leader', absence.id);

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
    const crtName = crt.name;
    const staffName = absence.staff_name;
    setTimeout(async () => {
      try {
        const cur = await dbGet('SELECT status FROM absences WHERE id = ?', absId);
        if (cur && cur.status === 'contacting') {
          await dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absId]);
          await addNotification(`${crtName} CONFIRMED for ${staffName} (leader override)`, 'success', 'leader', absId);
        }
      } catch (e) { console.error('Demo auto-confirm error:', e.message); }
    }, 3000);
  }
  res.json({ ok: true, crt: crt.name });
}));

app.put('/api/absences/:id/confirm', auth, wrap(async (req, res) => {
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  await dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absence.id]);
  const crt = await dbGet('SELECT * FROM crts WHERE id = ?', absence.assigned_crt_id);
  await addNotification(`${crt ? crt.name : 'CRT'} CONFIRMED for ${absence.staff_name} on ${absence.date_start}`, 'success', 'leader', absence.id);

  // Use system settings to notify staff
  await notifyStaffBooked(absence, crt ? crt.name : 'A CRT');
  res.json({ ok: true });
}));

app.put('/api/absences/:id/decline', auth, wrap(async (req, res) => {
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.id));
  if (!absence) return res.status(404).json({ error: 'Not found' });
  const declinedCrtId = absence.assigned_crt_id;
  const declinedCrt = await dbGet('SELECT * FROM crts WHERE id = ?', declinedCrtId);
  await addNotification(`${declinedCrt ? declinedCrt.name : 'CRT'} DECLINED for ${absence.staff_name}. Finding next CRT...`, 'urgent', 'leader', absence.id);
  await dbRun('UPDATE absences SET assigned_crt_id = NULL, status = ? WHERE id = ?', ['pending', absence.id]);
  const updated = await dbGet('SELECT * FROM absences WHERE id = ?', absence.id);
  const crtResult = await autoBookCRT(updated, declinedCrtId);
  res.json({ ok: true, nextCrt: crtResult });
}));

async function autoBookCRT(absence, skipCrtId) {
  const autoApprove = await getSettingBool('auto_approve_crts', false);

  // Smart CRT matching: area preferences first, then specialty match, then any available
  const areaPrefs = await dbAll('SELECT cp.crt_id, c.name, c.phone, c.email, c.specialties FROM crt_preferences cp JOIN crts c ON cp.crt_id = c.id WHERE cp.area = ? AND c.active = 1 ORDER BY cp.priority', absence.area);

  // Fallback: find CRTs whose specialties match the area
  let specialtyMatch = [];
  if (areaPrefs.length === 0) {
    const allCrts = await dbAll('SELECT id as crt_id, name, phone, email, specialties FROM crts WHERE active = 1');
    specialtyMatch = allCrts.filter(c => {
      if (!c.specialties) return false;
      try {
        const specs = JSON.parse(c.specialties);
        return specs.some(s => absence.area.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(absence.area.split(' ')[0].toLowerCase()));
      } catch (e) { return false; }
    });
  }

  // Final fallback: any CRT by general preference
  const generalFallback = (areaPrefs.length === 0 && specialtyMatch.length === 0) ?
    await dbAll('SELECT cp.crt_id, c.name, c.phone, c.email, c.specialties FROM crt_preferences cp JOIN crts c ON cp.crt_id = c.id WHERE c.active = 1 ORDER BY cp.priority LIMIT 10') : [];

  const allPrefs = [...areaPrefs, ...specialtyMatch, ...generalFallback];
  // Deduplicate by crt_id
  const seen = new Set();
  const uniquePrefs = allPrefs.filter(p => { if (seen.has(p.crt_id)) return false; seen.add(p.crt_id); return true; });

  for (const pref of uniquePrefs) {
    if (skipCrtId && pref.crt_id === skipCrtId) continue;
    const unavail = await dbGet('SELECT 1 as found FROM crt_unavailable WHERE crt_id = ? AND date = ?', pref.crt_id, absence.date_start);
    if (unavail) continue;
    const alreadyBooked = await dbGet("SELECT 1 as found FROM absences WHERE assigned_crt_id = ? AND date_start <= ? AND date_end >= ? AND status IN ('contacting','booked')", pref.crt_id, absence.date_start, absence.date_start);
    if (alreadyBooked) continue;

    if (autoApprove) {
      // Auto-approve: book immediately, just notify CRT
      await dbRun('UPDATE absences SET assigned_crt_id = ?, status = ? WHERE id = ?', [pref.crt_id, 'booked', absence.id]);
      await addNotification(`Auto-booked ${pref.name} for ${absence.staff_name}'s absence (${absence.area})`, 'success', 'leader', absence.id);

      const msg = `WPS BOOKED: You've been assigned to cover ${absence.staff_name}'s ${absence.area} classes on ${absence.date_start}.${absence.classes ? ' Classes: ' + absence.classes : ''}`;
      await sendSMS(pref.phone, msg);
      if (pref.email) {
        await sendEmail(pref.email, `CRT Booking Confirmed - ${absence.date_start}`,
          `<h2>Booking Confirmed</h2><p>You've been assigned to cover <strong>${absence.staff_name}'s</strong> ${absence.area} classes.</p>
          <p>Date: ${absence.date_start}</p>${absence.classes ? '<p>Classes: ' + absence.classes + '</p>' : ''}
          <p>This booking was auto-confirmed. Log into the WPS Staff Hub for details.</p>`
        );
      }

      // Notify staff their CRT is booked
      await notifyStaffBooked(absence, pref.name);
      return { crtId: pref.crt_id, name: pref.name, status: 'booked' };
    } else {
      // Standard flow: contact CRT and wait for confirmation
      await dbRun('UPDATE absences SET assigned_crt_id = ?, status = ? WHERE id = ?', [pref.crt_id, 'contacting', absence.id]);
      await addNotification(`Auto-contacting ${pref.name} for ${absence.staff_name}'s absence (${absence.area})`, 'info', 'leader', absence.id);

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
        setTimeout(async () => {
          try {
            const cur = await dbGet('SELECT status FROM absences WHERE id = ?', absId);
            if (cur && cur.status === 'contacting') {
              await dbRun('UPDATE absences SET status = ? WHERE id = ?', ['booked', absId]);
              await addNotification(`${crtName} CONFIRMED for ${staffName} on ${dateStr}`, 'success', 'leader', absId);
              // Notify staff
              const abs = await dbGet('SELECT * FROM absences WHERE id = ?', absId);
              if (abs) await notifyStaffBooked(abs, crtName);
            }
          } catch (e) { console.error('Demo auto-confirm error:', e.message); }
        }, 5000);
      }

      return { crtId: pref.crt_id, name: pref.name, status: 'contacting' };
    }
  }

  await dbRun('UPDATE absences SET status = ? WHERE id = ?', ['nocrt', absence.id]);
  await addNotification(`No CRT available for ${absence.staff_name} (${absence.area}). Manual booking needed.`, 'urgent', 'leader', absence.id);

  const leaderSms = await getSettingBool('leader_notify_sms', true);
  if (leaderSms) {
    const leaders = await dbAll("SELECT * FROM users WHERE role = 'leader' AND active = 1");
    for (const leader of leaders) {
      if (leader.phone) {
        await sendSMS(leader.phone, `WPS ALERT: No CRT available for ${absence.staff_name} (${absence.area}) on ${absence.date_start}. Manual booking required.`);
      }
    }
  }
  return { crtId: null, name: null, status: 'nocrt' };
}

// Notify the absent staff member that their CRT has been booked
async function notifyStaffBooked(absence, crtName) {
  const notifyStaff = await getSettingBool('notify_staff_booked', true);
  if (!notifyStaff) return;
  const staff = await dbGet('SELECT * FROM users WHERE id = ?', absence.staff_id);
  if (!staff) return;

  const staffSms = await getSettingBool('staff_notify_sms', false);
  const staffEmail = await getSettingBool('staff_notify_email', true);

  if (staffSms && staff.phone) {
    await sendSMS(staff.phone, `WPS: ${crtName} is confirmed to cover your ${absence.area} classes on ${absence.date_start}.`);
  }
  if (staffEmail && staff.email) {
    await sendEmail(staff.email, `CRT Confirmed: ${crtName}`,
      `<h2>CRT Confirmed</h2><p><strong>${crtName}</strong> will cover your ${absence.area} classes on ${absence.date_start}.</p>
      ${absence.classes ? '<p>Classes: ' + absence.classes + '</p>' : ''}`
    );
  }
}

// ===== NOTIFICATIONS =====
app.get('/api/notifications', auth, wrap(async (req, res) => {
  const { role, limit, since } = req.query;
  const r = role || (req.user.role === 'crt' ? 'crt' : 'leader');
  let sql = "SELECT * FROM notifications WHERE for_roles LIKE ?";
  const params = ['%' + r + '%'];
  if (since) { sql += ' AND created_at > ?'; params.push(since); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 50);
  res.json(await dbAll(sql, ...params));
}));

// ===== SYSTEM SETTINGS (leadership configurable) =====
async function getSetting(key, defaultVal) {
  const row = await dbGet('SELECT value FROM system_settings WHERE key = ?', key);
  if (!row) return defaultVal;
  return row.value;
}
async function getSettingBool(key, defaultVal) {
  const v = await getSetting(key, defaultVal ? '1' : '0');
  return v === '1' || v === 'true';
}

app.get('/api/system-settings', auth, leaderOnly, wrap(async (req, res) => {
  const rows = await dbAll('SELECT key, value FROM system_settings');
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json(settings);
}));

app.put('/api/system-settings', auth, leaderOnly, wrap(async (req, res) => {
  const allowed = [
    'auto_contact_crts', 'auto_approve_crts',
    'notify_leaders_absence', 'leader_notify_sms', 'leader_notify_email', 'leader_notify_app',
    'notify_staff_booked', 'staff_notify_sms', 'staff_notify_email',
    'enable_push_notifications', 'enable_sub_plans', 'enable_prebook'
  ];
  for (const [key, value] of Object.entries(req.body)) {
    if (!allowed.includes(key)) continue;
    const existing = await dbGet('SELECT key FROM system_settings WHERE key = ?', key);
    if (existing) {
      await dbRun('UPDATE system_settings SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?', [String(value), req.user.id, key]);
    } else {
      await dbRun('INSERT INTO system_settings (key, value, updated_by) VALUES (?, ?, ?)', [key, String(value), req.user.id]);
    }
  }
  const rows = await dbAll('SELECT key, value FROM system_settings');
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json(settings);
}));

// ===== NOTIFICATION SETTINGS =====
app.get('/api/settings', auth, wrap(async (req, res) => {
  let settings = await dbGet('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);
  if (!settings) {
    await dbRun('INSERT INTO user_settings (user_id) VALUES (?)', [req.user.id]);
    settings = await dbGet('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);
  }
  res.json(settings);
}));

app.put('/api/settings', auth, wrap(async (req, res) => {
  const { notifications_enabled, quiet_start, quiet_end, notify_sms, notify_email, notify_app } = req.body;
  let settings = await dbGet('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);
  if (!settings) {
    await dbRun('INSERT INTO user_settings (user_id) VALUES (?)', [req.user.id]);
  }
  await dbRun(`UPDATE user_settings SET
    notifications_enabled = COALESCE(?, notifications_enabled),
    quiet_start = COALESCE(?, quiet_start),
    quiet_end = COALESCE(?, quiet_end),
    notify_sms = COALESCE(?, notify_sms),
    notify_email = COALESCE(?, notify_email),
    notify_app = COALESCE(?, notify_app)
    WHERE user_id = ?`,
    [notifications_enabled, quiet_start, quiet_end, notify_sms, notify_email, notify_app, req.user.id]
  );
  res.json(await dbGet('SELECT * FROM user_settings WHERE user_id = ?', req.user.id));
}));

// ===== STATS =====
app.get('/api/stats', auth, wrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayAbs = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status != 'cancelled'", today, today);
  const booked = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status = 'booked'", today, today);
  const needAction = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status IN ('pending','nocrt')", today, today);
  const totalTerm = await dbGet("SELECT COUNT(*) as c FROM absences WHERE status != 'cancelled'");
  res.json({ absentToday: todayAbs.c, crtsBooked: booked.c, needAction: needAction.c, totalTerm: totalTerm.c });
}));

// ===== LOGS =====
app.get('/api/logs/sms', auth, leaderOnly, wrap(async (req, res) => {
  res.json(await dbAll('SELECT * FROM sms_log ORDER BY created_at DESC LIMIT 50'));
}));
app.get('/api/logs/email', auth, leaderOnly, wrap(async (req, res) => {
  res.json(await dbAll('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 50'));
}));

// ===== DASHBOARD STATS (detailed, auth required) =====
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const userCount = await dbGet('SELECT COUNT(*) as c FROM users WHERE active = 1');
  const crtCount = await dbGet('SELECT COUNT(*) as c FROM crts WHERE active = 1');
  const todayAbs = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status != 'cancelled'", today, today);
  const booked = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status = 'booked'", today, today);
  const pending = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start <= ? AND date_end >= ? AND status IN ('pending','nocrt','contacting')", today, today);
  const thisWeekStart = new Date();
  thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay() + 1);
  const weekStart = thisWeekStart.toISOString().split('T')[0];
  const weekAbs = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start >= ? AND status != 'cancelled'", weekStart);
  const recentNotifs = await dbAll("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5");
  res.json({
    version: '5.0.0',
    demo: DEMO,
    live: LIVE,
    database: USE_TURSO ? 'turso' : 'local',
    uptime: Math.floor(process.uptime()),
    staff: userCount?.c || 0,
    crts: crtCount?.c || 0,
    today: { absences: todayAbs?.c || 0, booked: booked?.c || 0, needAction: pending?.c || 0 },
    thisWeek: weekAbs?.c || 0,
    recentNotifications: recentNotifs
  });
}));

// ===== DEMO RESET =====
app.post('/api/demo/reset', auth, leaderOnly, wrap(async (req, res) => {
  if (!DEMO) return res.status(400).json({ error: 'Only available in demo mode' });
  if (USE_TURSO) {
    // For Turso, run setup-db-turso.js
    try {
      require('child_process').execSync('node setup-db.js --turso', { cwd: __dirname, stdio: 'inherit' });
      res.json({ ok: true, message: 'Demo data reset successfully' });
    } catch (e) {
      res.status(500).json({ error: 'Reset failed: ' + e.message });
    }
  } else {
    try {
      require('child_process').execSync('node setup-db.js', { cwd: __dirname, stdio: 'inherit' });
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const fileBuffer = fs.readFileSync(DB_PATH);
      _sqlDb = new SQL.Database(fileBuffer);
      res.json({ ok: true, message: 'Demo data reset successfully' });
    } catch (e) {
      res.status(500).json({ error: 'Reset failed: ' + e.message });
    }
  }
}));

// ===== COVER REPORT API =====
app.get('/api/report/today', auth, leaderOnly, wrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const absences = await dbAll(
    "SELECT a.*, c.name as crt_name, c.phone as crt_phone FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.area, a.staff_name",
    today, today
  );
  const booked = absences.filter(a => a.status === 'booked').length;
  const pending = absences.filter(a => a.status !== 'booked').length;
  res.json({ date: today, absences, summary: { total: absences.length, booked, pending } });
}));

// ===== SUB PLANS / HANDOVER NOTES =====
app.get('/api/absences/:id/sub-plans', auth, wrap(async (req, res) => {
  const plans = await dbAll('SELECT * FROM sub_plans WHERE absence_id = ? ORDER BY created_at DESC', parseInt(req.params.id));
  res.json(plans);
}));

app.post('/api/absences/:id/sub-plans', auth, wrap(async (req, res) => {
  const { title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required' });
  const absId = parseInt(req.params.id);
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', absId);
  if (!absence) return res.status(404).json({ error: 'Absence not found' });
  await dbRun('INSERT INTO sub_plans (absence_id, title, content, created_by) VALUES (?, ?, ?, ?)',
    [absId, title || 'Sub Plan', content, req.user.id]);
  const id = await dbLastId();
  // Notify CRT if one is assigned
  if (absence.assigned_crt_id) {
    await addNotification('📝 Sub plan added for ' + absence.staff_name + ' (' + absence.area + ')', 'info', 'crt', absId);
  }
  res.json({ ok: true, id });
}));

app.delete('/api/sub-plans/:id', auth, wrap(async (req, res) => {
  await dbRun('DELETE FROM sub_plans WHERE id = ? AND created_by = ?', [parseInt(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

// ===== PUSH NOTIFICATIONS =====
app.get('/api/push/vapid-key', wrap(async (req, res) => {
  const row = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_public_key'");
  res.json({ publicKey: row ? row.value : null });
}));

app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const keys = subscription.keys || {};
  // Upsert
  try {
    await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint]);
  } catch(e) {}
  await dbRun('INSERT INTO push_subscriptions (user_id, user_type, endpoint, p256dh, auth_key) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, req.user.role === 'crt' ? 'crt' : 'staff', subscription.endpoint, keys.p256dh || '', keys.auth || '']);
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', auth, wrap(async (req, res) => {
  await dbRun('DELETE FROM push_subscriptions WHERE user_id = ? AND user_type = ?',
    [req.user.id, req.user.role === 'crt' ? 'crt' : 'staff']);
  res.json({ ok: true });
}));

// Send push notification helper
async function sendPushNotification(userId, userType, title, body, data = {}) {
  try {
    const webpush = require('web-push');
    const pubKey = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_public_key'");
    const privKey = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_private_key'");
    if (!pubKey || !privKey) return;

    webpush.setVapidDetails('mailto:admin@wps-staff-hub.onrender.com', pubKey.value, privKey.value);

    const subs = await dbAll('SELECT * FROM push_subscriptions WHERE user_id = ? AND user_type = ?', userId, userType || 'staff');
    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key }
        }, JSON.stringify({ title, body, ...data }));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await dbRun('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
        }
      }
    }
  } catch (e) {
    console.log('Push notification error:', e.message);
  }
}

// ===== PRE-BOOKED / RECURRING ABSENCES =====
app.post('/api/absences/prebook', auth, wrap(async (req, res) => {
  const { staffId, dateStart, dateEnd, reason, classes, notes, halfDay, recurrence, dates } = req.body;
  const uid = staffId || req.user.id;
  const user = await dbGet('SELECT * FROM users WHERE id = ?', uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const created = [];
  const datesToBook = dates || [{ start: dateStart, end: dateEnd || dateStart }];

  for (const d of datesToBook) {
    await dbRun(
      "INSERT INTO absences (staff_id, staff_name, area, date_start, date_end, reason, classes, notes, half_day, status, is_prebooked, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)",
      [uid, user.name, user.area || '', d.start, d.end || d.start, reason, classes || '', notes || '', halfDay || 'full', recurrence || 'none']
    );
    const id = await dbLastId();
    created.push(id);

    // Auto-book CRT if enabled
    const autoContact = await getSettingBool('auto_contact_crts', true);
    if (autoContact) {
      setTimeout(() => autoBookCRT(id), 500);
    }
  }

  await addNotification('📅 Pre-booked absence: ' + user.name + ' — ' + reason + ' (' + datesToBook.length + ' date' + (datesToBook.length > 1 ? 's' : '') + ')', 'info', 'leader');
  res.json({ ok: true, ids: created });
}));

// ===== REPORTS & EXPORT =====
app.get('/api/reports/export', auth, leaderOnly, wrap(async (req, res) => {
  const { from, to, area, status, format } = req.query;
  let sql = "SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE 1=1";
  const params = [];

  if (from) { sql += ' AND a.date_start >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date_end <= ?'; params.push(to); }
  if (area) { sql += ' AND a.area = ?'; params.push(area); }
  if (status && status !== 'all') { sql += ' AND a.status = ?'; params.push(status); }

  sql += ' ORDER BY a.date_start DESC';
  const rows = await dbAll(sql, ...params);

  if (format === 'json') {
    return res.json(rows);
  }

  // CSV export
  const headers = ['Date Start', 'Date End', 'Staff Name', 'Area', 'Reason', 'Duration', 'Status', 'CRT Assigned', 'Notes', 'Submitted'];
  const csvRows = [headers.join(',')];
  for (const r of rows) {
    csvRows.push([
      r.date_start, r.date_end, '"' + (r.staff_name || '').replace(/"/g, '""') + '"',
      '"' + (r.area || '').replace(/"/g, '""') + '"',
      '"' + (r.reason || '').replace(/"/g, '""') + '"',
      r.half_day || 'full', r.status, '"' + (r.crt_name || '').replace(/"/g, '""') + '"',
      '"' + (r.notes || '').replace(/"/g, '""') + '"',
      r.submitted_at || ''
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wps-absences-' + new Date().toISOString().split('T')[0] + '.csv"');
  res.send(csvRows.join('\n'));
}));

app.get('/api/reports/summary', auth, leaderOnly, wrap(async (req, res) => {
  const { from, to } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const startDate = from || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
  const endDate = to || today;

  const total = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? AND status != 'cancelled'", startDate, endDate);
  const byStatus = await dbAll("SELECT status, COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? GROUP BY status", startDate, endDate);
  const byArea = await dbAll("SELECT area, COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? AND status != 'cancelled' GROUP BY area ORDER BY c DESC", startDate, endDate);
  const byReason = await dbAll("SELECT reason, COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? AND status != 'cancelled' GROUP BY reason ORDER BY c DESC LIMIT 10", startDate, endDate);
  const byMonth = await dbAll("SELECT substr(date_start,1,7) as month, COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? AND status != 'cancelled' GROUP BY month ORDER BY month", startDate, endDate);
  const topStaff = await dbAll("SELECT staff_name, COUNT(*) as c FROM absences WHERE date_start >= ? AND date_end <= ? AND status != 'cancelled' GROUP BY staff_id ORDER BY c DESC LIMIT 10", startDate, endDate);
  const crtUsage = await dbAll("SELECT c.name, COUNT(*) as c FROM absences a JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start >= ? AND a.date_end <= ? AND a.status = 'booked' GROUP BY a.assigned_crt_id ORDER BY c DESC", startDate, endDate);

  res.json({ total: total.c, byStatus, byArea, byReason, byMonth, topStaff, crtUsage, from: startDate, to: endDate });
}));

// ===== CRT AVAILABILITY CALENDAR (enhanced) =====
app.get('/api/crts/availability', auth, wrap(async (req, res) => {
  const { month, year } = req.query;
  const yr = parseInt(year) || new Date().getFullYear();
  const mo = parseInt(month) || (new Date().getMonth() + 1);
  const startDate = `${yr}-${String(mo).padStart(2,'0')}-01`;
  const endDay = new Date(yr, mo, 0).getDate();
  const endDate = `${yr}-${String(mo).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

  const crts = await dbAll('SELECT id, name, phone, specialties FROM crts WHERE active = 1');
  const unavail = await dbAll('SELECT crt_id, date, reason FROM crt_unavailable WHERE date >= ? AND date <= ?', startDate, endDate);
  const bookings = await dbAll("SELECT assigned_crt_id, date_start, date_end, staff_name, area FROM absences WHERE assigned_crt_id IS NOT NULL AND status IN ('booked','contacting') AND date_start <= ? AND date_end >= ?", endDate, startDate);

  res.json({ crts, unavailable: unavail, bookings, month: mo, year: yr });
}));

// ===== DAILY ZAP =====
// Get daily zap with auto-populated data
app.get('/api/daily-zap/:date', auth, wrap(async (req, res) => {
  const date = req.params.date;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()];

  // Manual zap content
  let zap = await dbGet('SELECT * FROM daily_zaps WHERE date = ?', date);

  // Auto-populated: today's absences with CRT assignments
  const absences = await dbAll(
    "SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.staff_name",
    date, date
  );

  // Yard duty: base roster for this day + any changes
  const roster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY time_slot, location', dayName);
  const changes = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY time_slot, location', date);

  // Calendar events for this week and next
  const weekStart = new Date(d);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);
  const nextWeekEnd = new Date(weekEnd);
  nextWeekEnd.setDate(nextWeekEnd.getDate() + 7);

  const thisWeekEvents = await dbAll('SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date, title',
    weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]);
  const nextWeekEvents = await dbAll('SELECT * FROM calendar_events WHERE date > ? AND date <= ? ORDER BY date, title',
    weekEnd.toISOString().split('T')[0], nextWeekEnd.toISOString().split('T')[0]);

  // Current timetables
  const timetables = await dbAll('SELECT id, name, type, term FROM timetables WHERE is_current = 1 ORDER BY type, name');

  // Specialist class absence alerts for this date
  let specialistAlerts = [];
  try {
    specialistAlerts = await dbAll(
      `SELECT ca.*, a.reason, a.half_day, a.status as absence_status
       FROM class_absence_alerts ca
       LEFT JOIN absences a ON ca.absence_id = a.id
       WHERE ca.date = ? AND (a.status IS NULL OR a.status != 'cancelled')
       ORDER BY ca.specialist_name, ca.time_slot`,
      date
    );
  } catch(e) { /* table may not exist yet */ }

  res.json({
    date, dayName, zap: zap || {},
    absences, yardDuty: { roster, changes },
    calendar: { thisWeek: thisWeekEvents, nextWeek: nextWeekEvents },
    timetables, specialistAlerts
  });
}));

// Create/update daily zap
app.post('/api/daily-zap/:date', auth, leaderOnly, wrap(async (req, res) => {
  const date = req.params.date;
  const { weekly_quote, quote_author, daily_org, es_notes, nft_notes, extra_notes, movements } = req.body;
  const existing = await dbGet('SELECT id FROM daily_zaps WHERE date = ?', date);
  if (existing) {
    await dbRun(`UPDATE daily_zaps SET weekly_quote=?, quote_author=?, daily_org=?, es_notes=?, nft_notes=?, extra_notes=?, movements=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE date=?`,
      [weekly_quote||'', quote_author||'', daily_org||'', es_notes||'', nft_notes||'', extra_notes||'', movements||'', req.user.id, date]);
  } else {
    await dbRun(`INSERT INTO daily_zaps (date, weekly_quote, quote_author, daily_org, es_notes, nft_notes, extra_notes, movements, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [date, weekly_quote||'', quote_author||'', daily_org||'', es_notes||'', nft_notes||'', extra_notes||'', movements||'', req.user.id]);
  }
  res.json({ ok: true });
}));

// ===== YARD DUTY =====
// Get full roster
app.get('/api/yard-duty/roster', auth, wrap(async (req, res) => {
  const { term } = req.query;
  let sql = 'SELECT * FROM yard_duty_roster';
  const params = [];
  if (term) { sql += ' WHERE term = ?'; params.push(parseInt(term)); }
  sql += ' ORDER BY CASE day_of_week WHEN "Monday" THEN 1 WHEN "Tuesday" THEN 2 WHEN "Wednesday" THEN 3 WHEN "Thursday" THEN 4 WHEN "Friday" THEN 5 END, time_slot, location';
  res.json(await dbAll(sql, ...params));
}));

// Bulk set roster (replace all for a term)
app.post('/api/yard-duty/roster', auth, leaderOnly, wrap(async (req, res) => {
  const { term, roster } = req.body;
  if (!Array.isArray(roster)) return res.status(400).json({ error: 'roster must be array' });
  await dbRun('DELETE FROM yard_duty_roster WHERE term = ?', [term || 1]);
  for (const r of roster) {
    await dbRun('INSERT INTO yard_duty_roster (day_of_week, time_slot, location, staff_name, is_leadership, term) VALUES (?,?,?,?,?,?)',
      [r.day, r.slot, r.location, r.staff, r.isLeadership ? 1 : 0, term || 1]);
  }
  res.json({ ok: true, count: roster.length });
}));

// Add single roster entry
app.post('/api/yard-duty/roster/add', auth, leaderOnly, wrap(async (req, res) => {
  const { day, slot, location, staff, isLeadership, term } = req.body;
  await dbRun('INSERT INTO yard_duty_roster (day_of_week, time_slot, location, staff_name, is_leadership, term) VALUES (?,?,?,?,?,?)',
    [day, slot, location, staff, isLeadership ? 1 : 0, term || 1]);
  res.json({ ok: true, id: await dbLastId() });
}));

// Delete roster entry
app.delete('/api/yard-duty/roster/:id', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM yard_duty_roster WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// Get today's yard duty (with auto-changes applied)
app.get('/api/yard-duty/today', auth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()];

  const roster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY time_slot, location', dayName);
  const changes = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY time_slot, location', date);

  // Check which rostered staff are absent today
  const absences = await dbAll(
    "SELECT staff_name FROM absences WHERE date_start <= ? AND date_end >= ? AND status != 'cancelled'", date, date);
  const absentNames = absences.map(a => a.staff_name.toLowerCase());

  // Build combined view
  const combined = roster.map(r => {
    const isAway = absentNames.some(n => r.staff_name.toLowerCase().includes(n) || n.includes(r.staff_name.toLowerCase().split(' ')[0]));
    const change = changes.find(c => c.time_slot === r.time_slot && c.location === r.location);
    return { ...r, isAway, change: change || null };
  });

  res.json({ date, dayName, duties: combined, changes });
}));

// Manual yard duty change/override
app.post('/api/yard-duty/change', auth, leaderOnly, wrap(async (req, res) => {
  const { date, time_slot, location, original_staff, replacement, replacement_type } = req.body;
  // Upsert
  const existing = await dbGet('SELECT id FROM yard_duty_changes WHERE date=? AND time_slot=? AND location=?', date, time_slot, location);
  if (existing) {
    await dbRun('UPDATE yard_duty_changes SET replacement=?, replacement_type=?, auto_assigned=0, overridden_by=? WHERE id=?',
      [replacement, replacement_type || 'manual', req.user.id, existing.id]);
  } else {
    await dbRun('INSERT INTO yard_duty_changes (date, time_slot, location, original_staff, replacement, replacement_type, auto_assigned, overridden_by) VALUES (?,?,?,?,?,?,0,?)',
      [date, time_slot, location, original_staff, replacement, replacement_type || 'manual', req.user.id]);
  }
  res.json({ ok: true });
}));

// Auto-assign CRT to yard duty when staff is absent
app.post('/api/yard-duty/auto-cover', auth, wrap(async (req, res) => {
  const { date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const result = await autoYardDutyCover(targetDate);
  res.json(result);
}));

async function autoYardDutyCover(date) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()];

  // Get today's absent staff
  const absences = await dbAll(
    "SELECT a.staff_name, c.name as crt_name, a.assigned_crt_id FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled'",
    date, date);
  const absentNames = absences.map(a => a.staff_name);

  // Get roster for today
  const roster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ?', dayName);

  // Find duties that need cover
  const needsCover = roster.filter(r => absentNames.some(n => r.staff_name.toLowerCase().includes(n.toLowerCase().split(' ')[0])));

  // Get existing changes (don't override manual ones)
  const existingChanges = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ? AND auto_assigned = 0', date);

  // Get available CRTs (booked for today)
  const bookedCrts = await dbAll(
    "SELECT DISTINCT c.name FROM absences a JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status IN ('booked','contacting')",
    date, date);
  const crtNames = bookedCrts.map(c => c.name);

  let assigned = 0;
  for (const duty of needsCover) {
    // Skip if already manually overridden
    if (existingChanges.find(c => c.time_slot === duty.time_slot && c.location === duty.location)) continue;

    // Find which CRT is covering this person
    const absence = absences.find(a => duty.staff_name.toLowerCase().includes(a.staff_name.toLowerCase().split(' ')[0]));
    const crtName = absence && absence.crt_name ? absence.crt_name : (crtNames.length > 0 ? crtNames[0] : null);

    if (crtName) {
      const existing = await dbGet('SELECT id FROM yard_duty_changes WHERE date=? AND time_slot=? AND location=?', date, duty.time_slot, duty.location);
      if (existing) {
        await dbRun('UPDATE yard_duty_changes SET replacement=?, replacement_type=?, auto_assigned=1 WHERE id=?',
          [crtName, 'crt', existing.id]);
      } else {
        await dbRun('INSERT INTO yard_duty_changes (date, time_slot, location, original_staff, replacement, replacement_type, auto_assigned) VALUES (?,?,?,?,?,?,1)',
          [date, duty.time_slot, duty.location, duty.staff_name, crtName, 'crt']);
      }
      assigned++;
    }
  }
  return { assigned, needsCover: needsCover.length };
}

// ===== SPECIALIST CLASS ABSENCE ALERTS =====
// When a classroom teacher is absent, check the specialist timetable to see which
// specialist teachers are affected and auto-notify them before they set up for a lesson.
async function notifySpecialists(absence) {
  const date = absence.date_start;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()];
  const dayIndex = d.getDay(); // 0=Sun, 1=Mon...

  // Get all current specialist timetables
  const timetables = await dbAll("SELECT * FROM timetables WHERE is_current = 1 AND type = 'specialist'");
  if (timetables.length === 0) return { alerts: 0 };

  const staffName = absence.staff_name;
  const classesField = (absence.classes || '').toLowerCase();
  const areaField = (absence.area || '').toLowerCase();
  let alertCount = 0;

  for (const tt of timetables) {
    let data;
    try { data = JSON.parse(tt.data); } catch(e) { continue; }
    if (!data || !data.headers || !data.rows) continue;

    const headers = data.headers;
    const rows = data.rows;

    // The timetable headers are typically: [Time, Staff1, Staff2, ...]
    // Each row is: [timeSlot, class1, class2, ...]
    // We need to find rows where the absent teacher's class/area appears in a specialist column

    // Determine which day rows to look at. If timetable has a day structure,
    // rows may be grouped by day. Common formats:
    // - Row[0] might contain the day name if it spans multiple days
    // We look for rows relevant to today's day of the week.

    let inCorrectDay = false;
    let dayRowStarted = false;

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const firstCell = (Array.isArray(row) ? row[0] : (row[headers[0]] || '')).toString().trim().toLowerCase();

      // Check if this row marks a day
      if (['monday','tuesday','wednesday','thursday','friday'].includes(firstCell)) {
        inCorrectDay = firstCell === dayName.toLowerCase();
        dayRowStarted = true;
        continue;
      }

      // If the timetable has no day markers, include all rows (single-day format)
      if (!dayRowStarted) inCorrectDay = true;

      if (!inCorrectDay) continue;

      // Scan each specialist column (skip first column which is usually Time)
      const rowValues = Array.isArray(row) ? row : headers.map(h => row[h] || '');
      const timeSlot = String(rowValues[0] || '');

      for (let ci = 1; ci < headers.length; ci++) {
        const cellValue = String(rowValues[ci] || '').toLowerCase();
        if (!cellValue || cellValue === '-' || cellValue === 'nft' || cellValue === 'planning') continue;

        // Check if this cell references the absent teacher's class/area
        // Match on: staff name, class name from the classes field, or area keywords
        const staffFirst = staffName.toLowerCase().split(' ')[0];
        const areaKey = areaField.replace(/[^a-z0-9]/g, '');

        // Check if the timetable cell contains a class taught by the absent teacher
        let isMatch = false;

        // Match 1: Cell contains the absent teacher's name
        if (cellValue.includes(staffFirst) && staffFirst.length > 2) isMatch = true;

        // Match 2: If 'classes' field specifies classes, check each
        if (classesField) {
          const classParts = classesField.split(/[,;&]+/).map(c => c.trim()).filter(Boolean);
          for (const cp of classParts) {
            if (cp.length > 1 && cellValue.includes(cp)) { isMatch = true; break; }
            // Also match shortened forms like "Prep G" matching "prep" or "1/2A" matching "1/2"
            const shortClass = cp.replace(/\s+/g, '').toLowerCase();
            if (shortClass.length > 1 && cellValue.replace(/\s+/g, '').includes(shortClass)) { isMatch = true; break; }
          }
        }

        // Match 3: Area-based match (e.g. "Junior (P-2)" matches cells with "prep", "1/2", "p-2")
        if (!isMatch && areaField) {
          if (areaField.includes('junior') && (cellValue.includes('prep') || cellValue.includes('1/2') || cellValue.includes('p-2') || cellValue.match(/\b[12]\b/))) isMatch = true;
          if (areaField.includes('middle') && (cellValue.includes('3/4') || cellValue.includes('3-4') || cellValue.match(/\b[34]\b/))) isMatch = true;
          if (areaField.includes('senior') && (cellValue.includes('5/6') || cellValue.includes('5-6') || cellValue.match(/\b[56]\b/))) isMatch = true;
        }

        if (isMatch) {
          const specialistName = headers[ci];
          // Record the alert
          try {
            const existing = await dbGet(
              'SELECT id FROM class_absence_alerts WHERE date = ? AND specialist_name = ? AND time_slot = ? AND absent_staff_id = ?',
              date, specialistName, timeSlot, absence.staff_id
            );
            if (!existing) {
              await dbRun(
                'INSERT INTO class_absence_alerts (date, specialist_name, time_slot, class_name, absent_staff_id, absent_staff_name, absence_id, timetable_id) VALUES (?,?,?,?,?,?,?,?)',
                [date, specialistName, timeSlot, cellValue, absence.staff_id, staffName, absence.id, tt.id]
              );
              alertCount++;
            }
          } catch(e) { console.log('Alert insert skipped:', e.message); }

          // Send push notification to the specialist teacher (find by name match)
          try {
            const specUser = await dbGet(
              "SELECT id FROM users WHERE LOWER(name) LIKE ? AND active = 1",
              '%' + specialistName.toLowerCase().split(' ')[0] + '%'
            );
            if (specUser) {
              await sendPushNotification(specUser.id, 'staff',
                '⚠️ Class Cancelled',
                `${staffName}'s class (${cellValue}) won't be in for ${specialistName} at ${timeSlot} on ${date}. ${staffName} is away — ${absence.reason}.`
              );
            }
          } catch(e) { /* push is best-effort */ }
        }
      }
    }
  }

  // Create a single in-app notification summarising the specialist alerts
  if (alertCount > 0) {
    await addNotification(
      `⚠️ ${alertCount} specialist lesson${alertCount > 1 ? 's' : ''} affected — ${staffName} is absent on ${date}`,
      'urgent', 'leader,staff', absence.id
    );
  }

  return { alerts: alertCount };
}

// Get specialist alerts for a date (used by Daily Zap)
app.get('/api/class-absence-alerts', auth, wrap(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date required' });
  const alerts = await dbAll(
    `SELECT ca.*, a.reason, a.half_day, a.status as absence_status
     FROM class_absence_alerts ca
     LEFT JOIN absences a ON ca.absence_id = a.id
     WHERE ca.date = ? AND (a.status IS NULL OR a.status != 'cancelled')
     ORDER BY ca.specialist_name, ca.time_slot`,
    date
  );
  res.json(alerts);
}));

// Delete alerts (when an absence is cancelled)
app.delete('/api/class-absence-alerts/by-absence/:absenceId', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM class_absence_alerts WHERE absence_id = ?', [parseInt(req.params.absenceId)]);
  res.json({ ok: true });
}));

// ===== CALENDAR EVENTS =====
app.get('/api/calendar-events', auth, wrap(async (req, res) => {
  const { from, to, term } = req.query;
  let sql = 'SELECT * FROM calendar_events WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  if (term) { sql += ' AND term = ?'; params.push(parseInt(term)); }
  sql += ' ORDER BY date, title';
  res.json(await dbAll(sql, ...params));
}));

app.post('/api/calendar-events', auth, leaderOnly, wrap(async (req, res) => {
  const { date, title, category, term, week_num } = req.body;
  if (!date || !title) return res.status(400).json({ error: 'Date and title required' });
  await dbRun('INSERT INTO calendar_events (date, title, category, term, week_num, created_by) VALUES (?,?,?,?,?,?)',
    [date, title, category || 'general', term || 1, week_num || null, req.user.id]);
  res.json({ ok: true, id: await dbLastId() });
}));

app.delete('/api/calendar-events/:id', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM calendar_events WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// Bulk import calendar events
app.post('/api/calendar-events/bulk', auth, leaderOnly, wrap(async (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events must be array' });
  let count = 0;
  for (const e of events) {
    if (!e.date || !e.title) continue;
    await dbRun('INSERT INTO calendar_events (date, title, category, term, week_num, created_by) VALUES (?,?,?,?,?,?)',
      [e.date, e.title, e.category || 'general', e.term || 1, e.week_num || null, req.user.id]);
    count++;
  }
  res.json({ ok: true, count });
}));

// ===== TIMETABLES =====
app.get('/api/timetables', auth, wrap(async (req, res) => {
  const { type, current } = req.query;
  let sql = 'SELECT id, name, type, term, is_current, created_at FROM timetables WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (current === '1') { sql += ' AND is_current = 1'; }
  sql += ' ORDER BY type, name';
  res.json(await dbAll(sql, ...params));
}));

app.get('/api/timetables/:id', auth, wrap(async (req, res) => {
  const tt = await dbGet('SELECT * FROM timetables WHERE id = ?', parseInt(req.params.id));
  if (!tt) return res.status(404).json({ error: 'Not found' });
  try { tt.data = JSON.parse(tt.data); } catch(e) { tt.data = []; }
  res.json(tt);
}));

app.post('/api/timetables', auth, leaderOnly, wrap(async (req, res) => {
  const { name, type, term, data, is_current } = req.body;
  if (!name || !data) return res.status(400).json({ error: 'Name and data required' });
  // If setting as current, unset others of same type
  if (is_current) {
    await dbRun('UPDATE timetables SET is_current = 0 WHERE type = ?', [type || 'general']);
  }
  await dbRun('INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?,?,?,?,?,?)',
    [name, type || 'general', term || 1, typeof data === 'string' ? data : JSON.stringify(data), is_current ? 1 : 0, req.user.id]);
  res.json({ ok: true, id: await dbLastId() });
}));

app.delete('/api/timetables/:id', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM timetables WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// ===== LESSONLAB — Lesson Plan Storage & Auto-Pull =====
// Store lesson plans per teacher, per day/period. When a teacher calls in sick,
// the system auto-pulls their plans for the CRT covering their classes.

app.get('/api/lessonlab/plans', auth, wrap(async (req, res) => {
  const { teacherId, date, dayOfWeek, subject } = req.query;
  let sql = 'SELECT * FROM lesson_plans WHERE 1=1';
  const params = [];
  if (teacherId) { sql += ' AND teacher_id = ?'; params.push(parseInt(teacherId)); }
  if (date) { sql += ' AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))'; params.push(date); const d = new Date(date + 'T12:00:00'); params.push(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]); }
  if (dayOfWeek) { sql += ' AND day_of_week = ?'; params.push(dayOfWeek); }
  if (subject) { sql += ' AND LOWER(subject) LIKE ?'; params.push('%' + subject.toLowerCase() + '%'); }
  sql += ' ORDER BY period_slot, subject';
  res.json(await dbAll(sql, ...params));
}));

app.get('/api/lessonlab/plans/:id', auth, wrap(async (req, res) => {
  const plan = await dbGet('SELECT * FROM lesson_plans WHERE id = ?', parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
}));

app.post('/api/lessonlab/plans', auth, wrap(async (req, res) => {
  const { teacherId, dayOfWeek, specificDate, periodSlot, subject, className, planTitle, planContent, resources, notes } = req.body;
  const tid = teacherId || req.user.id;
  if (!subject || !planContent) return res.status(400).json({ error: 'Subject and plan content required' });
  await dbRun(
    `INSERT INTO lesson_plans (teacher_id, day_of_week, specific_date, period_slot, subject, class_name, plan_title, plan_content, resources, notes, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [tid, dayOfWeek || null, specificDate || null, periodSlot || '', subject, className || '', planTitle || subject, planContent, resources || '', notes || '', req.user.id]
  );
  res.json({ ok: true, id: await dbLastId() });
}));

app.put('/api/lessonlab/plans/:id', auth, wrap(async (req, res) => {
  const { dayOfWeek, specificDate, periodSlot, subject, className, planTitle, planContent, resources, notes } = req.body;
  const plan = await dbGet('SELECT * FROM lesson_plans WHERE id = ?', parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  // Only the teacher or a leader can edit
  if (plan.teacher_id !== req.user.id && req.user.role !== 'leader' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorised' });
  }
  const updates = []; const params = [];
  if (dayOfWeek !== undefined) { updates.push('day_of_week = ?'); params.push(dayOfWeek); }
  if (specificDate !== undefined) { updates.push('specific_date = ?'); params.push(specificDate); }
  if (periodSlot !== undefined) { updates.push('period_slot = ?'); params.push(periodSlot); }
  if (subject !== undefined) { updates.push('subject = ?'); params.push(subject); }
  if (className !== undefined) { updates.push('class_name = ?'); params.push(className); }
  if (planTitle !== undefined) { updates.push('plan_title = ?'); params.push(planTitle); }
  if (planContent !== undefined) { updates.push('plan_content = ?'); params.push(planContent); }
  if (resources !== undefined) { updates.push('resources = ?'); params.push(resources); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  updates.push('updated_by = ?', 'updated_at = CURRENT_TIMESTAMP'); params.push(req.user.id);
  params.push(parseInt(req.params.id));
  await dbRun(`UPDATE lesson_plans SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
}));

app.delete('/api/lessonlab/plans/:id', auth, wrap(async (req, res) => {
  await dbRun('DELETE FROM lesson_plans WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// Auto-pull lesson plans for a specific absence — returns the CRT pack
app.get('/api/lessonlab/crt-pack/:absenceId', auth, wrap(async (req, res) => {
  const absence = await dbGet('SELECT * FROM absences WHERE id = ?', parseInt(req.params.absenceId));
  if (!absence) return res.status(404).json({ error: 'Absence not found' });

  const date = absence.date_start;
  const d = new Date(date + 'T12:00:00');
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];

  // Get lesson plans for this teacher on this day
  const plans = await dbAll(
    `SELECT * FROM lesson_plans WHERE teacher_id = ?
     AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))
     ORDER BY period_slot`,
    absence.staff_id, date, dayName
  );

  // Get sub plans attached to this absence
  const subPlans = await dbAll('SELECT * FROM sub_plans WHERE absence_id = ? ORDER BY created_at', absence.id);

  // Get teacher's timetable for the day from specialist timetable
  let timetableSlots = [];
  try {
    const timetables = await dbAll("SELECT * FROM timetables WHERE is_current = 1");
    for (const tt of timetables) {
      let data; try { data = JSON.parse(tt.data); } catch(e) { continue; }
      if (!data || !data.headers || !data.rows) continue;
      const staffFirst = absence.staff_name.toLowerCase().split(' ')[0];
      const colIdx = data.headers.findIndex(h => h.toLowerCase().includes(staffFirst));
      if (colIdx === -1) continue;
      let inDay = false, dayStarted = false;
      for (const row of data.rows) {
        const vals = Array.isArray(row) ? row : data.headers.map(h => row[h] || '');
        const first = String(vals[0] || '').trim().toLowerCase();
        if (['monday','tuesday','wednesday','thursday','friday'].includes(first)) {
          inDay = first === dayName.toLowerCase(); dayStarted = true; continue;
        }
        if (!dayStarted) inDay = true;
        if (!inDay) continue;
        const classVal = String(vals[colIdx] || '').trim();
        if (classVal && classVal !== '-' && classVal.toLowerCase() !== 'nft' && classVal.toLowerCase() !== 'planning') {
          timetableSlots.push({ time: String(vals[0] || ''), className: classVal, timetable: tt.name });
        }
      }
    }
  } catch(e) {}

  // Get yard duty for this teacher on this day
  let yardDuties = [];
  try {
    const roster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ?', dayName);
    const staffFirst = absence.staff_name.toLowerCase().split(' ')[0];
    yardDuties = roster.filter(r => r.staff_name.toLowerCase().includes(staffFirst));
    // Check for changes/covers
    const changes = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ?', date);
    yardDuties = yardDuties.map(yd => {
      const change = changes.find(c => c.time_slot === yd.time_slot && c.location === yd.location);
      return { ...yd, covered: !!change, coveredBy: change ? change.replacement : null };
    });
  } catch(e) {}

  res.json({
    absence, lessonPlans: plans, subPlans, timetableSlots, yardDuties,
    teacher: { id: absence.staff_id, name: absence.staff_name, area: absence.area },
    date, dayName
  });
}));

// Bulk import lesson plans (for a teacher's whole week)
app.post('/api/lessonlab/plans/bulk', auth, wrap(async (req, res) => {
  const { plans } = req.body;
  if (!Array.isArray(plans)) return res.status(400).json({ error: 'plans must be array' });
  let count = 0;
  for (const p of plans) {
    if (!p.subject || !p.planContent) continue;
    const tid = p.teacherId || req.user.id;
    await dbRun(
      `INSERT INTO lesson_plans (teacher_id, day_of_week, specific_date, period_slot, subject, class_name, plan_title, plan_content, resources, notes, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, p.dayOfWeek || null, p.specificDate || null, p.periodSlot || '', p.subject, p.className || '', p.planTitle || p.subject, p.planContent, p.resources || '', p.notes || '', req.user.id]
    );
    count++;
  }
  res.json({ ok: true, count });
}));

// ===== CRT PORTAL — Dedicated day-view for CRTs =====
// Returns everything a CRT needs for their day in one call
app.get('/api/crt-portal/my-day', auth, wrap(async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const d = new Date(targetDate + 'T12:00:00');
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];

  // Get all absences this CRT is covering today
  const myAbsences = await dbAll(
    `SELECT a.*, u.email as staff_email, u.phone as staff_phone
     FROM absences a LEFT JOIN users u ON a.staff_id = u.id
     WHERE a.assigned_crt_id = ? AND a.date_start <= ? AND a.date_end >= ? AND a.status IN ('booked','contacting')
     ORDER BY a.staff_name`,
    req.user.id, targetDate, targetDate
  );

  // For each absence, pull lesson plans and timetable info
  const coverDetails = [];
  for (const abs of myAbsences) {
    // Lesson plans
    const plans = await dbAll(
      `SELECT * FROM lesson_plans WHERE teacher_id = ?
       AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))
       ORDER BY period_slot`,
      abs.staff_id, targetDate, dayName
    );
    // Sub plans
    const subPlans = await dbAll('SELECT * FROM sub_plans WHERE absence_id = ? ORDER BY created_at', abs.id);

    // Teacher's timetable slots
    let slots = [];
    try {
      const timetables = await dbAll("SELECT * FROM timetables WHERE is_current = 1");
      for (const tt of timetables) {
        let data; try { data = JSON.parse(tt.data); } catch(e) { continue; }
        if (!data || !data.headers || !data.rows) continue;
        const staffFirst = abs.staff_name.toLowerCase().split(' ')[0];
        const colIdx = data.headers.findIndex(h => h.toLowerCase().includes(staffFirst));
        if (colIdx === -1) continue;
        let inDay = false, dayStarted = false;
        for (const row of data.rows) {
          const vals = Array.isArray(row) ? row : data.headers.map(h => row[h] || '');
          const first = String(vals[0] || '').trim().toLowerCase();
          if (['monday','tuesday','wednesday','thursday','friday'].includes(first)) {
            inDay = first === dayName.toLowerCase(); dayStarted = true; continue;
          }
          if (!dayStarted) inDay = true;
          if (!inDay) continue;
          const classVal = String(vals[colIdx] || '').trim();
          if (classVal && classVal !== '-') {
            slots.push({ time: String(vals[0] || ''), className: classVal });
          }
        }
      }
    } catch(e) {}

    coverDetails.push({
      absence: abs, lessonPlans: plans, subPlans, timetableSlots: slots
    });
  }

  // Yard duty assignments for the CRT today
  const yardChanges = await dbAll(
    'SELECT * FROM yard_duty_changes WHERE date = ? AND replacement = ?',
    targetDate, req.user.name
  );

  // School info for the day (from daily zap)
  let schoolInfo = {};
  try {
    const zap = await dbGet('SELECT * FROM daily_zaps WHERE date = ?', targetDate);
    schoolInfo = zap || {};
  } catch(e) {}

  // Today's calendar events
  const events = await dbAll('SELECT * FROM calendar_events WHERE date = ? ORDER BY title', targetDate);

  res.json({
    date: targetDate, dayName,
    coverDetails,
    yardDuties: yardChanges,
    schoolInfo,
    calendarEvents: events,
    crtName: req.user.name
  });
}));

// ===== YARD DUTY SWAP SYSTEM =====
// Request a duty swap
app.post('/api/yard-duty/swap-request', auth, wrap(async (req, res) => {
  const { date, timeSlot, location, requestedStaffName, reason } = req.body;
  if (!date || !timeSlot || !location) return res.status(400).json({ error: 'Date, time slot and location required' });

  await dbRun(
    `INSERT INTO yard_duty_swaps (date, time_slot, location, requester_id, requester_name, requested_staff_name, reason, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [date, timeSlot, location, req.user.id, req.user.name, requestedStaffName || null, reason || '', 'pending']
  );
  const swapId = await dbLastId();

  // Notify the requested staff member (or all staff if open swap)
  if (requestedStaffName) {
    const target = await dbGet("SELECT id FROM users WHERE LOWER(name) LIKE ? AND active = 1", '%' + requestedStaffName.toLowerCase().split(' ')[0] + '%');
    if (target) {
      await sendPushNotification(target.id, 'staff', 'Yard Duty Swap Request',
        `${req.user.name} wants to swap yard duty on ${date} (${timeSlot} at ${location}). ${reason ? 'Reason: ' + reason : ''}`);
    }
    await addNotification(`Yard duty swap requested: ${req.user.name} → ${requestedStaffName} on ${date} (${timeSlot})`, 'info', 'leader,staff');
  } else {
    await addNotification(`Open yard duty swap: ${req.user.name} needs someone for ${date} ${timeSlot} at ${location}`, 'info', 'leader,staff');
  }

  res.json({ ok: true, id: swapId });
}));

// Accept a swap request
app.put('/api/yard-duty/swap-request/:id/accept', auth, wrap(async (req, res) => {
  const swap = await dbGet('SELECT * FROM yard_duty_swaps WHERE id = ?', parseInt(req.params.id));
  if (!swap) return res.status(404).json({ error: 'Swap not found' });
  if (swap.status !== 'pending') return res.status(400).json({ error: 'Swap already ' + swap.status });

  await dbRun('UPDATE yard_duty_swaps SET status = ?, accepted_by_id = ?, accepted_by_name = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['accepted', req.user.id, req.user.name, swap.id]);

  // Auto-update the yard duty roster change
  const existing = await dbGet('SELECT id FROM yard_duty_changes WHERE date = ? AND time_slot = ? AND location = ?',
    swap.date, swap.time_slot, swap.location);
  if (existing) {
    await dbRun('UPDATE yard_duty_changes SET replacement = ?, replacement_type = ?, auto_assigned = 0, overridden_by = ? WHERE id = ?',
      [req.user.name, 'swap', req.user.id, existing.id]);
  } else {
    await dbRun('INSERT INTO yard_duty_changes (date, time_slot, location, original_staff, replacement, replacement_type, auto_assigned, overridden_by) VALUES (?,?,?,?,?,?,0,?)',
      [swap.date, swap.time_slot, swap.location, swap.requester_name, req.user.name, 'swap', req.user.id]);
  }

  // Notify requester
  await sendPushNotification(swap.requester_id, 'staff', 'Swap Accepted!',
    `${req.user.name} accepted your yard duty swap for ${swap.date} (${swap.time_slot}).`);
  await addNotification(`Yard duty swap accepted: ${req.user.name} covering ${swap.requester_name} on ${swap.date} (${swap.time_slot})`, 'success', 'leader,staff');

  res.json({ ok: true });
}));

// Decline a swap request
app.put('/api/yard-duty/swap-request/:id/decline', auth, wrap(async (req, res) => {
  const swap = await dbGet('SELECT * FROM yard_duty_swaps WHERE id = ?', parseInt(req.params.id));
  if (!swap) return res.status(404).json({ error: 'Swap not found' });
  await dbRun('UPDATE yard_duty_swaps SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?', ['declined', swap.id]);
  await sendPushNotification(swap.requester_id, 'staff', 'Swap Declined',
    `${req.user.name} declined the yard duty swap for ${swap.date} (${swap.time_slot}).`);
  res.json({ ok: true });
}));

// Get swap requests
app.get('/api/yard-duty/swap-requests', auth, wrap(async (req, res) => {
  const { status, date } = req.query;
  let sql = 'SELECT * FROM yard_duty_swaps WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (date) { sql += ' AND date = ?'; params.push(date); }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  res.json(await dbAll(sql, ...params));
}));

// ===== NFT (Non-Face-to-Face Time) TRACKING =====
app.get('/api/nft', auth, wrap(async (req, res) => {
  const { staffId, weekOf, date } = req.query;
  let sql = 'SELECT * FROM nft_records WHERE 1=1';
  const params = [];
  if (staffId) { sql += ' AND staff_id = ?'; params.push(parseInt(staffId)); }
  if (weekOf) { sql += ' AND date >= ? AND date <= date(?, "+4 days")'; params.push(weekOf, weekOf); }
  if (date) { sql += ' AND date = ?'; params.push(date); }
  sql += ' ORDER BY date DESC, created_at DESC';
  res.json(await dbAll(sql, ...params));
}));

app.post('/api/nft', auth, wrap(async (req, res) => {
  const { staffId, date, periodSlot, type, minutes, reason, notes } = req.body;
  const sid = staffId || req.user.id;
  if (!date || !type) return res.status(400).json({ error: 'Date and type required' });
  const staff = await dbGet('SELECT name FROM users WHERE id = ?', sid);
  await dbRun(
    `INSERT INTO nft_records (staff_id, staff_name, date, period_slot, type, minutes, reason, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [sid, staff ? staff.name : 'Unknown', date, periodSlot || '', type, minutes || 0, reason || '', notes || '', req.user.id]
  );
  const id = await dbLastId();

  // Notify the staff member if it's an extra NFT
  if (type === 'extra' && sid !== req.user.id && staff) {
    await sendPushNotification(sid, 'staff', 'Extra NFT Granted',
      `You have been given extra NFT on ${date}${periodSlot ? ' (' + periodSlot + ')' : ''}. ${reason || ''}`);
    await addNotification(`Extra NFT: ${staff.name} on ${date}${periodSlot ? ' (' + periodSlot + ')' : ''} — ${reason || 'No reason given'}`, 'info', 'leader,staff');
  }
  if (type === 'lost' && staff) {
    await addNotification(`NFT lost: ${staff.name} on ${date}${periodSlot ? ' (' + periodSlot + ')' : ''} — ${reason || ''}`, 'info', 'leader');
  }

  res.json({ ok: true, id });
}));

app.delete('/api/nft/:id', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM nft_records WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

// NFT summary for a staff member (weekly/term totals)
app.get('/api/nft/summary/:staffId', auth, wrap(async (req, res) => {
  const sid = parseInt(req.params.staffId);
  const thisYear = new Date().getFullYear();
  const scheduled = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'scheduled' AND date >= ?", sid, `${thisYear}-01-01`);
  const extra = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'extra' AND date >= ?", sid, `${thisYear}-01-01`);
  const lost = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'lost' AND date >= ?", sid, `${thisYear}-01-01`);
  const covered = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'covered_duty' AND date >= ?", sid, `${thisYear}-01-01`);
  res.json({
    staffId: sid,
    year: thisYear,
    scheduled: scheduled?.total || 0,
    extra: extra?.total || 0,
    lost: lost?.total || 0,
    coveredDuty: covered?.total || 0,
    net: (scheduled?.total || 0) + (extra?.total || 0) - (lost?.total || 0)
  });
}));

// ===== LEADERSHIP DASHBOARD ENHANCED =====
app.get('/api/dashboard/leadership', auth, leaderOnly, wrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];

  // Who's away today
  const awayToday = await dbAll(
    "SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.staff_name",
    today, today
  );

  // Pending swap requests
  const pendingSwaps = await dbAll("SELECT * FROM yard_duty_swaps WHERE status = 'pending' AND date >= ? ORDER BY date", today);

  // Today's specialist alerts
  let specAlerts = [];
  try { specAlerts = await dbAll("SELECT * FROM class_absence_alerts WHERE date = ? ORDER BY specialist_name", today); } catch(e) {}

  // Recent NFT changes
  const recentNft = await dbAll("SELECT * FROM nft_records WHERE date >= date(?, '-7 days') ORDER BY date DESC, created_at DESC LIMIT 20", today);

  // CRT pack status — which absences have lesson plans ready
  const packStatus = [];
  for (const abs of awayToday) {
    const planCount = await dbGet(
      `SELECT COUNT(*) as c FROM lesson_plans WHERE teacher_id = ?
       AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))`,
      abs.staff_id, today, dayName
    );
    const subPlanCount = await dbGet('SELECT COUNT(*) as c FROM sub_plans WHERE absence_id = ?', abs.id);
    packStatus.push({
      absenceId: abs.id, staffName: abs.staff_name, area: abs.area,
      crtName: abs.crt_name, status: abs.status,
      lessonPlans: planCount?.c || 0, subPlans: subPlanCount?.c || 0,
      packReady: (planCount?.c || 0) > 0 || (subPlanCount?.c || 0) > 0
    });
  }

  // Today's yard duty roster with changes
  const roster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY time_slot, location', dayName);
  const changes = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY time_slot', today);

  res.json({
    date: today, dayName,
    awayToday, pendingSwaps, specialistAlerts: specAlerts,
    recentNft, packStatus,
    yardDuty: { roster, changes }
  });
}));

// ===== SERVE FRONTEND =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ===== STARTUP =====
async function start() {
  if (USE_TURSO) {
    // Use Turso cloud database
    const { createClient } = require('@libsql/client');
    _tursoDb = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
    });
    console.log('Connected to Turso database');

    // Check if tables exist, if not run setup
    try {
      await _tursoDb.execute('SELECT 1 FROM users LIMIT 1');
      console.log('Turso database ready');
    } catch (e) {
      console.log('Turso tables not found, running setup...');
      await runTursoSetup();
    }
  } else {
    // Use local sql.js database
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      _sqlDb = new SQL.Database(fileBuffer);
      console.log('Loaded existing local database');
    } else {
      console.log('Database not found. Running setup...');
      require('child_process').execSync('node setup-db.js', { cwd: __dirname, stdio: 'inherit' });
      const fileBuffer = fs.readFileSync(DB_PATH);
      _sqlDb = new SQL.Database(fileBuffer);
    }
  }

  // Ensure schema is up to date
  try { await dbRun(`CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER,
    FOREIGN KEY (updated_by) REFERENCES users(id)
  )`); } catch(e) {}
  // Seed defaults if empty
  const settingsCount = await dbGet('SELECT COUNT(*) as c FROM system_settings');
  if (!settingsCount || settingsCount.c === 0) {
    const defaults = [['auto_contact_crts','1'],['auto_approve_crts','0'],['notify_leaders_absence','1'],['leader_notify_sms','1'],['leader_notify_email','1'],['leader_notify_app','1'],['notify_staff_booked','1'],['staff_notify_sms','0'],['staff_notify_email','1']];
    for (const [k,v] of defaults) { try { await dbRun('INSERT INTO system_settings (key, value) VALUES (?, ?)', [k, v]); } catch(e) {} }
  }
  try { await dbRun('CREATE INDEX IF NOT EXISTS idx_absences_status ON absences(status)'); } catch(e) {}
  try { await dbRun("ALTER TABLE absences ADD COLUMN half_day TEXT DEFAULT 'full'"); } catch(e) {}
  try { await dbRun("ALTER TABLE crts ADD COLUMN pin_hash TEXT"); } catch(e) {}

  // v3.0 tables
  try { await dbRun(`CREATE TABLE IF NOT EXISTS sub_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absence_id INTEGER NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (absence_id) REFERENCES absences(id)
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_type TEXT DEFAULT 'staff',
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  try { await dbRun("ALTER TABLE absences ADD COLUMN is_prebooked INTEGER DEFAULT 0"); } catch(e) {}
  try { await dbRun("ALTER TABLE absences ADD COLUMN recurrence TEXT DEFAULT 'none'"); } catch(e) {}

  // v4.0 tables - Daily Zap
  try { await dbRun(`CREATE TABLE IF NOT EXISTS daily_zaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    weekly_quote TEXT DEFAULT '',
    quote_author TEXT DEFAULT '',
    daily_org TEXT DEFAULT '',
    es_notes TEXT DEFAULT '',
    nft_notes TEXT DEFAULT '',
    extra_notes TEXT DEFAULT '',
    movements TEXT DEFAULT '',
    created_by INTEGER,
    updated_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS yard_duty_roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    location TEXT NOT NULL,
    staff_name TEXT NOT NULL,
    is_leadership INTEGER DEFAULT 0,
    term INTEGER DEFAULT 1
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS yard_duty_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    location TEXT NOT NULL,
    original_staff TEXT,
    replacement TEXT,
    replacement_type TEXT DEFAULT 'crt',
    auto_assigned INTEGER DEFAULT 0,
    overridden_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    term INTEGER DEFAULT 1,
    week_num INTEGER,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS timetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    term INTEGER DEFAULT 1,
    data TEXT NOT NULL,
    is_current INTEGER DEFAULT 0,
    uploaded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  // v5.0 tables — LessonLab, Yard Duty Swaps, NFT Tracking
  try { await dbRun(`CREATE TABLE IF NOT EXISTS lesson_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    day_of_week TEXT,
    specific_date TEXT,
    period_slot TEXT DEFAULT '',
    subject TEXT NOT NULL,
    class_name TEXT DEFAULT '',
    plan_title TEXT DEFAULT '',
    plan_content TEXT NOT NULL,
    resources TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    updated_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id)
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS yard_duty_swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    location TEXT NOT NULL,
    requester_id INTEGER NOT NULL,
    requester_name TEXT NOT NULL,
    requested_staff_name TEXT,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    accepted_by_id INTEGER,
    accepted_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (requester_id) REFERENCES users(id)
  )`); } catch(e) {}

  try { await dbRun(`CREATE TABLE IF NOT EXISTS nft_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    staff_name TEXT NOT NULL,
    date TEXT NOT NULL,
    period_slot TEXT DEFAULT '',
    type TEXT NOT NULL DEFAULT 'scheduled',
    minutes INTEGER DEFAULT 0,
    reason TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES users(id)
  )`); } catch(e) {}

  // v4.4 table - Specialist class absence alerts
  try { await dbRun(`CREATE TABLE IF NOT EXISTS class_absence_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    specialist_name TEXT NOT NULL,
    time_slot TEXT NOT NULL,
    class_name TEXT NOT NULL,
    absent_staff_id INTEGER,
    absent_staff_name TEXT,
    absence_id INTEGER,
    timetable_id INTEGER,
    notified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (absence_id) REFERENCES absences(id)
  )`); } catch(e) {}

  // Generate VAPID keys if not stored
  try {
    const existingVapid = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_public_key'");
    if (!existingVapid) {
      const webpush = require('web-push');
      const vapidKeys = webpush.generateVAPIDKeys();
      try { await dbRun("INSERT INTO system_settings (key, value) VALUES (?, ?)", ['vapid_public_key', vapidKeys.publicKey]); } catch(e) {}
      try { await dbRun("INSERT INTO system_settings (key, value) VALUES (?, ?)", ['vapid_private_key', vapidKeys.privateKey]); } catch(e) {}
    }
  } catch(e) { console.log('VAPID key generation skipped:', e.message); }

  try { await dbRun(`CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    notifications_enabled INTEGER DEFAULT 1,
    quiet_start TEXT DEFAULT '21:00',
    quiet_end TEXT DEFAULT '06:00',
    notify_sms INTEGER DEFAULT 1,
    notify_email INTEGER DEFAULT 1,
    notify_app INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`); } catch(e) {}

  if (!USE_TURSO) {
    process.on('SIGINT', () => { saveLocalDbNow(); process.exit(); });
    process.on('SIGTERM', () => { saveLocalDbNow(); process.exit(); });
  }

  app.listen(PORT, () => {
    console.log(`\n  WPS Staff Hub v5.0`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Database: ${USE_TURSO ? 'Turso (cloud)' : 'sql.js (local)'}`);
    console.log(`  Notifications: ${LIVE ? 'LIVE' : 'SIMULATED'}`);
    console.log(`  Demo auto-confirm: ${DEMO ? 'ON' : 'OFF'}\n`);
  });
}

// Run Turso setup - creates tables from schema.sql, then seeds via setup-db.js --turso
async function runTursoSetup() {
  // Step 1: Create tables from schema.sql
  const setupSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = setupSQL.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    try { await _tursoDb.execute(stmt); } catch(e) { console.log('Schema statement skipped:', e.message); }
  }
  console.log('Turso schema created');

  // Step 2: Seed data via setup-db.js --turso
  require('child_process').execSync('node setup-db.js --turso', { cwd: __dirname, stdio: 'inherit' });
  console.log('Turso seeding complete');
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
