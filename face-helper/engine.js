/* Face engine — runs inside the helper's local Chrome on the Mac Studio.
   Exposes window.scanItem(url, isVideo) → faces found in that photo/video:
   [{ box: [x,y,w,h] as 0..1 fractions, size, embedding: base64 Float32, thumb: base64 JPEG }]
   Same approach as the site's faces-test page: whole frame + overlapping
   tiles so small faces in group shots are found, duplicates merged. */
import Human from 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js';

const MAX_EDGE = 2400;
const MIN_FACE = 40;
const VIDEO_STEP = 2;
const VIDEO_MAX_SAMPLES = 30;
const SAME_IN_VIDEO = 0.6;

const config = {
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/',
  wasmPath: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/',
  backend: 'webgl',
  cacheSensitivity: 0,
  filter: { enabled: false },
  gesture: { enabled: false },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  segmentation: { enabled: false },
  face: {
    enabled: true,
    detector: { maxDetected: 50, rotation: true, minConfidence: 0.4, skipFrames: 0, skipTime: 0 },
    mesh: { enabled: true },
    iris: { enabled: false },
    emotion: { enabled: false },
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    antispoof: { enabled: false },
    liveness: { enabled: false }
  }
};

let human = new Human(config);

window.engineReady = (async () => {
  try {
    await human.load();
    await human.warmup();
  } catch (e) {
    // No GPU in this Chrome → slower but works.
    human = new Human({ ...config, backend: 'wasm' });
    await human.load();
    await human.warmup();
  }
  return 'human ' + human.version + ' / ' + human.tf.getBackend();
})();

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not open photo'));
    img.src = src;
  });
}

async function findFaces(source, w, h, light) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const W = Math.round(w * scale), H = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').drawImage(source, 0, 0, W, H);

  const regions = [[0, 0, W, H]];
  if (Math.max(W, H) > 900) {
    for (const g of (light ? [2] : [2, 3])) {
      const tw = W / g, th = H / g, ox = tw * 0.25, oy = th * 0.25;
      for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) {
        const x = Math.max(0, c * tw - ox), y = Math.max(0, r * th - oy);
        regions.push([x, y, Math.min(W, (c + 1) * tw + ox) - x, Math.min(H, (r + 1) * th + oy) - y]);
      }
    }
  }

  const hits = [];
  const tile = document.createElement('canvas');
  for (const [x, y, rw, rh] of regions) {
    tile.width = Math.round(rw); tile.height = Math.round(rh);
    tile.getContext('2d').drawImage(canvas, x, y, rw, rh, 0, 0, tile.width, tile.height);
    const result = await human.detect(tile);
    for (const f of result.face || []) {
      if (!f.embedding || !f.embedding.length) continue;
      const [bx, by, bw, bh] = f.box;
      if (Math.min(bw, bh) < MIN_FACE) continue;
      hits.push({ box: [bx + x, by + y, bw, bh], score: f.boxScore || f.score || 0, emb: Float32Array.from(f.embedding) });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const h1 of hits) {
    if (!kept.some((k) => iou(k.box, h1.box) > 0.3 || centerInside(h1.box, k.box))) kept.push(h1);
  }
  return kept.map((k) => ({
    box: [k.box[0] / W, k.box[1] / H, k.box[2] / W, k.box[3] / H].map((v) => Math.round(v * 10000) / 10000),
    size: Math.round(Math.min(k.box[2], k.box[3])),
    emb: k.emb,
    thumb: crop(canvas, k.box)
  }));
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}
function centerInside(a, b) {
  const cx = a[0] + a[2] / 2, cy = a[1] + a[3] / 2;
  return cx > b[0] && cx < b[0] + b[2] && cy > b[1] && cy < b[1] + b[3];
}

function crop(canvas, box) {
  const [x, y, w, h] = box;
  const s = Math.max(w, h) * 1.5;
  const cx = x + w / 2, cy = y + h / 2;
  const c = document.createElement('canvas');
  c.width = c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 200, 200);
  ctx.drawImage(canvas, cx - s / 2, cy - s / 2, s, s, 0, 0, 200, 200);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function scanVideo(src) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.src = src;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('could not open video')); });
  const dur = v.duration || 0;
  const times = [];
  for (let t = 0.5; t < dur && times.length < VIDEO_MAX_SAMPLES; t += VIDEO_STEP) times.push(t);
  if (!times.length) times.push(0);

  const mine = [];
  for (const t of times) {
    v.currentTime = t;
    await new Promise((res) => { v.onseeked = res; });
    const found = await findFaces(v, v.videoWidth, v.videoHeight, true);
    for (const f of found) {
      const same = mine.find((m) => human.match.similarity(Array.from(m.emb), Array.from(f.emb)) >= SAME_IN_VIDEO);
      if (!same) mine.push(f);
      else if (f.size > same.size) Object.assign(same, f);
    }
  }
  v.removeAttribute('src');
  v.load();
  return mine;
}

window.scanItem = async (url, isVideo) => {
  await window.engineReady;
  let found;
  if (isVideo) {
    found = await scanVideo(url);
  } else {
    const img = await loadImage(url);
    found = await findFaces(img, img.naturalWidth, img.naturalHeight, false);
  }
  return found.map((f) => ({ box: f.box, size: f.size, embedding: b64(f.emb.buffer), thumb: f.thumb }));
};
