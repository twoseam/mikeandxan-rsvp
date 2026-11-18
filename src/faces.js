/**
 * Face tagging for the photo site.
 *
 * Flow:
 *  1. The helper on Michael's Mac Studio asks for unscanned feed items
 *     (faceTodo), finds faces locally, and posts each item's faces back
 *     (faceResults): box, face crop, fingerprint (embedding).
 *  2. New faces are compared with faces Michael already tagged:
 *       similarity >= AUTO_TAG → tagged automatically
 *       similarity >= ASK      → kept as a suggestion ("Is this Jack?")
 *       otherwise              → a brand-new face to name
 *  3. When Michael names a face (faceLabel), every untagged face is compared
 *     with it and auto-tagged / suggested the same way.
 *
 * Similarity is the same 0..1 score the Human library uses (its docs:
 * above 0.5 "can be considered a match"). The two lines below are the
 * margin of error — tune them here.
 */

export const AUTO_TAG = 0.60;
export const ASK = 0.45;
const IGNORED_NAME = 'Ignored';

// ---------- fingerprint math (mirrors human.match.similarity) ----------

export function decodeEmb(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  const dist = Math.round(100 * 25 * sum) / 100;
  if (dist === 0) return 1;
  const min = 0.2, max = 0.8;
  const norm = (1 - Math.sqrt(dist) / 100 - min) / (max - min);
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
}

const rejectedSet = (s) => new Set(String(s || '').split(',').filter(Boolean).map(Number));
const now = () => new Date().toISOString();
const mediaUrl = (key) => (key ? '/media/' + encodeURIComponent(key) : '');

// ---------- helper (Mac Studio) ----------

export async function faceTodo(env, info) {
  await env.DB.prepare('UPDATE face_helper SET last_seen = ?, info = ? WHERE id = 1')
    .bind(now(), info ? String(info).slice(0, 300) : null).run();
  const rows = (await env.DB.prepare(
    `SELECT id, r2_key, content_type FROM feed_items
     WHERE faces_scanned_at IS NULL ORDER BY id LIMIT 25`
  ).all()).results;
  return { ok: true, items: rows.map(r => ({ id: r.id, mediaPath: mediaUrl(r.r2_key), contentType: r.content_type })) };
}

export async function faceResults(env, payload) {
  const itemId = Number(payload.itemId);
  if (!itemId) return { ok: false, error: 'Missing item id.' };
  const item = await env.DB.prepare('SELECT id FROM feed_items WHERE id = ?').bind(itemId).first();
  if (!item) return { ok: true, skipped: true }; // deleted meanwhile

  // A re-scan replaces earlier untagged faces for this item.
  await deleteFaces(env, 'item_id = ? AND person_id IS NULL', [itemId]);

  if (payload.error) {
    await env.DB.prepare('UPDATE feed_items SET faces_scanned_at = ?, faces_error = ? WHERE id = ?')
      .bind(now(), String(payload.error).slice(0, 300), itemId).run();
    return { ok: true };
  }

  const faces = Array.isArray(payload.faces) ? payload.faces.slice(0, 60) : [];
  const refs = await labeledFaces(env.DB);
  // Faces already tagged in this item survive a re-scan — don't add them twice.
  const kept = (await env.DB.prepare('SELECT box FROM faces WHERE item_id = ?').bind(itemId).all()).results
    .map(r => safeJson(r.box)).filter(Boolean);
  const stmts = [];
  for (const f of faces) {
    const emb = decodeEmb(f.embedding);
    if (!emb) continue;
    if (Array.isArray(f.box) && kept.some(b => iou(b, f.box) > 0.4)) continue;
    const thumbKey = 'face/' + itemId + '-' + crypto.randomUUID() + '.jpg';
    if (f.thumb) {
      const bin = atob(f.thumb);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await env.MEDIA.put(thumbKey, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    }
    const m = bestMatch(emb, refs, new Set());
    let personId = null, status = 'new', sugId = null, sugSim = null;
    if (m.confirmed && m.confirmed.sim >= AUTO_TAG) { personId = m.confirmed.personId; status = 'auto'; }
    else if (m.any && m.any.sim >= ASK) { sugId = m.any.personId; sugSim = m.any.sim; }
    stmts.push(env.DB.prepare(
      `INSERT INTO faces (item_id, box, size, thumb_key, embedding, person_id, status, suggest_person_id, suggest_sim, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(itemId, JSON.stringify(f.box || []), Math.round(Number(f.size) || 0), f.thumb ? thumbKey : null,
      f.embedding, personId, status, sugId, sugSim, now()));
  }
  stmts.push(env.DB.prepare('UPDATE feed_items SET faces_scanned_at = ?, faces_error = NULL WHERE id = ?').bind(now(), itemId));
  await env.DB.batch(stmts);
  return { ok: true, saved: stmts.length - 1 };
}

// Tagged faces with fingerprints, for matching new faces against.
async function labeledFaces(db) {
  const rows = (await db.prepare(
    `SELECT person_id, status, embedding FROM faces
     WHERE person_id IS NOT NULL AND embedding IS NOT NULL`
  ).all()).results;
  return rows.map(r => ({ personId: r.person_id, confirmed: r.status === 'confirmed', emb: decodeEmb(r.embedding) }));
}

// Best match overall, and best match among faces Michael confirmed himself.
// Auto-tagging only trusts confirmed faces so one wrong auto-tag can't snowball.
function bestMatch(emb, refs, rejected) {
  let any = null, confirmed = null;
  for (const r of refs) {
    if (rejected.has(r.personId)) continue;
    const sim = similarity(emb, r.emb);
    if (!any || sim > any.sim) any = { personId: r.personId, sim };
    if (r.confirmed && (!confirmed || sim > confirmed.sim)) confirmed = { personId: r.personId, sim };
  }
  return { any, confirmed };
}

// ---------- admin: labeling ----------

export async function faceQueue(env) {
  const db = env.DB;
  const faceCols = `f.id, f.item_id, f.box, f.size, f.thumb_key, f.suggest_person_id, f.suggest_sim,
    i.r2_key, i.thumb_key AS item_thumb, i.content_type`;
  const suggested = (await db.prepare(
    `SELECT ${faceCols}, p.name AS suggest_name FROM faces f
     JOIN feed_items i ON i.id = f.item_id
     JOIN people p ON p.id = f.suggest_person_id
     WHERE f.person_id IS NULL AND f.suggest_sim >= ?
     ORDER BY f.suggest_sim DESC, f.size DESC LIMIT 20`
  ).bind(ASK).all()).results;
  const fresh = (await db.prepare(
    `SELECT ${faceCols} FROM faces f JOIN feed_items i ON i.id = f.item_id
     WHERE f.person_id IS NULL AND (f.suggest_person_id IS NULL OR f.suggest_sim IS NULL OR f.suggest_sim < ?)
     ORDER BY f.size DESC LIMIT 20`
  ).bind(ASK).all()).results;

  // One reference crop per suggested person, so "Is this Jack?" shows Jack.
  const refThumbs = {};
  const sugIds = [...new Set(suggested.map(r => r.suggest_person_id))];
  for (const pid of sugIds) {
    const r = await db.prepare(
      `SELECT thumb_key FROM faces WHERE person_id = ? AND status = 'confirmed' AND thumb_key IS NOT NULL
       ORDER BY size DESC LIMIT 1`
    ).bind(pid).first();
    refThumbs[pid] = r ? mediaUrl(r.thumb_key) : '';
  }

  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM feed_items WHERE faces_scanned_at IS NULL) AS waiting,
       (SELECT COUNT(*) FROM feed_items WHERE faces_scanned_at IS NOT NULL) AS scanned,
       (SELECT COUNT(*) FROM feed_items WHERE faces_error IS NOT NULL) AS failed,
       (SELECT COUNT(*) FROM faces) AS faces,
       (SELECT COUNT(*) FROM faces WHERE person_id IS NULL AND suggest_sim >= ?1) AS ask,
       (SELECT COUNT(*) FROM faces WHERE person_id IS NULL AND (suggest_sim IS NULL OR suggest_sim < ?1)) AS fresh,
       (SELECT COUNT(*) FROM faces WHERE status = 'auto') AS auto,
       (SELECT COUNT(*) FROM faces WHERE status = 'confirmed') AS confirmed`
  ).bind(ASK).first();
  const helper = await db.prepare('SELECT last_seen, info FROM face_helper WHERE id = 1').first();

  return {
    ok: true,
    autoTag: AUTO_TAG, ask: ASK,
    counts, helper,
    suggested: suggested.map(r => ({ ...faceOut(r), suggestId: r.suggest_person_id, suggestName: r.suggest_name, suggestSim: r.suggest_sim, suggestThumb: refThumbs[r.suggest_person_id] || '' })),
    fresh: fresh.map(faceOut),
    people: await peopleWithCounts(db, true),
    guests: await guestNames(db)
  };
}

function faceOut(r) {
  return {
    id: r.id, itemId: r.item_id, box: safeJson(r.box), size: r.size,
    thumb: mediaUrl(r.thumb_key),
    photo: mediaUrl(r.content_type && r.content_type.startsWith('video/') ? (r.item_thumb || r.r2_key) : r.r2_key),
    isVideo: !!(r.content_type && r.content_type.startsWith('video/'))
  };
}
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
}
const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function guestNames(db) {
  const rows = (await db.prepare(
    `SELECT g.id, g.name, g.is_plus_one,
       (SELECT rg.guest_name FROM rsvp_guests rg WHERE rg.guest_id = g.id ORDER BY rg.id DESC LIMIT 1) AS claimed
     FROM guests g ORDER BY g.name`
  ).all()).results;
  return rows
    .map(r => ({ id: r.id, name: (r.is_plus_one && r.claimed) ? r.claimed : r.name }))
    .filter(r => r.name && r.name !== 'Plus 1');
}

async function peopleWithCounts(db, includeIgnored) {
  const rows = (await db.prepare(
    `SELECT p.id, p.name, p.guest_id, p.ignored,
       (SELECT COUNT(*) FROM (
          SELECT f.item_id FROM faces f JOIN feed_items i ON i.id = f.item_id WHERE f.person_id = p.id AND i.hidden = 0
          UNION SELECT t.item_id FROM photo_tags t JOIN feed_items i ON i.id = t.item_id WHERE t.person_id = p.id AND i.hidden = 0
       )) AS photos
     FROM people p ${includeIgnored ? '' : 'WHERE p.ignored = 0'} ORDER BY p.name`
  ).all()).results;
  return rows.map(r => ({ id: r.id, name: r.name, guestId: r.guest_id, ignored: !!r.ignored, photos: r.photos }));
}

// Find or create the person a label points at.
async function resolvePerson(db, p) {
  if (p.ignore) {
    const row = await db.prepare('SELECT id FROM people WHERE ignored = 1 ORDER BY id LIMIT 1').first();
    if (row) return row.id;
    const r = await db.prepare('INSERT INTO people (name, ignored, created_at) VALUES (?, 1, ?)').bind(IGNORED_NAME, now()).run();
    return r.meta.last_row_id;
  }
  if (p.personId) {
    const row = await db.prepare('SELECT id FROM people WHERE id = ?').bind(Number(p.personId)).first();
    return row ? row.id : null;
  }
  if (p.guestId) {
    const row = await db.prepare('SELECT id FROM people WHERE guest_id = ?').bind(Number(p.guestId)).first();
    if (row) return row.id;
    const names = await guestNames(db);
    const g = names.find(n => n.id === Number(p.guestId));
    if (!g) return null;
    const r = await db.prepare('INSERT INTO people (name, guest_id, created_at) VALUES (?, ?, ?)').bind(g.name, g.id, now()).run();
    return r.meta.last_row_id;
  }
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) return null;
  const row = await db.prepare('SELECT id FROM people WHERE ignored = 0 AND lower(name) = lower(?)').bind(name).first();
  if (row) return row.id;
  const r = await db.prepare('INSERT INTO people (name, created_at) VALUES (?, ?)').bind(name, now()).run();
  return r.meta.last_row_id;
}

// Michael names a face (or says "yes" to a suggestion, or ignores it).
export async function faceLabel(env, payload) {
  const db = env.DB;
  const faceId = Number(payload.faceId);
  const face = await db.prepare('SELECT id, embedding FROM faces WHERE id = ?').bind(faceId).first();
  if (!face) return { ok: false, error: 'Face not found.' };
  const personId = await resolvePerson(db, payload);
  if (!personId) return { ok: false, error: 'Pick a name.' };

  await db.prepare(
    `UPDATE faces SET person_id = ?, status = 'confirmed', suggest_person_id = NULL, suggest_sim = NULL WHERE id = ?`
  ).bind(personId, faceId).run();

  const result = await spreadLabel(db, personId, decodeEmb(face.embedding));
  return { ok: true, personId, ...result };
}

// Compare one newly confirmed face with every untagged face.
async function spreadLabel(db, personId, emb) {
  if (!emb) return { autoTagged: 0, suggested: 0 };
  const rows = (await db.prepare(
    `SELECT id, embedding, suggest_sim, rejected FROM faces WHERE person_id IS NULL AND embedding IS NOT NULL`
  ).all()).results;
  const stmts = [];
  let autoTagged = 0, suggested = 0;
  for (const r of rows) {
    if (rejectedSet(r.rejected).has(personId)) continue;
    const sim = similarity(emb, decodeEmb(r.embedding));
    if (sim >= AUTO_TAG) {
      stmts.push(db.prepare(`UPDATE faces SET person_id = ?, status = 'auto', suggest_person_id = NULL, suggest_sim = NULL WHERE id = ?`).bind(personId, r.id));
      autoTagged++;
    } else if (sim >= ASK && sim > (r.suggest_sim || 0)) {
      stmts.push(db.prepare('UPDATE faces SET suggest_person_id = ?, suggest_sim = ? WHERE id = ?').bind(personId, sim, r.id));
      suggested++;
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { autoTagged, suggested };
}

// "No, that's not them" on a suggestion, or removing a wrong tag.
// The face goes back to the "new face" pile and never gets that name again.
export async function faceReject(env, payload) {
  const db = env.DB;
  const face = await db.prepare('SELECT id, person_id, suggest_person_id, rejected FROM faces WHERE id = ?').bind(Number(payload.faceId)).first();
  if (!face) return { ok: false, error: 'Face not found.' };
  const no = Number(payload.personId) || face.person_id || face.suggest_person_id;
  const rej = rejectedSet(face.rejected);
  if (no) rej.add(no);
  await db.prepare(
    `UPDATE faces SET person_id = NULL, status = 'new', suggest_person_id = NULL, suggest_sim = NULL, rejected = ? WHERE id = ?`
  ).bind([...rej].join(','), face.id).run();
  return { ok: true };
}

// All faces + manual tags for one person (admin review screen).
export async function personFaces(env, payload) {
  const pid = Number(payload.personId);
  const rows = (await env.DB.prepare(
    `SELECT f.id, f.item_id, f.box, f.size, f.thumb_key, f.status, i.r2_key, i.thumb_key AS item_thumb, i.content_type
     FROM faces f JOIN feed_items i ON i.id = f.item_id WHERE f.person_id = ? ORDER BY f.status DESC, f.size DESC`
  ).bind(pid).all()).results;
  const tags = (await env.DB.prepare('SELECT item_id FROM photo_tags WHERE person_id = ?').bind(pid).all()).results;
  return { ok: true, faces: rows.map(r => ({ ...faceOut(r), status: r.status })), manualItems: tags.map(t => t.item_id) };
}

export async function renamePerson(env, payload) {
  const name = String(payload.name || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Name required.' };
  await env.DB.prepare('UPDATE people SET name = ? WHERE id = ?').bind(name, Number(payload.personId)).run();
  return { ok: true };
}

// ---------- admin: per-photo tags ----------

export async function itemTags(env, payload) {
  const itemId = Number(payload.itemId);
  const faces = (await env.DB.prepare(
    `SELECT f.id, f.box, f.thumb_key, f.person_id, f.status, p.name FROM faces f
     LEFT JOIN people p ON p.id = f.person_id WHERE f.item_id = ? AND (p.ignored IS NULL OR p.ignored = 0)`
  ).bind(itemId).all()).results;
  const manual = (await env.DB.prepare(
    'SELECT p.id, p.name FROM photo_tags t JOIN people p ON p.id = t.person_id WHERE t.item_id = ?'
  ).bind(itemId).all()).results;
  return {
    ok: true,
    faces: faces.map(f => ({ id: f.id, box: safeJson(f.box), thumb: mediaUrl(f.thumb_key), personId: f.person_id, name: f.name || '', status: f.status })),
    manual
  };
}

export async function photoTagAdd(env, payload) {
  const personId = await resolvePerson(env.DB, payload);
  if (!personId) return { ok: false, error: 'Pick a name.' };
  await env.DB.prepare('INSERT OR IGNORE INTO photo_tags (item_id, person_id, created_at) VALUES (?, ?, ?)')
    .bind(Number(payload.itemId), personId, now()).run();
  return { ok: true, personId };
}

export async function photoTagRemove(env, payload) {
  const itemId = Number(payload.itemId), personId = Number(payload.personId);
  await env.DB.prepare('DELETE FROM photo_tags WHERE item_id = ? AND person_id = ?').bind(itemId, personId).run();
  const faces = (await env.DB.prepare('SELECT id FROM faces WHERE item_id = ? AND person_id = ?').bind(itemId, personId).all()).results;
  for (const f of faces) await faceReject(env, { faceId: f.id, personId });
  return { ok: true };
}

// ---------- public: who's in which photo ----------

// Map of itemId → [personId] plus the name list, for the guest gallery.
export async function feedPeople(db, includeHidden) {
  const rows = (await db.prepare(
    `SELECT f.item_id, f.person_id FROM faces f JOIN people p ON p.id = f.person_id WHERE p.ignored = 0
     UNION SELECT t.item_id, t.person_id FROM photo_tags t JOIN people p ON p.id = t.person_id WHERE p.ignored = 0`
  ).all()).results;
  const byItem = {};
  for (const r of rows) (byItem[r.item_id] = byItem[r.item_id] || []).push(r.person_id);
  const people = (await peopleWithCounts(db, false)).filter(p => p.photos > 0 || includeHidden)
    .map(p => ({ id: p.id, name: p.name, photos: p.photos }));
  return { byItem, people };
}

// ---------- cleanup ----------

async function deleteFaces(env, where, binds) {
  const rows = (await env.DB.prepare(`SELECT id, thumb_key FROM faces WHERE ${where}`).bind(...binds).all()).results;
  for (const r of rows) if (r.thumb_key) await env.MEDIA.delete(r.thumb_key);
  if (rows.length) await env.DB.prepare(`DELETE FROM faces WHERE ${where}`).bind(...binds).run();
}

export async function deleteFacesForItem(env, itemId) {
  await deleteFaces(env, 'item_id = ?', [itemId]);
}

// Re-scan everything (e.g. after changing the scanner). Keeps tagged faces.
export async function faceRescanAll(env) {
  await env.DB.prepare('UPDATE feed_items SET faces_scanned_at = NULL, faces_error = NULL').run();
  return { ok: true };
}

// Privacy step for when tagging is done: drop every fingerprint, keep tags.
export async function faceClearEmbeddings(env) {
  await env.DB.prepare('UPDATE faces SET embedding = NULL').run();
  return { ok: true };
}
