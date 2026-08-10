/**
 * Mike & Xan Wedding RSVP — backend (Cloudflare Worker + D1)
 *
 * Replaces the old Google Apps Script + Sheets backend. Same request/
 * response shapes the frontend already expects:
 *
 *   GET  ?action=lookup&name=...          → guest-facing: matching households
 *   GET  ?action=admin&token=...          → staff-facing: full guest+RSVP dashboard data
 *   POST { action: 'submit',     payload }→ guest-facing: records RSVP + emails Mike + guest
 *   POST { action: 'adminLogin', password }→ staff-facing: password → session token
 *   POST { action: 'adminAddGuest',    token, payload }→ staff-facing: add a guest
 *   POST { action: 'adminRemoveGuest', token, payload }→ staff-facing: remove a guest
 *   POST { action: 'adminEditHousehold', token, payload }→ staff-facing: edit a household's
 *         label/address, rename its guests, add/remove its +1 slot
 *
 * Households/guests/RSVPs are real rows with real ids (see migrations/) —
 * no more matching people by name/row-position the way the Sheet forced us to.
 */

const PLUS_ONE_PLACEHOLDER = 'Plus 1';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NOTIFY_EMAIL = ['michael@twoseam.com', 'aafortenbery@gmail.com'];

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type'
        }
      });
    }

    try {
      if (request.method === 'GET') {
        const action = url.searchParams.get('action');
        if (action === 'lookup') {
          return jsonResponse(await lookupHouseholds(env.DB, url.searchParams.get('name') || ''));
        }
        if (action === 'admin') {
          if (!(await verifySession(env.DB, url.searchParams.get('token') || ''))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
          }
          return jsonResponse(await buildAdminData(env.DB));
        }
        return jsonResponse({ error: 'unknown action' }, 404);
      }

      if (request.method === 'POST') {
        const body = await request.json();
        if (body.action === 'submit') {
          return jsonResponse(await submitRsvp(env, body.payload));
        }
        if (body.action === 'adminLogin') {
          return jsonResponse(await adminLogin(env, body.password || ''));
        }
        if (body.action === 'adminAddGuest') {
          if (!(await verifySession(env.DB, body.token || ''))) return jsonResponse({ error: 'unauthorized' }, 401);
          return jsonResponse(await adminAddGuest(env.DB, body.payload || {}));
        }
        if (body.action === 'adminRemoveGuest') {
          if (!(await verifySession(env.DB, body.token || ''))) return jsonResponse({ error: 'unauthorized' }, 401);
          return jsonResponse(await adminRemoveGuest(env.DB, body.payload || {}));
        }
        if (body.action === 'adminEditHousehold') {
          if (!(await verifySession(env.DB, body.token || ''))) return jsonResponse({ error: 'unauthorized' }, 401);
          return jsonResponse(await adminEditHousehold(env.DB, body.payload || {}));
        }
        if (body.action === 'adminResetRsvp') {
          if (!(await verifySession(env.DB, body.token || ''))) return jsonResponse({ error: 'unauthorized' }, 401);
          return jsonResponse(await adminResetRsvp(env.DB, body.payload || {}));
        }
        return jsonResponse({ error: 'unknown action' }, 404);
      }

      return jsonResponse({ error: 'unknown action' }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: String(err && err.message || err) }, 500);
    }
  }
};

// ====== Admin auth ======

async function adminLogin(env, password) {
  const real = env.ADMIN_PASSWORD;
  if (!real) return { ok: false, error: 'Admin password not configured on the server.' };
  if (!timingSafeStringEqual(String(password), real)) return { ok: false, error: 'Wrong password.' };

  const token = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + SESSION_LIFETIME_MS;
  await env.DB.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(token, new Date(now).toISOString(), new Date(expiresAt).toISOString())
    .run();
  return { ok: true, token, expiresAt };
}

async function verifySession(db, token) {
  if (!token) return false;
  const row = await db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').bind(token).first();
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

function timingSafeStringEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

// ====== Shared household-building (used by lookup + admin) ======

async function buildAllHouseholds(db) {
  const guestRows = (await db.prepare(
    `SELECT h.id AS household_id, h.group_name, h.address,
            h.envelope_name, h.envelope_subline,
            g.id AS guest_id, g.name, g.is_plus_one
     FROM households h
     JOIN guests g ON g.household_id = h.id
     ORDER BY h.id, g.sort_order`
  ).all()).results;

  const rsvpRows = (await db.prepare(
    `SELECT r.id AS rsvp_id, r.household_id, r.submitted_at, r.email, r.phone,
            r.contact_method, r.song_request, r.pizza_topping, r.notes,
            rg.guest_id, rg.guest_name, rg.attending, rg.dietary, rg.dietary_other, rg.bringing_plus_one
     FROM rsvps r
     JOIN rsvp_guests rg ON rg.rsvp_id = r.id`
  ).all()).results;

  const rsvpByHousehold = {};
  rsvpRows.forEach(row => {
    if (!rsvpByHousehold[row.household_id]) {
      rsvpByHousehold[row.household_id] = {
        submittedAt: row.submitted_at,
        email: row.email, phone: row.phone, contactMethod: row.contact_method,
        songRequest: row.song_request, pizzaTopping: row.pizza_topping, notes: row.notes,
        byGuestId: {}
      };
    }
    rsvpByHousehold[row.household_id].byGuestId[row.guest_id] = row;
  });

  const householdsMap = {};
  const order = [];
  guestRows.forEach(row => {
    if (!householdsMap[row.household_id]) {
      householdsMap[row.household_id] = {
        id: row.household_id, group: row.group_name || '', address: row.address || '',
        envelopeName: row.envelope_name || '', envelopeSubline: row.envelope_subline || '',
        members: []
      };
      order.push(row.household_id);
    }
    householdsMap[row.household_id].members.push({ id: row.guest_id, name: row.name, isPlusOne: !!row.is_plus_one });
  });

  return order.map(hid => {
    const h = householdsMap[hid];
    const rsvp = rsvpByHousehold[hid];
    const memberNames = h.members.map(m => m.name);
    const realMemberNames = h.members.filter(m => !m.isPlusOne).map(m => m.name);

    let memberSnapshots = h.members.map(m => ({ id: m.id, name: m.name, isPlusOne: m.isPlusOne, attending: '', dietary: '', dietaryOther: '' }));
    let existing = null;

    if (rsvp) {
      memberSnapshots = h.members.map(m => {
        const row = rsvp.byGuestId[m.id];
        if (!row) {
          return m.isPlusOne
            ? { id: m.id, name: m.name, isPlusOne: true, bringingPlusOne: '', actualName: '', attending: '', dietary: '', dietaryOther: '' }
            : { id: m.id, name: m.name, attending: '', dietary: '', dietaryOther: '' };
        }
        if (m.isPlusOne) {
          const bringing = row.bringing_plus_one === 'yes';
          return {
            id: m.id, name: m.name, isPlusOne: true,
            bringingPlusOne: row.bringing_plus_one || 'no',
            actualName: bringing ? row.guest_name : '',
            attending: bringing ? (row.attending ? 'yes' : 'no') : '',
            dietary: row.dietary || '', dietaryOther: row.dietary_other || ''
          };
        }
        return { id: m.id, name: m.name, attending: row.attending ? 'yes' : 'no', dietary: row.dietary || '', dietaryOther: row.dietary_other || '' };
      });
      existing = {
        members: memberSnapshots,
        timestamp: rsvp.submittedAt,
        email: rsvp.email || '', phone: rsvp.phone || '', contactMethod: rsvp.contactMethod || '',
        songRequest: rsvp.songRequest || '', pizzaTopping: rsvp.pizzaTopping || '', notes: rsvp.notes || ''
      };
    }

    return {
      id: h.id,
      label: formatHouseholdLabel(memberNames),
      address: h.address,
      group: h.group,
      envelopeName: h.envelopeName,
      envelopeSubline: h.envelopeSubline,
      members: memberSnapshots,
      alreadySubmitted: !!rsvp,
      alreadySubmittedFor: rsvp ? formatHouseholdLabel(realMemberNames) : '',
      existing
    };
  });
}

// ====== Lookup (guest-facing) ======

async function lookupHouseholds(db, query) {
  const all = await buildAllHouseholds(db);
  const matches = all.filter(h => h.members.some(m => !m.isPlusOne && nameMatches(m.name, query)));
  return {
    households: matches.map(h => ({
      id: h.id,
      label: h.label,
      address: h.address,
      members: h.members.map(m => ({ id: m.id, name: m.name, isPlusOne: m.isPlusOne })),
      alreadySubmitted: h.alreadySubmitted,
      alreadySubmittedFor: h.alreadySubmittedFor,
      existing: h.existing
    }))
  };
}

// ====== Admin dashboard data ======

async function buildAdminData(db) {
  const households = await buildAllHouseholds(db);

  let invited = 0, responded = 0, attending = 0, declined = 0;
  households.forEach(h => {
    h.members.forEach(m => {
      invited++;
      if (m.isPlusOne && m.bringingPlusOne !== 'yes') return;
      if (m.attending === 'yes') { responded++; attending++; }
      else if (m.attending === 'no') { responded++; declined++; }
    });
  });

  return {
    stats: { invited, responded, notResponded: invited - responded, attending, declined },
    households
  };
}

// ====== Address normalization (safe, mechanical subset only) ======
//
// Applied automatically whenever an address is saved (new household, or an
// edit) - not the full address-cleanup pass, just the part of it that's
// safe to run unsupervised on arbitrary future input: abbreviation
// expansion and whitespace/punctuation mechanics. Deliberately does NOT
// try to insert a missing comma between street and city - with no
// delimiter, splitting "123 Main St Kansas City MO" requires knowing where
// a multi-word city name begins, which isn't safe to guess automatically
// (the original cleanup pass did that by hand, address by address).
//
// NOT \bTOKEN\b - a plain word boundary treats an apostrophe as a break,
// so "Lee's" reads as two words and "St" inside "Lee's" would corrupt into
// "Lee'Street". Lookaround against real separator characters avoids that.
const ADDR_SEP_BEFORE = '(?<=^|[\\s,])';
const ADDR_SEP_AFTER = '(?=$|[\\s,.])';
function addrTok(word) {
  return new RegExp(ADDR_SEP_BEFORE + word + '\\.?' + ADDR_SEP_AFTER, 'gi');
}
const ADDR_SUFFIX_ABBR = [
  [addrTok('St'), 'Street'], [addrTok('Ave'), 'Avenue'], [addrTok('Dr'), 'Drive'],
  [addrTok('Rd'), 'Road'], [addrTok('Ct'), 'Court'], [addrTok('Crt'), 'Court'],
  [addrTok('Ln'), 'Lane'], [addrTok('Terr'), 'Terrace'], [addrTok('Cir'), 'Circle'],
  [addrTok('Blvd'), 'Boulevard'], [addrTok('Pkwy'), 'Parkway'], [addrTok('Pl'), 'Place']
];
const ADDR_DIRECTIONAL_ABBR = [
  [addrTok('NE'), 'Northeast'], [addrTok('NW'), 'Northwest'],
  [addrTok('SE'), 'Southeast'], [addrTok('SW'), 'Southwest'],
  [addrTok('N'), 'North'], [addrTok('S'), 'South'], [addrTok('E'), 'East'], [addrTok('W'), 'West']
];
const ADDR_SAINT_PLACES = ['Louis', 'Petersburg', 'Paul', 'Joseph'];
function normalizeAddress(address) {
  let out = String(address || '').trim();
  if (!out) return out;

  ADDR_SAINT_PLACES.forEach(place => {
    const re = new RegExp('\\bSt\\.?\\s+' + place + '\\b', 'gi');
    out = out.replace(re, m => m.replace(/^St\.?/i, ' SAINT '));
  });
  ADDR_SUFFIX_ABBR.forEach(([re, full]) => { out = out.replace(re, full); });
  ADDR_DIRECTIONAL_ABBR.forEach(([re, full]) => { out = out.replace(re, full); });
  out = out.replace(/ SAINT /g, 'Saint');

  out = out.replace(/\s{2,}/g, ' ').trim();
  out = out.replace(/!+\s*$/g, '');
  out = out.replace(/,\s*(\d{5}(-\d{4})?)\b/g, ' $1');
  // "KCMO" / "KC MO" before a ZIP is unambiguous (it IS the city+state
  // token), so unlike a generic missing street/city comma this one is
  // safe to fix mechanically - Michael hit it on a newly added guest.
  out = out.replace(/,?\s+KC\s?MO\s+(?=\d{5})/gi, ', Kansas City, MO ');
  out = out.replace(/\bMissouri\b/gi, 'MO');
  out = out.replace(/\bKansas\b(?!\s+City)/gi, 'KS');
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/\s+,/g, ',');
  out = out.replace(/,(?=\S)/g, ', ');
  return out.trim();
}

// ====== Envelope name auto-generation ======
//
// Only ever called when a household's envelope_name is currently empty -
// never overwrites something Michael already curated (nicknames like "Aly"
// become "Alyson" on envelopes, which no formula can derive, so once a
// value exists it's his to own).
function envLastName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}
function envFirstName(fullName) {
  return fullName.trim().split(/\s+/)[0];
}
function envJoinWithAmp(list) {
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return list[0] + ' & ' + list[1];
  return list.slice(0, -1).join(', ') + ', & ' + list[list.length - 1];
}
function generateEnvelopeName(members) {
  const real = members.filter(m => !m.isPlusOne);
  const hasPlusOne = members.some(m => m.isPlusOne);
  if (!real.length) return { envelopeName: '', envelopeSubline: '' };

  if (real.length > 3) {
    const surnames = new Set(real.map(m => envLastName(m.name)).filter(Boolean));
    const surname = surnames.size === 1 ? [...surnames][0] : envLastName(real[0].name);
    return {
      envelopeName: 'The ' + surname + ' Family',
      envelopeSubline: envJoinWithAmp(real.map(m => envFirstName(m.name)))
    };
  }

  const surnames = new Set(real.map(m => envLastName(m.name)).filter(Boolean));
  let baseNames;
  if (real.length >= 2 && surnames.size === 1) {
    baseNames = [envJoinWithAmp(real.map(m => envFirstName(m.name))) + ' ' + [...surnames][0]];
  } else {
    baseNames = real.map(m => m.name);
  }
  const parts = hasPlusOne ? [...baseNames, 'Guest'] : baseNames;
  return { envelopeName: envJoinWithAmp(parts), envelopeSubline: '' };
}

// Recomputes and saves a household's envelope name/subline after its guest
// list changes (add or remove) - but only while the stored value still
// looks machine-generated. "Still looks auto" means it exactly matches
// what generateEnvelopeName() would have produced from the membership
// *before* this change; once Michael hand-edits a value (e.g. "Aly" ->
// "Alyson", or a custom "Family" framing), it diverges from that formula
// and this stops touching it - so a later add/remove to the same
// household won't clobber his correction, but an untouched household
// keeps tracking its membership automatically, which is the whole point.
function envNameStateEqual(a, b) {
  return (a.envelopeName || '') === (b.envelopeName || '') && (a.envelopeSubline || '') === (b.envelopeSubline || '');
}
async function regenerateEnvelopeNameIfStillAuto(db, householdId, priorMembers) {
  const household = await db.prepare('SELECT envelope_name, envelope_subline FROM households WHERE id = ?').bind(householdId).first();
  if (!household) return;
  const stored = { envelopeName: household.envelope_name || '', envelopeSubline: household.envelope_subline || '' };
  const expectedFromPrior = generateEnvelopeName(priorMembers);
  const stillAuto = !stored.envelopeName || envNameStateEqual(stored, expectedFromPrior);
  if (!stillAuto) return;

  const guestRows = (await db.prepare('SELECT name, is_plus_one FROM guests WHERE household_id = ? ORDER BY sort_order')
    .bind(householdId).all()).results;
  const currentMembers = guestRows.map(g => ({ name: g.name, isPlusOne: !!g.is_plus_one }));
  const fresh = generateEnvelopeName(currentMembers);
  if (!fresh.envelopeName) return;
  await db.prepare('UPDATE households SET envelope_name = ?, envelope_subline = ? WHERE id = ?')
    .bind(fresh.envelopeName, fresh.envelopeSubline || null, householdId).run();
}

// ====== Guest add/remove (admin-facing) ======

async function adminAddGuest(db, payload) {
  const name = String(payload.name || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };

  if (payload.householdId) {
    const household = await db.prepare('SELECT id, address FROM households WHERE id = ?').bind(payload.householdId).first();
    if (!household) return { ok: false, error: 'Could not find that household — try refreshing.' };
    const priorRows = (await db.prepare('SELECT name, is_plus_one FROM guests WHERE household_id = ?').bind(household.id).all()).results;
    const priorMembers = priorRows.map(g => ({ name: g.name, isPlusOne: !!g.is_plus_one }));
    const maxSort = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM guests WHERE household_id = ?').bind(household.id).first();
    await db.prepare('INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (?, ?, 0, ?)')
      .bind(household.id, name, maxSort.m + 1).run();
    await regenerateEnvelopeNameIfStillAuto(db, household.id, priorMembers);
    return { ok: true };
  }

  const group = String(payload.group || '').trim() || null;
  const address = normalizeAddress(payload.address) || null;
  const insertHousehold = await db.prepare('INSERT INTO households (group_name, address) VALUES (?, ?)').bind(group, address).run();
  const householdId = insertHousehold.meta.last_row_id;
  await db.prepare('INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (?, ?, 0, 0)')
    .bind(householdId, name).run();
  await regenerateEnvelopeNameIfStillAuto(db, householdId, []);
  return { ok: true };
}

async function adminRemoveGuest(db, payload) {
  const guestId = Number(payload.guestId);
  const expectedName = normalize(payload.name || '');
  if (!guestId) return { ok: false, error: 'Invalid guest.' };

  const row = await db.prepare('SELECT name, household_id FROM guests WHERE id = ?').bind(guestId).first();
  if (!row) return { ok: false, error: 'stale', message: 'That guest is already gone — refresh and try again.' };
  if (expectedName && normalize(row.name) !== expectedName) {
    return { ok: false, error: 'stale', message: 'That row changed — refresh and try again.' };
  }
  const priorRows = (await db.prepare('SELECT name, is_plus_one FROM guests WHERE household_id = ?').bind(row.household_id).all()).results;
  const priorMembers = priorRows.map(g => ({ name: g.name, isPlusOne: !!g.is_plus_one }));
  await db.prepare('DELETE FROM guests WHERE id = ?').bind(guestId).run();
  await regenerateEnvelopeNameIfStillAuto(db, row.household_id, priorMembers);
  return { ok: true };
}

// Edits a household's label/address, envelope name/subline, renames its
// guests, and optionally adds/removes its open +1 slot (a real
// is_plus_one=1 guest row) — everything the admin card shows as one
// editable unit. allowPlusOne is only sent when the card showed the toggle
// (single-real-guest household); null/undefined leaves the +1 slot
// untouched.
async function adminEditHousehold(db, payload) {
  const householdId = Number(payload.householdId);
  if (!householdId) return { ok: false, error: 'Invalid household.' };

  const household = await db.prepare('SELECT id FROM households WHERE id = ?').bind(householdId).first();
  if (!household) return { ok: false, error: 'stale', message: 'That household is gone — refresh and try again.' };

  const group = String(payload.group || '').trim() || null;
  const address = normalizeAddress(payload.address) || null;
  const submittedEnvelope = {
    envelopeName: String(payload.envelopeName || '').trim(),
    envelopeSubline: String(payload.envelopeSubline || '').trim()
  };

  // The edit form always round-trips whatever was already in the envelope
  // fields, so an unchanged submission looks identical to a real value -
  // "was this typed by Michael or just carried through?" is answered by
  // comparing it to what auto-gen would have produced from the guest list
  // *before* this save. If it matches (or was empty), a guest rename in
  // this same save should still flow through to a fresh auto value; if it
  // doesn't match, he typed something custom and it's respected as-is.
  const priorRows = (await db.prepare('SELECT name, is_plus_one FROM guests WHERE household_id = ?').bind(householdId).all()).results;
  const priorMembers = priorRows.map(g => ({ name: g.name, isPlusOne: !!g.is_plus_one }));
  const expectedFromPrior = generateEnvelopeName(priorMembers);
  const submissionIsStillAuto = !submittedEnvelope.envelopeName || envNameStateEqual(submittedEnvelope, expectedFromPrior);

  const guests = Array.isArray(payload.guests) ? payload.guests : [];
  for (const g of guests) {
    const guestId = Number(g.id);
    const name = String(g.name || '').trim();
    if (!guestId || !name) continue;
    await db.prepare('UPDATE guests SET name = ? WHERE id = ? AND household_id = ?')
      .bind(name, guestId, householdId).run();
  }

  let envelopeName = submittedEnvelope.envelopeName || null;
  let envelopeSubline = submittedEnvelope.envelopeSubline || null;
  if (submissionIsStillAuto) {
    const afterRows = (await db.prepare('SELECT name, is_plus_one FROM guests WHERE household_id = ?').bind(householdId).all()).results;
    const afterMembers = afterRows.map(g => ({ name: g.name, isPlusOne: !!g.is_plus_one }));
    const fresh = generateEnvelopeName(afterMembers);
    if (fresh.envelopeName) {
      envelopeName = fresh.envelopeName;
      envelopeSubline = fresh.envelopeSubline || null;
    }
  }

  await db.prepare('UPDATE households SET group_name = ?, address = ?, envelope_name = ?, envelope_subline = ? WHERE id = ?')
    .bind(group, address, envelopeName, envelopeSubline, householdId).run();

  if (payload.allowPlusOne === true) {
    const existing = await db.prepare('SELECT id FROM guests WHERE household_id = ? AND is_plus_one = 1').bind(householdId).first();
    if (!existing) {
      const maxSort = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM guests WHERE household_id = ?').bind(householdId).first();
      await db.prepare('INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (?, ?, 1, ?)')
        .bind(householdId, PLUS_ONE_PLACEHOLDER, maxSort.m + 1).run();
    }
  } else if (payload.allowPlusOne === false) {
    const plusOneGuest = await db.prepare('SELECT id FROM guests WHERE household_id = ? AND is_plus_one = 1').bind(householdId).first();
    if (plusOneGuest) {
      const claimed = await db.prepare(
        "SELECT 1 FROM rsvp_guests WHERE guest_id = ? AND bringing_plus_one = 'yes'"
      ).bind(plusOneGuest.id).first();
      if (!claimed) {
        await db.prepare('DELETE FROM guests WHERE id = ?').bind(plusOneGuest.id).run();
      }
    }
  }

  return { ok: true };
}

// Clears a household's RSVP entirely (back to "no response") — the guest
// can submit fresh afterward, same as if they'd never responded.
async function adminResetRsvp(db, payload) {
  const householdId = Number(payload.householdId);
  if (!householdId) return { ok: false, error: 'Invalid household.' };
  await db.prepare('DELETE FROM rsvps WHERE household_id = ?').bind(householdId).run();
  return { ok: true };
}

// ====== Nickname-aware name matching (guest-facing lookup) ======

const NICKNAMES = {
  alex:    ['alexander', 'alexandra', 'alexandria'],
  xan:     ['alexander', 'alexandra', 'alexandria'],
  beth:    ['elizabeth'],
  bill:    ['william'],
  billy:   ['william'],
  will:    ['william'],
  bob:     ['robert'],
  bobby:   ['robert'],
  rob:     ['robert'],
  robbie:  ['robert'],
  becky:   ['rebecca'],
  charlie: ['charles'],
  chuck:   ['charles'],
  cindy:   ['cynthia'],
  dave:    ['david'],
  dick:    ['richard'],
  ed:      ['edward'],
  eddie:   ['edward'],
  frank:   ['francis', 'franklin'],
  hank:    ['henry'],
  harry:   ['harold', 'henry'],
  jen:     ['jennifer'],
  jenny:   ['jennifer'],
  jim:     ['james'],
  jimmy:   ['james'],
  joe:     ['joseph'],
  joey:    ['joseph'],
  kate:    ['katherine', 'kathleen', 'kathryn'],
  kathy:   ['katherine', 'kathleen'],
  katie:   ['katherine'],
  larry:   ['lawrence'],
  liz:     ['elizabeth'],
  lizzie:  ['elizabeth'],
  maggie:  ['margaret'],
  meg:     ['margaret'],
  mike:    ['michael'],
  mikey:   ['michael'],
  nick:    ['nicholas'],
  nicky:   ['nicholas'],
  pat:     ['patrick', 'patricia'],
  pete:    ['peter'],
  peggy:   ['margaret'],
  rich:    ['richard'],
  rick:    ['richard'],
  ricky:   ['richard'],
  sam:     ['samuel', 'samantha'],
  sandy:   ['sandra'],
  steve:   ['steven', 'stephen'],
  sue:     ['susan'],
  susie:   ['susan'],
  ted:     ['theodore', 'edward'],
  teddy:   ['theodore'],
  tina:    ['christina', 'christine'],
  tom:     ['thomas'],
  tommy:   ['thomas'],
  tony:    ['anthony']
};

function expandToken(token) {
  const variants = new Set([token]);
  if (NICKNAMES[token]) NICKNAMES[token].forEach(formal => variants.add(formal));
  Object.keys(NICKNAMES).forEach(nick => {
    if (NICKNAMES[nick].indexOf(token) !== -1) variants.add(nick);
  });
  return Array.from(variants);
}

function nameMatches(name, query) {
  const nameTokens = normalize(name).split(' ').filter(Boolean);
  const queryTokens = normalize(query).split(' ').filter(Boolean);
  if (queryTokens.length === 0) return false;
  return queryTokens.every(qt => {
    const variants = expandToken(qt);
    return nameTokens.some(nt => variants.some(v => nt.indexOf(v) === 0));
  });
}

function formatHouseholdLabel(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' & ' + names[1];
  return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDietary(diet, other) {
  if (!diet) return '';
  if (diet === 'other') return 'Other: ' + (other || '');
  return diet.charAt(0).toUpperCase() + diet.slice(1);
}

// Friendly label for a member (uses actual +1 name if provided).
function labelFor(m) {
  if (m.isPlusOne) {
    const actual = String(m.actualName || '').trim();
    if (actual && String(m.bringingPlusOne || '').toLowerCase() === 'yes') return actual;
    return PLUS_ONE_PLACEHOLDER;
  }
  return m.name;
}

// ====== Submit (guest-facing RSVP) ======

async function submitRsvp(env, payload) {
  const db = env.DB;
  if (!payload || !Array.isArray(payload.members) || payload.members.length === 0) {
    return { ok: false, error: 'No members in submission.' };
  }
  if (!payload.email) return { ok: false, error: 'Email is required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email).trim())) {
    return { ok: false, error: 'Email format is invalid.' };
  }
  if (!payload.contactMethod) return { ok: false, error: 'Preferred contact method is required.' };

  const anchor = payload.members.find(m => !m.isPlusOne && m.id) || payload.members.find(m => m.id);
  if (!anchor) return { ok: false, error: 'Missing guest identity — please look up your invitation again.' };
  const guestRow = await db.prepare('SELECT household_id FROM guests WHERE id = ?').bind(anchor.id).first();
  if (!guestRow) return { ok: false, error: 'Could not find your household — please look up your invitation again.' };
  const householdId = guestRow.household_id;

  const existingRsvp = await db.prepare('SELECT id FROM rsvps WHERE household_id = ?').bind(householdId).first();

  if (payload.editing) {
    if (existingRsvp) await db.prepare('DELETE FROM rsvps WHERE id = ?').bind(existingRsvp.id).run();
  } else if (existingRsvp) {
    return { error: 'duplicate', alreadySubmittedFor: anchor.name };
  }

  const now = new Date().toISOString();
  const email = String(payload.email).trim();
  const phone = String(payload.phone || '').trim();
  const contactMethod = String(payload.contactMethod).trim();
  const songRequest = String(payload.songRequest || '');
  const pizzaTopping = String(payload.pizzaTopping || '');
  const notes = String(payload.notes || '');

  const insertRsvp = await db.prepare(
    `INSERT INTO rsvps (household_id, submitted_at, email, phone, contact_method, song_request, pizza_topping, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(householdId, now, email, phone || null, contactMethod, songRequest || null, pizzaTopping || null, notes || null).run();
  const rsvpId = insertRsvp.meta.last_row_id;

  const guestStmts = payload.members.map(m => {
    let nameOut, attendingOut, dietary, dietaryOther, bringingPlusOne;
    if (m.isPlusOne) {
      const bringing = String(m.bringingPlusOne || '').toLowerCase() === 'yes';
      const actualName = String(m.actualName || '').trim();
      bringingPlusOne = bringing && actualName ? 'yes' : 'no';
      nameOut = bringing && actualName ? actualName : PLUS_ONE_PLACEHOLDER;
      attendingOut = bringing && actualName ? 1 : 0;
      dietary = bringing ? (m.dietary || null) : null;
      dietaryOther = bringing ? (m.dietaryOther || null) : null;
    } else {
      nameOut = m.name;
      attendingOut = m.attending === 'yes' ? 1 : 0;
      dietary = m.dietary || null;
      dietaryOther = m.dietaryOther || null;
      bringingPlusOne = null;
    }
    return db.prepare(
      `INSERT INTO rsvp_guests (rsvp_id, guest_id, guest_name, attending, dietary, dietary_other, is_plus_one, bringing_plus_one)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(rsvpId, m.id || null, nameOut, attendingOut, dietary, dietaryOther, m.isPlusOne ? 1 : 0, bringingPlusOne);
  });
  await db.batch(guestStmts);

  const householdLabel = formatHouseholdLabel(payload.members.map(m => labelFor(m)));

  await sendNotification(env, payload, householdLabel, email, phone, contactMethod, songRequest, pizzaTopping, notes);
  try {
    await sendGuestConfirmation(env, payload, householdLabel, email, songRequest, pizzaTopping);
  } catch (err) {
    console.error('Guest confirmation failed: ' + err);
  }

  return { ok: true, edited: !!payload.editing };
}

// ====== Internal notification email (to Michael + Alexandria) ======

async function sendNotification(env, payload, householdLabel, email, phone, contactMethod, songRequest, pizzaTopping, notes) {
  let yesCount = 0, noCount = 0;
  payload.members.forEach(m => {
    if (m.isPlusOne) {
      if (String(m.bringingPlusOne || '').toLowerCase() === 'yes' && String(m.actualName || '').trim()) yesCount++;
      else noCount++;
    } else {
      if (m.attending === 'yes') yesCount++; else noCount++;
    }
  });

  const tag = payload.editing ? '[EDIT] ' : '';
  const subject = tag + 'RSVP — ' + householdLabel + ' (' + yesCount + ' yes, ' + noCount + ' no)';

  const lines = [];
  if (payload.editing) lines.push('** This is an EDIT — previous response for this household was replaced. **');
  lines.push('Household: ' + householdLabel);
  lines.push('');
  payload.members.forEach(m => {
    if (m.isPlusOne) {
      const bringing = String(m.bringingPlusOne || '').toLowerCase() === 'yes';
      const actualName = String(m.actualName || '').trim();
      if (bringing && actualName) {
        lines.push('— ' + actualName + ' (+1): YES');
        if (m.dietary) lines.push('  Dietary: ' + formatDietary(m.dietary, m.dietaryOther));
      } else {
        lines.push('— Plus 1: declined / not bringing');
      }
    } else {
      lines.push('— ' + m.name + ': ' + (m.attending === 'yes' ? 'YES' : 'NO'));
      if (m.dietary) lines.push('  Dietary: ' + formatDietary(m.dietary, m.dietaryOther));
    }
  });
  lines.push('');
  lines.push('Email: ' + email);
  if (phone) lines.push('Phone: ' + phone);
  lines.push('Preferred contact: ' + contactMethod);
  lines.push('');
  if (songRequest) lines.push('Song request: ' + songRequest);
  if (pizzaTopping) lines.push('Favorite pizza topping: ' + pizzaTopping);
  if (notes) lines.push('Notes: ' + notes);
  lines.push('');
  lines.push('— Posted by the wedding site');

  // Styled HTML body - same visual language as the guest confirmation
  // email (Georgia serif, 640px card, brand orange, green/red attendance).
  const memberRowsHtml = payload.members.map(m => {
    let name, isYes, extraTag = '';
    if (m.isPlusOne) {
      const bringing = String(m.bringingPlusOne || '').toLowerCase() === 'yes';
      const actualName = String(m.actualName || '').trim();
      if (bringing && actualName) { name = actualName; isYes = true; extraTag = ' <span style="color:#a89580;">(+1)</span>'; }
      else { return '<li style="margin:8px 0; color:#a89580;">Plus 1: declined / not bringing</li>'; }
    } else {
      name = m.name;
      isYes = m.attending === 'yes';
    }
    const pill = isYes
      ? '<strong style="color:#3a7a3a;">YES</strong>'
      : '<strong style="color:#a02a23;">NO</strong>';
    const diet = m.dietary
      ? '<div style="color:#7a6a55; font-size:14px; margin-top:2px;">Dietary: ' + escapeHtml(formatDietary(m.dietary, m.dietaryOther)) + '</div>'
      : '';
    return '<li style="margin:8px 0;">' + escapeHtml(name) + extraTag + ': ' + pill + diet + '</li>';
  }).join('');

  const editBanner = payload.editing
    ? '<div style="margin:0 0 18px; padding:10px 16px; background:#a02a23; color:#ffffff; border-radius:8px; font-size:14px; font-weight:600;">EDIT — this household\'s previous response was replaced</div>'
    : '';

  const contactRows =
    '<div style="margin:6px 0;"><span style="color:#7a6a55;">Email:</span> <a href="mailto:' + escapeHtml(email) + '" style="color:#eb5519;">' + escapeHtml(email) + '</a></div>' +
    (phone ? '<div style="margin:6px 0;"><span style="color:#7a6a55;">Phone:</span> ' + escapeHtml(phone) + '</div>' : '') +
    '<div style="margin:6px 0;"><span style="color:#7a6a55;">Preferred contact:</span> ' + escapeHtml(contactMethod) + '</div>';

  const extras = [];
  if (songRequest) extras.push('<div style="margin:6px 0;"><span style="color:#7a6a55;">Song request:</span> ' + escapeHtml(songRequest) + '</div>');
  if (pizzaTopping) extras.push('<div style="margin:6px 0;"><span style="color:#7a6a55;">Favorite pizza topping:</span> ' + escapeHtml(pizzaTopping) + '</div>');
  if (notes) extras.push('<div style="margin:6px 0;"><span style="color:#7a6a55;">Notes:</span> ' + escapeHtml(notes) + '</div>');
  const extrasBlock = extras.length
    ? '<div style="margin:0 0 20px; padding:12px 16px; background:#fde6d5; border-radius:8px; font-size:15px;">' + extras.join('') + '</div>'
    : '';

  const htmlBody =
    '<div style="background:#ffffff; padding:32px 16px; font-family:Georgia, \'Times New Roman\', serif;">' +
      '<div style="max-width:640px; margin:0 auto; background:#ffffff; padding:32px; border-radius:10px; color:#2a2a2a; line-height:1.55; border:1px solid #f0e4d6;">' +
        editBanner +
        '<p style="margin:0 0 4px; font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#eb5519; font-weight:700;">RSVP received</p>' +
        '<p style="margin:0 0 6px; font-size:20px; font-weight:700;">' + escapeHtml(householdLabel) + '</p>' +
        '<p style="margin:0 0 18px; font-size:15px; color:#7a6a55;">' + yesCount + ' yes &middot; ' + noCount + ' no</p>' +
        '<ul style="list-style:none; padding:0; margin:0 0 20px;">' + memberRowsHtml + '</ul>' +
        extrasBlock +
        '<div style="border-top:1px solid #e6cfb6; padding-top:16px; margin-top:8px; font-size:15px;">' + contactRows + '</div>' +
        '<p style="margin-top:24px; font-style:italic; color:#a89580; font-size:13px;">Posted by the wedding site</p>' +
      '</div>' +
    '</div>';

  await sendViaResend(env, {
    to: NOTIFY_EMAIL,
    subject,
    text: lines.join('\n'),
    html: htmlBody
  });
}

// ====== Guest confirmation email ======

async function sendGuestConfirmation(env, payload, householdLabel, email, songRequest, pizzaTopping) {
  if (!email) return;

  const isEdit = !!payload.editing;
  const subject = isEdit ? 'Your RSVP was updated' : 'We got your RSVP!';
  const opener = isEdit
    ? "Got your update — all the information you entered is below. If you need to make any more changes, click the button at the bottom of this email."
    : "Thanks for RSVP'ing for our wedding! All of the information you entered is below. If you need to make any changes, click the button at the bottom of the page.";
  const openerExtra = "Any updates or new information about the wedding and reception will come to you via your preferred contact method. We will only send important stuff, promise.";

  const CAL_URL = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Michael+%26+Alexandria%27s+Wedding&dates=20261114T220000Z%2F20261115T040000Z&details=Please+arrive+by+4%3A00+pm.+The+ceremony+begins+at+approximately+4%3A30+pm.%0A%0ACheck+mikeandxan.com+for+the+latest+details%2C+travel+info%2C+and+updates+as+the+day+approaches.&location=The+Thompson+Barn%2C+11184+Lackman+Rd%2C+Lenexa%2C+KS+66219';
  const ICS_URL = 'https://mikeandxan.com/assets/wedding.ics';
  const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=11184+Lackman+Rd%2C+Lenexa%2C+KS+66219';

  const lookupGuest = payload.members.find(m => !m.isPlusOne) || payload.members[0] || {};
  const lookupName = String(lookupGuest.name || '').trim();
  const CHANGE_URL = 'https://mikeandxan.com/?rsvp=1' + (lookupName ? '&name=' + encodeURIComponent(lookupName) : '') + '#rsvp';

  const textLines = [opener, '', openerExtra, ''];
  payload.members.forEach(m => {
    if (m.isPlusOne) {
      const bringing = String(m.bringingPlusOne || '').toLowerCase() === 'yes';
      const actualName = String(m.actualName || '').trim();
      if (bringing && actualName) {
        textLines.push('— ' + actualName + ' (+1): ATTENDING');
        if (m.dietary) textLines.push('  Dietary: ' + formatDietary(m.dietary, m.dietaryOther));
      } else {
        textLines.push('— Plus 1: not bringing');
      }
    } else {
      textLines.push('— ' + m.name + ': ' + (m.attending === 'yes' ? 'ATTENDING' : 'NOT ATTENDING'));
      if (m.dietary) textLines.push('  Dietary: ' + formatDietary(m.dietary, m.dietaryOther));
    }
  });
  if (songRequest) { textLines.push(''); textLines.push('Song request: ' + songRequest); }
  if (pizzaTopping) { if (!songRequest) textLines.push(''); textLines.push('Favorite pizza topping: ' + pizzaTopping); }
  textLines.push('', 'November 14, 2026 · 4:00 PM', 'The Thompson Barn · 11184 Lackman Rd, Lenexa, KS 66219', '');
  textLines.push('Add to your calendar (Google): ' + CAL_URL);
  textLines.push('Apple / Outlook: ' + ICS_URL);
  textLines.push('Change RSVP: ' + CHANGE_URL);
  textLines.push('', "Can't wait to party with y'all!", '', '— Michael & Alexandria');

  const htmlMembers = payload.members.map(m => {
    if (m.isPlusOne) {
      const bringing = String(m.bringingPlusOne || '').toLowerCase() === 'yes';
      const actualName = String(m.actualName || '').trim();
      if (bringing && actualName) {
        const diet = m.dietary
          ? '<div style="color:#7a6a55; font-size:14px; margin-top:2px;">Dietary: ' + escapeHtml(formatDietary(m.dietary, m.dietaryOther)) + '</div>'
          : '';
        return '<li style="margin: 8px 0;">' + escapeHtml(actualName) + ' <span style="color:#a89580;">(+1)</span>: <strong style="color:#3a7a3a;">ATTENDING</strong>' + diet + '</li>';
      }
      return '<li style="margin: 8px 0; color:#a89580;">Plus 1: not bringing</li>';
    }
    const att = m.attending === 'yes'
      ? '<strong style="color:#3a7a3a;">ATTENDING</strong>'
      : '<strong style="color:#a02a23;">NOT ATTENDING</strong>';
    const diet = m.dietary
      ? '<div style="color:#7a6a55; font-size:14px; margin-top:2px;">Dietary: ' + escapeHtml(formatDietary(m.dietary, m.dietaryOther)) + '</div>'
      : '';
    return '<li style="margin: 8px 0;">' + escapeHtml(m.name) + ': ' + att + diet + '</li>';
  }).join('');

  const extras = [];
  if (songRequest) extras.push('<div style="margin: 6px 0;"><span style="color:#7a6a55;">Song request:</span> ' + escapeHtml(songRequest) + '</div>');
  if (pizzaTopping) extras.push('<div style="margin: 6px 0;"><span style="color:#7a6a55;">Favorite pizza topping:</span> ' + escapeHtml(pizzaTopping) + '</div>');
  const extrasBlock = extras.length
    ? '<div style="margin: 0 0 20px; padding: 12px 16px; background:#fde6d5; border-radius: 8px; font-size: 15px;">' + extras.join('') + '</div>'
    : '';

  const buttonStyle = 'display:inline-block; padding: 14px 36px; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; font-family: Helvetica, Arial, sans-serif; letter-spacing: 0.025em; margin: 6px 6px 6px 0;';
  const buttonsBlock =
    '<div style="margin: 24px 0;">' +
      '<a href="' + CAL_URL + '" style="' + buttonStyle + ' background:#eb5519; color:#ffffff; box-shadow: 0 2px 10px rgba(235, 85, 25, 0.28);">Add to your calendar</a>' +
      '<a href="' + CHANGE_URL + '" style="' + buttonStyle + ' background:transparent; color:#eb5519; border: 1.5px solid #eb5519;">Change RSVP</a>' +
      '<div style="margin: 4px 0 0; font-size: 13px;"><a href="' + ICS_URL + '" style="color:#7a6a55; text-decoration: underline;">Use Apple Calendar or Outlook instead</a></div>' +
    '</div>';

  const htmlBody =
    '<div style="background:#ffffff; padding: 32px 16px; font-family: Georgia, \'Times New Roman\', serif;">' +
      '<div style="max-width: 640px; margin: 0 auto; background:#ffffff; padding: 32px; border-radius: 10px; color:#2a2a2a; line-height: 1.55;">' +
        '<img src="https://mikeandxan.com/assets/email-head.jpg" alt="Michael & Alexandria" width="640" height="240" style="display:block; width:100%; max-width:640px; height:auto; margin:0 0 20px; border-radius:6px;" />' +
        '<p style="margin:0 0 14px; font-size:16px;">' + escapeHtml(opener) + '</p>' +
        '<p style="margin:0 0 18px; font-size:16px;">' + escapeHtml(openerExtra) + '</p>' +
        '<ul style="list-style:none; padding:0; margin:0 0 20px;">' + htmlMembers + '</ul>' +
        extrasBlock +
        '<div style="border-top: 1px solid #e6cfb6; padding-top: 16px; margin-top: 8px;">' +
          '<p style="margin:0; font-size:17px;"><strong>November 14, 2026 · 4:00 PM</strong></p>' +
          '<p style="margin:4px 0 0;"><a href="' + MAP_URL + '" style="color:#7a6a55; text-decoration: underline;">The Thompson Barn · 11184 Lackman Rd, Lenexa, KS 66219</a></p>' +
        '</div>' +
        buttonsBlock +
        "<p>Can't wait to party with y'all!</p>" +
        '<p style="margin-top:24px; font-style:italic; color:#7a6a55;">— Michael &amp; Alexandria</p>' +
      '</div>' +
    '</div>';

  await sendViaResend(env, {
    to: [email],
    subject,
    text: textLines.join('\n'),
    html: htmlBody,
    attachments: [{ filename: 'wedding.ics', content: base64Encode(buildIcs()) }]
  });
}

function buildIcs() {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Michael and Alexandria Wedding//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:wedding-2026-11-14@mikeandxan.com',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261114T220000Z',
    'DTEND:20261115T040000Z',
    "SUMMARY:Michael & Alexandria's Wedding",
    'LOCATION:The Thompson Barn\\, 11184 Lackman Rd\\, Lenexa\\, KS 66219',
    'DESCRIPTION:Please arrive by 4:00 pm. The ceremony begins at approximately 4:30 pm.\\n\\nCheck mikeandxan.com for the latest details\\, travel info\\, and updates as the day approaches.',
    'URL:https://mikeandxan.com/',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function sendViaResend(env, opts) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY missing — skipping email send.');
    return;
  }
  const body = {
    from: 'Michael & Alexandria <hello@mikeandxan.com>',
    to: opts.to,
    reply_to: 'hello@mikeandxan.com',
    subject: opts.subject,
    html: opts.html,
    text: opts.text
  };
  if (opts.attachments && opts.attachments.length) body.attachments = opts.attachments;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    console.error('Resend API error ' + response.status + ': ' + (await response.text()));
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
