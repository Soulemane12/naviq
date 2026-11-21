// npm run check: is NAVIQ ready for a live demo? Checks every real dependency and says how to fix what isn't.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels } from "../indoor.mjs";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = process.env;
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, fix) => { failures++; console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ""}`); };
const sh = (cmd) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString(); } catch { return ""; } };
const get = async (url, opts = {}) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts }); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };

console.log("\nNAVIQ readiness check\n");

console.log("Keys (.env)");
for (const k of ["OPENAI_API_KEY", "MAPBOX_TOKEN", "NAVIQ_TOKEN"]) env[k] ? ok(`${k} set`) : bad(`${k} missing`, `add ${k}=… to .env`);

console.log("AI model");
const model = env.MODEL ?? "gpt-6.1-terra";
if (env.OPENAI_API_KEY) {
  const r = await get(`https://api.openai.com/v1/models/${model}`, { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } });
  r.status === 200 ? ok(`OpenAI key works and can use ${model}`) : bad(`OpenAI ${model}: HTTP ${r.status}`, r.status === 401 ? "the key is invalid or revoked: make a new one" : "set MODEL=… in .env to a model your key has");
}

console.log("Maps (Mapbox)");
if (env.MAPBOX_TOKEN) {
  const d = await get(`https://api.mapbox.com/directions/v5/mapbox/walking/-73.98702,40.69553;-73.9871,40.69621?steps=true&geometries=geojson&access_token=${env.MAPBOX_TOKEN}`);
  d.status === 200 && JSON.parse(d.body).code === "Ok" ? ok("walking directions (City Tech → Jay & Tillary)") : bad(`Mapbox directions: HTTP ${d.status}`, "check MAPBOX_TOKEN (OpenStreetMap fallback still works)");
  const s = await get(`https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent("Jay St-MetroTech")}&proximity=-73.9867,40.6955&access_token=${env.MAPBOX_TOKEN}`);
  s.status === 200 ? ok(`place search ("Jay St-MetroTech" → ${JSON.parse(s.body).features?.[0]?.properties?.name ?? "?"})`) : bad(`Mapbox search: HTTP ${s.status}`);
}

console.log("Indoor plan");
const models = loadModels(path.join(here, "data/citytech"));
models.length ? ok(`${models.map((m) => `${m.name}: ${m.nodes.length} places, ${m.places.length} destinations`).join("; ")}`) : bad("no building plan loaded", "data/citytech/academic-complex.json missing?");

console.log("Server");
const port = env.PORT ?? 8787;
const st = await get(`http://localhost:${port}/api/naviq/state`);
st.status === 200 ? ok(`NAVIQ server running on :${port}`) : bad(`server not reachable on :${port}`, "npm start");

console.log("Tunnel (phone GPS needs https)");
const cf = sh("pgrep -fl 'cloudflared tunnel'");
if (!cf.trim()) bad("cloudflared not running", "./tunnel.sh   (keep it running: restarting it changes the link)");
else {
  const logs = sh(`ls -t ${os.tmpdir()}/tmp.* 2>/dev/null`).split("\n").filter(Boolean).slice(0, 8);
  const url = logs.map((f) => (fs.readFileSync(f, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) ?? []).find((u) => !u.includes("api."))).find(Boolean);
  if (!url) bad("tunnel running but its link wasn't found", "restart ./tunnel.sh and use the link it prints");
  else {
    const t = await get(`${url}/api/state`, { headers: { cookie: `naviq_t=${env.NAVIQ_TOKEN}` } });
    t.status === 200 ? ok(`tunnel up: ${url}/?t=${env.NAVIQ_TOKEN}`) : bad(`tunnel ${url}: HTTP ${t.status}`, "is the server running? (npm start)");
  }
}

console.log("Glasses");
const adb = sh("adb devices -l");
if (!/XNM_Glass/.test(adb)) console.log("  • not on USB (fine if they're already set up wirelessly; plug in to update the link)");
else {
  ok("M6 glasses on USB");
  sh("adb shell pm list packages com.wornhack.hud").includes("com.wornhack.hud") ? ok("NAVIQ glasses app installed") : bad("glasses app not installed", "./glasses-app/install.sh");
  const fg = sh("adb shell dumpsys activity activities").match(/mResumedActivity: \S+ \S+ (\S+)/)?.[1] ?? "?";
  fg.includes("wornhack") ? ok("NAVIQ is on screen") : console.log(`  • on screen: ${fg} (run ./glasses-app/install.sh to bring NAVIQ back)`);
}

console.log(failures ? `\n${failures} problem(s) above.\n` : "\nAll good: ready to demo.\n");
process.exit(failures ? 1 : 0);
