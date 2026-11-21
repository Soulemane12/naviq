#!/bin/bash
# Runs the whole NAVIQ demo on this laptop.  See sim/README.md for the pieces and what each mode starts.
#
#   sim/demo.sh demo [CLIP.mp4] [--route]  replay a recorded walk: the clip is the glasses camera and mic,
#                                          CLIP.gps.csv (if any) the phone GPS; --route, or no track,
#                                          walks the active route instead.  No clip: newest recording,
#                                          else the A105 test clip.
#   sim/demo.sh record                     record a walk: webcam + mic + laptop location (sim/record.sh)
#   sim/demo.sh live                       laptop webcam as the glasses camera, laptop location as GPS
#   sim/demo.sh stop                       stop everything this script started
#   sim/demo.sh status                     what's running
#
# Environment:
#   BACKEND=claude-code (default) | openai   which model reads the camera frames
#   MAPBOX_TOKEN=pk...                       street-named walking directions (else OpenStreetMap)
#   OPENAI_API_KEY=sk-...                    needed for BACKEND=openai and for the server's voice (/api/tts)
#   GPS_SPEED=1.4                            walking pace in m/s when the phone walks the route
set -euo pipefail
cd "$(dirname "$0")/.."
SIM="$PWD/sim"
RUN="$SIM/run/session"
mkdir -p "$RUN"
BACKEND="${BACKEND:-claude-code}"
CC_PORT=8789
say() { echo "demo: $*" >&2; }

# ---------- process helpers (pid files in sim/run/session) ----------

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

stop_one() {
  if alive "$1"; then kill "$(cat "$RUN/$1.pid")" 2>/dev/null || true; say "stopped $1"; fi
  rm -f "$RUN/$1.pid"
}

# port_pid PORT: the pid listening on 127.0.0.1:PORT, if any.
port_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

wait_http() {
  local url=$1 i
  for i in $(seq 1 40); do curl -fsS -o /dev/null "$url" 2>/dev/null && return 0; sleep 0.5; done
  say "$url did not come up"; return 1
}

# ---------- pieces ----------

start_backend() {
  if [ "$BACKEND" != claude-code ]; then stop_one claude-code; return 0; fi
  command -v claude >/dev/null || { say "no claude CLI on PATH: use BACKEND=openai"; exit 1; }
  alive claude-code || {
    CLAUDE_CODE_PORT=$CC_PORT node "$SIM/claude-code-server.mjs" >"$RUN/claude-code.log" 2>&1 &
    echo $! >"$RUN/claude-code.pid"
  }
  wait_http "http://127.0.0.1:$CC_PORT/health"
  say "model: Claude Code via http://127.0.0.1:$CC_PORT (log $RUN/claude-code.log)"
}

# The NAVIQ server, restarted so it picks up the backend choice.
start_server() {
  local pid
  pid=$(port_pid 8787)
  [ -n "$pid" ] && { kill "$pid"; sleep 1; say "stopped the old server ($pid)"; }
  local env=(env -u ANTHROPIC_LOG)
  if [ "$BACKEND" = claude-code ]; then
    env+=(PROVIDER=anthropic ANTHROPIC_BASE_URL="http://127.0.0.1:$CC_PORT" ANTHROPIC_API_KEY=claude-code)
  else
    env+=(PROVIDER=openai)
  fi
  "${env[@]}" npm start >"$RUN/server.log" 2>&1 &
  echo $! >"$RUN/server.pid"
  wait_http http://localhost:8787/api/state
  say "server: $(grep -m1 'NAVIQ server' "$RUN/server.log") (log $RUN/server.log)"
  [ -n "${MAPBOX_TOKEN:-}" ] || grep -q '^MAPBOX_TOKEN=' .env 2>/dev/null ||
    say "no MAPBOX_TOKEN: directions come from OpenStreetMap"
}

start_devices() { "$SIM/sim.sh" start; }   # emulators, glasses app, phone Chrome, camera window, layout

start_gps() {   # start_gps ARGS...  (gps.py subcommand and its arguments)
  stop_one gps
  python3 -I "$SIM/gps.py" "$@" >/dev/null 2>"$RUN/gps.log" &
  echo $! >"$RUN/gps.pid"
  say "gps: gps.py $* (log $RUN/gps.log)"
}

# ---------- modes ----------

demo() {
  local clip="" route=0 a
  for a in "$@"; do
    case "$a" in
      --route) route=1 ;;
      *) clip="$a" ;;
    esac
  done
  if [ -z "$clip" ]; then
    clip=$(ls -t "$SIM"/run/video-rec/walk-*.mp4 2>/dev/null | head -1 || true)
    clip="${clip:-$SIM/run/video-test/plaque-A105.mp4}"
  fi
  [ -f "$clip" ] || { say "no such clip: $clip"; exit 1; }
  local track="${clip%.mp4}.gps.csv"
  say "clip: $clip"
  start_backend
  start_server
  VIDEO="$clip" start_devices
  if [ "$route" = 0 ] && [ -s "$track" ] && [ "$(wc -l <"$track")" -gt 1 ]; then
    start_gps replay --loop "$track"   # loops with the video, which Chrome also loops
  else
    say "no GPS track for this clip: the phone walks the route once you start an outdoor trip"
    start_gps route --repeat --speed "${GPS_SPEED:-1.4}"
  fi
  ready
}

live() {
  start_backend
  start_server
  start_devices   # no VIDEO: the camera window uses the webcam
  if [ -x /usr/libexec/geoclue-2.0/demos/where-am-i ]; then
    start_gps live
  else
    say "no GeoClue: set the phone's location by hand (phone emulator \"...\" > Location)"
  fi
  ready
}

ready() {
  say "ready.  Phone: pick a room or a place, then Start on glasses.  Glasses: Enter = look now."
  say "stop everything:  sim/demo.sh stop"
}

stop() {
  stop_one gps
  "$SIM/sim.sh" stop || true
  local pid
  pid=$(port_pid 8787)
  [ -n "$pid" ] && { kill "$pid"; say "stopped server ($pid)"; }
  rm -f "$RUN/server.pid"
  stop_one claude-code
}

status() {
  local p
  for p in claude-code server gps; do
    if [ "$p" = server ]; then
      [ -n "$(port_pid 8787)" ] && echo "server       running (pid $(port_pid 8787))" || echo "server       stopped"
    else
      alive "$p" && printf '%-12s running (pid %s)\n' "$p" "$(cat "$RUN/$p.pid")" || printf '%-12s stopped\n' "$p"
    fi
  done
  "$SIM/android/sdk/platform-tools/adb" devices 2>/dev/null | grep -E '^emulator' | sed 's/^/emulator     /' || true
  wmctrl -l 2>/dev/null | grep -q "NAVIQ HUD" && echo "camera       window open" || echo "camera       no window"
}

case "${1:-}" in
  demo) shift; demo "$@" ;;
  record) exec "$SIM/record.sh" ;;
  live) live ;;
  stop) stop ;;
  status) status ;;
  *) sed -n 2,18p "$0" >&2; exit 2 ;;
esac
