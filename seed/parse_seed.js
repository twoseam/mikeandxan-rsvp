// Parses the raw markdown table dump of the "Guest List" tab (as exported by
// Drive's file-content reader) into normalized households/guests, then
// emits a D1-ready SQL seed file. Run: node parse_seed.js
'use strict';
const fs = require('fs');
const path = require('path');

const PLUS_ONE_PLACEHOLDER = 'Plus 1';

function unescapeMd(s) {
  return s
    .replace(/\\#/g, '#')
    .replace(/\\!/g, '!')
    .replace(/\\_/g, '_')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .trim();
}

function stripMergedTag(s) {
  const m = s.match(/^\\\[merged\\\]\s*(.*)$/);
  return unescapeMd(m ? m[1] : s);
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const raw = fs.readFileSync(path.join(__dirname, 'raw_sheet.md'), 'utf8');
const lines = raw.split('\n').filter(l => l.trim().startsWith('|'));

const rows = [];
let lastGroup = '';
let skippedHeaderRows = 0;

for (const line of lines) {
  // Split on unescaped pipes (the markdown escapes # ! _ [ ] but not |)
  const cells = line.split('|').slice(1, -1).map(c => c.trim());
  if (cells.length < 3) continue;
  const [groupRaw, nameRaw, streetRaw] = cells;

  // Skip header/separator rows
  if (groupRaw === ':-:' || nameRaw === ':-:' || streetRaw === ':-:') continue;
  if (nameRaw === 'Name' && streetRaw === 'Street') { skippedHeaderRows++; continue; }

  const name = unescapeMd(nameRaw);
  if (!name) continue; // matches live readGuestList(): blank name -> skip row entirely

  const groupCell = stripMergedTag(groupRaw);
  if (groupCell) lastGroup = groupCell;
  const group = groupCell || lastGroup;

  const address = stripMergedTag(streetRaw);

  rows.push({
    name,
    group,
    address,
    isPlusOne: normalize(name) === normalize(PLUS_ONE_PLACEHOLDER)
  });
}

console.log('Parsed ' + rows.length + ' guest rows (skipped ' + skippedHeaderRows + ' header rows).');

// Group into households by normalized address text (matches live
// buildAllHouseholds(): same non-empty address text => same household,
// regardless of position; blank address => its own solo household).
const order = [];
const byKey = {};
rows.forEach((r, idx) => {
  const key = r.address ? normalize(r.address) : '__solo_' + idx;
  if (!byKey[key]) {
    byKey[key] = { group: r.group, address: r.address, members: [] };
    order.push(key);
  }
  byKey[key].members.push(r);
});

const households = order.map(k => byKey[k]);
console.log('Grouped into ' + households.length + ' households.');

// Sanity checks against known facts before trusting this for a SQL seed.
const totalGuests = households.reduce((n, h) => n + h.members.length, 0);
console.log('Total guest rows across all households: ' + totalGuests);
const jan = households.find(h => h.members.some(m => m.name === 'Jan Schoonover'));
console.log('Jan Schoonover household:', jan ? jan.members.map(m => m.name) : 'NOT FOUND');
const martin = households.find(h => h.members.some(m => m.name === 'Daniel Martin'));
console.log('Daniel Martin household:', martin ? martin.members.map(m => m.name) : 'NOT FOUND');
const plusOneCount = rows.filter(r => r.isPlusOne).length;
console.log('Unclaimed "Plus 1" slots: ' + plusOneCount);

// ---- Emit SQL ----
function sqlEscape(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const lines_out = [];
lines_out.push('-- Auto-generated from the live Google Sheet — see seed/parse_seed.js');
households.forEach((h, hIdx) => {
  lines_out.push(
    `INSERT INTO households (id, group_name, address) VALUES (${hIdx + 1}, ${sqlEscape(h.group || null)}, ${sqlEscape(h.address || null)});`
  );
  h.members.forEach((m, mIdx) => {
    lines_out.push(
      `INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (${hIdx + 1}, ${sqlEscape(m.name)}, ${m.isPlusOne ? 1 : 0}, ${mIdx});`
    );
  });
});

const outPath = path.join(__dirname, 'seed_guests.sql');
fs.writeFileSync(outPath, lines_out.join('\n') + '\n');
console.log('Wrote ' + outPath + ' (' + lines_out.length + ' statements)');

// ---- The 2 real RSVP responses already on file (both "No") ----
const schrierHHIdx = households.findIndex(h => h.members.some(m => m.name === 'Dustin Schrier'));
if (schrierHHIdx === -1) throw new Error('Could not find Dustin Schrier household for RSVP seed');
const schrierHousehold = households[schrierHHIdx];
const schrierHouseholdId = schrierHHIdx + 1;
// Guest ids are assigned sequentially in insertion order starting at 1 —
// mirror that here so the RSVP seed's guest_id FKs are correct, not NULL
// (a NULL guest_id here previously broke the rsvp_guests <-> guests join).
let runningGuestId = 0;
for (const h of households) {
  for (const m of h.members) {
    runningGuestId++;
    if (h === schrierHousehold) m._seedGuestId = runningGuestId;
  }
}
const dustinId = schrierHousehold.members.find(m => m.name === 'Dustin Schrier')._seedGuestId;
const katieId = schrierHousehold.members.find(m => m.name === 'Katie Schrier')._seedGuestId;

const rsvpLines = [
  '-- The 2 real submissions already on file as of this migration (both declined).',
  `INSERT INTO rsvps (id, household_id, submitted_at, email, phone, contact_method, song_request, pizza_topping, notes) VALUES (1, ${schrierHouseholdId}, '2026-08-09T19:55:00-05:00', 'michael@TwoSeam.com', '(816) 786-1561', 'Email', NULL, NULL, NULL);`,
  `INSERT INTO rsvp_guests (rsvp_id, guest_id, guest_name, attending, dietary, dietary_other, is_plus_one, bringing_plus_one) VALUES (1, ${dustinId}, 'Dustin Schrier', 0, NULL, NULL, 0, NULL);`,
  `INSERT INTO rsvp_guests (rsvp_id, guest_id, guest_name, attending, dietary, dietary_other, is_plus_one, bringing_plus_one) VALUES (1, ${katieId}, 'Katie Schrier', 0, NULL, NULL, 0, NULL);`
];
const rsvpOutPath = path.join(__dirname, 'seed_rsvps.sql');
fs.writeFileSync(rsvpOutPath, rsvpLines.join('\n') + '\n');
console.log('Wrote ' + rsvpOutPath + ' (household_id=' + schrierHouseholdId + ')');
