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
    ['Sarah Thompson',       '0400 000 002', 'sarah.t@example.com', '["Generalist","Year 1-2"]'],
    ['James Mitchell',       '0400 000 003', 'james.m@example.com', '["Generalist","Year 3-6"]'],
    ['Linda Nguyen',         '0400 000 004', 'linda.n@example.com', '["Languages","Arts","Generalist"]'],
    ['Tom Henderson',        '0400 000 005', 'tom.h@example.com', '["Generalist","Year 5-6","Sport"]'],
    ['Rachel O\'Brien',      '0400 000 006', 'rachel.o@example.com', '["Generalist","Early Years"]'],
  ];

  // ===== CRT Preferences per area =====
  // Leaders can update these through the app — these are just defaults
  // CRT IDs: 1=Neale(PE/Health/Sport), 2=Sarah(Generalist/Yr1-2), 3=James(Generalist/Yr3-6),
  //          4=Linda(Languages/Arts/Generalist), 5=Tom(Generalist/Yr5-6/Sport), 6=Rachel(Generalist/Early Years)
  const prefs = {
    'Prep':           [6, 2, 4],    // Rachel (Early Years) → Sarah (Yr 1-2) → Linda
    'Year 1':         [2, 6, 4],    // Sarah (Yr 1-2) → Rachel (Early Years) → Linda
    'Year 2':         [2, 6, 3],    // Sarah (Yr 1-2) → Rachel → James (Yr 3-6)
    'Year 3/4':       [3, 5, 4],    // James (Yr 3-6) → Tom (Yr 5-6) → Linda
    'Year 5/6':       [5, 3, 1],    // Tom (Yr 5-6) → James (Yr 3-6) → Neale
    'PE / Health':    [1, 5, 3],    // Neale (PE/Sport) → Tom (Sport) → James
    'Visual Arts':    [4, 6, 2],    // Linda (Arts) → Rachel → Sarah
    'Performing Arts': [4, 6, 2],   // Linda (Arts) → Rachel → Sarah
    'French (LoTE)':  [4, 3, 2],   // Linda (Languages) → James → Sarah
    'Kitchen Garden':  [6, 2, 3],   // Rachel → Sarah → James
    'Learning Support': [2, 6, 3],  // Sarah → Rachel → James
    'ES - Classroom': [2, 6, 3],
    'ES - Admin':     [2, 6, 3],
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

  // ===== DEMO DATA =====
  // Pre-populate realistic absences so the dashboard looks active for demos
  const today = new Date();
  const fmt = (d) => d.toISOString().split('T')[0];
  const dayOffset = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return fmt(d); };
  const todayStr = fmt(today);
  const yesterdayStr = dayOffset(-1);
  const twoDaysAgoStr = dayOffset(-2);
  const threeDaysAgoStr = dayOffset(-3);
  const tomorrowStr = dayOffset(1);
  const twoDaysFromNow = dayOffset(2);
  const nextWeekStr = dayOffset(7);
  const nextWeek2Str = dayOffset(8);
  const nextWeek3Str = dayOffset(9);

  // Staff IDs from insert order: 1=Mat, 2=Lisa, 3=Anna, 4=Steven, 5=Rebecca,
  // 6=Caitlin(Prep), 7=Georgia(Prep), 8=Claire(Prep),
  // 9=Stephanie(Yr1), 10=Emma(Yr1),
  // 11=Joel(Yr2), 12=Rochelle(Yr2), 13=Bianca I(Yr2), 14=Zoe(Yr2),
  // 15=Hayley(Yr3/4), 16=Grace(Yr3/4), 17=Kayleen(Yr3/4), 18=Katja(Yr3/4), 19=Alison(Yr3/4), 20=Katherine(Yr3/4),
  // 21=Melati(Yr5/6), 22=Bianca R(Yr5/6), 23=Christina(Yr5/6), 24=Edan(Yr5/6), 25=Molly(Yr5/6), 26=Matt EJ(Yr5/6),
  // 27=Marcia(VA), 28=Faye(PA), 29=Paddy(PE), 30=Sara(French), 31=Kate(KG),
  // 32=Anna W(LS), 33-38=ES, 39-41=ES Admin

  // CRT IDs: 1=Neale(PE/Sport), 2=Sarah(Yr1-2), 3=James(Yr3-6), 4=Linda(Lang/Arts), 5=Tom(Yr5-6/Sport), 6=Rachel(Early Yrs)

  const demoAbsences = [
    // --- PAST (completed/booked) - shows history ---
    // 3 days ago: Joel Kitchen (Yr2) sick — Sarah Thompson covered (1st pref for Yr2)
    [11, 'Joel Kitchen', 'Year 2', threeDaysAgoStr, threeDaysAgoStr, 'Personal Illness/Injury', '2K, 2J', '', 'full', 'booked', 2],
    // 2 days ago: Faye Ferry (PA) at PD — Linda Nguyen covered (1st pref for Performing Arts)
    [28, 'Faye Ferry', 'Performing Arts', twoDaysAgoStr, twoDaysAgoStr, 'Professional Development', 'All Performing Arts classes', 'Music PD at Williamstown Town Hall', 'full', 'booked', 4],
    // Yesterday: Stephanie Keswick (Yr1) sick AM — Sarah Thompson covered (1st pref for Yr1)
    [9, 'Stephanie Keswick', 'Year 1', yesterdayStr, yesterdayStr, 'Personal Illness/Injury', '1S', 'Feeling unwell', 'am', 'booked', 2],
    // Yesterday: Melati Cordell (Yr5/6) at meeting — Tom Henderson covered (1st pref for Yr5/6)
    [21, 'Melati Cordell', 'Year 5/6', yesterdayStr, yesterdayStr, 'Meeting/Conference', '5/6M', 'Cluster meeting at Altona North PS', 'full', 'booked', 5],

    // --- TODAY (active - the key demo data) ---
    // Georgia Grainger (Prep) sick — Rachel O'Brien booked (1st pref for Prep = Early Years specialist)
    [7, 'Georgia Grainger', 'Prep', todayStr, todayStr, 'Personal Illness/Injury', 'Prep G', 'Called in sick this morning', 'full', 'booked', 6],
    // Paddy Gallivan (PE) at Sport Carnival — Neale Curry booked (1st pref for PE = PE/Sport specialist)
    [29, 'Paddy Gallivan', 'PE / Health', todayStr, todayStr, 'Sport Carnival/Event', 'All PE classes', 'District Athletics at Newport Park', 'full', 'booked', 1],
    // Hayley Thibou (Yr3/4) sick — contacting James Mitchell (1st pref for Yr3/4 = Yr3-6 specialist)
    [15, 'Hayley Thibou', 'Year 3/4', todayStr, todayStr, 'Personal Illness/Injury', '3/4H', '', 'full', 'contacting', 3],

    // --- UPCOMING (shows forward planning) ---
    // Tomorrow: Edan Baccega (Yr5/6) at camp — Tom Henderson booked (1st pref for Yr5/6)
    [24, 'Edan Baccega', 'Year 5/6', tomorrowStr, twoDaysFromNow, 'Excursion/Camp', '5/6E', 'Year 5/6 camp at Anglesea', 'full', 'booked', 5],
    // Tomorrow: Sara Borrens (French) at PD — Linda Nguyen booked (1st pref for French = Languages specialist)
    [30, 'Sara Borrens', 'French (LoTE)', tomorrowStr, tomorrowStr, 'Professional Development', 'All French classes', 'Languages PD - online', 'full', 'booked', 4],
    // Next week: Christina Crosland (Yr5/6) at conference — not yet booked
    [23, 'Christina Crosland', 'Year 5/6', nextWeekStr, nextWeekStr, 'Meeting/Conference', '5/6C', 'STEM conference at Melbourne Convention Centre', 'full', 'pending', null],
    // Next week: Marcia Evans (VA) - carer leave — not yet booked
    [27, 'Marcia Evans', 'Visual Arts', nextWeek2Str, nextWeek3Str, 'Carer Leave', 'All Art classes', '', 'full', 'pending', null],
  ];

  demoAbsences.forEach(a => {
    db.run(
      'INSERT INTO absences (staff_id, staff_name, area, date_start, date_end, reason, classes, notes, half_day, status, assigned_crt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a
    );
  });

  // Demo notifications (recent activity feed)
  const demoNotifications = [
    [`Georgia Grainger (Prep) reported absent — Personal Illness/Injury`, 'urgent', 'leader', 5],
    [`Auto-contacting Rachel O'Brien for Georgia Grainger's absence (Prep)`, 'info', 'leader', 5],
    [`Rachel O'Brien CONFIRMED for Georgia Grainger on ${todayStr}`, 'success', 'leader', 5],
    [`Paddy Gallivan (PE / Health) reported away — Sport Carnival/Event`, 'urgent', 'leader', 6],
    [`Auto-contacting Neale Curry for Paddy Gallivan's absence (PE / Health)`, 'info', 'leader', 6],
    [`Neale Curry CONFIRMED for Paddy Gallivan on ${todayStr}`, 'success', 'leader', 6],
    [`Hayley Thibou (Year 3/4) reported absent — Personal Illness/Injury`, 'urgent', 'leader', 7],
    [`Auto-contacting James Mitchell for Hayley Thibou's absence (Year 3/4)`, 'info', 'leader', 7],
    [`Edan Baccega (Year 5/6) reported away — Excursion/Camp (2 days)`, 'info', 'leader', 8],
    [`Tom Henderson CONFIRMED for Edan Baccega on ${tomorrowStr}`, 'success', 'leader', 8],
    [`Sara Borrens (French) reported away — Professional Development`, 'info', 'leader', 9],
    [`Linda Nguyen CONFIRMED for Sara Borrens on ${tomorrowStr}`, 'success', 'leader', 9],
  ];

  demoNotifications.forEach(n => {
    db.run('INSERT INTO notifications (message, type, for_roles, related_absence_id) VALUES (?, ?, ?, ?)', n);
  });

  // Demo SMS log entries
  const demoSMS = [
    ['0400 000 006', `WPS BOOKING: Can you cover Georgia Grainger's Prep classes on ${todayStr}? Classes: Prep G. Log in to confirm.`, 'simulated'],
    ['0400 000 001', `WPS BOOKING: Can you cover Paddy Gallivan's PE / Health classes on ${todayStr}? Classes: All PE classes. Log in to confirm.`, 'simulated'],
    ['0400 000 003', `WPS BOOKING: Can you cover Hayley Thibou's Year 3/4 classes on ${todayStr}? Classes: 3/4H. Log in to confirm.`, 'simulated'],
  ];

  demoSMS.forEach(s => {
    db.run('INSERT INTO sms_log (to_phone, message, status) VALUES (?, ?, ?)', s);
  });

  console.log(`  ${demoAbsences.length} demo absences (past, today, upcoming)`);
  console.log(`  ${demoNotifications.length} demo notifications`);
  console.log(`  ${demoSMS.length} demo SMS log entries\n`);

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
