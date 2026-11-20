"""Mike & Xan face scanner — runs on the Mac Studio (started by launchd via run.sh).

Every minute it asks the site for photos/videos that haven't been scanned,
finds faces with the ArcFace engine (faces_engine.py) on this Mac, and posts
each face's crop + fingerprint back. It also makes small tile images for
photos that lack one (keeps the gallery fast), and re-matches faces after a
re-scan.

Remote control (no one needs to be at the Mac): the site can send
  'restart' → exit; launchd starts it again
  'update'  → download the latest helper files from GitHub, then restart

Setup: .env next to this file with MX_PASSWORD=<admin password>.
Log: helper.log next to this file.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import cv2
import numpy as np

from faces_engine import Engine

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, 'helper.log')
IDLE_SECONDS = 60
VIDEO_STEP = 2          # seconds between video frames
VIDEO_MAX_FRAMES = 30
SAME_IN_VIDEO = 0.5     # cosine: same person seen again in one video
THUMB_EDGE = 800        # gallery tile image size (long edge)
FFMPEG = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
UPDATE_BASE = 'https://raw.githubusercontent.com/twoseam/mikeandxan-rsvp/master/face-helper/'
UPDATE_FILES = ['helper.py', 'faces_engine.py', 'requirements.txt', 'run.sh']


def load_env():
    env = {}
    path = os.path.join(HERE, '.env')
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env()
WORKER = ENV.get('WORKER_URL', 'https://mikeandxan-rsvp.michael-afc.workers.dev')
PASSWORD = ENV.get('MX_PASSWORD', '')


def log(*a):
    line = time.strftime('%Y-%m-%dT%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line, flush=True)
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 5 * 1024 * 1024:
            os.replace(LOG, LOG + '.old')
        with open(LOG, 'a') as f:
            f.write(line + '\n')
    except OSError:
        pass


# ---------- site API ----------
_token = ''


def http(method, url, body=None, ctype='application/json', timeout=120):
    data = None
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={'content-type': ctype, 'user-agent': 'mx-face-helper'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def login():
    global _token
    if not PASSWORD:
        raise RuntimeError('No MX_PASSWORD in .env')
    code, raw = http('POST', WORKER, {'action': 'adminLogin', 'password': PASSWORD})
    j = json.loads(raw or b'{}')
    if not j.get('ok'):
        raise RuntimeError('Login failed: ' + str(j.get('error') or code))
    _token = j['token']


def api_get(query):
    for _ in range(2):
        if not _token:
            login()
        code, raw = http('GET', WORKER + '/?' + query + '&token=' + urllib.parse.quote(_token))
        if code == 401:
            globals()['_token'] = ''
            continue
        return json.loads(raw)
    raise RuntimeError('Not authorized')


def api_post(action, payload):
    for _ in range(2):
        if not _token:
            login()
        code, raw = http('POST', WORKER, {'action': action, 'token': _token, 'payload': payload})
        if code == 401:
            globals()['_token'] = ''
            continue
        return json.loads(raw)
    raise RuntimeError('Not authorized')


# ---------- media ----------
def download(item, folder):
    ext = os.path.splitext(item['key'])[1] or '.bin'
    path = os.path.join(folder, 'src' + ext)
    code, raw = http('GET', WORKER + item['mediaPath'], timeout=600)
    if code != 200:
        raise RuntimeError('download failed (%s)' % code)
    with open(path, 'wb') as f:
        f.write(raw)
    return path


def open_photo(path, ctype, folder):
    """BGR image with phone rotation applied. HEIC goes through macOS's sips first."""
    if 'heic' in ctype or 'heif' in ctype or path.lower().endswith(('.heic', '.heif')):
        out = os.path.join(folder, 'conv.jpg')
        subprocess.run(['/usr/bin/sips', '-s', 'format', 'jpeg', path, '--out', out], check=True, capture_output=True)
        path = out
    img = cv2.imread(path, cv2.IMREAD_COLOR)  # applies EXIF orientation
    if img is None:
        raise RuntimeError('could not open photo')
    return img


def video_frames(path, folder):
    pattern = os.path.join(folder, 'f%03d.jpg')
    subprocess.run([FFMPEG, '-v', 'error', '-i', path, '-vf', 'fps=1/%d,scale=\'min(1920,iw)\':-2' % VIDEO_STEP,
                    '-frames:v', str(VIDEO_MAX_FRAMES), '-q:v', '3', pattern], check=True, capture_output=True, timeout=600)
    frames = sorted(f for f in os.listdir(folder) if f.startswith('f') and f.endswith('.jpg'))
    if not frames:  # very short clip: grab the first frame
        subprocess.run([FFMPEG, '-v', 'error', '-i', path, '-frames:v', '1', os.path.join(folder, 'f001.jpg')], check=True, capture_output=True)
        frames = ['f001.jpg']
    return [cv2.imread(os.path.join(folder, f)) for f in frames]


def make_thumb(img):
    h, w = img.shape[:2]
    s = min(1.0, THUMB_EDGE / max(h, w))
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes()


def upload_thumb(item, img):
    code, raw = http('POST', WORKER + '/upload-thumb?key=' + urllib.parse.quote(item['key']), make_thumb(img), ctype='image/jpeg')
    return code == 200 and json.loads(raw or b'{}').get('ok')


def face_payload(f):
    return {
        'box': f['box'], 'size': f['size'],
        'embedding': base64.b64encode(np.asarray(f['emb'], dtype=np.float32).tobytes()).decode(),
        'thumb': base64.b64encode(f['thumb']).decode(),
    }


# ---------- work ----------
def scan_item(engine, item):
    folder = tempfile.mkdtemp(prefix='mxface-')
    try:
        src = download(item, folder)
        if item['contentType'].startswith('video/'):
            found = []
            for frame in video_frames(src, folder):
                for f in engine.faces(frame):
                    same = next((m for m in found if float(np.dot(m['emb'], f['emb'])) >= SAME_IN_VIDEO), None)
                    if same is None:
                        found.append(f)
                    elif f['size'] > same['size']:
                        same.update(f)
        else:
            img = open_photo(src, item['contentType'], folder)
            found = engine.faces(img)
            if not item.get('hasThumb'):
                upload_thumb(item, img)
        res = api_post('faceResults', {'itemId': item['id'], 'faces': [face_payload(f) for f in found]})
        log('item %s: %d face(s)%s' % (item['id'], len(found), '' if res.get('ok') else ' ' + json.dumps(res)))
    except Exception as e:  # noqa: BLE001 — one bad file must not stop the queue
        log('item %s: failed — %s' % (item['id'], e))
        api_post('faceResults', {'itemId': item['id'], 'error': str(e)[:280]})
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def thumb_item(item):
    folder = tempfile.mkdtemp(prefix='mxthumb-')
    try:
        img = open_photo(download(item, folder), item['contentType'], folder)
        log('thumb %s: %s' % (item['id'], 'ok' if upload_thumb(item, img) else 'failed'))
    except Exception as e:  # noqa: BLE001
        log('thumb %s: failed — %s' % (item['id'], e))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def rematch_all():
    after, changed = 0, 0
    while True:
        r = api_post('faceRematch', {'after': after, 'limit': 100})
        changed += r.get('changed', 0)
        if not r.get('ok') or r.get('done'):
            break
        after = r['next']
    log('re-matched %d face(s)' % changed)


def self_update():
    for name in UPDATE_FILES:
        code, raw = http('GET', UPDATE_BASE + name + '?t=%d' % time.time())
        if code != 200 or not raw:
            log('update: could not fetch', name, code)
            return
        tmp = os.path.join(HERE, name + '.new')
        with open(tmp, 'wb') as f:
            f.write(raw)
        os.replace(tmp, os.path.join(HERE, name))
    log('update: got latest files, restarting')


def main():
    log('Helper starting')
    engine = Engine()
    info = 'arcface w600k_r50 / onnxruntime'
    log('Engine ready:', info)
    failed_thumbs = set()
    need_rematch = True  # settle tags once on start (rules may have changed)
    while True:
        try:
            todo = api_get('action=faceTodo&info=' + urllib.parse.quote(info))
            cmd = todo.get('command')
            if cmd == 'update':
                self_update()
                sys.exit(0)
            if cmd == 'restart':
                log('restart requested')
                sys.exit(0)
            items = todo.get('items') or []
            if items:
                log('%d item(s) to scan' % len(items))
            for item in items:
                scan_item(engine, item)
                need_rematch = True
            thumbs = [t for t in (todo.get('thumbs') or []) if t['id'] not in failed_thumbs and t['id'] not in {i['id'] for i in items}]
            for t in thumbs:
                thumb_item(t)
                failed_thumbs.add(t['id'])  # don't loop forever on a file that won't open
            if not items and need_rematch:
                rematch_all()  # queue drained: settle every automatic tag against the latest names
                need_rematch = False
            if not items and not thumbs:
                time.sleep(IDLE_SECONDS)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            log('Loop error:', e)
            time.sleep(IDLE_SECONDS)


if __name__ == '__main__':
    main()
