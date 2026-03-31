// Seed real timetable data from Paddy's uploaded files
// Run this once to populate the Turso database

const { createClient } = require('@libsql/client');
require('dotenv').config();

const db = createClient({
  url: process.env.TURSO_URL || 'libsql://wps-staff-hub-paddygallivan.aws-us-east-1.turso.io',
  authToken: process.env.TURSO_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzQ0ODQ2MTUsImlkIjoiMDE5ZDI3ODYtNTQwMS03MzM4LWFhZTQtOWI5NThkMjNjYjYyIiwicmlkIjoiYjZmYjczYWYtYmE2MC00YjhmLTkyZDMtZGY4YmI0YzQzNWEzIn0.HbLxuuJ-xkOGrfZ_thQvU3njT499Ng2-GXtz1pwuwUQVexVydvWFaGah5bt5i65VAFUI74b0p4U2Ix6gXiX5DQ'
});

async function seed() {
  console.log('Connecting to database...');

  // 1. Delete old timetables
  console.log('Clearing old timetables...');
  await db.execute('DELETE FROM timetables');

  // 2. Planning Days Timetable (Week 10 - current week March 31 2026)
  // This maps specialist subjects (columns) to class codes (cells) per time slot per day
  // Headers: Time, Art, Music, PE, French, Extra (CRT/Zoe/KG-KF)
  const planningData = {
    headers: ["Time", "Art", "Music", "PE", "French", "Extra"],
    rows: [
      // MONDAY - Year 5/6 planning day
      { Time: "Monday" },
      { Time: "9:00-10:00", Art: "56M", Music: "56C", PE: "56B", French: "56H", Extra: "56E" },
      { Time: "10:00-11:00", Art: "56E", Music: "56M", PE: "56C", French: "56B", Extra: "56H" },
      { Time: "11:30-12:30", Art: "56H", Music: "56E", PE: "56M", French: "56C", Extra: "56B" },
      { Time: "12:30-1:30", Art: "56B", Music: "56H", PE: "56E", French: "56M", Extra: "56C" },
      { Time: "2:30-3:30", Art: "56C", Music: "56B", PE: "56H", French: "56E", Extra: "56M" },
      // TUESDAY - Year 3/4 planning day
      { Time: "Tuesday" },
      { Time: "9:00-10:00", Art: "34T", Music: "34P", PE: "34M", French: "34S", Extra: "34B" },
      { Time: "10:00-11:00", Art: "34B", Music: "34T", PE: "34P", French: "34M", Extra: "34S" },
      { Time: "11:30-12:30", Art: "34S", Music: "34B", PE: "34T", French: "34P", Extra: "34M" },
      { Time: "12:30-1:30", Art: "34M", Music: "34S", PE: "34B", French: "34T", Extra: "34P" },
      { Time: "2:30-3:30", Art: "34P", Music: "34M", PE: "34S", French: "34B", Extra: "34T" },
      // WEDNESDAY - Year 1/2 planning day
      { Time: "Wednesday" },
      { Time: "9:00-10:00", Art: "2J", Music: "2I", PE: "2W", French: "1K", Extra: "1E" },
      { Time: "10:00-11:00", Art: "1E", Music: "2J", PE: "2I", French: "2W", Extra: "1K" },
      { Time: "11:30-12:30", Art: "1K", Music: "1E", PE: "2J", French: "2I", Extra: "2W" },
      { Time: "12:30-1:30", Art: "2W", Music: "1K", PE: "1E", French: "2J", Extra: "2I" },
      { Time: "2:30-3:30", Art: "2I", Music: "2W", PE: "1K", French: "1E", Extra: "2J" },
      // THURSDAY - Prep planning + Easter Hat Parade
      { Time: "Thursday" },
      { Time: "9:00-10:00", Art: "Easter", Music: "Easter", PE: "Easter", French: "Easter", Extra: "Easter" },
      { Time: "10:00-11:00", Art: "Hat Parade", Music: "Hat Parade", PE: "Hat Parade", French: "Hat Parade", Extra: "Hat Parade" },
      { Time: "11:30-12:30", Art: "Resources", Music: "Resources", PE: "Resources", French: "56M", Extra: "Planning" },
      { Time: "12:30-1:30", Art: "Resources", Music: "Resources", PE: "Resources", French: "56M", Extra: "Planning" },
      // FRIDAY - Good Friday (public holiday)
      { Time: "Friday" },
      { Time: "9:00-10:00", Art: "Good Friday", Music: "Good Friday", PE: "Good Friday", French: "Good Friday", Extra: "Good Friday" },
    ]
  };

  console.log('Uploading Planning Days timetable...');
  await db.execute({
    sql: 'INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['Planning Days Week 10', 'specialist', 1, JSON.stringify(planningData), 1, 1]
  });
  console.log('✓ Planning Days uploaded');

  // 3. Classroom teacher timetable - maps each teacher to their home class per day
  // This is the KEY timetable for classroom teacher absences
  // Based on the class codes from Planning Days:
  // 56M, 56E, 56H, 56B, 56C = Year 5/6 classes
  // 34T, 34B, 34S, 34M, 34P = Year 3/4 classes
  // 2J, 2I, 2W, 1E, 1K = Year 1/2 classes
  // PG, PD, PS = Prep classes
  const classroomData = {
    headers: ["Time", "Melati", "Emma", "Hayley", "Joel", "Claire",
              "Caitlin", "Sara", "Marcia", "Anna", "Edan",
              "Grace", "Georgia", "Steph", "Katherine", "Matt EJ",
              "Alison", "Bianca R", "Bianca I", "Kayleen", "Rochelle",
              "Katja", "Christina", "Molly", "Zoe"],
    rows: [
      // Classroom teachers teach their home class all day every day
      // Year 5/6
      { Time: "Monday", Melati: "56M", Emma: "56E", Hayley: "56H", Joel: "56B", Claire: "56C",
        Caitlin: "34T", Sara: "34S", Marcia: "34M", Anna: "34P", Edan: "34B",
        Grace: "2J", Georgia: "2I", Steph: "2W", Katherine: "1E", "Matt EJ": "1K",
        Alison: "Prep G", "Bianca R": "Prep D", "Bianca I": "Prep S",
        Kayleen: "", Rochelle: "", Katja: "", Christina: "", Molly: "", Zoe: "" },
      { Time: "Tuesday", Melati: "56M", Emma: "56E", Hayley: "56H", Joel: "56B", Claire: "56C",
        Caitlin: "34T", Sara: "34S", Marcia: "34M", Anna: "34P", Edan: "34B",
        Grace: "2J", Georgia: "2I", Steph: "2W", Katherine: "1E", "Matt EJ": "1K",
        Alison: "Prep G", "Bianca R": "Prep D", "Bianca I": "Prep S",
        Kayleen: "", Rochelle: "", Katja: "", Christina: "", Molly: "", Zoe: "" },
      { Time: "Wednesday", Melati: "56M", Emma: "56E", Hayley: "56H", Joel: "56B", Claire: "56C",
        Caitlin: "34T", Sara: "34S", Marcia: "34M", Anna: "34P", Edan: "34B",
        Grace: "2J", Georgia: "2I", Steph: "2W", Katherine: "1E", "Matt EJ": "1K",
        Alison: "Prep G", "Bianca R": "Prep D", "Bianca I": "Prep S",
        Kayleen: "", Rochelle: "", Katja: "", Christina: "", Molly: "", Zoe: "" },
      { Time: "Thursday", Melati: "56M", Emma: "56E", Hayley: "56H", Joel: "56B", Claire: "56C",
        Caitlin: "34T", Sara: "34S", Marcia: "34M", Anna: "34P", Edan: "34B",
        Grace: "2J", Georgia: "2I", Steph: "2W", Katherine: "1E", "Matt EJ": "1K",
        Alison: "Prep G", "Bianca R": "Prep D", "Bianca I": "Prep S",
        Kayleen: "", Rochelle: "", Katja: "", Christina: "", Molly: "", Zoe: "" },
      { Time: "Friday", Melati: "56M", Emma: "56E", Hayley: "56H", Joel: "56B", Claire: "56C",
        Caitlin: "34T", Sara: "34S", Marcia: "34M", Anna: "34P", Edan: "34B",
        Grace: "2J", Georgia: "2I", Steph: "2W", Katherine: "1E", "Matt EJ": "1K",
        Alison: "Prep G", "Bianca R": "Prep D", "Bianca I": "Prep S",
        Kayleen: "", Rochelle: "", Katja: "", Christina: "", Molly: "", Zoe: "" }
    ]
  };

  console.log('Uploading Classroom Teachers timetable...');
  await db.execute({
    sql: 'INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['Classroom Teachers Term 1', 'general', 1, JSON.stringify(classroomData), 1, 1]
  });
  console.log('✓ Classroom Teachers uploaded');

  // 4. ES Timetable (Education Support staff) - Week 10 Monday
  const esData = {
    headers: ["Time", "Michelle", "Bee", "Kelly", "Rachel", "Jade", "Prue", "Alana", "Lou", "Maddie"],
    rows: [
      { Time: "Monday" },
      { Time: "9:00-10:00", Michelle: "Noah L", Bee: "Ceci", Kelly: "Mariam", Rachel: "Juan", Jade: "", Prue: "Elijah", Alana: "Billy", Lou: "Mia", Maddie: "Zain" },
      { Time: "10:00-11:00", Michelle: "Noah L", Bee: "Will/Munib", Kelly: "Mariam", Rachel: "Josh C", Jade: "", Prue: "Elijah", Alana: "Eleanor", Lou: "Mia", Maddie: "Zain" },
      { Time: "11:30-12:30", Michelle: "Josh C", Bee: "Ceci", Kelly: "Noah A", Rachel: "Noah L", Jade: "Dom/Archie", Prue: "Elijah", Alana: "Eleanor", Lou: "", Maddie: "Zain" },
      { Time: "12:30-1:30", Michelle: "Noah L", Bee: "Ceci", Kelly: "Noah A", Rachel: "Josh C", Jade: "Dom/Archie", Prue: "Elijah", Alana: "Eleanor", Lou: "", Maddie: "Zain" },
      { Time: "2:30-3:30", Michelle: "Noah L", Bee: "Hunter", Kelly: "George", Rachel: "Juan", Jade: "Dom/Archie", Prue: "Elijah", Alana: "", Lou: "", Maddie: "Zain" },
    ]
  };

  console.log('Uploading ES Timetable...');
  await db.execute({
    sql: 'INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['ES Timetable Week 10', 'es', 1, JSON.stringify(esData), 1, 1]
  });
  console.log('✓ ES Timetable uploaded');

  // 5. Yard Duty Timetable - who has duty at each area/time each day
  // Columns: 8:45-9:00, Recess 11:10, Recess 11:20, Lunch 1:40, Lunch 2:00, 3:30-3:45
  // Areas: Front (Blue North), Back (Blue South), Redbrick, Oval (Gallery-Deck), Bluestone Lounge
  // The * person in the Lunch 2:00 column also does the Additional Duty: Front 2:10-2:30
  const yardDutyData = {
    headers: ["Day", "Area", "8:45-9:00", "Recess 11:10", "Recess 11:20", "Lunch 1:40", "Lunch 2:00", "3:30-3:45"],
    rows: [
      { Day: "Monday" },
      { Day: "", Area: "Front", "8:45-9:00": "Leadership", "Recess 11:10": "Edan", "Recess 11:20": "Joel", "Lunch 1:40": "Melati", "Lunch 2:00": "Molly*", "3:30-3:45": "Leadership" },
      { Day: "", Area: "Back", "8:45-9:00": "", "Recess 11:10": "Matt EJ", "Recess 11:20": "Katherine", "Lunch 1:40": "Hayley", "Lunch 2:00": "Rebecca", "3:30-3:45": "" },
      { Day: "", Area: "Redbrick", "8:45-9:00": "", "Recess 11:10": "Anna", "Recess 11:20": "Caitlin", "Lunch 1:40": "Steven", "Lunch 2:00": "Georgia", "3:30-3:45": "" },
      { Day: "", Area: "Oval", "8:45-9:00": "", "Recess 11:10": "Paddy", "Recess 11:20": "Melati", "Lunch 1:40": "Matt EJ", "Lunch 2:00": "Paddy", "3:30-3:45": "" },
      { Day: "", Area: "Bluestone Lounge", "8:45-9:00": "", "Recess 11:10": "", "Recess 11:20": "", "Lunch 1:40": "Bee", "Lunch 2:00": "Anna", "3:30-3:45": "" },
      { Day: "Tuesday" },
      { Day: "", Area: "Front", "8:45-9:00": "Leadership", "Recess 11:10": "Molly", "Recess 11:20": "Grace", "Lunch 1:40": "Sara", "Lunch 2:00": "Claire*", "3:30-3:45": "Leadership" },
      { Day: "", Area: "Back", "8:45-9:00": "", "Recess 11:10": "Sara", "Recess 11:20": "Katherine", "Lunch 1:40": "Molly", "Lunch 2:00": "Steph", "3:30-3:45": "" },
      { Day: "", Area: "Redbrick", "8:45-9:00": "", "Recess 11:10": "Caitlin", "Recess 11:20": "Emma", "Lunch 1:40": "Joel", "Lunch 2:00": "Caitlin", "3:30-3:45": "" },
      { Day: "", Area: "Oval", "8:45-9:00": "", "Recess 11:10": "Matt EJ", "Recess 11:20": "Steven", "Lunch 1:40": "Paddy", "Lunch 2:00": "Edan", "3:30-3:45": "" },
      { Day: "", Area: "Bluestone Lounge", "8:45-9:00": "", "Recess 11:10": "", "Recess 11:20": "", "Lunch 1:40": "Anna", "Lunch 2:00": "Bee", "3:30-3:45": "" },
      { Day: "Wednesday" },
      { Day: "", Area: "Front", "8:45-9:00": "Leadership", "Recess 11:10": "Grace", "Recess 11:20": "Anna", "Lunch 1:40": "Grace", "Lunch 2:00": "Alison*", "3:30-3:45": "Leadership" },
      { Day: "", Area: "Back", "8:45-9:00": "", "Recess 11:10": "Katherine", "Recess 11:20": "Melati", "Lunch 1:40": "Marcia", "Lunch 2:00": "Bianca I", "3:30-3:45": "" },
      { Day: "", Area: "Redbrick", "8:45-9:00": "", "Recess 11:10": "Georgia", "Recess 11:20": "Caitlin", "Lunch 1:40": "Georgia", "Lunch 2:00": "Emma", "3:30-3:45": "" },
      { Day: "", Area: "Oval", "8:45-9:00": "", "Recess 11:10": "Edan", "Recess 11:20": "Matt EJ", "Lunch 1:40": "Christina", "Lunch 2:00": "Steven", "3:30-3:45": "" },
      { Day: "", Area: "Bluestone Lounge", "8:45-9:00": "", "Recess 11:10": "", "Recess 11:20": "", "Lunch 1:40": "Anna", "Lunch 2:00": "Bee", "3:30-3:45": "" },
      { Day: "Thursday" },
      { Day: "", Area: "Front", "8:45-9:00": "Leadership", "Recess 11:10": "Alison", "Recess 11:20": "Bianca R", "Lunch 1:40": "Katja", "Lunch 2:00": "Sara*", "3:30-3:45": "Leadership" },
      { Day: "", Area: "Back", "8:45-9:00": "", "Recess 11:10": "Kayleen", "Recess 11:20": "Hayley", "Lunch 1:40": "Rochelle", "Lunch 2:00": "Katherine", "3:30-3:45": "" },
      { Day: "", Area: "Redbrick", "8:45-9:00": "", "Recess 11:10": "Rochelle", "Recess 11:20": "Edan", "Lunch 1:40": "Claire", "Lunch 2:00": "Rebecca", "3:30-3:45": "" },
      { Day: "", Area: "Oval", "8:45-9:00": "", "Recess 11:10": "Claire", "Recess 11:20": "Matt EJ", "Lunch 1:40": "Bianca I", "Lunch 2:00": "Christina", "3:30-3:45": "" },
      { Day: "", Area: "Bluestone Lounge", "8:45-9:00": "", "Recess 11:10": "", "Recess 11:20": "", "Lunch 1:40": "Belinda", "Lunch 2:00": "Anna", "3:30-3:45": "" },
      { Day: "Friday" },
      { Day: "", Area: "Front", "8:45-9:00": "Leadership", "Recess 11:10": "Kayleen", "Recess 11:20": "Steph", "Lunch 1:40": "Alison", "Lunch 2:00": "Marcia*", "3:30-3:45": "Leadership" },
      { Day: "", Area: "Back", "8:45-9:00": "", "Recess 11:10": "Rochelle", "Recess 11:20": "Katja", "Lunch 1:40": "Rochelle", "Lunch 2:00": "Katja", "3:30-3:45": "" },
      { Day: "", Area: "Redbrick", "8:45-9:00": "", "Recess 11:10": "Zoe", "Recess 11:20": "Marcia", "Lunch 1:40": "Steph", "Lunch 2:00": "Hayley", "3:30-3:45": "" },
      { Day: "", Area: "Oval", "8:45-9:00": "", "Recess 11:10": "Anna", "Recess 11:20": "Bianca R", "Lunch 1:40": "Emma", "Lunch 2:00": "Joel", "3:30-3:45": "" },
      { Day: "", Area: "Bluestone Lounge", "8:45-9:00": "", "Recess 11:10": "", "Recess 11:20": "", "Lunch 1:40": "Anna", "Lunch 2:00": "Anna", "3:30-3:45": "" },
    ],
    // Additional Duty: Front 2:10-2:30 (rotating weekly, * marks the person in Lunch 2:00 column)
    additionalDuty: {
      area: "Front",
      time: "2:10-2:30",
      // Week 10 roster:
      week10: { Monday: "Caitlin", Tuesday: "Katja", Wednesday: "Steph", Thursday: "Bianca R", Friday: "Claire" }
    }
  };

  console.log('Uploading Yard Duty timetable...');
  await db.execute({
    sql: 'INSERT INTO timetables (name, type, term, data, is_current, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['Yard Duty Term 1', 'yard_duty', 1, JSON.stringify(yardDutyData), 1, 1]
  });
  console.log('✓ Yard Duty uploaded');

  console.log('\n✅ All timetables uploaded successfully!');
  console.log('Verifying...');

  const count = await db.execute('SELECT COUNT(*) as c FROM timetables');
  console.log(`Total timetables in DB: ${count.rows[0].c}`);

  const all = await db.execute('SELECT id, name, type, is_current FROM timetables');
  all.rows.forEach(r => console.log(`  [${r.id}] ${r.name} (${r.type}) current=${r.is_current}`));

  process.exit(0);
}

seed().catch(e => { console.error('Error:', e); process.exit(1); });
