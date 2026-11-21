// NAVIQ server: the part of the stack that doesn't depend on the M6 SDK. Real data only.
//
//   glasses app (tap → camera frame) ──POST /api/snap──▶ vision model ──▶ HUD card ──SSE──▶ glasses + phone
//   phone (GPS) ──POST /api/naviq/loc──▶ OpenStreetMap walking directions ──▶ HUD card
//
// Pages
//   GET  /       phone app: search a destination, navigate, record indoor routes, trip review
//   GET  /hud    640x480 HUD (the glasses app shows it full screen)
// API (all JSON)
//   GET  /api/events                 SSE stream of cards
//   POST /api/snap                   { image } → recorder / trip verification / general assist, by state
//   POST /api/card                   { mode, text?, image? } → assist card
//   POST /api/push                   { card } → show a hand-written card
//   POST /api/key                    { code, name } → glasses key (logged + relayed)
//   GET  /api/geo/search?q=&lat=&lon= → OpenStreetMap place search
//   GET  /api/tts?text=              → mp3 for the glasses speaker (OpenAI)
//   GET  /api/live                   latest camera look: what the AI saw + the current instruction (no image)
//   GET  /api/live/frame             latest camera frame (image/jpeg)
//   GET  /api/indoor/places          one-tap indoor destinations from the real City Tech plan
//   GET  /api/indoor/plan            the plan for a map: image url, node x/y, edges, current node + planned path
//   GET  /api/indoor/plan.jpg        City Tech's floor plan image (node x/y are pixels in it)
//   POST /api/heading                { h } glasses compass, degrees
//   GET  /api/naviq/routes           recorded routes (data/routes.json)
//   POST /api/naviq/routes/delete    { id }
//   POST /api/naviq/start            { destination?: {name,lat,lon}, room?: "A103"|"exit"|"bathroom"|"elevator"|…, exit?: true }
//   POST /api/naviq/loc              { lat, lon, acc, speed?, sampleAt? } phone GPS (sampleAt = Safari pos.timestamp)
//   POST /api/naviq/observe          { image } verify with the phone camera
//   POST /api/naviq/step             { dir: "next" | "back" }
//   POST /api/naviq/stop
//   GET  /api/naviq/state            trip state + history
//   GET  /api/naviq/frame?i=N        camera frame behind history entry N
//   POST /api/record/start|confirm|walk|undo|save|cancel, GET /api/record/state, GET /api/record/frame?i=N
//
// Over a Cloudflare tunnel (phone GPS needs https) every request must carry the access token:
// open  https://<tunnel>/?t=<NAVIQ_TOKEN>  once and a cookie keeps you signed in.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { MODES, CardSchema } from "./prompts.mjs";
import { createNav } from "./naviq.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.NAVIQ_TOKEN || crypto.randomBytes(9).toString("base64url");

// Provider: whichever key is in .env. If both are set, PROVIDER=openai|anthropic picks one.
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const PROVIDER = process.env.PROVIDER ?? (hasOpenAI && !hasAnthropic ? "openai" : hasAnthropic ? "anthropic" : "none");
// gpt-6.1-terra: on real frames from this venue it found the right exit and read room numbers in ~1.5 s
// (gpt-5.4-mini/5.5 picked the wrong doors; gpt-5 was right but ~6 s).
const MODEL = process.env.MODEL ?? (PROVIDER === "openai" ? "gpt-6.1-terra" : "claude-opus-5-5");
const EFFORT = process.env.EFFORT ?? "low"; // Claude: low effort keeps glances fast

const client = PROVIDER === "anthropic" && hasAnthropic ? new Anthropic() : null;
const openai = PROVIDER === "openai" && hasOpenAI ? new OpenAI() : null;
const hasKey = Boolean(client || openai);

// ---------- model calls ----------

function imageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

function strictJsonSchema(schema) {
  const js = z.toJSONSchema(schema);
  delete js.$schema;
  js.additionalProperties = false;
  js.required = Object.keys(js.properties);
  return js;
}

// Reasoning knob per model family (values each family accepts, found by trying them against the API).
function reasoningFor(model, heavy) {
  if (process.env.OPENAI_REASONING && !heavy) return { reasoning_effort: process.env.OPENAI_REASONING };
  if (/^gpt-6|^gpt-5\.[4-9]/.test(model)) return { reasoning_effort: heavy ? "low" : "none" };
  if (/^gpt-5/.test(model)) return { reasoning_effort: heavy ? "low" : "minimal" };
  return {};
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * One structured vision call, same shape for both providers. Returns the parsed object.
 * `images`: data URLs in order (e.g. [floor plan, camera frame]). `effort: "plan"` = spatial reasoning
 * over a floor plan, which needs more thinking than reading a single sign.
 */
async function askJSON({ system, prompt, image, images, schema, name, effort, fast, scene }) {
  const urls = (images ?? [image]).filter((u) => imageBlock(u));
  const img = imageBlock(urls[0]);
  const heavy = effort === "plan";

  if (openai) {
    // fast: plain reading (room numbers) on a non-reasoning model: ~1 s instead of ~2-3 s, measured on real frames.
    // scene: understanding a space (where's the way out, through what) — gpt-5 got the real exit right on a real
    // lobby photo where faster models picked the wrong doors.
    const model = scene ? process.env.SCENE_MODEL ?? MODEL : fast ? process.env.FAST_MODEL ?? MODEL : MODEL;
    const completion = await openai.chat.completions.create({
      model,
      max_completion_tokens: heavy ? 12000 : 4000,
      // gpt-5 models reason before answering; "minimal" keeps a glance to a few seconds.
      ...reasoningFor(model, heavy),
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: strictJsonSchema(schema) } },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            ...urls.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    const msg = completion.choices[0]?.message;
    if (msg?.refusal) throw httpError(422, msg.refusal);
    if (!msg?.content) throw httpError(502, "empty model reply");
    return schema.parse(JSON.parse(msg.content));
  }

  if (client) {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety classifier declines, the API retries on a fallback model in the same call
      output_config: { effort: heavy ? "medium" : EFFORT, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: [...urls.map(imageBlock), { type: "text", text: prompt }] }],
    });
    if (response.stop_reason === "refusal") throw httpError(422, response.stop_details?.explanation ?? "refused");
    if (!response.parsed_output) throw httpError(502, `no parsed output (stop_reason: ${response.stop_reason})`);
    return response.parsed_output;
  }

  throw httpError(503, "No API key: put OPENAI_API_KEY or ANTHROPIC_API_KEY in .env");
}

async function makeCard({ mode = "assist", text = "", image, context }) {
  const def = MODES[mode];
  if (!def) throw httpError(400, `unknown mode "${mode}"`);
  if (!hasKey) {
    return { title: "NO API KEY", lines: ["Add a key to .env", "then restart server"], speak: "", phone_detail: "Put OPENAI_API_KEY=... in .env, then npm start" };
  }
  try {
    const prompt = def.userText({ text, context, hasImage: Boolean(imageBlock(image)) });
    return await askJSON({ system: def.system, prompt, image, schema: CardSchema, name: "hud_card" });
  } catch (err) {
    if (err.status === 422) return { title: "CAN'T HELP", lines: ["Try rephrasing"], speak: "", phone_detail: err.message };
    throw err;
  }
}

// ---------- OpenStreetMap place search (Nominatim; 1 request/second policy) ----------

let lastGeo = 0;
// Two Mapbox searches in parallel: Search Box finds named places (it returns "Jay St–MetroTech" station
// first; Geocoding returns street addresses for that query), Geocoding v6 is better at exact addresses and
// intersections. Order by what the query looks like; OpenStreetMap is the fallback.
async function mapboxJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).features ?? [];
}
const fromFeature = (f, kind) => ({
  name: f.properties.name,
  address: f.properties.full_address ?? f.properties.place_formatted ?? "",
  lat: f.properties.coordinates.latitude,
  lon: f.properties.coordinates.longitude,
  kind,
});
async function geoSearch(q, near) {
  const tok = process.env.MAPBOX_TOKEN;
  if (tok) {
    const prox = near ? { proximity: `${near.lon},${near.lat}` } : {};
    const [poi, addr] = await Promise.all([
      mapboxJson(`https://api.mapbox.com/search/searchbox/v1/forward?${new URLSearchParams({ q, limit: "6", language: "en", access_token: tok, ...prox })}`)
        .then((fs) => fs.map((f) => fromFeature(f, "place"))).catch((e) => (console.error(`[search] searchbox: ${e.message}`), [])),
      mapboxJson(`https://api.mapbox.com/search/geocode/v6/forward?${new URLSearchParams({ q, limit: "6", access_token: tok, ...prox })}`)
        .then((fs) => fs.map((f) => fromFeature(f, "address"))).catch((e) => (console.error(`[search] geocoding: ${e.message}`), [])),
    ]);
    const addressy = /^\s*\d|&|\band\b|\bcorner\b/i.test(q); // "285 Jay St", "Jay St & Tillary St"
    const merged = [];
    for (const r of addressy ? [...addr, ...poi] : [...poi, ...addr]) {
      if (!Number.isFinite(r.lat)) continue;
      if (near && Math.hypot((r.lat - near.lat) * 111, (r.lon - near.lon) * 85) > 50) continue; // same name, other city
      if (merged.some((m) => Math.hypot((m.lat - r.lat) * 111000, (m.lon - r.lon) * 85000) < 40 && m.name === r.name)) continue;
      merged.push(r);
    }
    if (merged.length) return merged.slice(0, 8);
  }
  return osmSearch(q, near);
}

async function osmSearch(q, near) {
  const wait = 1100 - (Date.now() - lastGeo);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeo = Date.now();
  const p = new URLSearchParams({ format: "json", limit: "6", q });
  if (near) {
    const d = 0.08; // bias results to ~8 km around the phone
    p.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${p}`, {
    headers: { "user-agent": "naviq-hackathon/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw httpError(502, `place search HTTP ${res.status}`);
  return (await res.json()).map((x) => ({
    name: x.name || x.display_name.split(",")[0],
    address: x.display_name.split(",").slice(1, 4).join(",").trim(),
    lat: Number(x.lat),
    lon: Number(x.lon),
  }));
}

// ---------- live cards (SSE) ----------

let lastCard = { title: "NAVIQ", lines: ["Open NAVIQ on your phone"], speak: "", phone_detail: "", ts: Date.now() };
const sseClients = new Set();

function lanIp() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return "localhost";
}

function broadcast(card) {
  lastCard = { ...card, ts: Date.now() };
  const msg = `data: ${JSON.stringify(lastCard)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function sseEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

const nav = createNav({ routesFile: path.join(here, "data/routes.json"), askJSON, broadcast });
const ttsCache = new Map(); // text → mp3

// ---------- HTTP ----------

async function readJson(req, limit = 12 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, "body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, body, type = "application/json", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFrame(res, dataUrl) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl ?? "");
  if (!m) return send(res, 404, { error: "no frame" });
  return send(res, 200, Buffer.from(m[2], "base64"), m[1]);
}

function logStep(src, image, out) {
  const v = out.verdict, g = out.guide, r = out.read, n = out.card?.nav;
  const what = v ? `${v.seen_id} (${v.confidence}) "${v.sign_text}"`
    : g ? `${g.located ? g.location : "not located"} (${g.confidence}) → ${g.instruction} ${g.detail}${g.arrived ? " ARRIVED" : ""}`
    : r ? `rooms [${r.rooms.map((x) => x.label + "@" + x.position).join(" ")}] places [${(r.places ?? []).map((x) => x.kind + "@" + x.position + (x.close ? "!" : "")).join(" ")}] up:${r.numbers_increase} → ${n?.instruction ?? ""} · ${n?.detail ?? ""}${n?.aheadBearing != null ? ` [${n.aheadBearing}°]` : ""}` : "";
  console.log(`[naviq] ${src} image=${kb(image)}KB ${out.ms}ms → ${what}`);
}

const kb = (dataUrl) => (dataUrl ? Math.round((dataUrl.length * 3) / 4 / 1024) : 0);
const STATIC = { "/": "public/phone.html", "/hud": "public/hud.html" };

// Requests through the Cloudflare tunnel carry cf-* headers; local ones (laptop, glasses over adb) don't.
function authorized(req, url) {
  if (!req.headers["cf-connecting-ip"] && !req.headers["cf-ray"]) return { ok: true };
  const cookie = /(?:^|;\s*)naviq_t=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  if (cookie === TOKEN) return { ok: true };
  if (url.searchParams.get("t") === TOKEN) return { ok: true, setCookie: true };
  return { ok: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const auth = authorized(req, url);
  if (!auth.ok) return send(res, 401, "NAVIQ: open the link with ?t=<token> printed by the server.", "text/plain");
  if (auth.setCookie) {
    url.searchParams.delete("t");
    return send(res, 302, "", "text/plain", {
      location: url.pathname + (url.search || ""),
      "set-cookie": `naviq_t=${TOKEN}; Path=/; Max-Age=172800; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case "GET /api/events": {
        // no-transform + X-Accel-Buffering + a 2 KB opening comment: proxies (the Cloudflare tunnel) otherwise
        // hold the stream back.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          connection: "keep-alive",
        });
        res.flushHeaders?.();
        res.write(`: ${" ".repeat(2048)}\n\n`);
        res.write(`data: ${JSON.stringify(lastCard)}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      case "GET /api/state":
        return send(res, 200, lastCard);

      case "POST /api/snap": {
        const { image, text } = await readJson(req);
        const t0 = Date.now();
        nav.noteFrame(image, "glasses");
        if (nav.recording) {
          const out = await nav.recSnap(image);
          if (out.busy) return send(res, 202, { busy: true });
          console.log(`[record] image=${kb(image)}KB ${Date.now() - t0}ms → "${out.read.sign_text}" (${out.read.kind})`);
          return send(res, 200, out);
        }
        if (nav.active) {
          const out = await nav.observe(image, text);
          if (out.busy) return send(res, 202, { busy: true });
          logStep("glasses", image, out);
          return send(res, 200, out.card);
        }
        const card = await makeCard({ mode: "assist", text, image });
        broadcast(card);
        console.log(`[assist] image=${kb(image)}KB ${Date.now() - t0}ms → ${card.title}`);
        return send(res, 200, { ...card, ms: Date.now() - t0 });
      }

      case "POST /api/card": {
        const body = await readJson(req);
        const t0 = Date.now();
        const card = await makeCard(body);
        broadcast(card);
        console.log(`[card] ${body.mode ?? "assist"} image=${kb(body.image)}KB ${Date.now() - t0}ms → ${card.title}`);
        return send(res, 200, { ...card, ms: Date.now() - t0 });
      }

      case "POST /api/push": {
        const { card } = await readJson(req);
        const parsed = CardSchema.safeParse(card);
        if (!parsed.success) return send(res, 400, { error: parsed.error.issues });
        broadcast(parsed.data);
        return send(res, 200, { ok: true });
      }

      case "POST /api/key": {
        const { code, name } = await readJson(req);
        console.log(`[key] ${name} (${code})`);
        sseEvent("key", { code, name, ts: Date.now() });
        return send(res, 200, { ok: true });
      }

      // The HUD polls this and reloads itself when public/hud.html changes (no cable needed for updates).
      case "GET /api/hud-version":
        return send(res, 200, { v: (await fs.stat(path.join(here, "public/hud.html"))).mtimeMs });

      case "GET /api/config":
        return send(res, 200, { mapboxToken: process.env.MAPBOX_TOKEN ?? null });

      case "GET /api/geo/search": {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return send(res, 400, { error: "empty search" });
        const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
        // No phone fix yet (GPS still locking): search around City Tech, where NAVIQ runs, so a vague query
        // doesn't return same-named places in other states.
        const near = lat && lon ? { lat, lon } : { lat: 40.6955, lon: -73.9867 };
        return send(res, 200, { results: await geoSearch(q, near) });
      }

      case "GET /api/tts": {
        const text = (url.searchParams.get("text") ?? "").slice(0, 300);
        if (!openai || !text) return send(res, 404, { error: "tts needs OPENAI_API_KEY" });
        let mp3 = ttsCache.get(text);
        if (!mp3) {
          const speech = await openai.audio.speech.create({
            model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
            voice: process.env.OPENAI_TTS_VOICE ?? "alloy",
            input: text,
            response_format: "mp3",
          });
          mp3 = Buffer.from(await speech.arrayBuffer());
          ttsCache.set(text, mp3);
          if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
        }
        return send(res, 200, mp3, "audio/mpeg");
      }

      // ----- trips -----
      case "GET /api/naviq/routes":
        return send(res, 200, { routes: await nav.loadRoutes() });

      case "POST /api/naviq/routes/delete": {
        const { id } = await readJson(req);
        return send(res, 200, { routes: await nav.deleteRoute(id) });
      }

      case "POST /api/naviq/start": {
        const body = await readJson(req);
        const st = await nav.start(body);
        console.log(`[naviq] start ${st.routeName}`);
        return send(res, 200, st);
      }

      case "POST /api/naviq/loc": {
        const { lat, lon, acc, speed, sampleAt } = await readJson(req);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: "bad location" });
        return send(res, 200, nav.location({
          lat, lon, acc,
          speed: Number.isFinite(speed) ? speed : undefined,
          sampleAt: Number.isFinite(sampleAt) ? sampleAt : undefined, // dedupes the phone's heartbeat copies
        }));
      }

      case "GET /api/live":
        return send(res, 200, nav.liveInfo());
      case "GET /api/live/frame":
        return sendFrame(res, nav.liveFrame());
      case "GET /api/indoor/places":
        return send(res, 200, { places: nav.places() });
      // City Tech's real floor plan for the phone map: image + node pixels + current position and path.
      case "GET /api/indoor/plan":
        return send(res, 200, nav.planInfo() ?? { error: "no plan" });
      case "GET /api/indoor/plan.jpg": {
        const f = nav.planImageFile();
        if (!f) return send(res, 404, { error: "no plan image" });
        return send(res, 200, await fs.readFile(f), "image/jpeg", { "cache-control": "public, max-age=3600" });
      }

      // Glasses compass: which way the wearer faces (the HUD rotates its arrow locally; this is for the log/phone).
      case "POST /api/heading": {
        const { h } = await readJson(req);
        return send(res, 200, nav.setHeading(Number(h)));
      }
      case "GET /api/heading":
        return send(res, 200, { heading: nav.heading });

      case "POST /api/naviq/observe": {
        const { image, text } = await readJson(req);
        nav.noteFrame(image, "phone");
        const out = await nav.observe(image, text);
        if (out.busy) return send(res, 202, { busy: true });
        logStep("phone", image, out);
        return send(res, 200, out);
      }

      case "POST /api/naviq/step": {
        const { dir } = await readJson(req);
        return send(res, 200, nav.step(dir === "back" ? "back" : "next"));
      }

      case "POST /api/naviq/stop":
        return send(res, 200, nav.stop());

      case "GET /api/naviq/state":
        return send(res, 200, nav.state());

      case "GET /api/naviq/frame":
        return sendFrame(res, nav.frame(Number(url.searchParams.get("i"))));

      // ----- floor plans -----
      case "GET /api/plan/list":
        return send(res, 200, { plans: await nav.listPlans() });
      case "POST /api/plan/upload": {
        const { image } = await readJson(req, 20 * 1024 * 1024);
        const t0 = Date.now();
        const plan = await nav.addPlan(image);
        console.log(`[plan] read ${plan.places.length} places (${plan.building} ${plan.floor}) in ${Date.now() - t0}ms`);
        return send(res, 200, plan);
      }
      case "GET /api/plan/image": {
        const img = await nav.planImage(url.searchParams.get("id"));
        return img ? sendFrame(res, img) : send(res, 404, { error: "no plan" });
      }
      case "POST /api/plan/delete": {
        const { id } = await readJson(req);
        return send(res, 200, { plans: await nav.deletePlan(id) });
      }

      // ----- recorder -----
      case "GET /api/record/state":
        return send(res, 200, nav.recState());
      case "POST /api/record/start": {
        const { name } = await readJson(req);
        return send(res, 200, nav.recStart(name));
      }
      case "POST /api/record/snap": {
        const { image } = await readJson(req);
        return send(res, 200, await nav.recSnap(image));
      }
      case "POST /api/record/confirm":
        return send(res, 200, nav.recConfirm(await readJson(req)));
      case "POST /api/record/walk": {
        const { place } = await readJson(req);
        if (!place || !Number.isFinite(place.lat)) return send(res, 400, { error: "pick a place" });
        return send(res, 200, nav.recWalk(place));
      }
      case "POST /api/record/undo":
        return send(res, 200, nav.recUndo());
      case "POST /api/record/save":
        return send(res, 200, await nav.recSave());
      case "POST /api/record/cancel":
        return send(res, 200, nav.recCancel());
      case "GET /api/record/frame":
        return sendFrame(res, nav.recFrame(Number(url.searchParams.get("i"))));
    }

    if (req.method === "GET" && STATIC[url.pathname]) {
      return send(res, 200, await fs.readFile(path.join(here, STATIC[url.pathname]), "utf8"), "text/html; charset=utf-8");
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof OpenAI.APIError || err instanceof Anthropic.APIError) {
      console.error(`[${PROVIDER}] ${err.status}: ${err.message}`);
      const status = err.status === 401 || err.status === 429 ? err.status : 502;
      return send(res, status, { error: status === 401 ? "invalid API key" : err.message });
    }
    if (!err.status) console.error(err);
    send(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const ip = lanIp();
  console.log(`\nNAVIQ server (provider ${PROVIDER}, model ${MODEL})`);
  console.log(`  phone (same Wi-Fi): http://${ip}:${PORT}/   (GPS needs the https tunnel link)`);
  console.log(`  HUD:                http://${ip}:${PORT}/hud`);
  console.log(`  tunnel token:       ${TOKEN}`);
  if (!hasKey) console.log("  ⚠ No API key: put OPENAI_API_KEY or ANTHROPIC_API_KEY in .env\n");
});
