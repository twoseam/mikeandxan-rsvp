"""Face engine for the Mac Studio helper.

Finds faces (SCRFD detector) and makes a fingerprint for each one
(ArcFace w600k_r50), from the InsightFace "buffalo_l" model pack.
Runs fully on this Mac with onnxruntime — no faces leave the computer
except the small crops + fingerprints sent to Michael's own database.

Model license: InsightFace pretrained models are for non-commercial use
(fine for a personal wedding site).
"""
import os
import numpy as np
import cv2
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')

DET_SIZE = 1280      # detector input (longest side)
DET_THRESH = 0.5     # detector confidence
NMS_THRESH = 0.4
MIN_FACE = 40        # px on the (max 2400px) working image — smaller faces match poorly
MAX_EDGE = 2400

# Standard ArcFace 112x112 landmark template (eyes, nose, mouth corners).
ARC_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                    [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def _session(name):
    opts = ort.SessionOptions()
    opts.log_severity_level = 3  # quiet: the detector's flexible input size triggers harmless warnings
    prov = [p for p in ('CoreMLExecutionProvider', 'CPUExecutionProvider') if p in ort.get_available_providers()]
    if name.startswith('det'):
        prov = ['CPUExecutionProvider']  # CoreML can't handle the detector's variable input size well
    return ort.InferenceSession(os.path.join(MODELS, name), sess_options=opts, providers=prov)


class Engine:
    def __init__(self):
        self.det = _session('det_10g.onnx')
        self.rec = _session('w600k_r50.onnx')
        self.det_in = self.det.get_inputs()[0].name
        self.rec_in = self.rec.get_inputs()[0].name
        self._centers = {}

    # ---------- detection (SCRFD, same decoding as insightface) ----------
    def _anchors(self, h, w, stride):
        key = (h, w, stride)
        if key not in self._centers:
            ys, xs = np.mgrid[:h, :w]
            c = np.stack([xs, ys], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            c = np.repeat(c, 2, axis=0)  # 2 anchors per location
            self._centers[key] = c
        return self._centers[key]

    def detect(self, img):
        h0, w0 = img.shape[:2]
        scale = DET_SIZE / max(h0, w0)
        nh, nw = int(round(h0 * scale)), int(round(w0 * scale))
        canvas = np.zeros((DET_SIZE, DET_SIZE, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (DET_SIZE, DET_SIZE), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.det.run(None, {self.det_in: blob})
        boxes, scores, kpss = [], [], []
        for i, stride in enumerate((8, 16, 32)):
            sc = outs[i].reshape(-1)
            bb = outs[i + 3].reshape(-1, 4) * stride
            kp = outs[i + 6].reshape(-1, 10) * stride
            fh, fw = DET_SIZE // stride, DET_SIZE // stride
            ctr = self._anchors(fh, fw, stride)
            keep = np.where(sc >= DET_THRESH)[0]
            if not len(keep):
                continue
            c = ctr[keep]
            b = bb[keep]
            boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=-1))
            k = kp[keep].reshape(-1, 5, 2) + c[:, None, :]
            kpss.append(k)
            scores.append(sc[keep])
        if not boxes:
            return []
        boxes = np.concatenate(boxes) / scale
        kpss = np.concatenate(kpss) / scale
        scores = np.concatenate(scores)
        order = _nms(boxes, scores, NMS_THRESH)
        return [(boxes[i], kpss[i], float(scores[i])) for i in order]

    # ---------- recognition (ArcFace) ----------
    def embed(self, img, kps):
        m = _umeyama(kps.astype(np.float32), ARC_DST)
        aligned = cv2.warpAffine(img, m, (112, 112), borderValue=0)
        blob = cv2.dnn.blobFromImage(aligned, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        v = self.rec.run(None, {self.rec_in: blob})[0][0].astype(np.float32)
        return v / (np.linalg.norm(v) + 1e-9)

    def faces(self, img):
        """img: BGR array. Returns [{box (0..1 fractions), size, emb, thumb_jpeg}]"""
        h, w = img.shape[:2]
        s = min(1.0, MAX_EDGE / max(h, w))
        if s < 1:
            img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
            h, w = img.shape[:2]
        out = []
        for box, kps, score in self.detect(img):
            x1, y1, x2, y2 = box
            bw, bh = x2 - x1, y2 - y1
            if min(bw, bh) < MIN_FACE:
                continue
            out.append({
                'box': [round(float(x1 / w), 4), round(float(y1 / h), 4), round(float(bw / w), 4), round(float(bh / h), 4)],
                'size': int(min(bw, bh)),
                'score': score,
                'emb': self.embed(img, kps),
                'thumb': _crop(img, (x1, y1, bw, bh)),
            })
        return out


def _nms(boxes, scores, thresh):
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]]); yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]]); yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


def _umeyama(src, dst):
    """Similarity transform (rotation + uniform scale + shift) src → dst, as a 2x3 matrix."""
    n = src.shape[0]
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = dc.T @ sc / n
    U, S, Vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[-1] = -1
    R = U @ np.diag(d) @ Vt
    var = (sc ** 2).sum() / n
    c = (S * d).sum() / var
    t = mu_d - c * R @ mu_s
    return np.hstack([c * R, t[:, None]]).astype(np.float32)


def _crop(img, box):
    x, y, w, h = box
    s = max(w, h) * 1.5
    cx, cy = x + w / 2, y + h / 2
    src = np.array([[cx - s / 2, cy - s / 2], [cx + s / 2, cy - s / 2], [cx - s / 2, cy + s / 2]], dtype=np.float32)
    dst = np.array([[0, 0], [200, 0], [0, 200]], dtype=np.float32)
    m = cv2.getAffineTransform(src, dst)
    c = cv2.warpAffine(img, m, (200, 200), borderValue=(0, 0, 0))
    ok, buf = cv2.imencode('.jpg', c, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes()
