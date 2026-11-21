/**
 * Face tagging for the photo site.
 *
 * Flow:
 *  1. The helper on Michael's Mac Studio asks for unscanned feed items
 *     (faceTodo), finds faces locally, and posts each item's faces back
 *     (faceResults): box, face crop, fingerprint (embedding).
 *  2. New faces are compared with faces Michael named himself:
 *       best person >= AUTO_TAG AND beats the next person by MARGIN → tagged automatically
 *       best person >= ASK      → kept as a question ("Is this Jack?")
 *       otherwise               → a brand-new face to name
 *  3. When Michael names a face (faceLabel), untagged faces AND automatic
 *     tags that look like that face are re-decided the same way.
 *
 * Fingerprints come from ArcFace (512 numbers, InsightFace buffalo_l) on the
 * Mac Studio; similarity is cosine (-1..1). Tested Nov 20 on Michael's own
 * named faces: 53/55 auto-tagged at these lines, 0 wrong. (The first
 * version used Human's 1024-number fingerprints — far worse: 6/55.)
 * Old 1024-number fingerprints simply don't match anything (similarity 0).
 */

export const AUTO_TAG = 0.40;
export const MARGIN = 0.10;
export const ASK = 0.25;
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
  if (a.length === 512) { // ArcFace: unit-length vectors → cosine = dot product
    let dot = 0;
    for (let i = 0; i < 512; i++) dot += a[i] * b[i];
    return Math.round(dot * 1000) / 1000;
  }
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
    `SELECT id, r2_key, content_type, thumb_key, web_key FROM feed_items
     WHERE faces_scanned_at IS NULL ORDER BY id LIMIT 25`
  ).all()).results;
  // Photos without a small tile image (older uploads, other browsers) — the
  // helper makes one so the gallery loads fast.
  const thumbs = (await env.DB.prepare(
    `SELECT id, r2_key, content_type, thumb_key, web_key FROM feed_items
     WHERE (thumb_key IS NULL OR web_key IS NULL) AND content_type LIKE 'image/%' ORDER BY id LIMIT 40`
  ).all()).results;
  const cmd = await env.DB.prepare('SELECT command FROM face_helper WHERE id = 1').first();
  if (cmd && cmd.command) await env.DB.prepare('UPDATE face_helper SET command = NULL WHERE id = 1').run();
  const out = (r) => ({ id: r.id, key: r.r2_key, mediaPath: mediaUrl(r.r2_key), contentType: r.content_type, hasThumb: !!r.thumb_key, hasWeb: !!r.web_key });
  return { ok: true, command: (cmd && cmd.command) || null, items: rows.map(out), thumbs: thumbs.map(out) };
}

export async function faceResults(env, payload) {
  const itemId = Number(payload.itemId);
  if (!itemId) return { ok: false, error: 'Missing item id.' };
  const item = await env.DB.prepare('SELECT id FROM feed_items WHERE id = ?').bind(itemId).first();
  if (!item) return { ok: true, skipped: true }; // deleted meanwhile

  // A re-scan replaces this item's untagged and automatic faces; faces
  // Michael named himself stay (and get the new fingerprint below).
  await deleteFaces(env, "item_id = ? AND status != 'confirmed'", [itemId]);

  if (payload.error) {
    await env.DB.prepare('UPDATE feed_items SET faces_scanned_at = ?, faces_error = ? WHERE id = ?')
      .bind(now(), String(payload.error).slice(0, 300), itemId).run();
    return { ok: true };
  }

  const faces = Array.isArray(payload.faces) ? payload.faces.slice(0, 80) : [];
  const refs = await confirmedRefs(env.DB);
  // Named faces in this item: refresh their fingerprint, don't add them twice.
  const kept = (await env.DB.prepare("SELECT id, box FROM faces WHERE item_id = ? AND status = 'confirmed'").bind(itemId).all()).results
    .map(r => ({ id: r.id, box: safeJson(r.box) })).filter(k => k.box);
  const stmts = [];
  for (const f of faces) {
    const emb = decodeEmb(f.embedding);
    if (!emb) continue;
    const same = Array.isArray(f.box) ? kept.find(k => sameFace(k.box, f.box)) : null;
    if (same) {
      stmts.push(env.DB.prepare('UPDATE faces SET embedding = ? WHERE id = ?').bind(f.embedding, same.id));
      continue;
    }
    const thumbKey = 'face/' + itemId + '-' + crypto.randomUUID() + '.jpg';
    if (f.thumb) {
      const bin = atob(f.thumb);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await env.MEDIA.put(thumbKey, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    }
    const d = decide(emb, refs, new Set());
    const personId = d.auto || null, status = d.auto ? 'auto' : 'new';
    const sugId = d.suggest || null, sugSim = d.sim ?? null;
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

// Re-decide every untagged / automatic face (after a re-scan, or when the
// rules change). Done in pages so each request stays small.
export async function faceRematch(env, payload) {
  const after = Number(payload.after) || 0;
  const limit = Math.min(Number(payload.limit) || 60, 150);
  const rows = (await env.DB.prepare(
    `SELECT id, embedding, rejected FROM faces
     WHERE id > ? AND status != 'confirmed' AND embedding IS NOT NULL ORDER BY id LIMIT ?`
  ).bind(after, limit).all()).results;
  if (!rows.length) return { ok: true, done: true, changed: 0 };
  const refs = await confirmedRefs(env.DB);
  const stmts = rows.map(r => applyDecision(env.DB, r.id, decide(decodeEmb(r.embedding), refs, rejectedSet(r.rejected))));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, done: rows.length < limit, next: rows[rows.length - 1].id, changed: stmts.length };
}

// One face's verdict → the row update.
//   auto: tagged (suggest_sim keeps how sure, for later re-checks)
//   suggest: a question for Michael
//   neither: new face
function applyDecision(db, faceId, d) {
  if (d.auto) {
    return db.prepare(`UPDATE faces SET person_id = ?, status = 'auto', suggest_person_id = NULL, suggest_sim = ? WHERE id = ?`).bind(d.auto, d.sim, faceId);
  }
  return db.prepare(`UPDATE faces SET person_id = NULL, status = 'new', suggest_person_id = ?, suggest_sim = ? WHERE id = ?`)
    .bind(d.suggest || null, d.suggest ? d.sim : null, faceId);
}

// Faces Michael named himself — the only ones matching trusts, so one
// wrong automatic tag can't snowball.
async function confirmedRefs(db) {
  const rows = (await db.prepare(
    `SELECT person_id, embedding FROM faces WHERE status = 'confirmed' AND person_id IS NOT NULL AND embedding IS NOT NULL`
  ).all()).results;
  return rows.map(r => ({ personId: r.person_id, emb: decodeEmb(r.embedding) }));
}

// Best person must clear AUTO_TAG and beat the runner-up by MARGIN to be
// tagged automatically; otherwise it's a question if it clears ASK.
export function decide(emb, refs, rejected) {
  if (!emb) return {};
  const best = new Map();
  for (const r of refs) {
    if (rejected.has(r.personId)) continue;
    const s = similarity(emb, r.emb);
    if (s > (best.get(r.personId) ?? -1)) best.set(r.personId, s);
  }
  let p1 = null, s1 = -1, s2 = -1;
  for (const [p, s] of best) {
    if (s > s1) { s2 = s1; s1 = s; p1 = p; } else if (s > s2) s2 = s;
  }
  if (p1 && s1 >= AUTO_TAG && s1 - s2 >= MARGIN) return { auto: p1, sim: s1 };
  if (p1 && s1 >= ASK) return { suggest: p1, sim: s1 };
  return {};
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
// Same face from two scanners: boxes overlap a lot, or each box's center
// sits inside the other (detectors draw boxes of different sizes).
function sameFace(a, b) {
  const inside = (p, q) => {
    const cx = p[0] + p[2] / 2, cy = p[1] + p[3] / 2;
    return cx > q[0] && cx < q[0] + q[2] && cy > q[1] && cy < q[1] + q[3];
  };
  return iou(a, b) > 0.4 || (inside(a, b) && inside(b, a));
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

// After Michael names a face: re-decide the untagged faces and automatic
// tags that look like it (cheap first pass, full check only for those).
async function spreadLabel(db, personId, emb) {
  if (!emb) return { autoTagged: 0, suggested: 0 };
  const rows = (await db.prepare(
    `SELECT id, embedding, person_id, status, suggest_sim, rejected FROM faces
     WHERE status != 'confirmed' AND embedding IS NOT NULL`
  ).all()).results;
  let refs = null;
  const stmts = [];
  let autoTagged = 0, suggested = 0;
  for (const r of rows) {
    const e = decodeEmb(r.embedding);
    const sim = similarity(emb, e);
    const isAuto = r.status === 'auto';
    // Untagged: worth a look if it resembles the new face at all.
    // Auto-tagged to someone else: worth a look if the new face competes.
    const look = isAuto
      ? (r.person_id !== personId && sim >= (r.suggest_sim ?? AUTO_TAG) - MARGIN)
      : sim >= ASK;
    if (!look) continue;
    refs = refs || await confirmedRefs(db);
    const d = decide(e, refs, rejectedSet(r.rejected));
    if (isAuto && d.auto === r.person_id) continue;
    stmts.push(applyDecision(db, r.id, d));
    if (d.auto === personId) autoTagged++; else if (d.suggest) suggested++;
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

// Tell the Mac Studio scanner to restart or fetch its latest code.
export async function faceHelperCommand(env, payload) {
  const c = String(payload.command || '');
  if (!['restart', 'update'].includes(c)) return { ok: false, error: 'Unknown command.' };
  await env.DB.prepare('UPDATE face_helper SET command = ? WHERE id = 1').bind(c).run();
  return { ok: true };
}

// Privacy step for when tagging is done: drop every fingerprint, keep tags.
export async function faceClearEmbeddings(env) {
  await env.DB.prepare('UPDATE faces SET embedding = NULL').run();
  return { ok: true };
}

// ---------- albums ----------

// Move a feed item to another album (admin photo page).
export async function setItemAlbum(env, payload) {
  const a = await env.DB.prepare('SELECT id FROM albums WHERE id = ?').bind(Number(payload.albumId)).first();
  if (!a) return { ok: false, error: 'No such album.' };
  await env.DB.prepare('UPDATE feed_items SET album_id = ? WHERE id = ?').bind(a.id, Number(payload.itemId)).run();
  return { ok: true };
}
