#!/bin/bash
# Record a walk with the laptop webcam and mic, for VIDEO=... sim/sim.sh camera later.
#
#   sim/record.sh            Start button → records (small preview window) → Stop button → saves the clip
#
# Clips go to sim/run/video-rec/walk-YYYYMMDD-HHMMSS.mp4; the path is printed on stdout.
# The webcam can only have one user, so this closes the simulator's camera window first.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$PWD/sim/run/video-rec"
mkdir -p "$OUT"
say() { echo "record: $*" >&2; }

pkill -f -- "--user-data-dir=$PWD/sim/run/session/chrome-camera" && sleep 1 || true

zenity --question --title="NAVIQ recorder" --width=320 \
  --text="Recording starts when you press Start.\n\nWalk the way the glasses would look." \
  --ok-label="Start" --cancel-label="Cancel" || { say "cancelled"; exit 1; }

clip="$OUT/walk-$(date +%Y%m%d-%H%M%S).mp4"
log="$OUT/ffmpeg.log"
# One ffmpeg: the clip to disk, plus a low-res copy to a small ffplay preview window.
ffmpeg -hide_banner -loglevel warning -y \
  -f v4l2 -input_format mjpeg -video_size 1280x720 -framerate 30 -i /dev/video0 \
  -f pulse -i default \
  -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "$clip" \
  -map 0:v -vf scale=320:-2 -c:v mjpeg -q:v 8 -f mpjpeg pipe:1 2>"$log" |
  ffplay -hide_banner -loglevel error -window_title "NAVIQ recording" -x 320 -y 180 -left 20 -top 60 \
    -f mpjpeg -i pipe:0 2>/dev/null &
pipeline=$!
sleep 1
ffpid=$(pgrep -n -f -- "ffmpeg .*$clip" || true)
[ -n "$ffpid" ] || { say "ffmpeg didn't start: $(tail -3 "$log")"; exit 1; }
say "recording $clip"

zenity --info --title="NAVIQ recorder" --width=320 --text="Recording…\n\nPress Stop when you're done." --ok-label="Stop" || true

kill -INT "$ffpid" 2>/dev/null || true   # ffmpeg finishes the mp4 cleanly on SIGINT
wait "$pipeline" 2>/dev/null || true
pkill -f -- "-window_title NAVIQ recording" 2>/dev/null || true

secs=$(ffprobe -loglevel error -show_entries format=duration -of csv=p=0 "$clip" 2>/dev/null || echo 0)
say "saved ${secs%.*} s → $clip"
say "use it:  VIDEO=$clip sim/sim.sh camera"
zenity --info --title="NAVIQ recorder" --width=420 --text="Saved ${secs%.*} s:\n$clip\n\nUse it:\nVIDEO=$clip sim/sim.sh camera" || true
echo "$clip"
