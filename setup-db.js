// WPS Absence Manager - Database Setup (sql.js version)
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'wps-absence.db');

async function setup() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  console.log('Setting up WPS Absence Manager database...\n');

  db.run(`
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

    CREATE INDEX IF NOT EXISTS idx_absences_date ON absences(date_start, date_end);
    CREATE INDEX IF NOT EXISTS idx_absences_staff ON absences(staff_id);
    CREATE INDEX IF NOT EXISTS idx_absences_status ON absences(status);
    CREATE INDEX IF NOT EXISTS idx_crt_prefs_area ON crt_preferences(area, priority);
    CREATE INDEX IF NOT EXISTS idx_crt_unavail ON crt_unavailable(crt_id, date);
    CREATE INDEX IF NOT EXISTS idx_notifs_date ON notifications(created_at);
  `);

  console.log('Tables created.\n');

  const hash = (pin) => bcrypt.hashSync(pin, 10);

  // ===== REAL WPS STAFF 2026 =====
  // PINs: Leadership = 0000, All staff = 1234 (CHANGE BEFORE GO-LIVE)
  // Emails/phones are placeholders — update with real details before going live

  const users = [
    // --- Leadership Team ---
    ['Mat Montebello',      'mat.m@wps.vic.edu.au',       '', hash('0000'), 'admin',  'Principal'],
    ['Lisa Leydin',         'lisa.l@wps.vic.edu.au',      '', hash('0000'), 'leader', 'Assistant Principal'],
    ['Anna Swan',           'anna.s@wps.vic.edu.au',      '', hash('0000'), 'leader', 'Wellbeing'],
    ['Steven Puhar',        'steven.p@wps.vic.edu.au',    '', hash('0000'), 'leader', 'Curriculum - Maths'],
    ['Rebecca Givogue',     'rebecca.g@wps.vic.edu.au',   '', hash('0000'), 'leader', 'Curriculum - English'],

    // --- Prep ---
    ['Caitlin Sullivan',    'caitlin.s@wps.vic.edu.au',   '', hash('1234'), 'staff', 'Prep'],
    ['Georgia Grainger',    'georgia.g@wps.vic.edu.au',   '', hash('1234'), 'staff', 'Prep'],
    ['Claire Davies',       'claire.d@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Prep'],

    // --- Year 1 ---
    ['Stephanie Keswick',   'stephanie.k@wps.vic.edu.au', '', hash('1234'), 'staff', 'Year 1'],
    ['Emma Chang',          'emma.c@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Year 1'],

    // --- Year 2 ---
    ['Joel Kitchen',        'joel.k@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Year 2'],
    ['Rochelle White',      'rochelle.w@wps.vic.edu.au',  '', hash('1234'), 'staff', 'Year 2'],
    ['Bianca Italiano',     'bianca.i@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Year 2'],
    ['Zoe Kitchen',         'zoe.k@wps.vic.edu.au',       '', hash('1234'), 'staff', 'Year 2'],

    // --- Year 3/4 ---
    ['Hayley Thibou',       'hayley.t@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Year 3/4'],
    ['Grace Pante',         'grace.p@wps.vic.edu.au',     '', hash('1234'), 'staff', 'Year 3/4'],
    ['Kayleen Dumic',       'kayleen.d@wps.vic.edu.au',   '', hash('1234'), 'staff', 'Year 3/4'],
    ['Katja Morris',        'katja.m@wps.vic.edu.au',     '', hash('1234'), 'staff', 'Year 3/4'],
    ['Alison Standish',     'alison.s@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Year 3/4'],
    ['Katherine Buenaventura', 'katherine.b@wps.vic.edu.au', '', hash('1234'), 'staff', 'Year 3/4'],

    // --- Year 5/6 ---
    ['Melati Cordell',      'melati.c@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Year 5/6'],
    ['Bianca Russo',        'bianca.r@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Year 5/6'],
    ['Christina Crosland',  'christina.c@wps.vic.edu.au', '', hash('1234'), 'staff', 'Year 5/6'],
    ['Edan Baccega',        'edan.b@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Year 5/6'],
    ['Molly Hedditch',      'molly.h@wps.vic.edu.au',     '', hash('1234'), 'staff', 'Year 5/6'],
    ['Matt Eason-Jones',    'matt.ej@wps.vic.edu.au',     '', hash('1234'), 'staff', 'Year 5/6'],

    // --- Specialists ---
    ['Marcia Evans',        'marcia.e@wps.vic.edu.au',    '', hash('1234'), 'staff', 'Visual Arts'],
    ['Faye Ferry',          'faye.f@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Performing Arts'],
    ['Paddy Gallivan',      'pgallivan@wps.vic.edu.au',   '', hash('0000'), 'leader', 'PE / Health'],
    ['Sara Borrens',        'sara.b@wps.vic.edu.au',      '', hash('1234'), 'staff', 'French (LoTE)'],
    ['Kate Fedele',         'kate.f@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Kitchen Garden'],

    // --- Learning Support ---
    ['Anna Wynn',           'anna.w@wps.vic.edu.au',      '', hash('1234'), 'staff', 'Learning Support'],

    // --- ES - Classroom Support ---
    ['Bee Waterfield',      'bee.w@wps.vic.edu.au',       '', hash('1234'), 'staff', 'ES - Classroom'],
    ['Kelly Walker',        'kelly.w@wps.vic.edu.au',     '', hash('1234'), 'staff', 'ES - Classroom'],
    ['Lou Randell',         'lou.r@wps.vic.edu.au',       '', hash('1234'), 'staff', 'ES - Classroom'],
    ['Michelle Pearson',    'michelle.p@wps.vic.edu.au',  '', hash('1234'), 'staff', 'ES - Classroom'],
    ['Belinda Slater',      'belinda.s@wps.vic.edu.au',   '', hash('1234'), 'staff', 'ES - Classroom'],
    ['Rachel Mackie',       'rachel.m@wps.vic.edu.au',    '', hash('1234'), 'staff', 'ES - Classroom'],

    // --- ES - Administration ---
    ['Cheryl Douglas',      'cheryl.d@wps.vic.edu.au',    '', hash('1234'), 'staff', 'ES - Admin'],
    ['Diana Bound',         'diana.b@wps.vic.edu.au',     '', hash('1234'), 'staff', 'ES - Admin'],
    ['Jo Munro',            'jo.m@wps.vic.edu.au',        '', hash('1234'), 'staff', 'ES - Admin'],
  ];

  // ===== CRTs =====
  // Add real CRT phone numbers and emails before going live
  const crts = [
    ['Neale Curry',          '0400 000 001', 'neale.c@example.com', '["PE","Health","Sport"]'],
    ['CRT 2 (Placeholder)',  '0400 000 002', 'crt2@example.com', '["Generalist"]'],
    ['CRT 3 (Placeholder)',  '0400 000 003', 'crt3@example.com', '["Generalist"]'],
    ['CRT 4 (Placeholder)',  '0400 000 004', 'crt4@example.com', '["Generalist"]'],
    ['CRT 5 (Placeholder)',  '0400 000 005', 'crt5@example.com', '["Generalist"]'],
    ['CRT 6 (Placeholder)',  '0400 000 006', 'crt6@example.com', '["Generalist"]'],
  ];

  // ===== CRT Preferences per area =====
  // Leaders can update these through the app — these are just defaults
  const prefs = {
    'Prep':           [1, 2, 3],
    'Year 1':         [1, 2, 3],
    'Year 2':         [1, 2, 3],
    'Year 3/4':       [1, 2, 3],
    'Year 5/6':       [1, 2, 3],
    'PE / Health':    [1, 2, 3],
    'Visual Arts':    [1, 2, 3],
    'Performing Arts': [1, 2, 3],
    'French (LoTE)':  [1, 2, 3],
    'Kitchen Garden':  [1, 2, 3],
    'Learning Support': [1, 2, 3],
    'ES - Classroom': [1, 2, 3],
    'ES - Admin':     [1, 2, 3],
  };

  users.forEach(u => {
    db.run('INSERT INTO users (name, email, phone, pin_hash, role, area) VALUES (?, ?, ?, ?, ?, ?)', u);
  });

  crts.forEach(c => {
    db.run('INSERT INTO crts (name, phone, email, specialties) VALUES (?, ?, ?, ?)', c);
  });

  Object.entries(prefs).forEach(([area, crtIds]) => {
    crtIds.forEach((crtId, idx) => {
      db.run('INSERT INTO crt_preferences (area, crt_id, priority) VALUES (?, ?, ?)', [area, crtId, idx + 1]);
    });
  });

  console.log('Seed data inserted:');
  console.log(`  ${users.length} staff (including leadership & ES)`);
  console.log(`  ${crts.length} CRTs (placeholders - update with real CRT details)`);
  console.log(`  ${Object.keys(prefs).length} area preference sets\n`);

  // Save to file
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  db.close();

  console.log('Database setup complete!');
  console.log(`Database file: ${DB_PATH}\n`);
  console.log('Default PINs (CHANGE BEFORE GO-LIVE):');
  console.log('  Leadership (Mat, Lisa, Anna, Steven, Rebecca, Paddy): 0000');
  console.log('  All other staff: 1234\n');
  console.log('CRTs are placeholders — add real CRT names, phones & emails above.\n');
}

setup().catch(err => { console.error('Setup failed:', err); process.exit(1); });
