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
      householdsMap[row.household_id] = { id: row.household_id, group: row.group_name || '', address: row.address || '', members: [] };
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

// ====== Guest add/remove (admin-facing) ======

async function adminAddGuest(db, payload) {
  const name = String(payload.name || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };

  if (payload.householdId) {
    const household = await db.prepare('SELECT id, address FROM households WHERE id = ?').bind(payload.householdId).first();
    if (!household) return { ok: false, error: 'Could not find that household — try refreshing.' };
    const maxSort = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM guests WHERE household_id = ?').bind(household.id).first();
    await db.prepare('INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (?, ?, 0, ?)')
      .bind(household.id, name, maxSort.m + 1).run();
    return { ok: true };
  }

  const group = String(payload.group || '').trim() || null;
  const address = String(payload.address || '').trim() || null;
  const insertHousehold = await db.prepare('INSERT INTO households (group_name, address) VALUES (?, ?)').bind(group, address).run();
  await db.prepare('INSERT INTO guests (household_id, name, is_plus_one, sort_order) VALUES (?, ?, 0, 0)')
    .bind(insertHousehold.meta.last_row_id, name).run();
  return { ok: true };
}

async function adminRemoveGuest(db, payload) {
  const guestId = Number(payload.guestId);
  const expectedName = normalize(payload.name || '');
  if (!guestId) return { ok: false, error: 'Invalid guest.' };

  const row = await db.prepare('SELECT name FROM guests WHERE id = ?').bind(guestId).first();
  if (!row) return { ok: false, error: 'stale', message: 'That guest is already gone — refresh and try again.' };
  if (expectedName && normalize(row.name) !== expectedName) {
    return { ok: false, error: 'stale', message: 'That row changed — refresh and try again.' };
  }
  await db.prepare('DELETE FROM guests WHERE id = ?').bind(guestId).run();
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

  await sendViaResend(env, {
    to: NOTIFY_EMAIL,
    subject,
    text: lines.join('\n'),
    html: '<pre style="font-family:inherit;white-space:pre-wrap;">' + escapeHtml(lines.join('\n')) + '</pre>'
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

  const CAL_URL = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Michael+%26+Alexandria%27s+Wedding&dates=20261114T220000Z%2F20261115T040000Z&details=Arrive+by+4%3A00+pm+%C2%B7+Ceremony+at+4%3A00+pm+%C2%B7+Reception+at+4%3A00+pm%0A%0ACheck+mikeandxan.com+for+the+latest+details%2C+travel+info%2C+and+updates+as+the+day+approaches.&location=The+Thompson+Barn%2C+11184+Lackman+Rd%2C+Lenexa%2C+KS+66219';
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
    'DESCRIPTION:Arrive by 4:00 pm. Ceremony at 4:00 pm. Reception at 4:00 pm.\\n\\nCheck mikeandxan.com for the latest details\\, travel info\\, and updates as the day approaches.',
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
