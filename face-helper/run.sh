#!/bin/bash
# Started by launchd (com.mikeandxan.facehelper). Sets up Python the first
# time (or when requirements change), fetches the face models, runs the helper.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PY=$(command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)

if [ ! -x venv/bin/python ]; then
  echo "Setting up Python ($PY)…"
  "$PY" -m venv venv || exit 1
  venv/bin/pip install -q --upgrade pip
fi
if ! cmp -s requirements.txt venv/.installed-requirements; then
  echo "Installing Python packages…"
  venv/bin/pip install -q -r requirements.txt && cp requirements.txt venv/.installed-requirements || exit 1
fi
if [ ! -f models/w600k_r50.onnx ] || [ ! -f models/det_10g.onnx ]; then
  echo "Downloading face models…"
  mkdir -p models tmp
  curl -fsSL -o tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/model-zoo/buffalo_l.zip || exit 1
  unzip -o -j -q tmp/buffalo_l.zip det_10g.onnx w600k_r50.onnx -d models || exit 1
  rm -f tmp/buffalo_l.zip
fi
# python.org Python ships without trusted certificates — use certifi's.
export SSL_CERT_FILE="$(venv/bin/python -c 'import certifi; print(certifi.where())' 2>/dev/null)"
exec venv/bin/python helper.py
