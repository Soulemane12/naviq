#!/usr/bin/env python3
"""GPS for the NAVIQ simulator: walk the route, replay a track, record one, or pass live laptop location.

    gps.py route  [--speed 1.4] [--repeat]    walk the active outdoor route (waits for a trip to start)
    gps.py replay TRACK.csv [--loop]          replay a recorded track with its own timing
    gps.py record TRACK.csv                   save laptop location (GeoClue) until Ctrl-C
    gps.py live                               send laptop location (GeoClue) as it changes

Fixes go to the phone emulator's GPS (adb emu geo fix), so the phone page in Chrome sends them to the
server as a real phone would.  --server sends them straight to the NAVIQ server instead.
Track files are CSV with a header: t,lat,lon,acc  (t = seconds from the start of the recording).
GeoClue on a laptop is Wi-Fi based: expect 20-100 m accuracy and a fix every few seconds at best.
Status goes to stderr.
"""
import argparse
import csv
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ADB = os.path.join(os.environ.get("ANDROID_HOME", os.path.join(HERE, "android", "sdk")), "platform-tools", "adb")
WHERE_AM_I = "/usr/libexec/geoclue-2.0/demos/where-am-i"
MAX_ACC_M = 500


def say(*a):
    print(*a, file=sys.stderr, flush=True)


def call(base, path, body=None):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET")
    data = None
    if body is not None:
        req.add_header("content-type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data, timeout=10) as r:
        return json.load(r)


class Sink:
    """Where a fix goes: the phone emulator's GPS, or the server directly."""

    def __init__(self, args):
        self.args = args

    def send(self, lat, lon, acc=6.0, speed=None):
        if self.args.server:
            body = {"lat": lat, "lon": lon, "acc": acc, "sampleAt": int(time.time() * 1000)}
            if speed is not None:
                body["speed"] = speed
            call(self.args.base, "/api/naviq/loc", body)
        else:
            subprocess.run([ADB, "-s", self.args.serial, "emu", "geo", "fix", str(lon), str(lat)],
                           check=True, stdout=subprocess.DEVNULL)


def dist(a, b):
    dy = (a["lat"] - b["lat"]) * 111320
    dx = (a["lon"] - b["lon"]) * 111320 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


def along(line, step):
    """Points every `step` metres along a polyline."""
    yield line[0]
    carry = 0.0
    for a, b in zip(line, line[1:]):
        seg = dist(a, b)
        t = step - carry
        while t <= seg:
            f = t / seg
            yield {"lat": a["lat"] + f * (b["lat"] - a["lat"]), "lon": a["lon"] + f * (b["lon"] - a["lon"])}
            t += step
        carry = seg - (t - step)
    yield line[-1]


def active_line(base):
    st = call(base, "/api/naviq/state")
    if not st.get("active") or st.get("done"):
        return []
    return (st.get("outdoor") or {}).get("line") or []


def route(args, sink):
    walked = None
    while True:
        line = active_line(args.base)
        if len(line) < 2 or line == walked:
            time.sleep(2)   # no outdoor trip yet, or the one we already walked
            continue
        say(f"gps: walking a {len(line)}-point route at {args.speed} m/s")
        walk(args, sink, line)
        walked = line
        if not args.repeat:
            return
        say("gps: waiting for the next outdoor trip")


def walk(args, sink, line):
    for p in along(line, args.speed * args.every):
        sink.send(p["lat"], p["lon"], speed=args.speed)
        card = call(args.base, "/api/state")
        say(f"gps: {p['lat']:.6f},{p['lon']:.6f}  {card.get('title')}  {' | '.join(card.get('lines') or [])}")
        if (card.get("nav") or {}).get("phase") == "arrived" or not active_line(args.base):
            return
        time.sleep(args.every)


def replay(args, sink):
    with open(args.track) as f:
        rows = [{k: float(v) for k, v in r.items()} for r in csv.DictReader(f)]
    if not rows:
        sys.exit(f"gps: {args.track} has no fixes")
    while True:
        t0 = time.time()
        for r in rows:
            time.sleep(max(0.0, r["t"] - (time.time() - t0)))
            sink.send(r["lat"], r["lon"], r.get("acc", 6.0))
            say(f"gps: t={r['t']:.0f}s {r['lat']:.6f},{r['lon']:.6f} ±{r.get('acc', 0):.0f} m")
        if not args.loop:
            break


def geoclue():
    """Yield (lat, lon, acc) from GeoClue's where-am-i demo client as fixes arrive."""
    if not os.access(WHERE_AM_I, os.X_OK):
        sys.exit(f"gps: no {WHERE_AM_I} (dnf install geoclue2-demos), so no laptop location")
    p = subprocess.Popen([WHERE_AM_I, "-t", "86400", "-a", "8"], stdout=subprocess.PIPE, text=True)
    fix = {}
    try:
        for line in p.stdout:
            m = re.match(r"\s*(Latitude|Longitude|Accuracy):\s+(-?[\d.]+)", line)
            if m:
                fix[m[1]] = float(m[2])
            if len(fix) == 3:
                if fix["Accuracy"] <= MAX_ACC_M:
                    yield fix["Latitude"], fix["Longitude"], fix["Accuracy"]
                else:  # GeoClue's first answer is often a GeoIP guess kilometres away
                    say(f"gps: skipped a ±{fix['Accuracy']:.0f} m fix")
                fix = {}
    finally:
        p.terminate()


def record(args, _sink):
    t0 = time.time()
    with open(args.track, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "lat", "lon", "acc"])
        say(f"gps: recording laptop location to {args.track} (Ctrl-C to stop)")
        try:
            for lat, lon, acc in geoclue():
                w.writerow([round(time.time() - t0, 1), lat, lon, acc])
                f.flush()
                say(f"gps: {lat:.6f},{lon:.6f} ±{acc:.0f} m")
        except KeyboardInterrupt:
            pass
    print(args.track)


def live(args, sink):
    say("gps: passing laptop location through (Ctrl-C to stop)")
    try:
        for lat, lon, acc in geoclue():
            sink.send(lat, lon, acc)
            say(f"gps: {lat:.6f},{lon:.6f} ±{acc:.0f} m")
    except KeyboardInterrupt:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:8787")
    ap.add_argument("--serial", default="emulator-5556", help="phone emulator (default %(default)s)")
    ap.add_argument("--server", action="store_true", help="post fixes to the server instead of the phone emulator")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("route")
    r.add_argument("--speed", type=float, default=1.4, help="metres per second (default %(default)s)")
    r.add_argument("--every", type=float, default=1.0, help="seconds between fixes (default %(default)s)")
    r.add_argument("--repeat", action="store_true", help="after arriving, wait for the next trip and walk it too")
    p = sub.add_parser("replay")
    p.add_argument("track")
    p.add_argument("--loop", action="store_true")
    c = sub.add_parser("record")
    c.add_argument("track")
    sub.add_parser("live")
    args = ap.parse_args()
    # Background jobs in scripts ignore SIGINT; let SIGTERM stop record/live cleanly too.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    {"route": route, "replay": replay, "record": record, "live": live}[args.cmd](args, Sink(args))


if __name__ == "__main__":
    main()
