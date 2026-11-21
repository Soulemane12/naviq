#!/bin/bash
# Installs and starts Worn HUD on the glasses (USB, Developer Mode on).
#   ./install.sh                 → glasses reach the laptop over USB (adb reverse), URL http://localhost:8787/hud
#   ./install.sh http://IP:8787/hud  → glasses reach the laptop over Wi-Fi instead
set -euo pipefail
cd "$(dirname "$0")"
adb devices -l | grep -q XNM_Glass || { echo "Glasses not found. Turn on Developer Mode in MLDemo, replug USB, accept the prompt on the glasses."; adb devices -l; exit 1; }
adb install -r WornHUD.apk
adb shell pm grant com.wornhack.hud android.permission.CAMERA || true
adb shell pm grant com.wornhack.hud android.permission.RECORD_AUDIO || true
URL="${1:-http://localhost:8787/hud}"
[[ "$URL" == *localhost* ]] && adb reverse tcp:8787 tcp:8787
adb shell am start -n com.wornhack.hud/.MainActivity --es url "$URL"
echo "Started Worn HUD → $URL   (logs: adb logcat -s WornHUD)"
