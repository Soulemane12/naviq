# NAVIQ: navigation that sees what you see

Worn Smart Glasses Hackathon · Seamless Handoff track · MicroLumin M6

Plan on the phone, put it away, and the glasses guide you, switching modes on their own:

- **Outdoors:** your phone's real GPS plus real walking directions from OpenStreetMap. The HUD counts down to each turn ("TURN LEFT onto Myrtle Ave · in 40 m"), reroutes if you drift off the path, and switches modes when you arrive.
- **Indoors and in the subway:** there is no indoor GPS, so NAVIQ reads the real signs (room plates, exits, station and platform signs) with the glasses camera to confirm where you are. Wrong sign means a recovery route. If it can't read anything, it says so rather than guessing.

There is **no fake or simulated data**. Destinations come from OpenStreetMap search. Indoors, NAVIQ uses a photo of the building's own posted floor plan.

> Prior-work disclosure: parts of this were written Friday evening before hacking began. List them as prior work in the submission.

## Run it

```bash
npm install
# .env (git-ignored): OPENAI_API_KEY=sk-...   NAVIQ_TOKEN=<random>
npm start
./tunnel.sh        # public https link: needed for phone GPS and for walking around (see below)
```

`tunnel.sh` prints two things:
- **Phone:** `https://….trycloudflare.com/?t=TOKEN`. Open it in Safari and allow location.
- **Glasses:** `./glasses-app/install.sh "https://…/hud?t=TOKEN"`. Run it with the glasses on USB once; they then work wirelessly.

Why the tunnel: iPhone Safari only gives GPS to https pages, and outdoors the phone and glasses can't reach the laptop on venue Wi-Fi. Every request through the tunnel needs the token, which is set as a cookie after the first visit.

**Glasses need internet to go wireless.** In MLDemo › Wi-Fi, join the glasses to your phone's hotspot (or the venue Wi-Fi indoors). Without that, keep them on USB: `./glasses-app/install.sh` with no URL uses `adb reverse`.

## Using it

**Floor plan tab (indoors).** Photograph the floor plan or evacuation map posted by the elevators or stairs. The AI reads every room, exit, stair and elevator printed on it and saves the plan. Only labels actually on the plan are used. A photo that isn't a readable plan is rejected.

**Navigate tab.** For *I'm starting…*, choose **Outdoors (GPS)** or **Inside: <the floor plan>**. Indoors, pick where you're going in the building (exits are listed first). Optionally also search an outdoor destination; GPS walking directions take over once you're out the door. Then choose **Start on glasses**.

Indoors, the glasses look around on their own every 8 s (a tap works any time). Each look sends the floor plan plus the camera frame to the AI, which reads the room numbers and signs in view, places you on the plan, and gives the next move. If it can't place you, it says "Face a room number" instead of guessing. Outdoors, the HUD shows live GPS turn-by-turn with a map on the phone.

**Review tab.** A trip timeline: each verified sign with the photo the glasses took, GPS arrivals, wrong turns and reroutes, plus trip time.

**Glasses gestures:** tap = read or verify the sign in view · BACK / key 300 / F12 = repeat the instruction aloud · BACK twice quickly = leave the app · avoid F9 (it opens the built-in camera).

Voice: the M6 has no on-device text-to-speech, so OpenAI generates the speech (`/api/tts`) and it plays through the glasses speaker.

## How it decides

| Input | NAVIQ does |
|---|---|
| Sign read matches the next or a later checkpoint | ✓ Verified, next instruction |
| Matches an earlier checkpoint | ✓ Back on route from there |
| Matches a recorded wrong-way sign | ⚠ WRONG WAY plus the recovery instruction |
| No match, or the sign text isn't readable | ? "Can't verify. Get closer to a sign" |
| Indoors, then 2 sharp GPS fixes (±15 m) | You walked outside: start the outdoor leg |
| Outdoors, more than 40 m off the walking path | Reroute from where you are |
| Within 30 m of the destination | Arrived; switch to the next leg (e.g. subway signs) or finish |

The model only reports what it sees. A checkpoint counts only if its sign words (such as the room number) were actually read. The decisions are plain code in `naviq.mjs`.

## Setup from zero (once per laptop and phone)

The MicroLumin kit is confidential and lives in `microlumin/` (git-ignored). Its iOS and Android SDKs only drive the glasses' built-in apps, so NAVIQ runs its own small Android app on the glasses (`glasses-app/`, plain Android 9, no Gradle).

1. **iPhone:** open `microlumin/Microlumin_Ship/04_Demo_Apps/MLDemo/MLDemo.xcworkspace`, set your Team, and run it on the phone. On the phone, trust the developer in Settings › General › VPN & Device Management.
2. In MLDemo: Set Up Glasses, pick yours (strongest signal; they say "Connected"), then Glasses › Developer › **Developer Mode**.
3. Replug the glasses' USB into the laptop. `adb devices -l` shows `model:XNM_Glass`.
4. `./glasses-app/install.sh` (USB) or `./glasses-app/install.sh "<tunnel hud link>"` (wireless).

Debug the glasses page: Chrome › `chrome://inspect`. Logs: `adb logcat -s WornHUD`. Rebuild after Java edits: `glasses-app/build.sh`.

## Config (`.env`)

`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` · `NAVIQ_TOKEN` · `PROVIDER` (if both keys) · `MODEL` (default `gpt-5-mini`) · `OPENAI_REASONING` (default `minimal`) · `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` · `PORT`

## Resume tomorrow (Sat)

Everything secret stays out of git: `.env` (OpenAI key, Mapbox token, tunnel token), and the confidential MicroLumin kit in `microlumin/`. Re-download the kit from the organizers' Drive link if this folder is lost. Recreate `.env` with:

```
OPENAI_API_KEY=sk-...
MAPBOX_TOKEN=pk....
NAVIQ_TOKEN=<any random string>
```

Then:

1. `npm install` (first time on a new machine), then `npm start`.
2. `./tunnel.sh` prints a **new** phone link and glasses command each time. Open the phone link in **Safari**.
3. Pick up the glasses from staff. Turn on Developer Mode with MLDemo if it's off, then plug them in and run the glasses command from `tunnel.sh` (`./glasses-app/install.sh "https://…/hud?t=…"`). Unplug. They now run wirelessly on the iPhone hotspot ("?") and update themselves.
4. The laptop stays on, open and online (venue Wi-Fi) for the whole demo.

What works now: outdoor GPS + Mapbox turn-by-turn (fake crosswalk turns removed, path distance to the metre, smoothing, live countdown); the glasses compass rotates the arrow to the real direction; indoor room-number finding (A105 → A103 logic, floors, wrong-way detection); exit finding by scene (gpt-6.1-terra); two parallel look workers; review timeline with photos.

Still to check on site: compass direction outdoors (face south on Jay St; the arrow should point behind you when heading north). If it's off by a fixed 90° or 180°, fix the heading formula in `public/hud.html` (`onOrient`).

## City Tech live navigation

- **Find a room:** In Navigate, choose **A103** or **A105**, or enter a room number. Tap **Start on glasses** and look at the nearest room plaque or landmark. The M6 scans automatically and uses City Tech's [Academic Complex floor plan](https://www.citytech.cuny.edu/theater/docs/AC_layout.pdf) for its mapped rooms and public paths. There is no route-recording step.
- **Exit and continue outside:** Choose **Exit** and optionally select a walking destination before starting. The glasses guide you to the exit and the phone supplies GPS for the outdoor leg. For an outdoor-only trip, select a walking destination by itself.
- **Check the live camera:** Expand **Glasses camera** during an indoor trip to see the latest frame and recognized landmarks. If the glasses need a better view, face a nearby sign and let them scan again.
- **Rehearse on the M6:** Confirm the same instruction appears on both screens during A105 → A103, then check the Jay Street doors and walk north toward Jay Street & Tillary Street. Turn to face south and confirm the arrow points behind you. The sensors and wireless connection need that on-site check.

## Indoor navigation at City Tech (live camera, no recording)

NAVIQ uses **City Tech's published Academic Complex floor plan** (`data/citytech/AC_layout.pdf`, from citytech.cuny.edu). It's traced into a walkable map in `data/citytech/academic-complex.json`: A103–A106, A209, the main entrance on Jay St, turnstiles, elevators, escalator, bathrooms and the theater side. It's oriented with real compass directions: the building sits on the east side of Jay St, which runs ~2°/182°.

How a trip works, entirely live:
1. **Pick a destination:** a room (A103), or exit / bathroom / elevator / escalator / stairs. One-tap list: `GET /api/indoor/places`.
2. **Look around.** The glasses camera sends a frame about every second, with two AI "workers" in parallel and the newest answer winning. The AI reports what it can read and see: room plaques (and whether they're close), turnstiles, elevators, exit doors, bathrooms, signs.
3. **NAVIQ places you on the plan:** a close plaque or a recognised landmark. Elevators and escalators are used only once the floor is confirmed. A105's two doors are told apart by what else is in view; if it can't tell and the directions would differ, it says **WHICH DOOR?** instead of guessing.
4. **It routes on the plan** and uses the **glasses compass** to say TURN LEFT / RIGHT / GO STRAIGHT / TURN AROUND. The arrow rotates live toward the right direction.
5. **Arrival** only when the target plaque is close, or the place is right there. Exit plus an outdoor destination → GPS walking directions take over outside.

For buildings or floors not on the plan, it falls back to room-number logic: the floor digit, which way numbers increase (remembered as a compass bearing), signs, and remembered landmark directions.

Phone map: `GET /api/indoor/plan` returns the plan image, node pixels, current position and planned path.

**Before demoing: `npm run check`** verifies keys, model access, Mapbox, the plan, the server, the tunnel and the glasses.

## Laptop simulator (no glasses, no iPhone)

`sim/demo.sh` runs the whole demo on a Linux laptop: Android emulators for the glasses and the phone, the webcam or a recorded walk as the glasses camera, a recorded track or the laptop's location as GPS, and optionally Claude Code as the model.  See [sim/README.md](sim/README.md).
