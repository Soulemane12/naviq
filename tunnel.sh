#!/bin/bash
# Gives the laptop's NAVIQ server a public https address (Cloudflare quick tunnel, no account).
# Needed for real use: iPhone Safari only shares GPS with https pages, and the phone/glasses must reach
# the laptop from outside the venue. Every request through the tunnel needs the token from .env.
#
# Venue networks: uses HTTP/2 over TCP (UDP/QUIC is often blocked) and passes Cloudflare's edge
# addresses directly, resolved through 1.1.1.1, because overloaded venue DNS times out.
set -uo pipefail
cd "$(dirname "$0")"
TOKEN=$(grep '^NAVIQ_TOKEN=' .env | cut -d= -f2)
CF=$([ -x bin/cloudflared ] && echo bin/cloudflared || echo cloudflared)

EDGES=()
for h in region1.v2.argotunnel.com region2.v2.argotunnel.com; do
  for ip in $(dig +time=3 +tries=2 +short A "$h" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -2); do
    EDGES+=(--edge "$ip:7844")
  done
done
[ ${#EDGES[@]} -eq 0 ] && EDGES=(--edge 198.41.192.227:7844 --edge 198.41.200.13:7844)

for attempt in 1 2 3 4 5 6; do
  LOG=$(mktemp)
  GODEBUG=netdns=cgo "$CF" tunnel --no-autoupdate --protocol http2 --edge-ip-version 4 "${EDGES[@]}" --url http://localhost:8787 >"$LOG" 2>&1 &
  PID=$!
  URL=""
  for i in $(seq 1 120); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | grep -v api.trycloudflare | head -1 || true)
    if [ -n "$URL" ] && grep -q "Registered tunnel connection" "$LOG"; then break; fi
    kill -0 $PID 2>/dev/null || break
    sleep 1
  done
  if [ -n "$URL" ] && grep -q "Registered tunnel connection" "$LOG"; then break; fi
  echo "attempt $attempt failed: $(grep -E 'ERR|failed' "$LOG" | tail -1 | cut -c1-160)"
  kill $PID 2>/dev/null
  URL=""
  sleep 2
done
[ -n "$URL" ] || { echo "tunnel didn't start (venue network). Try the laptop on your phone's hotspot."; exit 1; }
trap 'kill $PID 2>/dev/null' EXIT

echo
echo "  Phone:    $URL/?t=$TOKEN"
echo "  Glasses:  ./glasses-app/install.sh \"$URL/hud?t=$TOKEN\""
echo
echo "Tunnel running. Ctrl-C to stop."
wait $PID
