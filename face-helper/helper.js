/* Mike & Xan face helper — runs on the Mac Studio (started by launchd).
 *
 * Every minute: asks the site for photos/videos that haven't been scanned,
 * scans each in a hidden local Chrome (engine.html, open-source Human
 * library — faces never leave this Mac except as small crops + fingerprints
 * sent to Michael's own Cloudflare database), and posts the results.
 *
 * Setup: .env next to this file with MX_PASSWORD=<admin password>.
 * Logs: helper.log next to this file.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const run = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(DIR, 'tmp');
const LOG = path.join(DIR, 'helper.log');
const PORT = 47817;
const IDLE_MS = 60 * 1000;
const ITEM_TIMEOUT_MS = 5 * 60 * 1000;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const env = Object.fromEntries(
  (fs.existsSync(path.join(DIR, '.env')) ? fs.readFileSync(path.join(DIR, '.env'), 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const WORKER = env.WORKER_URL || 'https://mikeandxan-rsvp.michael-afc.workers.dev';
const PASSWORD = env.MX_PASSWORD || '';

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ') + '\n';
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, line);
  } catch (e) { /* ignore */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- local web server: the engine page + converted HEIC files ----------
fs.mkdirSync(TMP, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg' };
http.createServer((req, res) => {
  const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const file = name.startsWith('tmp/') ? path.join(TMP, path.basename(name))
    : ['engine.html', 'engine.js'].includes(name) ? path.join(DIR, name) : null;
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1');

// ---------- site API ----------
let token = '';
async function login() {
  if (!PASSWORD) throw new Error('No MX_PASSWORD in .env');
  const r = await fetch(WORKER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'adminLogin', password: PASSWORD }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Login failed: ' + (j.error || r.status));
  token = j.token;
}
async function api(method, query, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) await login();
    const r = method === 'GET'
      ? await fetch(WORKER + '/?' + query + '&token=' + encodeURIComponent(token))
      : await fetch(WORKER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token }) });
    if (r.status === 401) { token = ''; continue; }
    return r.json();
  }
  throw new Error('Not authorized');
}

// ---------- Chrome ----------
let browser = null, page = null, engineInfo = '';
async function startChrome() {
  if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: path.join(DIR, 'chrome-profile'),
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
  });
  page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('[chrome]', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/engine.html`);
  engineInfo = await page.evaluate(() => window.engineReady);
  log('Engine ready:', engineInfo);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

// Chrome can't open iPhone HEIC photos — convert with macOS's built-in sips.
async function sourceUrl(item) {
  const url = WORKER + item.mediaPath;
  if (!/heic|heif/i.test(item.contentType)) return url;
  const r = await fetch(url);
  const raw = path.join(TMP, 'item-' + item.id + '.heic');
  const out = path.join(TMP, 'item-' + item.id + '.jpg');
  fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
  await run('/usr/bin/sips', ['-s', 'format', 'jpeg', raw, '--out', out]);
  fs.unlinkSync(raw);
  return `http://127.0.0.1:${PORT}/tmp/${path.basename(out)}`;
}

const tries = {};
async function scanOne(item) {
  const isVideo = /^video\//.test(item.contentType);
  try {
    const url = await sourceUrl(item);
    const faces = await withTimeout(page.evaluate((u, v) => window.scanItem(u, v), url, isVideo), ITEM_TIMEOUT_MS);
    const res = await api('POST', '', { action: 'faceResults', payload: { itemId: item.id, faces } });
    log(`item ${item.id}: ${faces.length} face(s)`, res.ok ? '' : JSON.stringify(res));
  } catch (e) {
    log(`item ${item.id}: failed — ${e.message}`);
    const crashed = /timed out|Target closed|Session closed|detached/i.test(e.message);
    if (crashed) await startChrome();
    tries[item.id] = (tries[item.id] || 0) + 1;
    // Give a crashed/slow item one more go, then mark it failed so it doesn't block the queue.
    if (!crashed || tries[item.id] >= 2) {
      await api('POST', '', { action: 'faceResults', payload: { itemId: item.id, error: e.message } });
    }
  } finally {
    for (const f of fs.readdirSync(TMP)) if (f.startsWith('item-' + item.id + '.')) fs.unlinkSync(path.join(TMP, f));
  }
}

async function main() {
  log('Helper starting');
  await startChrome();
  for (;;) {
    try {
      const todo = await api('GET', 'action=faceTodo&info=' + encodeURIComponent(engineInfo));
      const items = todo.items || [];
      if (items.length) log(`${items.length} item(s) to scan`);
      for (const item of items) await scanOne(item);
      if (!items.length) await sleep(IDLE_MS);
    } catch (e) {
      log('Loop error:', e.message);
      await sleep(IDLE_MS);
    }
  }
}

main().catch((e) => { log('Fatal:', e.stack || e.message); process.exit(1); });
