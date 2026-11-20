#!/bin/bash
# Switches the Mac Studio face scanner to the new (ArcFace) engine.
# Double-click to run. Safe to run again.
HELPER="$HOME/code/mikeandxan-face-helper"
PLIST="$HOME/Library/LaunchAgents/com.mikeandxan.facehelper.plist"
cd "$HELPER" || exit 1
echo ""
if ! grep -q '^MX_PASSWORD=.' .env 2>/dev/null; then
  read -s -p "Type your wedding-site ADMIN password, then press Return (nothing shows while you type): " PW
  echo ""
  printf 'MX_PASSWORD=%s\n' "$PW" > .env
  chmod 600 .env
fi
mkdir -p "$HOME/Library/LaunchAgents"
cp com.mikeandxan.facehelper.plist "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Scanner restarting with the new engine. First start installs things (a few minutes)."
echo "Watching for up to 6 minutes..."
for i in $(seq 1 72); do
  sleep 5
  if grep -q "Engine ready: arcface" helper.log 2>/dev/null; then break; fi
done
echo ""
tail -n 12 launchd.log
echo ""
if grep -q "Engine ready: arcface" helper.log 2>/dev/null; then
  echo "=== DONE. New scanner is running. You can close this window. ==="
else
  echo "=== Not running yet. Tell Claude what the lines above say. ==="
fi
