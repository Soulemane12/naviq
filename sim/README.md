# NAVIQ laptop simulator

Run the whole NAVIQ demo on a Linux laptop, with no glasses and no iPhone.  Two Android emulators play the
M6 glasses and the phone.  The laptop webcam or a recorded video is what the glasses see, and a recorded
track or the laptop's own location is the phone's GPS.


## The pieces

| # | Piece | What runs | Stands in for |
|---|---|---|---|
| 1 | NAVIQ server | `npm start` on 127.0.0.1:8787 | the same server as on the venue laptop |
| 2 | Model backend | OpenAI, or `sim/claude-code-server.mjs` on 127.0.0.1:8789 | reads each camera frame |
| 3 | Glasses emulator | Android 9 (API 28), 640x480, 160 dpi, the real `WornHUD.apk` | the M6 glasses (display, speaker, compass, keys) |
| 4 | Phone emulator | Pixel, Android 14, Chrome on `http://localhost:8787/` | the iPhone and Safari (there is no iOS Simulator on Linux) |
| 5 | Camera window | desktop Chrome on `/hud?glasses=1`, sound muted | the glasses camera: the webcam, or a video file through Chrome's fake camera |
| 6 | GPS source | `sim/gps.py` into the phone emulator's GPS | the phone's GPS: a recorded track, a route walk, or the laptop's location (GeoClue) |
| 7 | Window layout | `wmctrl` | glasses top middle, camera below, phone on the right, terminal on the left |

Not used here: the Cloudflare tunnel (`tunnel.sh`), which only a real phone needs.  Both emulators reach the
server through `adb reverse`, so it stays on 127.0.0.1.

Why a separate camera window: the Android emulator crashes on MJPG webcams ("Unknown format: 0x18"), even with
libv4l's converter, so the emulator's own camera is off and its HUD shows "camera: Requested device not found".


## Modes

```bash
sim/sim.sh setup            # once: SDK packages, both emulators, WornHUD.apk (about 4 GB)

sim/demo.sh record          # Start button → walk → Stop button: webcam + mic + laptop location
sim/demo.sh demo [CLIP.mp4] # replay a recording (default: the newest one)
sim/demo.sh live            # webcam + laptop location, live
sim/demo.sh status
sim/demo.sh stop
```

| Mode | Glasses camera and mic | Phone GPS | Starts |
|---|---|---|---|
| `record` | webcam and mic, saved to `sim/run/video-rec/walk-*.mp4` | GeoClue, saved to `walk-*.gps.csv` | `sim/record.sh` only |
| `demo` | the clip, looped (its sound is the mic) | the clip's `.gps.csv`, looped with it; without one (or with `--route`) the phone walks each outdoor route you start | everything |
| `live` | webcam and mic | GeoClue as it changes | everything |

Then, on the phone: pick a room (A103) or search a place, and press **Start on glasses**.  Keys in the glasses
window: Enter = look now, Esc = repeat aloud.  Turn the glasses: "..." > Virtual sensors.

Environment: `BACKEND=claude-code` (default) or `openai`; `MAPBOX_TOKEN` for street names in directions;
`OPENAI_API_KEY` for `BACKEND=openai` and for the voice; `GPS_SPEED` (m/s) for route walks.


## Claude Code as the model

`sim/claude-code-server.mjs` answers the Anthropic Messages API on 127.0.0.1:8789 by running `claude -p`
under your Claude Code login.  NAVIQ's server uses it through its existing Anthropic code path
(`PROVIDER=anthropic ANTHROPIC_BASE_URL=http://127.0.0.1:8789 ANTHROPIC_API_KEY=claude-code`), so no NAVIQ
file changes.  Each call is a fresh `claude -p` with no tools, MCP servers, settings or saved session, and
the JSON schema from NAVIQ's request passed as `--json-schema`.

Measured with NAVIQ's own prompts on the A105 clip: 2.8 to 3.9 s per look (1.6 to 2.4 s of model time),
19 looks in 40 s, all correct.  OpenAI `gpt-6.1-terra` took about 1.5 s.  The voice (`/api/tts`) is
OpenAI-only, so with Claude Code the glasses use Android's built-in voice.

Test: `node --test sim/test/*.test.mjs` (the live test calls Claude Code; `NO_LIVE=1` skips it).


## Files

| File | What it does |
|---|---|
| `demo.sh` | the modes above: starts and stops every piece |
| `sim.sh` | the emulators: `setup`, `start`, `stop`, `camera` (restart the camera window, `VIDEO=` a clip), `arrange` |
| `record.sh` | Start/Stop recorder for walk clips and tracks |
| `gps.py` | GPS: `route`, `replay TRACK`, `record TRACK`, `live` |
| `claude-code-server.mjs` | Claude Code as a Messages API backend |
| `test/` | tests for the Claude Code backend, and a test frame |
| `android/` | git-ignored: the Android SDK (`sdk/`), emulator images and adb keys (`user/`) |
| `run/` | git-ignored: logs (`session/`), recordings (`video-rec/`), converted clips (`video/`), test clips |


## Limits

- Chrome on Android is not Safari: Safari-only behaviour (location permission prompts, `webkitCompassHeading`
  for the phone compass) is not tested here.
- GeoClue on a laptop is Wi-Fi based: 20 to 120 m accuracy, a fix every few seconds.  NAVIQ waits for ≤30 m
  before planning a route, so `live` outdoors may sit at "FINDING YOU".
- A clip and its track loop independently, so they drift apart slowly over many loops.
- The phone emulator needs about 2.7 GB of RAM, the glasses 1.4 GB and the camera window 1.2 GB.
- NAVIQ never uses the microphone yet; the clip's sound and the laptop mic reach the camera window only.
