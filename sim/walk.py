#!/usr/bin/env python3
"""Replay a walk along the active NAVIQ outdoor route with fake phone GPS fixes.

Usage: walk.py [--speed M_PER_S] [--every SECONDS] [--base URL] [--adb SERIAL]
Start an outdoor trip first (phone page or POST /api/naviq/start).  Status goes to stderr.
Without --adb, fixes go straight to the server.  With --adb emulator-5556, they go to the phone
emulator's GPS, and the phone page in Chrome sends them on, as a real phone would.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.request


def call(base, path, body=None):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET")
    data = None
    if body is not None:
        req.add_header("content-type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data, timeout=10) as r:
        return json.load(r)


def dist(a, b):
    dy = (a["lat"] - b["lat"]) * 111320
    dx = (a["lon"] - b["lon"]) * 111320 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


def points(line, step):
    """Yield points every `step` metres along the polyline."""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=1.4)
    ap.add_argument("--every", type=float, default=1.0)
    ap.add_argument("--base", default="http://localhost:8787")
    ap.add_argument("--adb", metavar="SERIAL", help="move this emulator's GPS instead of posting to the server")
    args = ap.parse_args()

    line = []
    for _ in range(30):
        st = call(args.base, "/api/naviq/state")
        line = (st.get("outdoor") or {}).get("line") or []
        if len(line) >= 2:
            break
        print("waiting for a route (start an outdoor trip)...", file=sys.stderr)
        time.sleep(1)
    if len(line) < 2:
        sys.exit("no outdoor route")

    for p in points(line, args.speed * args.every):
        if args.adb:
            adb = os.path.join(os.environ.get("ANDROID_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "sdk")), "platform-tools", "adb")
            subprocess.run([adb, "-s", args.adb, "emu", "geo", "fix", str(p["lon"]), str(p["lat"])], check=True, stdout=subprocess.DEVNULL)
        else:
            call(args.base, "/api/naviq/loc", {"lat": p["lat"], "lon": p["lon"], "acc": 6, "speed": args.speed, "sampleAt": int(time.time() * 1000)})
        card = call(args.base, "/api/state")
        print(f"{p['lat']:.6f},{p['lon']:.6f}  {card.get('title')}  {' | '.join(card.get('lines') or [])}", file=sys.stderr)
        if (card.get("nav") or {}).get("phase") == "arrived":
            break
        time.sleep(args.every)


if __name__ == "__main__":
    main()
