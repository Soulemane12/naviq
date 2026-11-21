#!/bin/bash
# Laptop simulator: two Android emulators stand in for the M6 glasses and the phone.
#
#   sim/sim.sh setup   install SDK packages (once), create both emulators, build WornHUD.apk
#   sim/sim.sh start   boot both, install the glasses app, point both at the laptop server
#   sim/sim.sh camera  restart only the camera window (to switch VIDEO)
#   sim/sim.sh stop    shut both down
#
# Glasses: Android 9 (API 28, as on the M6), 640x480 at 160 dpi, running the real WornHUD.apk.
#   Speaker = laptop audio.  Mic = laptop mic (the HUD doesn't use it yet).
#   Keys: Enter = tap (look now), Esc = BACK (repeat aloud).  Compass: "..." > Virtual sensors.
# Camera: a small muted desktop Chrome window runs the same HUD page on the laptop webcam and sends the
#   frames; the emulator's own camera is off.  The emulator crashes on MJPG webcams ("Unknown format: 0x18"),
#   even with libv4l's v4l2convert preloaded.  WEBCAM=webcam0 sim/sim.sh start tries the emulator camera anyway.
#   VIDEO=clip.mp4 sim/sim.sh start   plays a video file (looped) instead of the webcam, and its sound track
#   instead of the mic.  ffmpeg converts it once into sim/run/video/.
# Phone: a Pixel running Chrome on http://localhost:8787/ (localhost counts as secure, so GPS works).
#   GPS: "..." > Location, or  sim/walk.py --adb emulator-5556  to walk the active route.
# The iOS Simulator only runs on macOS; Chrome on Android is the closest stand-in for Safari here.
#
# Both reach the server through adb reverse, so the server stays bound to 127.0.0.1.
# Start the server first:  npm start
#
# Everything lives under sim/ (git-ignored): the SDK in sim/android/sdk, the emulators and adb keys in
# sim/android/user, logs and scratch in sim/run.
set -euo pipefail
cd "$(dirname "$0")/.."
SIM="$PWD/sim"

export ANDROID_HOME="${ANDROID_HOME:-$SIM/android/sdk}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$SIM/android/user}"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDM="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
EMU="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"
GLASSES=naviq-glasses PHONE=naviq-phone
GS=emulator-5554 PS=emulator-5556
GIMG="system-images;android-28;google_apis;x86_64"
PIMG="system-images;android-34;google_apis;x86_64"
CITYTECH_LON=-73.98735 CITYTECH_LAT=40.69545
WEBCAM="${WEBCAM:-none}"   # emulator camera; list webcams with: $EMU -webcam-list
LOG="$SIM/run/session"
mkdir -p "$LOG"

say() { echo "sim: $*" >&2; }

# set_ini FILE KEY VALUE: replace or append one config.ini line.
set_ini() {
  python3 -I - "$@" <<'EOF'
import sys
path, key, value = sys.argv[1:4]
lines = [l for l in open(path).read().splitlines() if not l.startswith(key + "=")]
lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
EOF
}

setup() {
  [ -x "$SDKM" ] || { say "missing $SDKM: install Android command-line tools there first"; exit 1; }
  yes | "$SDKM" --licenses >/dev/null 2>&1 || true
  "$SDKM" emulator platform-tools "platforms;android-28" "build-tools;36.0.0" "$GIMG" "$PIMG" >&2

  if ! "$AVDM" list avd -c | grep -qx "$GLASSES"; then
    echo no | "$AVDM" create avd -n "$GLASSES" -k "$GIMG" >&2
    ini="$ANDROID_AVD_HOME/$GLASSES.avd/config.ini"
    for kv in hw.lcd.width=640 hw.lcd.height=480 hw.lcd.density=160 hw.ramSize=1536 \
              hw.camera.back=none hw.camera.front=none hw.keyboard=yes hw.audioInput=yes hw.audioOutput=yes \
              hw.sensors.orientation=yes hw.sensors.magnetic_field=yes hw.gpu.enabled=yes hw.gpu.mode=host \
              showDeviceFrame=no skin.name=640x480 skin.path=_no_skin; do
      set_ini "$ini" "${kv%%=*}" "${kv#*=}"
    done
    say "created $GLASSES"
  fi
  if ! "$AVDM" list avd -c | grep -qx "$PHONE"; then
    echo no | "$AVDM" create avd -n "$PHONE" -k "$PIMG" -d pixel_7 >&2
    ini="$ANDROID_AVD_HOME/$PHONE.avd/config.ini"
    for kv in hw.ramSize=2048 hw.keyboard=yes hw.camera.back=emulated hw.camera.front=none \
              hw.gpu.enabled=yes hw.gpu.mode=host hw.gps=yes; do
      set_ini "$ini" "${kv%%=*}" "${kv#*=}"
    done
    say "created $PHONE"
  fi
  glasses-app/build.sh >&2   # needs build-tools 36: d8 34 crashes on classes from JDK 25
}

running() { "$ADB" devices | grep -q "^$1[[:space:]]"; }

wait_boot() {
  "$ADB" -s "$1" wait-for-device
  until [ "$("$ADB" -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
  say "$1 booted"
}

start() {
  curl -fsS -o /dev/null http://localhost:8787/api/state || { say "server not running: npm start"; exit 1; }
  [ -f glasses-app/WornHUD.apk ] || { say "no WornHUD.apk: sim/sim.sh setup"; exit 1; }
  "$ADB" start-server >/dev/null 2>&1   # once, before the parallel checks below race to start it

  running "$GS" || "$EMU" -avd "$GLASSES" -port 5554 -camera-back "$WEBCAM" -allow-host-audio -no-boot-anim -no-snapshot-save \
    >"$LOG/glasses.log" 2>&1 &
  running "$PS" || "$EMU" -avd "$PHONE" -port 5556 -no-boot-anim -no-snapshot-save >"$LOG/phone.log" 2>&1 &
  wait_boot "$GS"
  wait_boot "$PS"

  # Glasses: the same steps as glasses-app/install.sh, aimed at this emulator.
  "$ADB" -s "$GS" install -r glasses-app/WornHUD.apk >&2
  "$ADB" -s "$GS" shell pm grant com.wornhack.hud android.permission.CAMERA
  "$ADB" -s "$GS" shell pm grant com.wornhack.hud android.permission.RECORD_AUDIO
  "$ADB" -s "$GS" reverse tcp:8787 tcp:8787 >/dev/null
  "$ADB" -s "$GS" shell am start -n com.wornhack.hud/.MainActivity --es url http://localhost:8787/hud >&2

  # Phone: Chrome without its first-run screens, GPS at City Tech.
  "$ADB" -s "$PS" reverse tcp:8787 tcp:8787 >/dev/null
  "$ADB" -s "$PS" shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
  "$ADB" -s "$PS" shell am set-debug-app --persistent com.android.chrome
  "$ADB" -s "$PS" shell pm grant com.android.chrome android.permission.ACCESS_FINE_LOCATION || true
  "$ADB" -s "$PS" emu geo fix "$CITYTECH_LON" "$CITYTECH_LAT" >/dev/null
  "$ADB" -s "$PS" shell am start -a android.intent.action.VIEW -d http://localhost:8787/ com.android.chrome >&2

  [ "$WEBCAM" = none ] && camera_window

  say "glasses: $GS   phone: $PS   logs: $LOG"
  say "walk the route:  sim/walk.py --adb $PS"
}

# Converts $VIDEO once into what Chrome's fake capture device reads: MJPEG frames and a 16-bit PCM wav.
# Prints the Chrome flags on stdout.
video_flags() {
  [ -f "$VIDEO" ] || { say "no such video: $VIDEO"; exit 1; }
  local out="$SIM/run/video" base
  base="$(basename "${VIDEO%.*}")"
  mkdir -p "$out"
  if [ ! -s "$out/$base.mjpeg" ] || [ "$VIDEO" -nt "$out/$base.mjpeg" ]; then
    say "converting $VIDEO"
    ffmpeg -loglevel error -y -i "$VIDEO" -an -vf "scale=1280:-2,fps=15" -q:v 4 -f mjpeg "$out/$base.mjpeg"
    rm -f "$out/$base.wav"
    if ffprobe -loglevel error -select_streams a -show_entries stream=index -of csv=p=0 "$VIDEO" | grep -q .; then
      ffmpeg -loglevel error -y -i "$VIDEO" -vn -ac 1 -ar 48000 -c:a pcm_s16le "$out/$base.wav"
    fi
  fi
  echo "--use-fake-device-for-media-stream --use-file-for-fake-video-capture=$out/$base.mjpeg"
  [ -s "$out/$base.wav" ] && echo "--use-file-for-fake-audio-capture=$out/$base.wav"
  return 0
}

# The HUD page in a small muted Chrome window does the looking (?glasses=1 = auto-look), on the laptop
# webcam or on $VIDEO.  Restarted each time: Chrome ignores new flags while a profile is open.
camera_window() {
  local flags=()
  [ -n "${VIDEO:-}" ] && mapfile -t flags < <(video_flags | tr ' ' '\n')
  stop_camera
  google-chrome --user-data-dir="$LOG/chrome-camera" --no-first-run --use-fake-ui-for-media-stream --mute-audio \
    "${flags[@]}" --window-size=480,400 --app="http://localhost:8787/hud?glasses=1" >"$LOG/camera.log" 2>&1 &
  say "camera: ${VIDEO:-laptop webcam}"
}

stop_camera() {
  pkill -f -- "--user-data-dir=$LOG/chrome-camera" || true
  sleep 1
}

stop() {
  stop_camera
  for s in "$GS" "$PS"; do "$ADB" -s "$s" emu kill >/dev/null 2>&1 || true; done
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  camera) camera_window ;;   # restart only the camera window, e.g. VIDEO=other.mp4 sim/sim.sh camera
  stop) stop ;;
  *) sed -n 2,26p "$0" >&2; exit 2 ;;
esac
