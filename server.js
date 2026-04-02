// WPS Staff Hub - Production Server v7.0 (Turso + sql.js fallback)
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
  return r ? r.id : null;
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
// No-cache headers for index.html and sw.js so updates load immediately
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Executive leadership (Principal, AP) — never assigned classes, yard duty, or covers
function isExecLeadership(area) {
  if (!area) return false;
  const a = area.toLowerCase();
  return a.includes('principal') || a === 'ap' || a === 'assistant principal' || a === 'leadership';
}

function wrap(fn) {
  return function(req, res, next) {
    fn(req, res, next).catch(function(err) {
      console.error('Route error:', req.method, req.path, err);
      res.status(500).json({ error: 'Server error', detail: err.message || String(err) });
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
      const userType = role === 'crt' ? 'crt' : 'staff'; // leaders subscribe as 'staff' user_type
      // Get subscribed users matching the target role(s)
      let subs;
      if (role === 'leader') {
        subs = await dbAll(
          `SELECT DISTINCT ps.user_id FROM push_subscriptions ps
           INNER JOIN users u ON u.id = ps.user_id AND u.active = 1
           WHERE ps.user_type = 'staff' AND u.role IN ('leader','admin')`
        );
      } else {
        subs = await dbAll('SELECT DISTINCT user_id FROM push_subscriptions WHERE user_type = ?', userType);
      }
      for (const s of subs) {
        // Check notification preferences - determine category from message content
        let category = 'general_updates';
        const msgLower = message.toLowerCase();
        if (msgLower.includes('yard duty') || msgLower.includes('yard')) category = 'yard_duty';
        else if (msgLower.includes('swap')) category = 'swap_requests';
        else if (msgLower.includes('absence') || msgLower.includes('absent') || msgLower.includes('away') || msgLower.includes('cancelled')) category = 'absences';
        else if (msgLower.includes('announcement')) category = 'announcements';
        else if (msgLower.includes('wellbeing') || msgLower.includes('well-being')) category = 'wellbeing';
        else if (msgLower.includes('crt') || msgLower.includes('booked') || msgLower.includes('confirmed')) category = 'crt_assignments';
        else if (msgLower.includes('timetable') || msgLower.includes('schedule')) category = 'timetable_changes';

        // Check if user has this category disabled
        const pref = await dbGet('SELECT enabled FROM notification_preferences WHERE user_id = ? AND category = ?', s.user_id, category);
        if (pref && (pref.enabled === 0 || pref.enabled === false)) continue; // Skip if disabled

        sendPushNotification(s.user_id, userType, pushTitle, message).catch(() => {});
      }
    }
  } catch (e) { /* push is best-effort */ }
}

// ===== HEALTH & VERSION =====
app.get('/api/health', wrap(async (req, res) => {
  try {
    await dbGet('SELECT 1 as ok');
    res.json({ status: 'ok', version: '7.4.0', database: USE_TURSO ? 'turso' : 'local', uptime: Math.floor(process.uptime()) });
  } catch (e) {
    res.status(503).json({ status: 'error', error: 'Database unreachable' });
  }
}));

app.get('/api/version', (req, res) => {
  res.json({ version: '7.0.0', features: ['daily-zap', 'yard-duty', 'calendar', 'timetables', 'push-notifications', 'crt-auto-booking', 'staff-management', 'dashboard', 'lessonlab', 'crt-portal', 'yard-duty-swaps', 'nft-tracking', 'specialist-alerts', 'analytics', 'school-info', 'staff-directory', 'announcements', 'wellbeing', 'incidents', 'quick-status', 'pd-log', 'cover-summary', 'csv-timetable-upload', 'lesson-plan-edit'] });
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

// ===== CHANGE PIN =====
app.post('/api/change-pin', auth, wrap(async (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: 'Current PIN and new PIN required' });
  if (newPin.length < 4 || newPin.length > 6) return res.status(400).json({ error: 'New PIN must be 4-6 digits' });
  const user = await dbGet('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPin, user.pin_hash)) return res.status(401).json({ error: 'Current PIN is incorrect' });
  const newHash = bcrypt.hashSync(newPin, 10);
  await dbRun('UPDATE users SET pin_hash = ? WHERE id = ?', [newHash, req.user.id]);
  res.json({ ok: true, message: 'PIN updated successfully' });
}));

// ===== NOTIFICATION PREFERENCES =====
app.get('/api/notification-preferences', auth, wrap(async (req, res) => {
  const prefs = await dbAll('SELECT category, enabled FROM notification_preferences WHERE user_id = ?', req.user.id);
  // Return all categories with defaults (all enabled if not set)
  const categories = ['yard_duty','swap_requests','absences','announcements','wellbeing','crt_assignments','timetable_changes','general_updates'];
  const map = {};
  prefs.forEach(p => { map[p.category] = p.enabled; });
  const result = {};
  categories.forEach(c => { result[c] = map[c] !== undefined ? (map[c] === 1 || map[c] === true) : true; });
  res.json(result);
}));

app.put('/api/notification-preferences', auth, wrap(async (req, res) => {
  const { category, enabled } = req.body;
  const categories = ['yard_duty','swap_requests','absences','announcements','wellbeing','crt_assignments','timetable_changes','general_updates'];
  if (!categories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  const existing = await dbGet('SELECT id FROM notification_preferences WHERE user_id = ? AND category = ?', req.user.id, category);
  if (existing) {
    await dbRun('UPDATE notification_preferences SET enabled = ? WHERE user_id = ? AND category = ?', [enabled ? 1 : 0, req.user.id, category]);
  } else {
    await dbRun('INSERT INTO notification_preferences (user_id, category, enabled) VALUES (?, ?, ?)', [req.user.id, category, enabled ? 1 : 0]);
  }
  res.json({ ok: true });
}));

// Leader: get ALL staff notification preferences
app.get('/api/notification-preferences/all', auth, leaderOnly, wrap(async (req, res) => {
  const users = await dbAll("SELECT id, name, role, area FROM users WHERE active = 1");
  const categories = ['yard_duty','swap_requests','absences','announcements','wellbeing','crt_assignments','timetable_changes','general_updates'];
  const result = [];
  for (const u of users) {
    const prefs = await dbAll('SELECT category, enabled FROM notification_preferences WHERE user_id = ?', u.id);
    const map = {};
    prefs.forEach(p => { map[p.category] = p.enabled; });
    const p = {};
    categories.forEach(c => { p[c] = map[c] !== undefined ? (map[c] === 1 || map[c] === true) : true; });
    result.push({ ...u, prefs: p });
  }
  res.json(result);
}));

// Leader: update a specific staff member's notification preferences
app.put('/api/notification-preferences/:userId', auth, leaderOnly, wrap(async (req, res) => {
  const targetUserId = parseInt(req.params.userId);
  const targetUser = await dbGet('SELECT id FROM users WHERE id = ? AND active = 1', targetUserId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  const { category, enabled } = req.body;
  const categories = ['yard_duty','swap_requests','absences','announcements','wellbeing','crt_assignments','timetable_changes','general_updates'];
  if (!categories.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  const existing = await dbGet('SELECT id FROM notification_preferences WHERE user_id = ? AND category = ?', targetUserId, category);
  if (existing) {
    await dbRun('UPDATE notification_preferences SET enabled = ? WHERE user_id = ? AND category = ?', [enabled ? 1 : 0, targetUserId, category]);
  } else {
    await dbRun('INSERT INTO notification_preferences (user_id, category, enabled) VALUES (?, ?, ?)', [targetUserId, category, enabled ? 1 : 0]);
  }
  res.json({ ok: true });
}));

// Leader: bulk update all notification preferences for a staff member
app.put('/api/notification-preferences/:userId/bulk', auth, leaderOnly, wrap(async (req, res) => {
  const targetUserId = parseInt(req.params.userId);
  const targetUser = await dbGet('SELECT id FROM users WHERE id = ? AND active = 1', targetUserId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  const { prefs } = req.body; // { category: boolean, ... }
  const categories = ['yard_duty','swap_requests','absences','announcements','wellbeing','crt_assignments','timetable_changes','general_updates'];
  for (const cat of categories) {
    if (prefs[cat] === undefined) continue;
    const enabled = prefs[cat] ? 1 : 0;
    const existing = await dbGet('SELECT id FROM notification_preferences WHERE user_id = ? AND category = ?', targetUserId, cat);
    if (existing) {
      await dbRun('UPDATE notification_preferences SET enabled = ? WHERE user_id = ? AND category = ?', [enabled, targetUserId, cat]);
    } else {
      await dbRun('INSERT INTO notification_preferences (user_id, category, enabled) VALUES (?, ?, ?)', [targetUserId, cat, enabled]);
    }
  }
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

  // Auto-lookup affected classes from timetable if not provided
  let finalClasses = classes || '';
  if (!finalClasses) {
    try {
      const autoClasses = await lookupClassesForStaff(staffUser.id, dateStart);
      if (autoClasses.length > 0) finalClasses = autoClasses.map(c => c.class || c).join(', ');
    } catch(e) { console.log('Timetable class lookup skipped:', e.message); }
  }

  await dbRun(
    'INSERT INTO absences (staff_id, staff_name, area, date_start, date_end, reason, classes, notes, half_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [staffUser.id, staffUser.name, staffUser.area, dateStart, dateEnd || dateStart, reason, finalClasses, notes || '', halfDay || 'full']
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
    version: '7.0.0',
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

async function sendPushToAll(title, body) {
  try {
    const webpush = require('web-push');
    const pubKey = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_public_key'");
    const privKey = await dbGet("SELECT value FROM system_settings WHERE key = 'vapid_private_key'");
    if (!pubKey || !privKey) return;
    webpush.setVapidDetails('mailto:admin@wps-staff-hub.onrender.com', pubKey.value, privKey.value);
    const subs = await dbAll('SELECT * FROM push_subscriptions');
    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key }
        }, JSON.stringify({ title, body }));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await dbRun('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
        }
      }
    }
  } catch (e) {
    console.log('Push to all error:', e.message);
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
      const absRecord = await dbGet('SELECT * FROM absences WHERE id = ?', id);
      if (absRecord) setTimeout(() => autoBookCRT(absRecord).catch(e => console.error('Auto-book CRT error:', e.message)), 500);
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
  const roster = await dbAll(`SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location`, dayName);
  const changes = await dbAll(`SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location`, date);

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

// Personal daily schedule for a teacher
app.get('/api/my-schedule/:date', auth, wrap(async (req, res) => {
  const date = req.params.date;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()];
  const userName = req.user.name;
  const userId = req.user.id;
  const firstName = userName.split(' ')[0].toLowerCase();

  // Yard duty roster uses FIRST NAMES only — must match with LIKE
  const allRoster = await dbAll('SELECT * FROM yard_duty_roster WHERE day_of_week = ?', dayName);
  const myDuties = allRoster.filter(r => r.staff_name.toLowerCase() === firstName || r.staff_name.toLowerCase().includes(firstName));

  const dutyChanges = await dbAll('SELECT * FROM yard_duty_changes WHERE date = ?', date);

  // Duty changes where I'm the replacement (covering someone else)
  const coveringDuties = dutyChanges.filter(c => c.replacement && c.replacement.toLowerCase().includes(firstName));

  // Duty changes for MY duties (someone covering me)
  const myDutyChanges = dutyChanges.filter(c => c.original_staff && c.original_staff.toLowerCase().includes(firstName));

  // Am I absent? (include CRT name via join)
  const myAbsence = await dbGet("SELECT a.*, c.name as crt_name FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.staff_id = ? AND a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled'", userId, date, date);

  // My timetable classes for this day
  let myClasses = [];
  try {
    myClasses = await lookupClassesForStaff(userId, date);
  } catch(e) {}

  // Build full day schedule (all 5 sessions)
  let fullSchedule = [];
  try {
    const user = await dbGet('SELECT id, name, area FROM users WHERE id = ?', userId);
    if (user && !isExecLeadership(user.area)) {
      const sessions = [
        { num: 1, time: '9:00-10:00' },
        { num: 2, time: '10:00-11:00' },
        { num: 3, time: '11:30-12:30' },
        { num: 4, time: '12:30-1:30' },
        { num: 5, time: '2:30-3:30' }
      ];
      // Get the user's own class from classroom timetable
      const classroomEntry = myClasses.find(c => !c.time || c.time === '');
      const ownClass = classroomEntry?.class || '';

      // Check specialist timetable to see when this class goes to a specialist
      const specTTs = await dbAll("SELECT * FROM timetables WHERE is_current = 1 AND type = 'specialist'");
      const specSessionMap = {}; // time -> { specialist, class }
      for (const tt of specTTs) {
        let data; try { data = JSON.parse(tt.data); } catch(e) { continue; }
        if (!data || !data.headers || !data.rows) continue;
        const headers = data.headers;
        let inDay = false, dayStarted = false;
        for (const row of data.rows) {
          const vals = Array.isArray(row) ? row : headers.map(h2 => row[h2] || '');
          const fc = String(vals[0] || '').trim().toLowerCase();
          if (['monday','tuesday','wednesday','thursday','friday'].includes(fc)) {
            inDay = fc === dayName.toLowerCase(); dayStarted = true; continue;
          }
          if (!dayStarted) inDay = true;
          if (!inDay) continue;
          const timeSlot = String(vals[0] || '').trim();
          for (let ci = 1; ci < headers.length; ci++) {
            const cell = String(vals[ci] || '').trim();
            if (!cell || cell === '-') continue;
            // Check if this cell matches the teacher's class
            const cellLower = cell.toLowerCase();
            const ownLower = ownClass.toLowerCase().replace(/\s+/g, '');
            const cellClean = cellLower.replace(/\s+/g, '');
            if (ownLower.length > 1 && (cellClean === ownLower || cellClean.includes(ownLower) || ownLower.includes(cellClean))) {
              specSessionMap[timeSlot] = { specialist: headers[ci], class: cell };
            }
          }
        }
      }

      // Also check if the user IS a specialist (has time-based entries)
      const isSpecialist = myClasses.some(c => c.time && c.time !== '');

      if (isSpecialist) {
        // Specialist teacher: show their classes from timetable directly
        for (const s of sessions) {
          const match = myClasses.find(c => c.time === s.time);
          fullSchedule.push({ session: s.num, time: s.time, activity: match ? match.class : 'NFT / Planning', type: match ? 'teaching' : 'nft' });
        }
      } else if (ownClass || Object.keys(specSessionMap).length > 0) {
        // Classroom teacher: show own class or specialist lesson
        // Only build if they actually have a class or specialist sessions
        for (const s of sessions) {
          const spec = specSessionMap[s.time];
          if (spec) {
            fullSchedule.push({ session: s.num, time: s.time, activity: spec.specialist + ' lesson', type: 'specialist' });
          } else if (ownClass) {
            fullSchedule.push({ session: s.num, time: s.time, activity: ownClass, type: 'teaching' });
          } else {
            fullSchedule.push({ session: s.num, time: s.time, activity: 'Class', type: 'teaching' });
          }
        }
      }
    }
  } catch(e) { console.log('Full schedule build skipped:', e.message); }

  // All absences today (for NFT calculation)
  const allAbsToday = await dbAll("SELECT a.*, u.name as staff_name, c.name as crt_name FROM absences a JOIN users u ON a.staff_id = u.id LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled'", date, date);

  // NFT: am I covering someone else's classes? (I'm the CRT for their absence)
  const coveredByMe = allAbsToday.filter(a => a.crt_name && a.crt_name.toLowerCase().includes(firstName));

  // Am I being covered? (someone is subbing my classes because I'm absent)
  const myCoverage = myAbsence && myAbsence.status === 'booked' ? { covered: true, crtName: myAbsence.crt_name || '' } : null;

  // CRT covering info: what absences am I booked for today?
  let crtCovering = [];
  if (req.user.role === 'crt') {
    const myCrtBookings = await dbAll(
      "SELECT a.*, u.name as staff_name, u.area as staff_area FROM absences a JOIN users u ON a.staff_id = u.id WHERE a.assigned_crt_id = ? AND a.date_start <= ? AND a.date_end >= ? AND a.status = 'booked'",
      userId, date, date);
    for (const booking of myCrtBookings) {
      let theirClasses = [];
      try { theirClasses = await lookupClassesForStaff(booking.staff_id, date); } catch(e) {}
      // Roster uses first names — match on first name of absent staff
      const absentFirst = booking.staff_name.split(' ')[0].toLowerCase();
      const theirDuties = allRoster.filter(r => r.staff_name.toLowerCase() === absentFirst || r.staff_name.toLowerCase().includes(absentFirst));
      crtCovering.push({
        staffName: booking.staff_name,
        staffArea: booking.staff_area,
        classes: booking.classes || '',
        timetableClasses: theirClasses,
        duties: theirDuties,
        halfDay: booking.half_day || 'full'
      });
    }
  }

  // Swap requests involving me
  const mySwaps = await dbAll(
    "SELECT * FROM yard_duty_swaps WHERE date = ? AND (requester_id = ? OR requested_staff_name = ?)",
    date, userId, userName);

  // Day confirmation status
  const zapRow = await dbGet('SELECT day_confirmed, confirmed_by_name, confirmed_at FROM daily_zaps WHERE date = ?', date);
  const dayConfirmed = zapRow && zapRow.day_confirmed === 1;
  const confirmedBy = zapRow ? zapRow.confirmed_by_name || '' : '';

  res.json({
    date, dayName, userName,
    absent: myAbsence || null,
    duties: myDuties,
    dutyChanges: myDutyChanges,
    coveringDuties,
    classes: myClasses,
    fullSchedule,
    swaps: mySwaps,
    myCoverage,
    nft: coveredByMe.length > 0 ? coveredByMe.map(a => ({ staffName: a.staff_name, classes: a.classes })) : [],
    crtCovering,
    dayConfirmed,
    confirmedBy
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

// Confirm/unconfirm day (leader only)
app.put('/api/day-confirm/:date', auth, leaderOnly, wrap(async (req, res) => {
  // Only AP (Assistant Principal) can confirm the day
  const userArea = (req.user.area || '').toLowerCase();
  if (!userArea.includes('assistant principal') && !userArea.includes(' ap')) {
    return res.status(403).json({ error: 'Only the Assistant Principal can confirm the day' });
  }
  const date = req.params.date;
  const confirm = (req.body.confirm !== false && req.body.confirmed !== false); // default true
  const existing = await dbGet('SELECT id FROM daily_zaps WHERE date = ?', date);
  if (existing) {
    if (confirm) {
      await dbRun('UPDATE daily_zaps SET day_confirmed = 1, confirmed_by = ?, confirmed_by_name = ?, confirmed_at = CURRENT_TIMESTAMP WHERE date = ?',
        [req.user.id, req.user.name, date]);
    } else {
      await dbRun('UPDATE daily_zaps SET day_confirmed = 0, confirmed_by = NULL, confirmed_by_name = NULL, confirmed_at = NULL WHERE date = ?',
        [date]);
    }
  } else {
    // Create a minimal daily_zaps row with confirmation
    if (confirm) {
      await dbRun('INSERT INTO daily_zaps (date, day_confirmed, confirmed_by, confirmed_by_name, confirmed_at, created_by) VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP, ?)',
        [date, req.user.id, req.user.name, req.user.id]);
    }
  }
  res.json({ ok: true, confirmed: confirm });
}));

// ===== YARD DUTY =====
// Get full roster
app.get('/api/yard-duty/roster', auth, wrap(async (req, res) => {
  const { term } = req.query;
  let sql = 'SELECT * FROM yard_duty_roster';
  const params = [];
  if (term) { sql += ' WHERE term = ?'; params.push(parseInt(term)); }
  sql += " ORDER BY CASE day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 END, CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location";
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

  const roster = await dbAll(`SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location`, dayName);
  const changes = await dbAll(`SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location`, date);

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
    // Filter out leadership from roster — Principal/AP never get covers assigned
    const leadershipNames = (await dbAll("SELECT name FROM users WHERE area IN ('Principal','Assistant Principal','AP') OR role = 'admin'")).map(u => u.name.toLowerCase());
    const nonLeadershipRoster = roster.filter(r => {
          if (r.is_leadership) return false;
          if (leadershipNames.some(ln => r.staff_name.toLowerCase().includes(ln.split(' ')[0]))) return false;
          return true;
    });

  // Find duties that need cover
  const needsCover = nonLeadershipRoster.filter(r => absentNames.some(n => r.staff_name.toLowerCase().includes(n.toLowerCase().split(' ')[0])));

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

      // Auto-create NFT record for duty cover
      try {
        const coverUser = await dbGet("SELECT id FROM users WHERE name LIKE ? OR name LIKE ?",
          `%${crtName.split(' ')[0]}%`, crtName);
        if (coverUser) {
          const existingNft = await dbGet(
            "SELECT id FROM nft_records WHERE staff_id = ? AND date = ? AND period_slot = ? AND type = 'covered_duty'",
            coverUser.id, date, duty.time_slot);
          if (!existingNft) {
            await dbRun(
              `INSERT INTO nft_records (staff_id, staff_name, date, period_slot, type, minutes, reason, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
              [coverUser.id, crtName, date, duty.time_slot, 'covered_duty', 30,
               `Yard duty cover: ${duty.time_slot} at ${duty.location} (for ${duty.staff_name})`, 'auto', 0]);
          }
        }
      } catch(nftErr) { console.log('Auto NFT skip:', nftErr.message); }
    }
  }
  return { assigned, needsCover: needsCover.length };
}

// ===== SPECIALIST CLASS ABSENCE ALERTS =====
// When a classroom teacher is absent, check the specialist timetable to see which
// specialist teachers are affected and auto-notify them before they set up for a lesson.
async function notifySpecialists(absence) {
  // Executive leadership has no classes — nothing to notify
  if (isExecLeadership(absence.area)) return { alerts: 0 };

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
        const cellRaw = String(rowValues[ci] || '').trim();
        const cellValue = cellRaw.toLowerCase();
        if (!cellValue || cellValue === '-' || ['nft','planning','recess','lunch','assembly','duty','easter','hat parade','good friday','resources',''].includes(cellValue)) continue;

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
                [date, specialistName, timeSlot, cellRaw, absence.staff_id, staffName, absence.id, tt.id]
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
                `${staffName}'s class (${cellRaw}) won't be in for ${specialistName} at ${timeSlot} on ${date}. ${staffName} is away — ${absence.reason}.`
              );
            }
          } catch(e) { /* push is best-effort */ }
        }
      }
    }
  }
h
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

// CSV/Tab paste → JSON timetable converter
app.post('/api/timetables/from-csv', auth, leaderOnly, wrap(async (req, res) => {
  const { name, type, term, csvText, is_current } = req.body;
  if (!name || !csvText) return res.status(400).json({ error: 'Name and CSV text required' });
  // Parse CSV/tab-separated text into {headers, rows}
  const lines = csvText.trim().split('\n').map(l => l.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim()));
  if (lines.length < 2) return res.status(400).json({ error: 'Need at least a header row and one data row' });
  const headers = lines[0];
  const rows = lines.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
  const data = JSON.stringify({ headers, rows });
  if (is_current) {
    await dbRun('UPDATE timetables SET is_current = 0 WHERE type = ?', [type || 'general']);
  }
  await dbRun('INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?,?,?,?,?,?)',
    [name, type || 'general', term || 1, data, is_current ? 1 : 0, req.user.id]);
  res.json({ ok: true, id: await dbLastId(), headers, rowCount: rows.length });
}));

// ===== TIMETABLE CLASS LOOKUP =====
// Returns array of {time, class} objects for the given staff member on the given date
async function lookupClassesForStaff(staffId, date) {
  const user = await dbGet('SELECT id, name, area FROM users WHERE id = ?', staffId);
  if (!user) return [];

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(date + 'T12:00:00');
  const dayName = dayNames[d.getDay()].toLowerCase();

  const timetables = await dbAll("SELECT * FROM timetables WHERE is_current = 1 AND type != 'yard_duty'");
  if (timetables.length === 0) return [];

  const staffName = user.name.toLowerCase();
  const staffFirst = staffName.split(' ')[0];
  const staffLast = staffName.split(' ').slice(1).join(' ');
  const rawAreaKeywords = user.area ? user.area.toLowerCase().replace(/[()]/g,'').split(/[\s\/,&]+/).filter(w => w.length > 1) : [];
  // Add known specialist aliases (area term → timetable header) — aliases go FIRST for priority
  const specAliases = {'performing':'music','visual':'art','lote':'french','health':'pe','kitchen':'extra','garden':'extra'};
  const aliasKeywords = [];
  for (const kw of rawAreaKeywords) {
    if (specAliases[kw]) aliasKeywords.push(specAliases[kw]);
  }
  const areaKeywords = [...aliasKeywords, ...rawAreaKeywords];
  const classes = []; // Array of {time, class} objects

  const skip = ['nft','planning','recess','lunch','assembly','duty','easter','hat parade','good friday','resources',''];

  for (const tt of timetables) {
    let data;
    try { data = JSON.parse(tt.data); } catch(e) { continue; }
    if (!data || !data.headers || !data.rows) continue;

    const headers = data.headers;
    const rows = data.rows;

    // Find this staff member's column
    let staffColIndex = -1;
    for (let ci = 0; ci < headers.length; ci++) {
      const h = headers[ci].toLowerCase().trim();
      if (h === staffName) { staffColIndex = ci; break; }
      if (staffFirst.length > 2 && h.includes(staffFirst)) { staffColIndex = ci; break; }
      if (staffLast.length > 2 && h.includes(staffLast)) { staffColIndex = ci; break; }
      if (tt.type === 'specialist' && areaKeywords.length > 0) {
        // Exact match only in first pass (fuzzy second pass below)
        for (const kw of areaKeywords) {
          if (h === kw) { staffColIndex = ci; break; }
        }
        if (staffColIndex >= 0) break;
      }
    }
    // Second pass: fuzzy match for specialist headers (only if exact match failed)
    if (staffColIndex < 0 && tt.type === 'specialist' && areaKeywords.length > 0) {
      for (let ci = 0; ci < headers.length; ci++) {
        const h = headers[ci].toLowerCase().trim();
        for (const kw of areaKeywords) {
          if (kw.length > 2 && (h.includes(kw) || kw.includes(h))) { staffColIndex = ci; break; }
        }
        if (staffColIndex >= 0) break;
      }
    }

    if (staffColIndex >= 0) {
      let inCorrectDay = false;
      let dayRowStarted = false;

      for (const row of rows) {
        const rowValues = Array.isArray(row) ? row : headers.map(h2 => row[h2] || '');
        const firstCell = String(rowValues[0] || '').trim().toLowerCase();

        if (['monday','tuesday','wednesday','thursday','friday'].includes(firstCell)) {
          inCorrectDay = firstCell === dayName;
          dayRowStarted = true;
          if (inCorrectDay) {
            const cellValue = String(rowValues[staffColIndex] || '').trim();
            if (cellValue && cellValue !== '-' && !skip.includes(cellValue.toLowerCase())) {
              classes.push({ time: '', class: cellValue });
            }
          }
          continue;
        }
        if (!dayRowStarted) inCorrectDay = true;
        if (!inCorrectDay) continue;

        const cellValue = String(rowValues[staffColIndex] || '').trim();
        if (cellValue && cellValue !== '-' && !skip.includes(cellValue.toLowerCase())) {
          const timeSlot = String(rowValues[0] || '').trim();
          classes.push({ time: timeSlot, class: cellValue });
        }
      }
    }

    // Fallback: scan cells for teacher name references
    if (staffColIndex < 0) {
      let inCorrectDay = false;
      let dayRowStarted = false;
      for (const row of rows) {
        const rowValues = Array.isArray(row) ? row : headers.map(h2 => row[h2] || '');
        const firstCell = String(rowValues[0] || '').trim().toLowerCase();
        if (['monday','tuesday','wednesday','thursday','friday'].includes(firstCell)) {
          inCorrectDay = firstCell === dayName; dayRowStarted = true; continue;
        }
        if (!dayRowStarted) inCorrectDay = true;
        if (!inCorrectDay) continue;
        for (let ci = 1; ci < rowValues.length; ci++) {
          const cellLower = String(rowValues[ci] || '').trim().toLowerCase();
          if (staffFirst.length > 2 && cellLower.includes(staffFirst)) {
            const className = headers[ci] || '';
            if (className) classes.push({ time: String(rowValues[0] || '').trim(), class: className });
          }
        }
      }
    }
  }

  return classes;
}

// API endpoint: get affected classes for a staff member on a given date
app.get('/api/timetable/classes-for', auth, wrap(async (req, res) => {
  const { staffId, date } = req.query;
  if (!staffId || !date) return res.status(400).json({ error: 'staffId and date required' });
  const classes = await lookupClassesForStaff(parseInt(staffId), date);
  res.json({ classes, classesText: classes.map(c => c.class || c).join(', ') });
}));

// Get all staff lesson plans (leader view)
app.get('/api/lessonlab/all-plans', auth, leaderOnly, wrap(async (req, res) => {
  const { dayOfWeek, date } = req.query;
  let sql = `SELECT lp.*, u.name as teacher_name, u.area as teacher_area
    FROM lesson_plans lp LEFT JOIN users u ON lp.teacher_id = u.id WHERE 1=1`;
  const params = [];
  if (dayOfWeek) { sql += ' AND lp.day_of_week = ?'; params.push(dayOfWeek); }
  if (date) { sql += ' AND (lp.specific_date = ? OR (lp.specific_date IS NULL AND lp.day_of_week = ?))'; params.push(date); const d = new Date(date + 'T12:00:00'); params.push(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]); }
  sql += ' ORDER BY u.name, lp.day_of_week, lp.period_slot';
  res.json(await dbAll(sql, ...params));
}));

// Duplicate a lesson plan (copy for another day/week)
app.post('/api/lessonlab/plans/:id/duplicate', auth, wrap(async (req, res) => {
  const plan = await dbGet('SELECT * FROM lesson_plans WHERE id = ?', parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.teacher_id !== req.user.id && req.user.role !== 'leader' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorised' });
  }
  const { dayOfWeek, specificDate } = req.body;
  await dbRun(
    `INSERT INTO lesson_plans (teacher_id, day_of_week, specific_date, period_slot, subject, class_name, plan_title, plan_content, resources, notes, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [plan.teacher_id, dayOfWeek || plan.day_of_week, specificDate || null, plan.period_slot, plan.subject, plan.class_name,
     plan.plan_title, plan.plan_content, plan.resources, plan.notes, req.user.id]
  );
  res.json({ ok: true, id: await dbLastId() });
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
  const plan = await dbGet('SELECT * FROM lesson_plans WHERE id = ?', parseInt(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  // Only the teacher or a leader can delete
  if (plan.teacher_id !== req.user.id && req.user.role !== 'leader' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorised — only the plan owner or a leader can delete' });
  }
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
    const staffName = absence.staff_name.toLowerCase();
    const staffFirst = staffName.split(' ')[0];
    const staffLast = staffName.split(' ').slice(1).join(' ');
    for (const tt of timetables) {
      let data; try { data = JSON.parse(tt.data); } catch(e) { continue; }
      if (!data || !data.headers || !data.rows) continue;
      // Match by full name first, then first name, then last name
      let colIdx = data.headers.findIndex(h => h.toLowerCase() === staffName);
      if (colIdx === -1) colIdx = data.headers.findIndex(h => h.toLowerCase().includes(staffFirst) && (staffLast ? h.toLowerCase().includes(staffLast) : true));
      if (colIdx === -1) colIdx = data.headers.findIndex(h => h.toLowerCase().includes(staffFirst));
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
    const staffLower = absence.staff_name.toLowerCase();
    // Match by full name first, then partial
    yardDuties = roster.filter(r => r.staff_name.toLowerCase() === staffLower || r.staff_name.toLowerCase().includes(staffLower.split(' ')[0]));
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
    // Try exact name match first, then partial match as fallback
    let target = await dbGet("SELECT id FROM users WHERE LOWER(name) = ? AND active = 1", requestedStaffName.toLowerCase());
    if (!target) {
      target = await dbGet("SELECT id FROM users WHERE LOWER(name) LIKE ? AND active = 1", '%' + requestedStaffName.toLowerCase() + '%');
    }
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
  if (swap.status !== 'pending') return res.status(400).json({ error: 'Swap already ' + swap.status });
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

// ===== URGENT HELP / PANIC BUTTON =====
app.post('/api/urgent-help', auth, wrap(async (req, res) => {
  const { location, message } = req.body;
  const userName = req.user.name;
  const userId = req.user.id;
  const area = req.user.area || '';
  const alertMsg = `🚨 URGENT HELP: ${userName}${location ? ' in ' + location : ''}${area ? ' (' + area + ')' : ''}${message ? ' — ' + message : ''}`;

  // Add high-priority notification visible to leaders
  await addNotification(alertMsg, 'urgent', 'leader,admin');

  // Send push notifications and SMS to ALL leaders (push user_type is 'staff' for non-CRTs)
  const leaders = await dbAll("SELECT id, phone FROM users WHERE role IN ('leader','admin') AND active != 0");
  for (const leader of leaders) {
    try {
      await sendPushNotification(leader.id, 'staff', '🚨 URGENT HELP NEEDED', alertMsg);
    } catch(e) { /* push may fail, continue */ }
    // Also send SMS for urgent help
    if (leader.phone) {
      try { await sendSMS(leader.phone, alertMsg); } catch(e) {}
    }
  }

  // Log it
  console.log(`[URGENT HELP] ${new Date().toISOString()} — ${alertMsg}`);

  res.json({ ok: true, sent: leaders.length });
}));

// ===== NFT (Non-Face-to-Face Time) TRACKING =====
app.get('/api/nft', auth, wrap(async (req, res) => {
  const { staffId, weekOf, date } = req.query;
  const isLeader = req.user.role === 'leader' || req.user.role === 'admin';
  // Staff can only see their own NFT
  const effectiveStaffId = staffId ? parseInt(staffId) : null;
  if (effectiveStaffId && effectiveStaffId !== req.user.id && !isLeader) {
    return res.status(403).json({ error: 'You can only view your own NFT records' });
  }
  let sql = 'SELECT * FROM nft_records WHERE 1=1';
  const params = [];
  if (effectiveStaffId) { sql += ' AND staff_id = ?'; params.push(effectiveStaffId); }
  else if (!isLeader) { sql += ' AND staff_id = ?'; params.push(req.user.id); }
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

// All-staff NFT summary for leaders
app.get('/api/nft/summary-all', auth, leaderOnly, wrap(async (req, res) => {
  const thisYear = new Date().getFullYear();
  const startDate = `${thisYear}-01-01`;
  const staff = await dbAll("SELECT id, name FROM users WHERE role != 'crt' AND active = 1 ORDER BY name");
  const summaries = [];
  for (const s of staff) {
    const scheduled = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'scheduled' AND date >= ?", s.id, startDate);
    const extra = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'extra' AND date >= ?", s.id, startDate);
    const lost = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'lost' AND date >= ?", s.id, startDate);
    const covered = await dbGet("SELECT COALESCE(SUM(minutes),0) as total FROM nft_records WHERE staff_id = ? AND type = 'covered_duty' AND date >= ?", s.id, startDate);
    const net = (scheduled?.total||0) + (extra?.total||0) - (lost?.total||0);
    summaries.push({ staffId: s.id, name: s.name, scheduled: scheduled?.total||0, extra: extra?.total||0, lost: lost?.total||0, coveredDuty: covered?.total||0, net });
  }
  res.json({ year: thisYear, summaries });
}));

// ===== ABSENCE ANALYTICS & TRENDS =====
app.get('/api/analytics/trends', auth, leaderOnly, wrap(async (req, res) => {
  const thisYear = new Date().getFullYear();
  const startDate = `${thisYear}-01-01`;

  // Day-of-week distribution
  const byDayOfWeek = await dbAll(
    `SELECT
       CASE cast(strftime('%w', date_start) as integer)
         WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
         WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
         WHEN 6 THEN 'Saturday' END as day_name,
       cast(strftime('%w', date_start) as integer) as day_num,
       COUNT(*) as count
     FROM absences WHERE date_start >= ? AND status != 'cancelled'
     GROUP BY day_num ORDER BY day_num`, startDate
  );

  // Monthly trend
  const byMonth = await dbAll(
    `SELECT substr(date_start,1,7) as month, COUNT(*) as count
     FROM absences WHERE date_start >= ? AND status != 'cancelled'
     GROUP BY month ORDER BY month`, startDate
  );

  // Top absent staff
  const topStaff = await dbAll(
    `SELECT staff_name, staff_id, COUNT(*) as count,
       SUM(CASE WHEN date_end IS NOT NULL THEN CAST(julianday(date_end) - julianday(date_start) + 1 AS INTEGER) ELSE 1 END) as total_days
     FROM absences WHERE date_start >= ? AND status != 'cancelled'
     GROUP BY staff_id ORDER BY count DESC LIMIT 15`, startDate
  );

  // By reason
  const byReason = await dbAll(
    `SELECT reason, COUNT(*) as count
     FROM absences WHERE date_start >= ? AND status != 'cancelled'
     GROUP BY reason ORDER BY count DESC LIMIT 10`, startDate
  );

  // By area
  const byArea = await dbAll(
    `SELECT area, COUNT(*) as count
     FROM absences WHERE date_start >= ? AND status != 'cancelled'
     GROUP BY area ORDER BY count DESC`, startDate
  );

  // CRT utilization
  const crtUsage = await dbAll(
    `SELECT c.name, COUNT(*) as bookings,
       SUM(CASE WHEN a.date_end IS NOT NULL THEN CAST(julianday(a.date_end) - julianday(a.date_start) + 1 AS INTEGER) ELSE 1 END) as total_days
     FROM absences a JOIN crts c ON a.assigned_crt_id = c.id
     WHERE a.date_start >= ? AND a.status = 'booked'
     GROUP BY a.assigned_crt_id ORDER BY bookings DESC`, startDate
  );

  // Term totals (rough — Aus school terms)
  const termRanges = [
    { name: 'Term 1', start: `${thisYear}-01-28`, end: `${thisYear}-04-04` },
    { name: 'Term 2', start: `${thisYear}-04-21`, end: `${thisYear}-06-27` },
    { name: 'Term 3', start: `${thisYear}-07-14`, end: `${thisYear}-09-19` },
    { name: 'Term 4', start: `${thisYear}-10-06`, end: `${thisYear}-12-19` }
  ];
  const byTerm = [];
  for (const t of termRanges) {
    const r = await dbGet(
      "SELECT COUNT(*) as count FROM absences WHERE date_start >= ? AND date_start <= ? AND status != 'cancelled'",
      t.start, t.end
    );
    byTerm.push({ ...t, count: r?.count || 0 });
  }

  // Average absences per week
  const weeksElapsed = Math.max(1, Math.floor((Date.now() - new Date(startDate).getTime()) / (7*24*60*60*1000)));
  const totalAbs = await dbGet("SELECT COUNT(*) as c FROM absences WHERE date_start >= ? AND status != 'cancelled'", startDate);
  const avgPerWeek = ((totalAbs?.c || 0) / weeksElapsed).toFixed(1);

  res.json({
    year: thisYear, avgPerWeek,
    byDayOfWeek, byMonth, topStaff, byReason, byArea, crtUsage, byTerm,
    totalAbsences: totalAbs?.c || 0, weeksElapsed
  });
}));

// ===== SCHOOL INFO (bell times, contacts, etc.) =====
app.get('/api/school-info', auth, wrap(async (req, res) => {
  // Pull from system settings
  const settings = {};
  const rows = await dbAll('SELECT key, value FROM system_settings');
  rows.forEach(r => { settings[r.key] = r.value; });

  res.json({
    name: 'Williamstown Primary School',
    address: '185 Melbourne Rd, Williamstown VIC 3016',
    phone: settings.school_phone || '(03) 9397 1428',
    email: settings.school_email || 'williamstown.ps@education.vic.gov.au',
    principal: settings.principal_name || 'Principal',
    assistantPrincipal: settings.ap_name || 'Assistant Principal',
    officeManager: settings.office_manager || 'Office',
    bellTimes: [
      { time: '8:45', event: 'Yard Duty Begins' },
      { time: '9:00', event: 'Session 1' },
      { time: '10:00', event: 'Session 2' },
      { time: '11:00', event: 'Recess' },
      { time: '11:30', event: 'Session 3' },
      { time: '12:30', event: 'Session 4' },
      { time: '1:30', event: 'Lunch' },
      { time: '2:30', event: 'Session 5' },
      { time: '3:30', event: 'Dismissal' }
    ],
    emergencyProcedures: [
      { type: 'Lockdown', action: 'Lock doors, close blinds, students away from doors/windows, wait for all-clear' },
      { type: 'Evacuation', action: 'Take rolls, proceed to oval assembly area, report to marshals' },
      { type: 'Medical Emergency', action: 'Call office on internal phone, do not move student, first aider responds' },
      { type: 'Severe Weather', action: 'Students inside, close windows, listen for PA announcements' }
    ],
    keyLocations: [
      { name: 'Front Office', where: 'Main building, ground floor' },
      { name: 'Sick Bay', where: 'Adjacent to front office' },
      { name: 'Staff Room', where: 'Main building, first floor' },
      { name: 'Library', where: 'Building B, ground floor' },
      { name: 'Gym/Hall', where: 'Rear of main building' },
      { name: 'Art Room', where: 'Building C' },
      { name: 'Music Room', where: 'Building B, first floor' },
      { name: 'Oval', where: 'Behind main buildings' },
      { name: 'Adventure Playground', where: 'North side of oval' }
    ]
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
  const roster = await dbAll(`SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location`, dayName);
  const changes = await dbAll(`SELECT * FROM yard_duty_changes WHERE date = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END`, today);

  res.json({
    date: today, dayName,
    awayToday, pendingSwaps, specialistAlerts: specAlerts,
    recentNft, packStatus,
    yardDuty: { roster, changes }
  });
}));

// ===== STAFF DIRECTORY (enhanced) =====
app.get('/api/directory', auth, wrap(async (req, res) => {
  const staff = await dbAll("SELECT id, name, email, phone, role, area, active FROM users ORDER BY name");
  const crts = await dbAll("SELECT id, name, phone, email, specialties, active FROM crts ORDER BY name");
  // Get absence stats for each staff
  const thisYear = new Date().getFullYear();
  const enriched = [];
  for (const s of staff) {
    const absCount = await dbGet("SELECT COUNT(*) as c FROM absences WHERE staff_id = ? AND status != 'cancelled' AND date_start >= ?", s.id, `${thisYear}-01-01`);
    const isAway = await dbGet("SELECT id FROM absences WHERE staff_id = ? AND date_start <= date('now') AND date_end >= date('now') AND status != 'cancelled'", s.id);
    enriched.push({ ...s, absencesThisYear: absCount?.c || 0, isAwayToday: !!isAway });
  }
  res.json({ staff: enriched, crts });
}));

// ===== ANNOUNCEMENTS =====
app.get('/api/announcements', auth, wrap(async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const rows = await dbAll(
    "SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at >= date('now')) ORDER BY pinned DESC, created_at DESC LIMIT ?", limit
  );
  res.json(rows);
}));

app.post('/api/announcements', auth, leaderOnly, wrap(async (req, res) => {
  const { title, content, priority, category, pinned, expires_at } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
  await dbRun(
    'INSERT INTO announcements (title, content, priority, category, pinned, created_by, author_name, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [title, content, priority || 'normal', category || 'general', pinned ? 1 : 0, req.user.id, req.user.name, expires_at || null]
  );
  const id = await dbLastId();
  // Create notification for all staff
  await dbRun("INSERT INTO notifications (message, type, for_roles) VALUES (?, ?, ?)",
    [`📢 ${title}`, priority === 'urgent' ? 'urgent' : 'info', 'all']);
  try { await sendPushToAll(`📢 ${title}`, content.substring(0, 100)); } catch(e) {}
  res.json({ success: true, id });
}));

app.delete('/api/announcements/:id', auth, leaderOnly, wrap(async (req, res) => {
  await dbRun('DELETE FROM announcements WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
}));

// ===== WELLBEING CHECK-INS =====
app.get('/api/wellbeing', auth, wrap(async (req, res) => {
  if (req.user.role === 'leader' || req.user.role === 'admin') {
    // Leaders see aggregate data
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const recent = await dbAll(
      "SELECT * FROM wellbeing_checkins WHERE date >= ? ORDER BY date DESC", weekAgo
    );
    // Aggregate averages
    const todayCheckins = recent.filter(c => c.date === today);
    const avgMood = todayCheckins.length ? (todayCheckins.reduce((s,c) => s + c.mood, 0) / todayCheckins.length).toFixed(1) : null;
    const avgEnergy = todayCheckins.length ? (todayCheckins.reduce((s,c) => s + c.energy, 0) / todayCheckins.length).toFixed(1) : null;
    const avgWorkload = todayCheckins.length ? (todayCheckins.reduce((s,c) => s + c.workload, 0) / todayCheckins.length).toFixed(1) : null;
    // Weekly trend
    const dailyAvg = {};
    recent.forEach(c => {
      if (!dailyAvg[c.date]) dailyAvg[c.date] = { mood: [], energy: [], workload: [], count: 0 };
      dailyAvg[c.date].mood.push(c.mood);
      dailyAvg[c.date].energy.push(c.energy);
      dailyAvg[c.date].workload.push(c.workload);
      dailyAvg[c.date].count++;
    });
    const trend = Object.entries(dailyAvg).map(([date, d]) => ({
      date,
      avgMood: (d.mood.reduce((a,b) => a+b, 0) / d.mood.length).toFixed(1),
      avgEnergy: (d.energy.reduce((a,b) => a+b, 0) / d.energy.length).toFixed(1),
      avgWorkload: (d.workload.reduce((a,b) => a+b, 0) / d.workload.length).toFixed(1),
      responses: d.count
    })).sort((a,b) => a.date.localeCompare(b.date));
    // Flags: anyone consistently low
    const staffFlags = [];
    const byStaff = {};
    recent.filter(c => !c.is_anonymous).forEach(c => {
      if (!byStaff[c.staff_id]) byStaff[c.staff_id] = { name: c.staff_name, moods: [] };
      byStaff[c.staff_id].moods.push(c.mood);
    });
    Object.entries(byStaff).forEach(([id, d]) => {
      const avg = d.moods.reduce((a,b) => a+b, 0) / d.moods.length;
      if (avg <= 2 && d.moods.length >= 2) staffFlags.push({ staffId: parseInt(id), name: d.name, avgMood: avg.toFixed(1), checkins: d.moods.length });
    });
    // Anonymous notes from today
    const notes = todayCheckins.filter(c => c.note).map(c => ({ note: c.note, mood: c.mood, anonymous: c.is_anonymous }));
    res.json({ today: { avgMood, avgEnergy, avgWorkload, responses: todayCheckins.length }, trend, staffFlags, notes, totalStaff: (await dbAll("SELECT id FROM users WHERE role != 'crt' AND active = 1")).length });
  } else {
    // Staff see their own history
    const mine = await dbAll("SELECT * FROM wellbeing_checkins WHERE staff_id = ? ORDER BY date DESC LIMIT 14", req.user.id);
    const today = mine.find(c => c.date === new Date().toISOString().split('T')[0]);
    res.json({ history: mine, todayDone: !!today });
  }
}));

app.post('/api/wellbeing', auth, wrap(async (req, res) => {
  const { mood, energy, workload, note, anonymous } = req.body;
  if (!mood || !energy || !workload) return res.status(400).json({ error: 'Mood, energy, and workload ratings required (1-5)' });
  const today = new Date().toISOString().split('T')[0];
  // Check if already checked in today
  const existing = await dbGet("SELECT id FROM wellbeing_checkins WHERE staff_id = ? AND date = ?", req.user.id, today);
  if (existing) {
    await dbRun("UPDATE wellbeing_checkins SET mood = ?, energy = ?, workload = ?, note = ?, is_anonymous = ? WHERE id = ?",
      [mood, energy, workload, note || null, anonymous ? 1 : 0, existing.id]);
  } else {
    await dbRun("INSERT INTO wellbeing_checkins (staff_id, staff_name, date, mood, energy, workload, note, is_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [req.user.id, req.user.name, today, mood, energy, workload, note || null, anonymous ? 1 : 0]);
  }
  res.json({ success: true });
}));

// ===== INCIDENT REPORTS =====
app.get('/api/incidents', auth, wrap(async (req, res) => {
  const { status, limit } = req.query;
  let sql = 'SELECT * FROM incidents';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 30);
  const rows = await dbAll(sql, ...params);
  res.json(rows);
}));

app.get('/api/incidents/:id', auth, wrap(async (req, res) => {
  const inc = await dbGet('SELECT * FROM incidents WHERE id = ?', parseInt(req.params.id));
  if (!inc) return res.status(404).json({ error: 'Not found' });
  res.json(inc);
}));

app.post('/api/incidents', auth, wrap(async (req, res) => {
  const { date, time, location, type, severity, description, students_involved, witnesses, action_taken, follow_up } = req.body;
  if (!date || !type || !description) return res.status(400).json({ error: 'Date, type, and description required' });
  await dbRun(
    'INSERT INTO incidents (date, time, location, type, severity, description, students_involved, witnesses, action_taken, follow_up, reported_by, reporter_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [date, time || null, location || null, type, severity || 'minor', description, students_involved || null, witnesses || null, action_taken || null, follow_up || null, req.user.id, req.user.name]
  );
  const id = await dbLastId();
  // Notify leaders
  await dbRun("INSERT INTO notifications (message, type, for_roles) VALUES (?, ?, ?)",
    [`🚨 Incident: ${type} reported by ${req.user.name}`, severity === 'critical' ? 'urgent' : 'info', 'leader']);
  try { await sendPushToAll(`🚨 Incident Report: ${type}`, `${req.user.name} reported a ${severity} incident`); } catch(e) {}
  res.json({ success: true, id });
}));

app.put('/api/incidents/:id', auth, wrap(async (req, res) => {
  const { status, action_taken, follow_up } = req.body;
  const inc = await dbGet('SELECT * FROM incidents WHERE id = ?', parseInt(req.params.id));
  if (!inc) return res.status(404).json({ error: 'Not found' });
  if (action_taken !== undefined) await dbRun('UPDATE incidents SET action_taken = ? WHERE id = ?', [action_taken, inc.id]);
  if (follow_up !== undefined) await dbRun('UPDATE incidents SET follow_up = ? WHERE id = ?', [follow_up, inc.id]);
  if (status) {
    await dbRun('UPDATE incidents SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.user.id, inc.id]);
  }
  res.json({ success: true });
}));

// ===== QUICK STATUS (running late, leaving early, etc.) =====
app.get('/api/quick-status', auth, wrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const statuses = await dbAll("SELECT * FROM quick_status WHERE date = ? ORDER BY created_at DESC", today);
  res.json(statuses);
}));

app.post('/api/quick-status', auth, wrap(async (req, res) => {
  const { type, message, estimated_time } = req.body;
  if (!type) return res.status(400).json({ error: 'Status type required' });
  const today = new Date().toISOString().split('T')[0];
  await dbRun(
    'INSERT INTO quick_status (staff_id, staff_name, date, type, message, estimated_time) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, req.user.name, today, type, message || null, estimated_time || null]
  );
  // Notify leaders
  const typeLabels = { late: 'Running Late', leaving_early: 'Leaving Early', offsite: 'Offsite', other: 'Status Update' };
  await dbRun("INSERT INTO notifications (message, type, for_roles) VALUES (?, ?, ?)",
    [`📌 ${req.user.name}: ${typeLabels[type] || type}${message ? ' — ' + message : ''}`, 'info', 'leader']);
  try { await sendPushToAll(`📌 ${req.user.name}`, `${typeLabels[type] || type}${message ? ': ' + message : ''}`); } catch(e) {}
  res.json({ success: true });
}));

// ===== PROFESSIONAL DEVELOPMENT LOG =====
app.get('/api/pd-log', auth, wrap(async (req, res) => {
  const isLeader = req.user.role === 'leader' || req.user.role === 'admin';
  if (isLeader && req.query.all === 'true') {
    const records = await dbAll("SELECT * FROM pd_log ORDER BY date DESC LIMIT 100");
    res.json(records);
  } else {
    const records = await dbAll("SELECT * FROM pd_log WHERE staff_id = ? ORDER BY date DESC LIMIT 50", req.user.id);
    res.json(records);
  }
}));

app.post('/api/pd-log', auth, wrap(async (req, res) => {
  const { date, title, provider, hours, type, notes, certificate_ref } = req.body;
  if (!date || !title || !hours) return res.status(400).json({ error: 'Date, title, and hours required' });
  await dbRun(
    'INSERT INTO pd_log (staff_id, staff_name, date, title, provider, hours, type, notes, certificate_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, req.user.name, date, title, provider || null, hours, type || 'workshop', notes || null, certificate_ref || null]
  );
  res.json({ success: true, id: await dbLastId() });
}));

app.delete('/api/pd-log/:id', auth, wrap(async (req, res) => {
  const record = await dbGet('SELECT * FROM pd_log WHERE id = ?', parseInt(req.params.id));
  if (!record) return res.status(404).json({ error: 'Not found' });
  if (record.staff_id !== req.user.id && req.user.role !== 'leader' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  await dbRun('DELETE FROM pd_log WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
}));

// ===== DAILY COVER SUMMARY (printable for office) =====
app.get('/api/cover-summary', auth, wrap(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(date + 'T12:00:00').getDay()];
  const absences = await dbAll(
    "SELECT a.*, c.name as crt_name, c.phone as crt_phone FROM absences a LEFT JOIN crts c ON a.assigned_crt_id = c.id WHERE a.date_start <= ? AND a.date_end >= ? AND a.status != 'cancelled' ORDER BY a.area, a.staff_name",
    date, date
  );
  // Get yard duty roster for the day
  const roster = await dbAll("SELECT * FROM yard_duty_roster WHERE day_of_week = ? ORDER BY CASE time_slot WHEN '8:45-9:00' THEN 1 WHEN 'Recess 11:10' THEN 2 WHEN 'Recess 11:20' THEN 3 WHEN 'Lunch 1:40' THEN 4 WHEN 'Lunch 2:00' THEN 5 WHEN 'Extra 2:10-2:30' THEN 6 WHEN '3:30-3:45' THEN 7 ELSE 8 END, location", dayName);
  const changes = await dbAll("SELECT * FROM yard_duty_changes WHERE date = ?", date);
  // Quick statuses for today
  const statuses = await dbAll("SELECT * FROM quick_status WHERE date = ? ORDER BY created_at DESC", date);
  // Get lesson plan readiness
  const packs = [];
  for (const a of absences) {
    const plans = await dbAll("SELECT COUNT(*) as c FROM lesson_plans WHERE teacher_id = ? AND day_of_week = ?", a.staff_id, dayName);
    const subs = await dbAll("SELECT COUNT(*) as c FROM sub_plans WHERE absence_id = ?", a.id);
    packs.push({ absenceId: a.id, staffName: a.staff_name, area: a.area, crtName: a.crt_name, crtPhone: a.crt_phone, status: a.status, reason: a.reason, halfDay: a.half_day, lessonPlans: plans[0]?.c || 0, subPlans: subs[0]?.c || 0 });
  }
  res.json({ date, dayName, absences: packs, yardDuty: { roster, changes }, statuses, absentStaff: absences.map(a => a.staff_name) });
}));

// ===== CHAT =====

// Get user's chat groups with unread counts
app.get('/api/chat/groups', auth, wrap(async (req, res) => {
  const userId = req.user.id;
  const groups = await dbAll(
    `SELECT g.id, g.name, g.type, g.created_by,
      (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) as member_count,
      (SELECT m.message FROM chat_messages m WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) as last_message,
      (SELECT m.sender_name FROM chat_messages m WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) as last_sender,
      (SELECT m.created_at FROM chat_messages m WHERE m.group_id = g.id ORDER BY m.id DESC LIMIT 1) as last_message_at,
      (SELECT MAX(m.id) FROM chat_messages m WHERE m.group_id = g.id) as max_msg_id,
      COALESCE((SELECT rs.last_read_msg_id FROM chat_read_status rs WHERE rs.group_id = g.id AND rs.user_id = ?), 0) as last_read
    FROM chat_groups g
    INNER JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    ORDER BY last_message_at DESC NULLS LAST, g.name ASC`,
    userId, userId
  );
  // Calculate unread for each
  const result = groups.map(g => ({
    ...g,
    unread: Math.max(0, (g.max_msg_id || 0) - (g.last_read || 0))
  }));
  res.json(result);
}));

// Get messages for a group (with optional since parameter for polling)
app.get('/api/chat/groups/:id/messages', auth, wrap(async (req, res) => {
  const groupId = parseInt(req.params.id);
  const userId = req.user.id;
  // Verify membership
  const member = await dbGet(
    `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`,
    groupId, userId
  );
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const since = req.query.since ? parseInt(req.query.since) : 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  let messages;
  if (since > 0) {
    messages = await dbAll(
      `SELECT id, sender_id, sender_name, message, created_at FROM chat_messages
       WHERE group_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      groupId, since, limit
    );
  } else {
    messages = await dbAll(
      `SELECT id, sender_id, sender_name, message, created_at FROM chat_messages
       WHERE group_id = ? ORDER BY id DESC LIMIT ?`,
      groupId, limit
    );
    messages.reverse();
  }

  // Mark as read
  if (messages.length > 0) {
    const maxId = messages[messages.length - 1].id;
    try {
      const existing = await dbGet(
        `SELECT id FROM chat_read_status WHERE group_id = ? AND user_id = ?`,
        groupId, userId
      );
      if (existing) {
        await dbRun(
          `UPDATE chat_read_status SET last_read_msg_id = MAX(last_read_msg_id, ?) WHERE group_id = ? AND user_id = ?`,
          [maxId, groupId, userId]
        );
      } else {
        await dbRun(
          `INSERT INTO chat_read_status (group_id, user_id, last_read_msg_id) VALUES (?, ?, ?)`,
          [groupId, userId, maxId]
        );
      }
    } catch(e) { /* ok */ }
  }

  res.json(messages);
}));

// Send a message
app.post('/api/chat/groups/:id/messages', auth, wrap(async (req, res) => {
  const groupId = parseInt(req.params.id);
  const userId = req.user.id;
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });

  // Verify membership
  const member = await dbGet(
    `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`,
    groupId, userId
  );
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  await dbRun(
    `INSERT INTO chat_messages (group_id, sender_id, sender_name, message) VALUES (?, ?, ?, ?)`,
    [groupId, userId, req.user.name, message.trim()]
  );
  const msg = await dbGet(
    `SELECT id, sender_id, sender_name, message, created_at FROM chat_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1`,
    groupId
  );

  // Update sender's read status
  try {
    const existing = await dbGet(
      `SELECT id FROM chat_read_status WHERE group_id = ? AND user_id = ?`,
      groupId, userId
    );
    if (existing) {
      await dbRun(`UPDATE chat_read_status SET last_read_msg_id = ? WHERE group_id = ? AND user_id = ?`, [msg.id, groupId, userId]);
    } else {
      await dbRun(`INSERT INTO chat_read_status (group_id, user_id, last_read_msg_id) VALUES (?, ?, ?)`, [groupId, userId, msg.id]);
    }
  } catch(e) { /* ok */ }

  // Send push notifications to other group members
  try {
    const group = await dbGet(`SELECT name FROM chat_groups WHERE id = ?`, groupId);
    const groupName = group ? group.name : 'Chat';
    const members = await dbAll(`SELECT user_id FROM chat_group_members WHERE group_id = ? AND user_id != ?`, groupId, userId);
    const truncMsg = message.trim().length > 80 ? message.trim().substring(0, 80) + '...' : message.trim();
    for (const m of members) {
      sendPushNotification(m.user_id, 'staff', `💬 ${groupName}`, `${req.user.name}: ${truncMsg}`).catch(() => {});
    }
  } catch(e) { /* push is best-effort */ }

  res.json(msg);
}));

// Create a custom chat group (leaders only)
app.post('/api/chat/groups', auth, leaderOnly, wrap(async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) return res.status(400).json({ error: 'At least one member required' });

  await dbRun(
    `INSERT INTO chat_groups (name, type, created_by) VALUES (?, 'custom', ?)`,
    [name.trim(), req.user.id]
  );
  const group = await dbGet(`SELECT id FROM chat_groups WHERE name = ? AND created_by = ? ORDER BY id DESC LIMIT 1`, name.trim(), req.user.id);
  if (!group) return res.status(500).json({ error: 'Failed to create group' });

  // Add creator as member
  const allMembers = new Set([req.user.id, ...memberIds.map(Number)]);
  for (const uid of allMembers) {
    try {
      await dbRun(`INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [group.id, uid]);
    } catch(e) { /* duplicate ok */ }
  }

  res.json({ id: group.id, name: name.trim(), type: 'custom', member_count: allMembers.size });
}));

// Get group members
app.get('/api/chat/groups/:id/members', auth, wrap(async (req, res) => {
  const groupId = parseInt(req.params.id);
  const members = await dbAll(
    `SELECT u.id, u.name, u.role, u.area FROM users u
     INNER JOIN chat_group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = ? ORDER BY u.name`,
    groupId
  );
  res.json(members);
}));

// Add members to group (leaders only)
app.post('/api/chat/groups/:id/members', auth, leaderOnly, wrap(async (req, res) => {
  const groupId = parseInt(req.params.id);
  const { memberIds } = req.body;
  if (!memberIds || !Array.isArray(memberIds)) return res.status(400).json({ error: 'memberIds required' });
  for (const uid of memberIds) {
    try {
      await dbRun(`INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [groupId, Number(uid)]);
    } catch(e) { /* duplicate ok */ }
  }
  res.json({ ok: true });
}));

// Delete a custom group (leaders only)
app.delete('/api/chat/groups/:id', auth, leaderOnly, wrap(async (req, res) => {
  const groupId = parseInt(req.params.id);
  const group = await dbGet(`SELECT type FROM chat_groups WHERE id = ?`, groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.type === 'preset') return res.status(403).json({ error: 'Cannot delete preset groups' });
  await dbRun(`DELETE FROM chat_messages WHERE group_id = ?`, [groupId]);
  await dbRun(`DELETE FROM chat_read_status WHERE group_id = ?`, [groupId]);
  await dbRun(`DELETE FROM chat_group_members WHERE group_id = ?`, [groupId]);
  await dbRun(`DELETE FROM chat_groups WHERE id = ?`, [groupId]);
  res.json({ ok: true });
}));

// Poll for total unread count across all groups
app.get('/api/chat/unread', auth, wrap(async (req, res) => {
  const userId = req.user.id;
  const rows = await dbAll(
    `SELECT g.id as group_id,
      COALESCE((SELECT MAX(m.id) FROM chat_messages m WHERE m.group_id = g.id), 0) as max_msg_id,
      COALESCE((SELECT rs.last_read_msg_id FROM chat_read_status rs WHERE rs.group_id = g.id AND rs.user_id = ?), 0) as last_read
    FROM chat_groups g
    INNER JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?`,
    userId, userId
  );
  let total = 0;
  for (const r of rows) total += Math.max(0, (r.max_msg_id || 0) - (r.last_read || 0));
  res.json({ unread: total });
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

  // v6.0 tables - Announcements
  try { await dbRun(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    category TEXT DEFAULT 'general',
    pinned INTEGER DEFAULT 0,
    created_by INTEGER,
    author_name TEXT,
    expires_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}

  // v6.0 tables - Wellbeing check-ins
  try { await dbRun(`CREATE TABLE IF NOT EXISTS wellbeing_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    staff_name TEXT,
    date TEXT NOT NULL,
    mood INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    workload INTEGER NOT NULL,
    note TEXT,
    is_anonymous INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES users(id)
  )`); } catch(e) {}

  // v6.0 tables - Incident reports
  try { await dbRun(`CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT,
    location TEXT,
    type TEXT NOT NULL,
    severity TEXT DEFAULT 'minor',
    description TEXT NOT NULL,
    students_involved TEXT,
    witnesses TEXT,
    action_taken TEXT,
    follow_up TEXT,
    status TEXT DEFAULT 'open',
    reported_by INTEGER,
    reporter_name TEXT,
    resolved_by INTEGER,
    resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reported_by) REFERENCES users(id)
  )`); } catch(e) {}

  // v6.2 tables - Quick Status
  try { await dbRun(`CREATE TABLE IF NOT EXISTS quick_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    staff_name TEXT,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT,
    estimated_time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES users(id)
  )`); } catch(e) {}

  // v6.2 tables - Professional Development Log
  try { await dbRun(`CREATE TABLE IF NOT EXISTS pd_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    staff_name TEXT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    provider TEXT,
    hours REAL NOT NULL,
    type TEXT DEFAULT 'workshop',
    notes TEXT,
    certificate_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES users(id)
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

  // v7.4 - Notification preferences by category
  try { await dbRun(`CREATE TABLE IF NOT EXISTS notification_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    UNIQUE(user_id, category)
  )`); } catch(e) {}

  // v7.3 migration: split single 'recess' slot into 'recess_1' and 'recess_2'
  try {
    await dbRun("UPDATE yard_duty_roster SET time_slot = 'recess_1' WHERE time_slot = 'recess'", []);
    await dbRun("UPDATE yard_duty_changes SET time_slot = 'recess_1' WHERE time_slot = 'recess'", []);
    await dbRun("UPDATE yard_duty_swaps SET time_slot = 'recess_1' WHERE time_slot = 'recess'", []);
    console.log('v7.3 migration: recess slots updated');
  } catch(e) { console.log('v7.3 migration skipped:', e.message); }

  // v7.5 migration: rename yard duty locations to match actual WPS names
  try {
    await dbRun("UPDATE yard_duty_roster SET location = 'Back' WHERE location = 'Back-Blue South'", []);
    await dbRun("UPDATE yard_duty_roster SET location = 'Front' WHERE location = 'Front-Blue North'", []);
    await dbRun("UPDATE yard_duty_roster SET location = 'Oval' WHERE location IN ('Bluestone Lounge', 'Oval')", []);
    await dbRun("UPDATE yard_duty_roster SET location = 'Redbrick' WHERE location IN ('Gallery-Deck', 'Redbrick')", []);
    await dbRun("UPDATE yard_duty_changes SET location = 'Back' WHERE location = 'Back-Blue South'", []);
    await dbRun("UPDATE yard_duty_changes SET location = 'Front' WHERE location = 'Front-Blue North'", []);
    await dbRun("UPDATE yard_duty_changes SET location = 'Oval' WHERE location IN ('Bluestone Lounge', 'Oval')", []);
    await dbRun("UPDATE yard_duty_changes SET location = 'Redbrick' WHERE location IN ('Gallery-Deck', 'Redbrick')", []);
    await dbRun("UPDATE yard_duty_swaps SET location = 'Back' WHERE location = 'Back-Blue South'", []);
    await dbRun("UPDATE yard_duty_swaps SET location = 'Front' WHERE location = 'Front-Blue North'", []);
    await dbRun("UPDATE yard_duty_swaps SET location = 'Oval' WHERE location IN ('Bluestone Lounge', 'Oval')", []);
    await dbRun("UPDATE yard_duty_swaps SET location = 'Redbrick' WHERE location IN ('Gallery-Deck', 'Redbrick')", []);
    console.log('v7.5 migration: yard duty locations renamed');
  } catch(e) { console.log('v7.5 migration skipped:', e.message); }

  // v7.7 chat tables
  try { await dbRun(`CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'preset',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}
  try { await dbRun(`CREATE TABLE IF NOT EXISTS chat_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, user_id)
  )`); } catch(e) {}
  try { await dbRun(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); } catch(e) {}
  try { await dbRun(`CREATE TABLE IF NOT EXISTS chat_read_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_msg_id INTEGER DEFAULT 0,
    UNIQUE(group_id, user_id)
  )`); } catch(e) {}
  try { await dbRun(`CREATE INDEX IF NOT EXISTS idx_chat_msgs_group ON chat_messages(group_id, created_at)`); } catch(e) {}
  try { await dbRun(`CREATE INDEX IF NOT EXISTS idx_chat_members ON chat_group_members(user_id)`); } catch(e) {}

  // v7.7 seed preset chat groups (idempotent — creates missing groups)
  try {
    const allUsers = await dbAll(`SELECT id, role, area FROM users WHERE active = 1`);
    const presets = [
      { name: 'All Staff', filter: u => true },
      { name: 'Leaders', filter: u => u.role === 'leader' || u.role === 'admin' },
      { name: '5/6 Team', filter: u => u.area === 'Year 5/6' },
      { name: '3/4 Team', filter: u => u.area === 'Year 3/4' },
      { name: 'Prep Team', filter: u => u.area === 'Prep' },
      { name: 'Year 1/2 Team', filter: u => u.area === 'Year 1' || u.area === 'Year 2' },
      { name: 'Specialists', filter: u => ['PE / Health','Visual Arts','Performing Arts','French (LoTE)','Kitchen Garden'].includes(u.area) },
      { name: 'ES Staff', filter: u => u.area && u.area.startsWith('ES') },
    ];
    let created = 0;
    for (const p of presets) {
      try {
        let grp = await dbGet(`SELECT id FROM chat_groups WHERE name = ? AND type = 'preset'`, p.name);
        if (!grp) {
          await dbRun(`INSERT INTO chat_groups (name, type) VALUES (?, 'preset')`, [p.name]);
          grp = await dbGet(`SELECT id FROM chat_groups WHERE name = ? AND type = 'preset'`, p.name);
          created++;
        }
        if (grp) {
          const members = allUsers.filter(p.filter);
          for (const m of members) {
            try { await dbRun(`INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.id, m.id]); } catch(e) {}
          }
        }
      } catch(e) { console.log('Chat group "' + p.name + '" skip:', e.message); }
    }
    if (created > 0) console.log('v7.7 migration: ' + created + ' chat groups created');
  } catch(e) { console.log('v7.7 chat seed skipped:', e.message); }

  // v8.8 migration: day confirmation columns on daily_zaps
  try { await dbRun("ALTER TABLE daily_zaps ADD COLUMN day_confirmed INTEGER DEFAULT 0"); } catch(e) {}
  try { await dbRun("ALTER TABLE daily_zaps ADD COLUMN confirmed_by INTEGER"); } catch(e) {}
  try { await dbRun("ALTER TABLE daily_zaps ADD COLUMN confirmed_by_name TEXT"); } catch(e) {}
  try { await dbRun("ALTER TABLE daily_zaps ADD COLUMN confirmed_at DATETIME"); } catch(e) {}

  // v7.6 migration: add Jacky Rooney as leader
  try {
    const jacky = await dbGet("SELECT id FROM users WHERE name = 'Jacky Rooney'");
    if (!jacky) {
      const jackyHash = bcrypt.hashSync('0000', 10);
      await dbRun(
        `INSERT INTO users (name, email, phone, pin_hash, role, area, active) VALUES (?,?,?,?,?,?,1)`,
        ['Jacky Rooney', 'jacky.r@wps.vic.edu.au', '', jackyHash, 'leader', 'Leadership']
      );
      console.log('v7.6 migration: Jacky Rooney added as leader');
    }
  } catch(e) { console.log('v7.6 migration skipped:', e.message); }

  // v12.1 migration: add Scott (staff) and Bubbles (CRT)
  try {
    const scott = await dbGet("SELECT id FROM users WHERE name = 'Scott'");
    if (!scott) {
      const scottHash = bcrypt.hashSync('1234', 10);
      await dbRun(
        `INSERT INTO users (name, email, phone, pin_hash, role, area, active) VALUES (?,?,?,?,?,?,1)`,
        ['Scott', '', '', scottHash, 'staff', '']
      );
      console.log('v12.1 migration: Scott added as staff');
    }
  } catch(e) { console.log('v12.1 Scott migration skipped:', e.message); }
  try {
    const bubbles = await dbGet("SELECT id FROM crts WHERE name = 'Bubbles'");
    if (!bubbles) {
      await dbRun(
        `INSERT INTO crts (name, phone, email, specialties, pin_hash, active) VALUES (?,?,?,?,?,1)`,
        ['Bubbles', '', '', '[]', null]
      );
      console.log('v12.1 migration: Bubbles added as CRT');
    }
  } catch(e) { console.log('v12.1 Bubbles migration skipped:', e.message); }

  if (!USE_TURSO) {
    process.on('SIGINT', () => { saveLocalDbNow(); process.exit(); });
    process.on('SIGTERM', () => { saveLocalDbNow(); process.exit(); });
  }

  app.listen(PORT, () => {
    console.log(`\n  WPS Staff Hub v7.4`);
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
