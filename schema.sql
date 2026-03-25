-- WPS Staff Hub Schema
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('staff','leader','admin')),
  area TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  specialties TEXT,
  pin_hash TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crt_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL,
  crt_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  set_by INTEGER,
  FOREIGN KEY (crt_id) REFERENCES crts(id),
  FOREIGN KEY (set_by) REFERENCES users(id),
  UNIQUE(area, crt_id)
);

CREATE TABLE IF NOT EXISTS crt_unavailable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crt_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY (crt_id) REFERENCES crts(id),
  UNIQUE(crt_id, date)
);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  staff_name TEXT NOT NULL,
  area TEXT NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  reason TEXT NOT NULL,
  classes TEXT,
  notes TEXT,
  half_day TEXT DEFAULT 'full',
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','contacting','booked','nocrt','cancelled')),
  assigned_crt_id INTEGER,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES users(id),
  FOREIGN KEY (assigned_crt_id) REFERENCES crts(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info' CHECK(type IN ('info','urgent','success')),
  for_roles TEXT DEFAULT 'leader',
  related_absence_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (related_absence_id) REFERENCES absences(id)
);

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  twilio_sid TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  notifications_enabled INTEGER DEFAULT 1,
  quiet_start TEXT DEFAULT '21:00',
  quiet_end TEXT DEFAULT '06:00',
  notify_sms INTEGER DEFAULT 1,
  notify_email INTEGER DEFAULT 1,
  notify_app INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_absences_date ON absences(date_start, date_end);
CREATE INDEX IF NOT EXISTS idx_absences_staff ON absences(staff_id);
CREATE INDEX IF NOT EXISTS idx_absences_status ON absences(status);
CREATE INDEX IF NOT EXISTS idx_crt_prefs_area ON crt_preferences(area, priority);
CREATE INDEX IF NOT EXISTS idx_crt_unavail ON crt_unavailable(crt_id, date);
CREATE INDEX IF NOT EXISTS idx_notifs_date ON notifications(created_at);
