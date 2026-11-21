// NAVIQ navigation engine. Real data only: phone GPS, OpenStreetMap walking directions, and signs read by
// the glasses camera. Nothing here is simulated or pre-filled.
//
// A trip chains legs that switch automatically:
//   INDOOR / SUBWAY ── checkpoints verified by reading real signs (there is no indoor GPS, so signs are
//                      the "you are here"). Indoor routes come from the recorder: walk the path once and
//                      tap at each sign.
//   OUTDOOR         ── phone GPS + OpenStreetMap walking directions to a real, geocoded destination,
//                      rerouting when you drift off the path.
//
// Sign verification: the vision model only answers "which known landmark is clearly visible, and what
// does its sign say?". Plain code decides: verified / back on route / wrong turn / can't verify.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import * as indoor from "./indoor.mjs";

const VERIFY_SYSTEM = `You check navigation checkpoints for a person wearing smart glasses.
You get one first-person camera frame and a list of known landmarks. Each has an id and a description of its sign or appearance.
Decide which ONE landmark is clearly visible in the frame. Match readable sign text first (room numbers, station names, line letters, direction words), then distinctive appearance.
Be strict. If no listed landmark is clearly identifiable, answer "none". Never infer a landmark from context alone.
confidence: "high" = sign text clearly readable and matches; "medium" = partly readable or matched by appearance; "low" = unsure.
sign_text: the exact text you can read on any sign in view (empty string if none).
reason: one short sentence.`;

const READ_SYSTEM = `You read signs for a person recording a walking route with smart glasses.
Find the single most prominent sign in the first-person camera frame (room number plate, exit sign, stairs or elevator sign, hallway or directory sign, subway station or platform sign).
sign_text: its exact text as printed, nothing invented. Empty string if no sign is readable.
kind: what the sign is; "none" if there is no readable sign.
description: how to recognise this spot again (sign shape and colour, what's around it), one sentence.`;

const PLAN_READ_SYSTEM = `You read a photo of a building floor plan or evacuation map that is posted on a wall.
List every labelled place you can actually read on it: room numbers, exits, stairs, elevators, restrooms, offices, entrances.
Only include labels printed on the plan. Never invent or guess labels.
building / floor: from the plan's title if shown, else empty string.
you_are_here: the label nearest the "You are here" marker if there is one, else empty string.
readable: false if this is not a floor plan or its labels can't be read.
notes: one sentence on the layout (e.g. "one long east-west corridor, exits at both ends").`;

const PLAN_GUIDE_SYSTEM = `You guide a person wearing smart glasses inside a building, using the building's posted floor plan.
Image 1 is the floor plan (often a photo of an evacuation map). Image 2 is what the wearer sees right now; the camera faces the way they face.
1. Read any room numbers, signs or labels visible in image 2 and find them on the floor plan.
2. Work out where the wearer is standing and which way they are facing.
3. Give the single next move toward the destination. arrow is relative to the way they face. instruction: at most 16 characters, uppercase, e.g. "TURN LEFT". detail: at most 28 characters, e.g. "past A103 to the exit".
Be honest. If what's visible doesn't let you place the wearer on the plan, set located=false and confidence="low", and use detail to say what to look at (e.g. "Face a room number"). Never invent rooms that aren't on the plan.
arrived=true only when the destination is clearly right in front of the wearer.
location: where they are on the plan in a few words, e.g. "corridor outside A105, facing the lobby".
seen_text: the exact text you read in image 2 (empty if none).`;

const ROOM_READ_SYSTEM = `You are the eyes of a person wearing smart glasses indoors. Report only what is actually in the frame.
rooms: every room number you can read on a DOOR PLATE (the small plaque on the wall beside a single door), copied exactly as written including any suffix ("A104.02" is a different room from "A104"; never drop the ".02"), with where it sits in the frame ("left", "center" or "right") and close=true only if that plaque is within a few steps (large in the frame).
numbers_increase: if two or more room numbers are visible, the way the numbers go UP from the wearer's point of view: "left", "right", "ahead" (further down the corridor) or "behind". "unknown" with fewer than two numbers.
signs: every directional or wayfinding sign you can read: exact text, its arrow ("left", "right", "straight", "up", "down" or "none"), kind: "room_range" (a sign listing rooms, e.g. "A101-A120" or a hanging sign "A104 / A106"), "exit", "stairs", "elevator", "restroom" or "other", and close=true if it is within a few steps (large in the frame). A hanging, overhead or projecting sign that lists room numbers is a SIGN, never a door plate: put it here, not in rooms.
places: things you can recognise by how they look or by their sign: "exit_doors" (only the building's glass doors to the street; an EXIT sign over an ordinary door or stairwell is a sign of kind "exit", not exit_doors), "turnstiles" (security gates), "elevators" (elevator doors or call buttons), "escalator", "stairs", "restroom" (restroom door or sign), "info_desk" (security or information desk). For each: position in the frame, close=true if it is within a few steps (large in the frame), and cue: a few words (e.g. "glass doors with EXIT sign, past the turnstiles").
outdoors: the wearer is clearly outside the building.
Never invent text, rooms, doors or places that aren't in the frame.`;
const POS = z.enum(["left", "center", "right"]);
const READ_SCHEMA = z.object({
  rooms: z.array(z.object({ label: z.string(), position: POS, close: z.boolean() })),
  numbers_increase: z.enum(["left", "right", "ahead", "behind", "unknown"]),
  signs: z.array(z.object({ text: z.string(), arrow: z.enum(["left", "right", "straight", "up", "down", "none"]), kind: z.enum(["room_range", "exit", "stairs", "elevator", "restroom", "other"]), close: z.boolean() })),
  places: z.array(z.object({ kind: z.enum(["exit_doors", "turnstiles", "elevators", "escalator", "stairs", "restroom", "info_desk"]), position: POS, close: z.boolean(), cue: z.string() })),
  outdoors: z.boolean(),
});
const short = (txt, n) => (String(txt).length > n ? String(txt).slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : String(txt));

const MAX_FRAMES = 60;
const ROUTER = process.env.NAVIQ_ROUTER ?? "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const UA = "naviq-hackathon/1.0";

const INSTRUCTION = {
  left: "TURN LEFT", right: "TURN RIGHT", straight: "GO STRAIGHT", back: "TURN AROUND",
  up: "GO UPSTAIRS", down: "GO DOWNSTAIRS", elevator: "TAKE ELEVATOR", arrive: "YOU'RE HERE",
};

// ---------- geo helpers ----------
const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const COMPASS = ["NORTH", "NORTHEAST", "EAST", "SOUTHEAST", "SOUTH", "SOUTHWEST", "WEST", "NORTHWEST"];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
const roundDist = (m) => (m >= 100 ? Math.round(m / 10) * 10 : Math.max(5, Math.round(m / 5) * 5));
function segDist(p, a, b) {
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Project p onto segment a-b: perpendicular distance (m) and position t (0..1) along it.
function segProj(p, a, b) {
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}
// Distance under 100 m to the metre; beyond that, to 10 m (GPS can't do better far out anyway).
const exactDist = (m) => (m >= 100 ? Math.round(m / 10) * 10 : Math.max(0, Math.round(m)));

function maneuverView(step) {
  const m = step.maneuver, mod = m.modifier ?? "straight";
  if (m.type === "arrive") return { arrow: "arrive", instruction: "ARRIVING", detail: step.name || "destination" };
  if (m.type === "depart") return { arrow: "straight", instruction: `HEAD ${compass(m.bearing_after)}`, detail: step.name ? `on ${step.name}` : "along the path" };
  const arrow = mod.includes("left") ? "left" : mod.includes("right") ? "right" : mod === "uturn" ? "back" : "straight";
  const instruction =
    mod === "uturn" ? "TURN AROUND" : mod.startsWith("slight") ? `BEAR ${arrow.toUpperCase()}` : arrow === "straight" ? "CONTINUE" : `TURN ${arrow.toUpperCase()}`;
  return { arrow, instruction, detail: step.name ? `onto ${step.name}` : step.toward ? `toward ${step.toward}` : "on the path" };
}

// Walking routes follow sidewalk/crosswalk geometry, which produces fake turns: a 10 m "right" onto a
// crosswalk then "left" back to the same heading. Keep only turns a person would call a turn.
const turnAngle = (a, b) => ((b - a + 540) % 360) - 180; // signed degrees
function simplifySteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i], m = st.maneuver;
    if (m.type === "depart" || m.type === "arrive") { out.push(st); continue; }
    const nx = steps[i + 1];
    // jog: short sideways segment, then back to (about) the original heading → not a turn at all
    if (nx && nx.maneuver.type !== "arrive" && st.distance < 20 && Math.abs(turnAngle(m.bearing_before, nx.maneuver.bearing_after)) < 35) { i++; continue; }
    if (Math.abs(turnAngle(m.bearing_before, m.bearing_after)) < 25) continue; // gentle bend
    out.push(st);
  }
  // Unnamed segments ("along the path") read better as "toward <next named street>".
  out.forEach((st, i) => { if (!st.name) st.toward = out.slice(i + 1).find((x) => x.name)?.name ?? ""; });
  return out;
}

// Mapbox walking directions when MAPBOX_TOKEN is set (cleaner routes on real NYC sidewalks), else the free
// OpenStreetMap router. Same response shape (Mapbox Directions is OSRM-compatible).
async function fetchWalk(from, to) {
  const tok = process.env.MAPBOX_TOKEN;
  if (tok) {
    try {
      return await fetchWalkFrom(`https://api.mapbox.com/directions/v5/mapbox/walking/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true&access_token=${tok}`, "mapbox");
    } catch (err) {
      console.error(`[directions] mapbox failed (${err.message}), falling back to OpenStreetMap`);
    }
  }
  return fetchWalkFrom(`${ROUTER}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`, "osm");
}

async function fetchWalkFrom(url, source) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`directions HTTP ${res.status}`);
  const j = await res.json();
  const r = j.routes?.[0];
  if (j.code !== "Ok" || !r) throw new Error(`directions: ${j.code}`);
  const line = r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const steps = r.legs[0].steps.map((st) => {
    const at = { lat: st.maneuver.location[1], lon: st.maneuver.location[0] };
    let li = 0, best = Infinity;
    line.forEach((p, i) => { const d = dist(p, at); if (d < best) { best = d; li = i; } });
    return { maneuver: st.maneuver, name: st.name, distance: st.distance, at, lineIndex: li };
  });
  return { line, steps: simplifySteps(steps), distance: r.distance, duration: r.duration, source };
}

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "sign";
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
// Words with digits (room numbers) are the most reliable match; otherwise the whole sign text.
function matchTokens(text) {
  const digits = String(text).split(/[\s\-–—·,/()]+/).filter((w) => /\d/.test(w));
  return digits.length ? digits : [text];
}

// "A105" → building A, floor 1, number 105. "A1205" → floor 12.
function parseRoom(t) {
  const m = /([A-Z]{1,2})\s*-?\s*(\d{3,4})\b/.exec(String(t).toUpperCase());
  if (!m) return null;
  const num = Number(m[2]);
  return { label: m[1] + m[2], bldg: m[1], num, floor: Math.floor(num / 100) };
}
const OPPOSITE = { left: "right", right: "left", ahead: "behind", behind: "ahead" };
const DIR_ARROW = { left: "left", right: "right", ahead: "straight", behind: "back", straight: "straight", up: "up", down: "down", here: "straight" };
const DIR_WORD = { left: "TURN LEFT", right: "TURN RIGHT", ahead: "GO STRAIGHT", behind: "TURN AROUND", straight: "GO STRAIGHT", up: "GO UP", down: "GO DOWN" };

export function createNav({ routesFile, askJSON, broadcast }) {
  let s = null; // active trip
  let rec = null; // active recording
  let busy = false;
  let inflight = 0;
  let lastFix = null;
  let heading = null; // which way the wearer's head faces (glasses compass), degrees from north
  const models = indoor.loadModels(path.join(path.dirname(routesFile), "citytech")); // real building plans
  console.log(`[indoor] plans: ${models.map((m) => `${m.name} (${m.nodes.length} nodes)`).join(", ") || "none"}`);
  // Latest camera look, for the phone's "what the glasses see" panel.
  const live = { frame: null, frameTs: 0, source: null, read: null, view: null, ts: 0 };
  // Compass calibration: when a door plaque is read close and centred, the plan says which way the wearer faces;
  // the difference to the raw compass is an offset we learn and apply to plan bearings.
  const cal = { offset: 0, n: 0, errs: [], lastDoor: null, lastTs: 0, pending: null };
  const rawHeadingNow = () => heading && Date.now() - heading.ts < 4000 ? heading.deg : null;

  async function loadRoutes() {
    try {
      return JSON.parse(await fs.readFile(routesFile, "utf8")).routes ?? [];
    } catch {
      return [];
    }
  }
  async function saveRoutes(routes) {
    await fs.writeFile(routesFile, JSON.stringify({ routes }, null, 2) + "\n");
  }

  // ---------- floor plans (photos of the plans posted in the building, read by the vision model) ----------
  const plansDir = path.join(path.dirname(routesFile), "plans");
  const plansIndex = path.join(plansDir, "index.json");
  async function listPlans() {
    try {
      return JSON.parse(await fs.readFile(plansIndex, "utf8"));
    } catch {
      return [];
    }
  }
  async function addPlan(image) {
    if (!image) throw Object.assign(new Error("no photo"), { status: 400 });
    const PlanRead = z.object({
      building: z.string(),
      floor: z.string(),
      places: z.array(z.object({ label: z.string(), kind: z.enum(["room", "exit", "stairs", "elevator", "restroom", "office", "entrance", "other"]) })),
      you_are_here: z.string(),
      readable: z.boolean(),
      notes: z.string(),
    });
    const read = await askJSON({ system: PLAN_READ_SYSTEM, prompt: "Read this floor plan.", images: [image], schema: PlanRead, name: "floor_plan", effort: "plan" });
    if (!read.readable || !read.places.length) throw Object.assign(new Error("Couldn't read a floor plan in that photo. Get closer and keep it straight."), { status: 422 });
    const id = crypto.randomBytes(5).toString("hex");
    const m = /^data:image\/\w+;base64,(.+)$/.exec(image);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, `${id}.jpg`), Buffer.from(m[1], "base64"));
    const plan = { id, building: read.building, floor: read.floor, places: read.places, you_are_here: read.you_are_here, notes: read.notes, createdAt: new Date().toISOString() };
    const all = await listPlans();
    all.push(plan);
    await fs.writeFile(plansIndex, JSON.stringify(all, null, 2) + "\n");
    return plan;
  }
  async function planImage(id) {
    if (!/^[a-f0-9]{10}$/.test(String(id))) return null;
    try {
      return `data:image/jpeg;base64,${(await fs.readFile(path.join(plansDir, `${id}.jpg`))).toString("base64")}`;
    } catch {
      return null;
    }
  }
  async function deletePlan(id) {
    const all = (await listPlans()).filter((p) => p.id !== id);
    await fs.writeFile(plansIndex, JSON.stringify(all, null, 2) + "\n");
    await fs.rm(path.join(plansDir, `${id}.jpg`), { force: true });
    return all;
  }

  const route = () => s?.route;
  const cp = (i) => route()?.checkpoints[i] ?? null;
  const ICON = { ok: "✓", warn: "⚠", unknown: "?", pending: "…", arrived: "✓", manual: "•", gps: "◎" };

  function buildCard(kind, statusText, extra = {}) {
    const r = route();
    const total = r.checkpoints.length;
    let nav;
    if (s.finalView) nav = { mode: "outdoor", ...s.finalView };
    else if (s.plan && !s.outdoor) nav = { mode: "indoor", ...(s.planView ?? { arrow: "scan", instruction: "LOOK AROUND", detail: "Face a room number or sign" }) };
    else if (s.room && !s.outdoor) nav = { mode: "indoor", ...(s.roomView ?? { arrow: "scan", instruction: "LOOK AROUND", detail: "Face a room number" }) };
    else if (s.offRoute) {
      const o = r.offRoute.find((x) => x.id === s.offRoute);
      nav = { mode: (cp(Math.max(s.index, 0)) ?? {}).mode ?? "indoor", arrow: "back", instruction: "WRONG WAY", detail: o.recover };
    } else if (s.outdoor?.view) nav = { mode: "outdoor", ...s.outdoor.view };
    else if (s.index < 0) {
      const first = cp(0);
      nav = { mode: first.mode, arrow: "scan", instruction: "FIND START", detail: `Look at the ${first.label} sign` };
    } else {
      const c = cp(s.index);
      nav = { mode: c.mode, arrow: c.arrow, instruction: c.instruction, detail: c.detail };
    }
    Object.assign(nav, {
      kind,
      status: `${ICON[kind] ?? ""} ${statusText}`.trim(),
      dest: r.destination,
      step: r.outdoorOnly ? 0 : Math.max(0, s.index + 1),
      total: r.outdoorOnly ? 0 : total,
      modeChanged: Boolean(extra.modeChanged),
      ...(extra.dist ?? {}),
      ...(extra.navExtra ?? {}),
      auto: Boolean(((s.plan && !s.plan.done) || (s.room && !s.room.done)) && !s.outdoor && !s.done), // glasses look on their own
      autoMs: s.room ? 900 : 8000,
    });
    if (Number.isFinite(nav.aheadBearing)) {
      nav.aheadBearingTrue = Math.round(nav.aheadBearing) % 360;
      nav.aheadBearing = Math.round(norm360(nav.aheadBearing - (s.outdoor ? outdoorOffset() : indoorOffset()))) % 360;
    }
    if (s.plan || s.room) { nav.step = 0; nav.total = 0; }
    if (s.room && !nav.target) nav.target = s.room.target.label;
    if (!nav.phase) {
      const o = s.outdoor;
      nav.phase = s.finalView || kind === "arrived" ? "arrived"
        : o ? (o.waiting ? "waiting_gps" : o.routing ? "routing" : o.steps.length ? "guiding" : "compass")
        : kind === "unknown" || kind === "pending" ? "looking" : "guiding";
    }
    return {
      title: nav.instruction,
      lines: [nav.detail, nav.status],
      speak: extra.speak ?? "",
      phone_detail: extra.phoneDetail ?? `${nav.instruction}: ${nav.detail}. ${nav.status}.`,
      nav,
    };
  }

  function emit(kind, statusText, extra) {
    s.lastCard = buildCard(kind, statusText, extra);
    broadcast(s.lastCard);
    return s.lastCard;
  }

  function state() {
    if (!s) return { active: false };
    const r = route();
    const o = s.outdoor;
    return {
      active: !s.done,
      done: s.done,
      routeName: r.name,
      destination: r.destination,
      outdoorOnly: Boolean(r.outdoorOnly || r.plan || r.room),
      room: s.room ? { target: s.room.target.label, kind: s.room.target.kind, onPlan: Boolean(s.room.target.model), at: s.room.atLabel ?? null, atNode: s.room.ambiguous ? null : s.room.at ?? null, path: s.room.ambiguous ? null : s.room.path ?? null, floor: s.room.floor ?? null, last: s.room.last?.label ?? null, done: Boolean(s.room.done) } : null,
      plan: s.plan ? { id: s.plan.id, target: s.plan.target, last: s.plan.last ?? null, done: Boolean(s.plan.done) } : null,
      index: s.index,
      total: r.checkpoints.length,
      checkpoints: r.outdoorOnly ? [] : r.checkpoints.map((c) => ({ id: c.id, label: c.label, mode: c.mode, walkTo: c.walkTo?.name ?? null })),
      offRoute: s.offRoute,
      wrongTurns: s.wrongTurns,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      fix: s.fix,
      outdoor: o ? { to: o.to, line: o.line, distance: o.distance, remaining: o.remaining, next: o.nextDist, waiting: Boolean(o.waiting), error: o.error ?? null } : null,
      history: s.history,
      card: s.lastCard,
    };
  }

  // ---------- outdoor leg (real GPS + OpenStreetMap directions) ----------

  function startOutdoor(c, toIndex) {
    const to = c.walkTo;
    s.outdoor = { to, toIndex, line: [], steps: [], stepIdx: 0, view: null, near: false, rerouteAt: 0, waiting: false, routing: false, waitSince: Date.now() };
    // Plan only from a good fix: ±62 m next to the building picked the wrong street to start from.
    const fresh = s.fix && Date.now() - (s.fix.sampleAt ?? s.fix.ts) < 10000 && s.fix.acc <= 30;
    if (fresh) return routeOutdoor(s.fix, "Directions ready");
    s.outdoor.waiting = true;
    s.outdoor.view = { arrow: "scan", instruction: "FINDING YOU", detail: `Walking to ${to.name}` };
    emit("gps", "Waiting for phone GPS…", { speak: `Walking to ${to.name}. Waiting for GPS.`, navExtra: { phase: "waiting_gps" } });
  }

  async function routeOutdoor(from, reason) {
    const o = s.outdoor;
    if (o.routing) return; // one directions request at a time
    const rerouting = o.steps.length > 0;
    o.waiting = false;
    o.routing = true; // while true, new fixes don't touch the card (no premature compass fallback)
    o.view = { arrow: "scan", instruction: rerouting ? "REROUTING" : "GETTING ROUTE", detail: `To ${o.to.name}` };
    emit("gps", rerouting ? "Off route, rerouting…" : "Getting walking directions…", {
      speak: rerouting ? "Off route. Rerouting." : "",
      navExtra: { phase: rerouting ? "rerouting" : "routing" },
    });
    try {
      const w = await fetchWalk(from, o.to);
      if (s?.outdoor !== o) return; // leg ended while fetching
      const cum = [0];
      for (let i = 1; i < w.line.length; i++) cum.push(cum[i - 1] + dist(w.line[i - 1], w.line[i]));
      console.log(`[directions] ${w.source}: ${Math.round(w.distance)} m, ${w.steps.length} steps → ${w.steps.map((x) => x.maneuver.type + (x.maneuver.modifier ? "-" + x.maneuver.modifier : "") + (x.name ? "(" + x.name + ")" : "")).join(" → ")}`);
      Object.assign(o, w, { cum, stepIdx: -1, error: null, near: false, now10: false, remaining: w.distance, lastBucket: null, routing: false, routedAcc: from.acc ?? 50 });
      updateOutdoor(s.fix ?? from, { reason, force: true }); // the newest accepted fix, not the one we asked with
    } catch (err) {
      if (s?.outdoor !== o) return;
      o.routing = false;
      o.rerouteAt = Date.now();
      // Directions service down: real straight-line compass guidance from the newest real GPS fix.
      const fix = s.fix ?? from;
      o.error = err.message;
      o.line = [fix, o.to];
      o.steps = [];
      const d = dist(fix, o.to);
      o.view = { arrow: "straight", instruction: `HEAD ${compass(bearing(fix, o.to))}`, detail: `${o.to.name}, ${roundDist(d)} m` };
      emit("gps", "Compass only (directions offline)", {
        speak: `Head ${compass(bearing(fix, o.to)).toLowerCase()}, ${roundDist(d)} meters.`,
        navExtra: { phase: "compass", aheadBearing: Math.round(bearing(fix, o.to)), distM: d, acc: fix.acc, speed: 0 },
      });
    }
  }

  function arriveOutdoor() {
    const o = s.outdoor;
    s.history.push({ ts: Date.now(), result: "arrived-gps", label: o.to.name, confidence: "gps", ms: 0 });
    if (o.toIndex >= route().checkpoints.length) {
      s.outdoor = null;
      s.done = true;
      s.endedAt = Date.now();
      s.finalView = { arrow: "arrive", instruction: "ARRIVED", detail: o.to.name };
      emit("arrived", `Arrived: ${o.to.name}`, { speak: `You've arrived at ${o.to.name}.`, navExtra: { phase: "arrived" } });
      return;
    }
    enterCheckpoint(o.toIndex);
    const c = cp(o.toIndex);
    emit("ok", `At ${o.to.name} (GPS)`, {
      modeChanged: true,
      speak: `${c.mode} mode. You're at ${o.to.name}. Find the ${c.label} sign and tap to verify.`,
      phoneDetail: `GPS puts you at ${o.to.name}. Switched to ${c.mode} mode: tap at the ${c.label} sign to continue.`,
    });
  }

  function updateOutdoor(fix, { reason = "", force = false } = {}) {
    const o = s.outdoor;
    if (!o) return;
    if (o.routing) return; // directions on the way: keep the "getting route" card
    if (o.waiting) {
      // Good fix (±30 m), or the best we've had after 15 s of waiting (then re-planned once GPS improves).
      if (fix.acc <= 30 || (fix.acc <= 80 && Date.now() - (o.waitSince ?? 0) > 15000)) return routeOutdoor(fix, "Got your location");
      o.view = { arrow: "scan", instruction: "FINDING YOU", detail: `GPS ±${Math.round(fix.acc)} m, waiting for a better fix` };
      emit("gps", `Waiting for better GPS (±${Math.round(fix.acc)} m)`, { navExtra: { phase: "waiting_gps", acc: fix.acc } });
      return;
    }
    if (!o.steps.length) {
      // compass mode (directions service failed): keep heading/distance live, retry directions every 30 s
      const d = dist(fix, o.to);
      if (d <= (o.to.arriveRadius ?? 30)) return arriveOutdoor();
      if (Date.now() - o.rerouteAt > 30000) return routeOutdoor(fix, "Directions ready");
      o.view = { arrow: "straight", instruction: `HEAD ${compass(bearing(fix, o.to))}`, detail: `${o.to.name}, ${roundDist(d)} m` };
      emit("gps", `Compass only · GPS ±${Math.round(fix.acc)} m`, { navExtra: { phase: "compass", aheadBearing: Math.round(bearing(fix, o.to)), distM: d, acc: fix.acc, speed: fix.speed ?? 0 } });
      return;
    }

    // Planned from a poor fix and GPS is now much better: plan again from the real start (once).
    if (!o.refined && o.routedAcc > 30 && fix.acc <= 15) { o.refined = true; return routeOutdoor(fix, "GPS improved, route updated"); }

    // Arrival zone shrinks with good GPS: ±6 m → ~14 m, poor GPS → up to the route's 30 m.
    const arriveR = Math.min(o.to.arriveRadius ?? 30, Math.max(12, (fix.acc ?? 30) + 8));
    if (dist(fix, o.to) <= arriveR) return arriveOutdoor();

    // Snap onto the route: closest point on the path, and how far along the path that is.
    let off = Infinity, seg = 0, segT = 0;
    for (let i = 0; i < o.line.length - 1; i++) {
      const pr = segProj(fix, o.line[i], o.line[i + 1]);
      if (pr.d < off) { off = pr.d; seg = i; segT = pr.t; }
    }
    if (off > Math.max(40, (fix.acc ?? 0) * 1.5) && fix.acc <= 30 && Date.now() - o.rerouteAt > 15000) {
      o.rerouteAt = Date.now();
      s.history.push({ ts: Date.now(), result: "reroute", label: `${Math.round(off)} m off the path`, confidence: "gps", ms: 0 });
      routeOutdoor(fix, "Rerouted"); // shows its own "rerouting" card
      return;
    }
    const along = o.cum[seg] + segT * (o.cum[seg + 1] - o.cum[seg]);
    const total = o.cum[o.cum.length - 1];
    const toGo = Math.max(0, total - along);
    // The route usually ends on the sidewalk a few metres short of the geocoded point: arriving at the route's
    // end counts too.
    // Route-end arrival: on the route, near its end along the path, AND actually close to the final point
    // (Codex reproduced a false arrival 35 m beside the endpoint without the last two guards).
    if (off <= Math.max(15, fix.acc ?? 15) && toGo <= Math.max(8, Math.min(20, fix.acc ?? 20)) && dist(fix, o.line[o.line.length - 1]) <= arriveR) return arriveOutdoor();

    // Next real maneuver ahead of us along the path (distance measured along the path, not straight-line).
    let k = o.steps.findIndex((st, i) => i > 0 && o.cum[st.lineIndex] > along + 2);
    if (k < 0) k = o.steps.length - 1;
    const next = o.steps[k];
    const d = Math.max(0, (next.maneuver.type === "arrive" ? total : o.cum[next.lineIndex]) - along);
    o.nextDist = d;
    o.remaining = toGo;

    let view = maneuverView(next);
    const onlyArrivalLeft = next.maneuver.type === "arrive" && d > 30;
    if (onlyArrivalLeft) {
      // Nothing but the arrival ahead (e.g. a straight walk): keep showing the leg you're on until close.
      const cur = o.steps[Math.max(0, k - 1)];
      view = cur.maneuver.type === "depart" ? maneuverView(cur) : { arrow: "straight", instruction: "CONTINUE", detail: cur.name ? `on ${cur.name}` : `to ${o.to.name}` };
    } else if (next.maneuver.type === "arrive") view.detail = o.to.name;
    const stepChanged = k !== o.stepIdx;
    const near30 = d <= 30, near10 = d <= 10;
    let speak = "";
    if (force || stepChanged) speak = onlyArrivalLeft
      ? `${reason ? reason + ". " : ""}${view.instruction.toLowerCase()} ${view.detail}. ${o.to.name} in ${exactDist(d)} meters.`
      : `${reason ? reason + ". " : ""}In ${exactDist(d)} meters, ${view.instruction.toLowerCase()} ${view.detail}.`;
    else if (near10 && !o.now10 && next.maneuver.type !== "arrive") speak = `${view.instruction.toLowerCase()} now.`;
    else if (near30 && !o.near) speak = `In ${exactDist(d)} meters, ${view.instruction.toLowerCase()}.`;
    // Keep talking outdoors too: a progress update every 15 s when nothing else was said.
    if (!speak && Date.now() - (o.spokenAt ?? 0) > 15000) speak = `${view.instruction.toLowerCase()}${view.detail ? " " + view.detail : ""}. ${exactDist(toGo)} meters to go.`;
    if (speak) o.spokenAt = Date.now();
    o.stepIdx = k; o.near = near30; o.now10 = near10;
    o.evalAt = Date.now();
    const gps = `GPS ±${Math.round(fix.acc)} m`;
    // Where to walk right now: the point ~12 m further along the path. The glasses rotate their arrow by
    // (this bearing − the way the wearer's head faces), so it points the real direction to go.
    const aheadAlong = Math.min(total, along + 12);
    let j = seg;
    while (j < o.line.length - 2 && o.cum[j + 1] < aheadAlong) j++;
    const segLen = o.cum[j + 1] - o.cum[j] || 1;
    const tt = Math.max(0, Math.min(1, (aheadAlong - o.cum[j]) / segLen));
    const aheadPt = { lat: o.line[j].lat + (o.line[j + 1].lat - o.line[j].lat) * tt, lon: o.line[j].lon + (o.line[j + 1].lon - o.line[j].lon) * tt };
    const here = { lat: o.line[seg].lat + (o.line[seg + 1].lat - o.line[seg].lat) * segT, lon: o.line[seg].lon + (o.line[seg + 1].lon - o.line[seg].lon) * segT };
    const routeBearing = bearing(here, aheadPt);
    o.routeBearing = routeBearing; // for "I'm facing the right way" calibration

    // Facing the wrong way? (GPS course while walking, compass while standing.) Hysteresis: warn past 60°/130°,
    // clear once within 40° of the route.
    const face = outdoorFacing();
    const rel = face ? ((routeBearing - face.deg + 540) % 360) - 180 : null;
    let wrong = o.wrong ?? null;
    if (rel == null) wrong = null;
    else if (Math.abs(rel) >= 130) wrong = "around";
    else if (Math.abs(rel) >= 60) wrong = rel > 0 ? "right" : "left";
    else if (Math.abs(rel) < 40) wrong = null;
    else if (wrong === "around") wrong = rel > 0 ? "right" : "left"; // 40–60°: keep warning, but as a turn
    if (wrong) {
      const then = `then ${view.instruction.toLowerCase()}${view.detail ? " " + view.detail : ""}`;
      view = wrong === "around"
        ? { arrow: "back", instruction: "TURN AROUND", detail: short(`You're facing the wrong way, ${then}`, 60) }
        : { arrow: wrong, instruction: wrong === "right" ? "TURN RIGHT" : "TURN LEFT", detail: short(`to face your route, ${then}`, 60) };
    }
    if (wrong !== (o.wrong ?? null)) {
      speak = wrong === "around" ? "You're facing the wrong way. Turn around."
        : wrong ? `Turn ${wrong} to face your route.`
        : `That's it. ${view.instruction.toLowerCase()}${view.detail ? " " + view.detail : ""}.`;
    }
    o.wrong = wrong; o.view = view;
    emit("gps", `${onlyArrivalLeft ? "Arrive in" : "In"} ${exactDist(d)} m · ${gps}`, {
      speak,
      navExtra: { phase: "guiding", facing: face, routeBearing: Math.round(routeBearing), wrongWay: wrong },
      dist: { distM: d, speed: fix.speed ?? 0, acc: fix.acc, toGoM: toGo, aheadBearing: Math.round(routeBearing) },
      phoneDetail: `${view.instruction} ${view.detail} in ${exactDist(d)} m. ${exactDist(toGo)} m to ${o.to.name}.`,
    });
  }

  // Set the current checkpoint and start the outdoor leg that hangs off it, if any.
  function enterCheckpoint(j) {
    s.index = j;
    s.offRoute = null;
    s.outdoor = null;
    const c = cp(j);
    if (c?.walkTo) return startOutdoor(c, j + 1);
    if (j === route().checkpoints.length - 1) {
      s.done = true;
      s.endedAt = Date.now();
    }
  }

  // Blend the last few GPS readings: newer and more accurate readings count more. Cuts jitter without
  // lagging much (readings older than ~3 s fade out).
  const recent = [];
  function smooth(fix) {
    // Age by when the phone measured the fix (Safari pos.timestamp) when we have it, else by arrival time.
    const now = Number.isFinite(fix.sampleAt) ? fix.sampleAt : Date.now();
    if (recent.length && now < recent[recent.length - 1].ts) recent.length = 0; // clock source changed: start over
    recent.push({ ...fix, ts: now });
    while (recent.length && now - recent[0].ts > 4000) recent.shift();
    let wsum = 0, lat = 0, lon = 0;
    for (const r of recent) {
      const w = Math.exp(-(now - r.ts) / 1500) / Math.max(3, r.acc ?? 30) ** 2;
      wsum += w; lat += w * r.lat; lon += w * r.lon;
    }
    // Accuracy: consecutive GPS errors are correlated, so averaging doesn't shrink them by √n. Report the
    // (weighted) typical accuracy, never better than the newest reading claims.
    let accSum = 0;
    for (const r of recent) accSum += (Math.exp(-(now - r.ts) / 1500) / Math.max(3, r.acc ?? 30) ** 2) * (r.acc ?? 30);
    const acc = Math.max(fix.acc ?? 50, accSum / wsum);
    // Walking speed: the phone's own reading if it has one; else from displacement, but only when the move is
    // bigger than the GPS noise (otherwise standing still would count down metres).
    let speed = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : 0;
    if (!speed && recent.length > 1) {
      const a = recent[0], b = recent[recent.length - 1], moved = dist(a, b);
      if (b.ts > a.ts && moved > 2 * Math.max(a.acc ?? 30, b.acc ?? 30)) speed = Math.min(2.5, moved / ((b.ts - a.ts) / 1000));
    }
    return { lat: lat / wsum, lon: lon / wsum, acc: Math.max(3, Math.round(acc)), speed, ts: Date.now() };
  }

  // The phone re-sends its latest reading every second as a heartbeat. Only NEW readings may feed smoothing
  // and the indoor→outdoor counter: with sampleAt (Safari pos.timestamp) a repeat or older stamp is a copy;
  // old clients without it: an exact repeat of lat/lon/acc within 10 s.
  let lastSample = null;
  function isRepeat(raw) {
    const now = Date.now();
    if (Number.isFinite(raw.sampleAt)) {
      if (lastSample?.sampleAt != null && raw.sampleAt <= lastSample.sampleAt) return true;
    } else if (lastSample && raw.lat === lastSample.lat && raw.lon === lastSample.lon && raw.acc === lastSample.acc && now - lastSample.at < 10000) {
      return true;
    }
    lastSample = { sampleAt: Number.isFinite(raw.sampleAt) ? raw.sampleAt : null, lat: raw.lat, lon: raw.lon, acc: raw.acc, at: now };
    return false;
  }

  let acceptedSample = null, jumpCandidate = null;
  // Outdoors: which way they actually walk (GPS course) is the truth; it also calibrates the glasses compass for
  // outdoors (the indoor plaque offset is for indoors: steel shifts the magnetometer differently there).
  let courseRef = null, course = null; // course = { deg, ts }
  const outCal = { errs: [], offset: 0, n: 0 };
  function noteCourse(fix) {
    if (!fix || fix.acc > 20) return;
    if (!courseRef) { courseRef = fix; return; }
    const moved = dist(courseRef, fix);
    if (moved > 40) { courseRef = fix; return; } // a jump, not a walk
    if (moved < 6) return;
    course = { deg: bearing(courseRef, fix), ts: Date.now() };
    courseRef = fix;
    const raw = heading && Date.now() - heading.ts < 3000 ? heading.deg : null;
    if (raw != null) {
      const err = ((course.deg - raw + 540) % 360) - 180;
      outCal.errs = [...outCal.errs, err].slice(-9);
      const ref = outCal.errs[0];
      const rel = outCal.errs.map((e) => ((e - ref + 540) % 360) - 180).sort((a, b) => a - b);
      outCal.offset = ((ref + rel[Math.floor(rel.length / 2)] + 540) % 360) - 180;
      outCal.n += 1;
    }
  }
  // Which way they face outdoors, and how we know: walking → GPS course; standing → compass (calibrated by
  // walking if we have it, else by the last door plaque, else raw).
  // Phone compass (iPhone, far steadier than the M6 magnetometer): the true direction. Blended with the glasses
  // compass as a slowly-updated offset, so the glasses still follow quick head turns but stay anchored to the phone.
  let phone = null; // { deg, ts } true heading from the phone
  let phoneTrim = 0; // user correction from "I'm facing the right way"
  const phoneCal = { offset: 0, ts: 0 };
  const phoneFresh = () => phone && Date.now() - phone.ts < 4000;
  const phoneCalFresh = () => phoneFresh() && Date.now() - phoneCal.ts < 4000;
  function setPhoneHeading(h) {
    if (!Number.isFinite(h)) return { ok: false };
    const now = Date.now();
    phone = { deg: (((h + phoneTrim) % 360) + 360) % 360, ts: now };
    if (heading && now - heading.ts < 1500) {
      const err = ((phone.deg - heading.deg + 540) % 360) - 180;
      phoneCal.offset = now - phoneCal.ts < 4000 ? phoneCal.offset + 0.1 * (((err - phoneCal.offset + 540) % 360) - 180) : err;
      phoneCal.ts = now;
    }
    const o = s && !s.done ? s.outdoor : null;
    if (o && o.steps?.length && !o.routing && lastFix && now - (o.evalAt ?? 0) > 1200) updateOutdoor(lastFix);
    return { ok: true, offset: Math.round(phoneCal.offset) };
  }
  // ---------- indoor dead reckoning: real steps from the phone's motion sensor move the dot along the plan ----------
  // Between recognised places (room plaques, signs) the dot walks along the hallway the way they face, snapped
  // to the plan's corridors. Each new confirmed place snaps it back and teaches the stride (plan px per step).
  const stride = { px: 7, n: 0 }; // prior ≈ 0.7 m step at ≈10 px/m on City Tech's plan; learned from walks
  function trueFacingNow() {
    if (phoneFresh() && !(heading && Date.now() - heading.ts < 4000)) return phone.deg;
    if (heading && Date.now() - heading.ts < 4000) return norm360(heading.deg + indoorOffset());
    return phoneFresh() ? phone.deg : null;
  }
  function addSteps(n) {
    const R = s && !s.done ? s.room : null;
    const m = R?.target.model;
    if (!R || !m || !R.at || s.outdoor || !(n > 0)) return { ok: true, ignored: true };
    // (Re)start from the confirmed place; a door is a leaf off the hallway: start in the hallway in front of it.
    if (!R.est || R.est.anchor !== R.at) {
      const startNode = m.byId[R.at].kind === "door" ? (m.adj[R.at].map((e) => m.byId[e.to]).find((x) => x.kind === "corridor")?.id ?? R.at) : R.at;
      R.est = { anchor: R.at, a: startNode, b: null, d: 0, steps: 0 };
    }
    const f = trueFacingNow();
    R.est.steps += n;
    if (f == null) return { ok: true, noHeading: true };
    let px = n * stride.px, guard = 0;
    const E = R.est;
    while (px > 0 && guard++ < 20) {
      if (!E.b) {
        // At a node: take the hallway that best matches the way they face (within 60°), never a door/lift hop.
        let best = null;
        for (const e of m.adj[E.a] ?? []) {
          const to = m.byId[e.to];
          if (to.floor !== m.byId[E.a].floor || to.kind === "door") continue;
          const diff = Math.abs(indoor.turnAngle(f, indoor.planBearing(m, E.a, e.to)));
          if (diff <= 60 && (!best || diff < best.diff)) best = { to: e.to, diff };
        }
        if (!best) break; // turning or facing a wall: hold
        E.b = best.to; E.d = 0;
      }
      const A = m.byId[E.a], Bn = m.byId[E.b], len = Math.hypot(A.x - Bn.x, A.y - Bn.y) || 1;
      if (Math.abs(indoor.turnAngle(f, indoor.planBearing(m, E.a, E.b))) > 120) { [E.a, E.b] = [E.b, E.a]; E.d = len - E.d; } // walked back
      E.d += px; px = 0;
      if (E.d >= len) { px = E.d - len; E.a = E.b; E.b = null; E.d = 0; }
    }
    return { ok: true, steps: E.steps };
  }
  function estPosition(m, R) {
    const E = R?.est;
    if (!E || E.anchor !== R.at || !E.steps) return null;
    const A = m.byId[E.a];
    if (!E.b) return { x: A.x, y: A.y, steps: E.steps };
    const B = m.byId[E.b], len = Math.hypot(A.x - B.x, A.y - B.y) || 1, t = Math.min(1, E.d / len);
    return { x: Math.round(A.x + (B.x - A.x) * t), y: Math.round(A.y + (B.y - A.y) * t), steps: E.steps };
  }
  // A new place confirmed after walking from the last one: plan distance / steps = their stride.
  function learnStride(m, R, fromId, toId) {
    const steps = R.est?.anchor === fromId ? R.est.steps : 0;
    if (steps < 8) return;
    const d = indoor.dijkstra(m, fromId).dist[toId];
    if (!Number.isFinite(d) || d < 60) return;
    const px = Math.max(4, Math.min(14, d / steps));
    stride.px = stride.n === 0 ? px : stride.px * 0.6 + px * 0.4;
    stride.n += 1;
    console.log(`[steps] ${steps} steps ${fromId}→${toId} (${Math.round(d)} px) → stride ${stride.px.toFixed(1)} px (n=${stride.n})`);
  }

  // "I'm facing the right way": the wearer confirms they face along the route right now. That's ground truth:
  // correct whichever compass is in charge so this direction reads as straight.
  function alignHeading() {
    if (!s || s.done) return { ok: false, error: "Start a trip first" };
    let want = null;
    if (s.outdoor) want = Number.isFinite(s.outdoor.routeBearing) ? s.outdoor.routeBearing : null;
    else if (s.room?.target.model && s.room.at) {
      const g = indoor.guide(s.room.target.model, s.room.at, s.room.target.nodes, null);
      want = g && !g.arrived && Number.isFinite(g.bearing) ? g.bearing : null;
    }
    if (want == null) return { ok: false, error: "No route direction yet: get placed first (look at a room number) or wait for GPS" };
    const now = Date.now();
    const glassesFresh = heading && now - heading.ts < 4000;
    let what;
    if (phoneCalFresh() || (phoneFresh() && !glassesFresh)) {
      const cur = phoneCalFresh() && glassesFresh ? norm360(heading.deg + phoneCal.offset) : phone.deg;
      const adj = indoor.turnAngle(cur, want);
      phoneTrim = indoor.turnAngle(0, norm360(phoneTrim + adj));
      phone.deg = norm360(phone.deg + adj); phoneCal.offset = indoor.turnAngle(0, norm360(phoneCal.offset + adj));
      what = "phone compass";
    } else if (glassesFresh) {
      const off = indoor.turnAngle(heading.deg, want);
      if (s.outdoor) { outCal.errs = [off, off, off]; outCal.offset = off; outCal.n = Math.max(outCal.n, 3); }
      else { cal.offset = off; cal.errs = [off]; cal.n = Math.max(cal.n, 1); cal.pending = null; cal.lastDoor = null; }
      what = "glasses compass";
    } else return { ok: false, error: "No compass reading right now" };
    if (s.room) s.room.lock = null;
    console.log(`[compass] aligned by wearer: route ${Math.round(want)}° → ${what} corrected`);
    if (s.outdoor && lastFix) updateOutdoor(lastFix);
    return { ok: true, route: Math.round(want), corrected: what };
  }

  function indoorOffset() { return phoneCalFresh() ? phoneCal.offset : cal.offset; }
  function outdoorOffset() { return phoneCalFresh() ? phoneCal.offset : outCal.n >= 3 ? outCal.offset : cal.n > 0 ? cal.offset : 0; }
  function outdoorFacing() {
    if (course && Date.now() - course.ts < 4000) return { deg: Math.round(course.deg), src: "walking direction (GPS)", sure: true };
    if (phoneFresh() && !(heading && Date.now() - heading.ts < 4000)) return { deg: Math.round(phone.deg), src: "phone compass", sure: true };
    if (phoneCalFresh() && heading) return { deg: Math.round(((heading.deg + phoneCal.offset) % 360 + 360) % 360), src: "phone compass (glasses for head turns)", sure: true };
    if (!heading || Date.now() - heading.ts > 4000) return null;
    const src = outCal.n >= 3 ? "compass, calibrated by walking" : cal.n > 0 ? "compass, calibrated by a door sign" : "compass, not calibrated";
    return { deg: Math.round(((heading.deg + outdoorOffset()) % 360 + 360) % 360), src, sure: outCal.n >= 3 };
  }
  function location(raw) {
    const now = Date.now();
    const sample = { ...raw, acc: Number.isFinite(raw.acc) && raw.acc > 0 ? raw.acc : 50, sampleAt: raw.sampleAt ?? now };
    if (now - sample.sampleAt >= 10000) return { ok: true, ignored: "stale" };
    if (isRepeat(raw)) return { ok: true, duplicate: true };
    if (acceptedSample) {
      const elapsed = (sample.sampleAt - acceptedSample.sampleAt) / 1000;
      const plausible = Math.max(18, Math.hypot(acceptedSample.acc, sample.acc)) + Math.max(0, elapsed) * 4;
      if (dist(acceptedSample, sample) > plausible) {
        const confirmsJump = jumpCandidate && sample.sampleAt - jumpCandidate.sampleAt <= 10000
          && dist(jumpCandidate, sample) <= Math.max(18, Math.hypot(jumpCandidate.acc, sample.acc));
        if (!confirmsJump) {
          jumpCandidate = sample;
          return { ok: true, ignored: "jump" };
        }
        recent.length = 0;
      }
    }
    jumpCandidate = null;
    acceptedSample = sample;
    lastFix = { ...smooth(sample), sampleAt: sample.sampleAt };
    noteCourse(lastFix);
    if (!s || s.done) return { ok: true };
    s.fix = lastFix;
    if (s.outdoor) {
      updateOutdoor(s.fix);
    } else if (((s.plan && s.plan.outdoorDest) || (s.room && s.room.outdoorDest && !s.room.done)) && s.fix.acc <= 15) {
      s.goodFixes = (s.goodFixes ?? 0) + 1;
      if (s.goodFixes >= 2) leavePlanForOutdoor("Outside detected (GPS)");
    } else if (!s.offRoute && s.fix.acc <= 15) {
      // GPS is poor indoors; two sharp fixes in a row while on an indoor leg ⇒ you've walked outside.
      const exitIdx = route().checkpoints.findIndex((c, i) => i > s.index && c.walkTo);
      s.goodFixes = (s.goodFixes ?? 0) + 1;
      if (exitIdx >= 0 && s.goodFixes >= 2) {
        s.history.push({ ts: Date.now(), result: "outside-gps", label: "Outside detected", confidence: "gps", ms: 0 });
        enterCheckpoint(exitIdx);
      }
    } else {
      s.goodFixes = 0;
    }
    return { ok: true };
  }

  // ---------- trip control ----------

  async function start({ routeId, destination, planId, place, room, exit } = {}) {
    if (rec) throw Object.assign(new Error("finish or cancel the recording first"), { status: 409 });
    let r, plan = null, roomTrip = null;
    if (room || exit) {
      // "where": no destination, just keep locating the wearer on the plan (walk test / live dot on /where).
      const target = /^\s*(where( am i)?|track|locate)\s*\??\s*$/i.test(room ?? "") && models[0]
        ? { kind: "track", label: "Where am I", model: models[0], nodes: [] }
        : indoor.resolveTarget(room, models, { exit: Boolean(exit) });
      if (!target) throw Object.assign(new Error("Type a room number like A103, or exit / bathroom / elevator / stairs"), { status: 400 });
      // A room in a planned building but on a floor the plan doesn't cover: use the plan to reach the lifts.
      if (target.kind === "room" && !target.model && target.room.floor !== 1) {
        const m = models.find((mm) => mm.building === target.room.bldg);
        if (m) Object.assign(target, { model: m, nodes: target.room.floor === 2 ? ["escalator", "elevators"] : ["elevators"], viaLift: true });
      }
      roomTrip = { target, outdoorDest: destination ?? null, last: null, done: false, at: null, mem: { inc: {} } };
      r = { id: "_room", name: `${target.label}${destination ? ` → ${destination.name}` : ""}`, destination: destination?.name ?? target.label, room: true, checkpoints: [], offRoute: [] };
    } else if (planId) {
      const meta = (await listPlans()).find((p) => p.id === planId);
      const image = meta && (await planImage(planId));
      if (!image) throw Object.assign(new Error("floor plan not found"), { status: 400 });
      if (!place) throw Object.assign(new Error("pick where you're going in the building"), { status: 400 });
      plan = { id: planId, image, target: place, outdoorDest: destination ?? null, last: null, done: false };
      r = { id: "_plan", name: `${place}${destination ? ` → ${destination.name}` : ""}`, destination: destination?.name ?? place, plan: true, checkpoints: [], offRoute: [] };
    } else if (routeId) {
      const found = (await loadRoutes()).find((x) => x.id === routeId);
      if (!found) throw Object.assign(new Error(`unknown route ${routeId}`), { status: 400 });
      r = structuredClone(found);
      if (destination && !r.checkpoints.some((c) => c.walkTo)) {
        r.checkpoints[r.checkpoints.length - 1].walkTo = { ...destination, arriveRadius: 30 };
        r.destination = destination.name;
      }
    } else if (destination) {
      r = {
        id: "_outdoor",
        name: `To ${destination.name}`,
        destination: destination.name,
        outdoorOnly: true,
        checkpoints: [{ id: "_here", mode: "outdoor", label: "Your location", arrow: "straight", instruction: "WALK", detail: "", walkTo: { ...destination, arriveRadius: 30 } }],
        offRoute: [],
      };
    } else throw Object.assign(new Error("pick a destination or a recorded route"), { status: 400 });

    s = { route: r, plan, planView: null, room: roomTrip, roomView: null, index: -1, offRoute: null, outdoor: null, fix: lastFix && Date.now() - lastFix.ts < 60000 ? lastFix : null, wrongTurns: 0, history: [], frames: [], startedAt: Date.now(), endedAt: null, done: false, lastCard: null, finalView: null };
    if (roomTrip) emit("unknown", roomTrip.target.model ? "Finding you on the City Tech plan" : "Look at a room number", {
      speak: `Finding ${roomTrip.target.label}. Look around: room numbers, turnstiles or elevators.`,
      navExtra: { phase: "looking", target: roomTrip.target.label },
    });
    else if (plan) emit("unknown", "Locating you on the floor plan", { speak: `Heading to ${place}. Look around; I'll find you on the floor plan.` });
    else if (r.outdoorOnly) enterCheckpoint(0);
    else emit("unknown", "Tap at a sign to verify", { speak: `Navigation started. Find the ${cp(0).label} sign and tap to verify.` });
    return state();
  }

  function stop() {
    if (s && !s.done) {
      s.done = true;
      if (s.room) s.room.done = true;
      if (s.plan) s.plan.done = true;
      s.endedAt = Date.now();
      s.outdoor = null;
      broadcast({ title: "NAVIQ", lines: ["Trip ended", "Review on your phone"], speak: "", phone_detail: "" });
    }
    return state();
  }

  function step(dir) {
    if (!s || s.done) throw Object.assign(new Error("no active trip"), { status: 409 });
    if (route().outdoorOnly || route().plan || route().room) throw Object.assign(new Error("this trip is guided automatically"), { status: 400 });
    const total = route().checkpoints.length;
    const prevMode = s.outdoor ? "outdoor" : s.index >= 0 ? cp(s.index).mode : null;
    const j = Math.max(-1, Math.min(total - 1, s.index + (dir === "back" ? -1 : 1)));
    s.history.push({ ts: Date.now(), result: "manual", label: j >= 0 ? cp(j).label : "start", dir });
    if (j < 0) { s.index = -1; s.offRoute = null; s.outdoor = null; } else enterCheckpoint(j);
    if (s.outdoor) return { card: s.lastCard, state: state() };
    const c = j >= 0 ? cp(j) : null;
    return {
      card: emit(s.done ? "arrived" : "manual", s.done ? `Arrived: ${c.label}` : "Manual step, not verified", {
        modeChanged: Boolean(c && prevMode && c.mode !== prevMode),
        speak: c ? `${c.instruction}. ${c.detail}` : "",
      }),
      state: state(),
    };
  }

  function leavePlanForOutdoor(why) {
    const dest = s.plan?.outdoorDest ?? s.room?.outdoorDest;
    if (s.plan) s.plan.done = true;
    if (s.room) s.room.done = true;
    s.history.push({ ts: Date.now(), result: "outside-gps", label: why, confidence: "gps", ms: 0 });
    startOutdoor({ walkTo: { ...dest, arriveRadius: 30 } }, Infinity);
  }

  // ---------- indoor: live camera + glasses compass, routed on the real plan when we have one ----------
  // Every frame: the vision model reports what it can read/see; this code locates the wearer (room plaque or a
  // recognised place → plan node), routes on the plan, and turns the next leg into left/right/straight using the
  // compass. Without a plan for the target it falls back to room-number logic plus compass memory.
  const POS_OFFSET = { left: -30, center: 0, right: 30 }; // where something sits in frame → degrees off the head
  const DIR_OFFSET = { left: -90, right: 90, ahead: 0, behind: 180 };
  const TARGET_PLACE = { exit: ["exit_doors"], restroom: ["restroom"], elevator: ["elevators"], escalator: ["escalator"], stairs: ["stairs"] };
  const SHORT_NAME = { exit: "EXIT", restroom: "BATHROOMS", elevator: "ELEVATORS", escalator: "ESCALATOR", stairs: "STAIRS", theater: "THEATER" };
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const posWords = (pos) => pos === "center" ? "ahead" : pos === "back" ? "behind you" : `on your ${pos}`;
  const posLabel = (pos) => pos === "center" ? "AHEAD" : pos === "back" ? "BEHIND" : pos.toUpperCase();
  const relativePosition = (facing, bearing, fallback) => {
    if (facing == null || bearing == null) return fallback;
    const angle = indoor.turnAngle(facing, bearing);
    return Math.abs(angle) < 23 ? "center" : Math.abs(angle) >= 135 ? "back" : angle > 0 ? "right" : "left";
  };

  function acceptIndoorAnchor(model, R, anchor) {
    if (!anchor || anchor.id === R.at || (!R.at && anchor.via === "room")) {
      R.anchorCandidate = null;
      return Boolean(anchor);
    }
    const now = Date.now();
    const last = R.anchorCandidate;
    const count = last?.id === anchor.id && now - last.ts <= 8000 ? last.count + 1 : 1;
    R.anchorCandidate = { id: anchor.id, count, ts: now };
    const distance = R.at ? indoor.dijkstra(model, R.at).dist[anchor.id] ?? Infinity : 0;
    const nearby = distance <= 180 && (R.floor == null || anchor.floor === R.floor);
    const required = nearby && (anchor.via === "room" || !R.at || R.path?.slice(1, 4).includes(anchor.id)) ? 2 : 3;
    if (count < required) return false;
    R.anchorCandidate = null;
    return true;
  }

  async function indoorObserve(image, captureHeading) {
    inflight += 1;
    const trip = s, R = s.room;
    const seq = (R.seq = (R.seq ?? 0) + 1);
    const frame = s.frames.push(image) - 1;
    if (s.frames.length > MAX_FRAMES) s.frames[s.frames.length - MAX_FRAMES - 1] = null;
    const rawFrame = captureHeading === undefined ? rawHeadingNow()
      : Number.isFinite(captureHeading) ? norm360(captureHeading) : null;
    const t0 = Date.now();
    let v;
    try {
      // The target is deliberately NOT in the prompt, so the model can't "see" what it's told to expect.
      v = await askJSON({ system: ROOM_READ_SYSTEM, prompt: "What room numbers, signs and places are visible?", image, schema: READ_SCHEMA, name: "indoor_read", scene: true });
    } catch (err) {
      if (s === trip && !s.done && !s.outdoor && seq >= (R.applied ?? 0)) {
        R.applied = seq;
        R.anchorCandidate = null;
        s.history.push({ ts: Date.now(), result: "error", label: err.message, frame });
        emit("unknown", `AI error: ${err.message}`.slice(0, 40), { navExtra: { phase: "looking" } });
      }
      throw err;
    } finally {
      inflight -= 1;
    }
    // A newer frame already answered (or the trip changed): drop this stale answer.
    if (s !== trip || s.done || s.outdoor || R.done || seq < (R.applied ?? 0)) return { busy: true, stale: true };
    R.applied = seq;
    const t = R.target;
    const ms = Date.now() - t0;
    const seen = v.rooms.map((r) => ({ ...indoor.parseRoom(r.label), position: r.position })).filter((r) => r.label);
    const seenOut = v.rooms.map((r) => ({ label: r.label, position: r.position }));
    live.read = v; live.ts = Date.now();
    const entry = {
      ts: Date.now(), frame, ms,
      sign_text: [...seen.map((r) => r.label), ...v.places.map((p) => p.kind.replace("_", " "))].join(", "),
      confidence: seen.length || v.places.length ? "high" : "low",
    };
    const finish = (card) => { s.history.push(entry); live.view = card.nav; return { read: v, ms, card, state: state() }; };

    // Update position from close visual evidence, independently of which way the head faces.
    if (t.model) {
      const a = indoor.anchorFromRead(t.model, v, R.at, R.floor ?? null);
      if (acceptIndoorAnchor(t.model, R, a)) {
        if (a.id !== R.at) {
          R.ambiguous = a.ambiguous;
          R.path = indoor.shortestPath(t.model, a.id, t.nodes);
          if (R.near) {
            const distances = indoor.dijkstra(t.model, a.id).dist;
            if (!t.nodes.some((id) => (distances[id] ?? Infinity) <= 180)) R.near = null;
          }
        } else if (!a.ambiguous) R.ambiguous = null;
        R.at = a.id; R.atLabel = a.label;
        R.seenTs = Date.now();
        if (a.via === "room" || a.floorUnique) R.floor = a.floor;
        if (a.via === "room" && !a.ambiguous && a.position === "center" && rawFrame != null) {
          const corr = t.model.adj[a.id].map((e) => t.model.byId[e.to]).find((n) => n.kind === "corridor");
          if (corr) calibrateFrom(indoor.planBearing(t.model, corr.id, a.id), a.id, rawFrame);
        }
      }
    }
    // A close room plaque that's on the plan tells us which way they face from the camera alone (they're looking
    // at that door; plaque left/right of centre shifts it). The glasses magnetometer can be off by 150°+ indoors,
    // so this beats the compass whenever a plaque is in view, and it calibrates the compass for later frames.
    let visionFacing = null;
    if (t.model) {
      for (const r of v.rooms.filter((x) => x.close)) {
        const p = indoor.parseRoom(r.label);
        const doors = p ? t.model.nodes.filter((n) => n.kind === "door" && n.room === p.label) : [];
        const dirs = doors.map((d) => { const c = t.model.adj[d.id].map((e) => t.model.byId[e.to]).find((n) => n.kind === "corridor"); return c ? indoor.planBearing(t.model, c.id, d.id) : null; }).filter((b) => b != null);
        if (!dirs.length || dirs.some((b) => Math.abs(indoor.turnAngle(dirs[0], b)) > 20)) continue; // doors facing different ways: can't tell
        visionFacing = norm360(dirs[0] - POS_OFFSET[r.position]);
        if (rawFrame != null) calibrateFrom(visionFacing, doors[0].id, rawFrame);
        break;
      }
    }
    const h = visionFacing ?? (rawFrame != null ? norm360(rawFrame + indoorOffset()) : phoneFresh() ? phone.deg : null);
    const latestRaw = rawHeadingNow();
    // Head turned since the frame was taken? Carry the vision heading forward by the compass's relative change.
    const facing = visionFacing != null
      ? (latestRaw != null && rawFrame != null ? norm360(visionFacing + indoor.turnAngle(rawFrame, latestRaw)) : visionFacing)
      : latestRaw == null ? (phoneFresh() ? phone.deg : h) : norm360(latestRaw + indoorOffset());
    const seenBearing = (pos) => h != null ? norm360(h + POS_OFFSET[pos]) : null;

    // Remember where places were seen as compass bearings, to keep pointing after they leave the frame.
    if (h != null) for (const p of v.places) R.mem[p.kind] = { bearing: seenBearing(p.position), ts: Date.now(), cue: p.cue };

    // Every indoor trip (not only "where"): keep the trail of confirmed places for the live map.
    R.trail ??= [];
    if (t.model && R.at && !R.ambiguous && R.trail.at(-1)?.id !== R.at) {
      if (R.trail.length) learnStride(t.model, R, R.trail.at(-1).id, R.at);
      R.trail.push({ id: R.at, ts: R.seenTs ?? Date.now() });
    }

    // Tracking only (no destination): report where we've placed them, keep a trail for the /where map.
    if (t.kind === "track") {
      R.trail ??= [];
      if (R.at && !R.ambiguous && R.trail.at(-1)?.id !== R.at) R.trail.push({ id: R.at, ts: R.seenTs });
      const where = R.atLabel?.replace(/^the /i, "");
      const compass = facing == null ? null : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(facing / 45) % 8];
      const ago = R.seenTs ? Math.round((Date.now() - R.seenTs) / 1000) : null;
      const view = where
        ? { arrow: "arrive", instruction: short(`NEAR ${where.toUpperCase()}`, 18), detail: [compass && `facing ${compass}`, ago != null && (ago < 3 ? "seen now" : `seen ${ago}s ago`)].filter(Boolean).join(" · ") }
        : { arrow: "scan", instruction: "WHERE AM I?", detail: "Look at a room number or the turnstiles" };
      const key = `track|${R.at ?? ""}`;
      let say = "";
      if (where && key !== R.spokenKey) { say = `You're near ${where}.`; R.spokenKey = key; R.spokenAt = Date.now(); }
      s.roomView = view;
      entry.result = where ? "located" : "unverified"; entry.label = where ?? (seen[0]?.label || "nothing recognised");
      return finish(emit(where ? "ok" : "unknown", where ? `Located: ${where}` : "Finding you on the City Tech plan", {
        speak: say, phoneDetail: where ? `Last matched near ${where}. ${view.detail}.` : "Look at a room number.",
        navExtra: { phase: where ? "tracking" : "looking", target: t.label, seen: seenOut },
      }));
    }

    // Walked outside?
    if (v.outdoors && R.outdoorDest) {
      entry.result = "outside-gps"; entry.label = "Outside (camera)";
      s.history.push(entry);
      leavePlanForOutdoor("Outside (camera)");
      return { read: v, ms, card: s.lastCard, state: state() };
    }
    const finalArrive = (detail, statusText, spoken) => {
      entry.result = "arrived"; entry.label = t.label;
      R.done = true; s.done = true; s.endedAt = Date.now();
      s.finalView = { mode: "indoor", arrow: "arrive", instruction: t.kind === "exit" ? "YOU'RE OUT" : "ARRIVED", detail };
      return finish(emit("arrived", statusText, { speak: spoken, navExtra: { phase: "arrived", target: t.label, seen: seenOut } }));
    };
    // Follow head turns for a short time after seeing the target, then reacquire it from the camera.
    const nearView = (detail, statusText, spoken, arrow, b) => {
      const key = `near|${detail}`;
      let say = "";
      if (key !== R.spokenKey || Date.now() - (R.spokenAt ?? 0) > 5000) {
        // The HUD skips a line identical to the last one it spoke: alternate a trailing space so repeats play.
        R.nearFlip = !R.nearFlip;
        say = spoken + (R.nearFlip ? " " : ""); R.spokenKey = key; R.spokenAt = Date.now();
      }
      s.roomView = { arrow, instruction: "ARRIVED", detail };
      return finish(emit("arrived", statusText, {
        speak: say, phoneDetail: `${statusText}. ${detail}.`,
        navExtra: { phase: "arrived", target: t.label, seen: seenOut, aheadBearing: b },
      }));
    };
    const arrive = (detail, statusText, spoken, pos = null, b = null) => {
      entry.result = "arrived"; entry.label = t.label;
      // First time they reach it: say so ("You've arrived. A103, ahead."), then keep repeating where it is.
      if (!R.arrivedSaid) { R.arrivedSaid = true; R.spokenKey = null; spoken = `You've arrived. ${spoken}`; }
      R.near = { ts: Date.now(), bearing: b ?? R.near?.bearing ?? null, detail };
      return nearView(detail, statusText, spoken, pos && pos !== "center" ? pos : "arrive", b);
    };
    if (t.kind === "exit" && v.outdoors) return finalArrive("Outside", "Out of the building", "You're outside.");
    let view = null, kind = "ok", phase = "guiding", status = "", bearingOut = null, spoken = "";

    // 1) The target itself is in view.
    const roomHit = t.room && v.rooms.filter((r) => indoor.parseRoom(r.label)?.label === t.room.label).sort((a, b) => b.close - a.close)[0];
    if (roomHit) {
      bearingOut = seenBearing(roomHit.position);
      const pos = relativePosition(facing, bearingOut, roomHit.position);
      if (roomHit.close) return arrive(`${t.room.label} ${posWords(pos)}`, `Found ${t.room.label}`, `${t.room.label}, ${posWords(pos)}.`, pos, bearingOut);
      view = { arrow: pos === "center" ? "straight" : pos, instruction: `${t.room.label} ${posLabel(pos)}`, detail: "Walk up to the door" };
      status = `${t.room.label} in view`; spoken = `${t.room.label} ${posWords(pos)}.`;
    }
    const placeHit = TARGET_PLACE[t.kind] && (t.kind !== "exit" || v.signs.some((sg) => sg.kind === "exit"))
      && v.places.filter((p) => TARGET_PLACE[t.kind].includes(p.kind)).sort((x, y) => y.close - x.close)[0];
    if (!view && placeHit) {
      bearingOut = seenBearing(placeHit.position);
      const pos = relativePosition(facing, bearingOut, placeHit.position);
      if (placeHit.close && t.kind !== "exit") {
        return arrive(`${t.label} ${posWords(pos)}`, `At the ${t.label.toLowerCase()}`, `${t.label}, ${posWords(pos)}.`, pos, bearingOut);
      }
      view = { arrow: pos === "center" ? "straight" : pos, instruction: `${SHORT_NAME[t.kind]} ${posLabel(pos)}`, detail: short(placeHit.cue || "Walk to it", 40) };
      status = `${t.label} in view`;
      spoken = `${t.label} ${posWords(pos)}.`;
    }

    // Already close and it slipped out of view: say where it is from the compass (or repeat the last words).
    if (R.near && Date.now() - R.near.ts > 30000) R.near = null;
    if (!view && R.near) {
      let side = null, arrow = "arrive";
      if (R.near.bearing != null && facing != null) {
        const rel = indoor.turnAngle(facing, R.near.bearing);
        if (Math.abs(rel) <= 30) side = "ahead";
        else if (Math.abs(rel) >= 135) { side = "behind you"; arrow = "back"; }
        else { side = rel > 0 ? "on your right" : "on your left"; arrow = rel > 0 ? "right" : "left"; }
      }
      const detail = side ? `${t.label} ${side}` : R.near.detail;
      return nearView(detail, `Near ${t.label}`, `${detail}.`, arrow, R.near.bearing);
    }

    // 2) Routed on the real building plan (City Tech Academic Complex).
    if (!view && t.model) {
      if (R.at) {
        let g = indoor.guide(t.model, R.at, t.nodes, facing, { prevArrow: s.roomView?.arrow ?? null });
        R.path = g?.path ?? null;
        // Leg lock: once they've faced along a straight stretch, keep saying GO STRAIGHT for it. Glancing at the
        // bathroom on your right, or the indoor compass drifting as you walk past steel, must not flip it to
        // "TURN LEFT". Only facing backwards for 4 s straight (a real turn-around) breaks the lock.
        if (g && !g.arrived && g.legKey) {
          if (R.lock && R.lock.legKey !== g.legKey) R.lock = null;
          if (!R.lock && Math.abs(g.rel) < 35) R.lock = { legKey: g.legKey, backSince: null };
          if (R.lock) {
            R.lock.backSince = Math.abs(g.rel) >= 140 ? R.lock.backSince ?? Date.now() : null;
            if (R.lock.backSince && Date.now() - R.lock.backSince > 4000) R.lock = null; // really turned around
            else {
              if (g.arrow !== "straight") g = { ...g, arrow: "straight", instruction: "GO STRAIGHT", spoken: `Go straight. ${g.detail}.` };
              g.locked = true; // the HUD shows a plain straight arrow (no drifting compass rotation)
            }
          }
        }
        if (g?.arrived && t.viaLift) {
          // At the lifts for a room on a floor the plan doesn't cover: send them up, then read room numbers there.
          const up = t.room.floor > 1;
          view = { arrow: up ? "up" : "down", instruction: up ? "GO UP" : "GO DOWN", detail: `to floor ${t.room.floor}, then find ${t.room.label}` };
          spoken = `Take the elevator to floor ${t.room.floor}, then look for ${t.room.label}.`;
          status = `At the ${t.model.byId[R.at].label?.toLowerCase() ?? "elevators"}`;
          R.target = { ...t, model: null, nodes: null, viaLift: false }; // next frames: room-number logic on that floor
          R.at = null;
        } else if (g?.arrived && t.kind === "exit") {
          view = { arrow: "scan", instruction: "GO OUTSIDE", detail: "Walk through the exit doors" };
          spoken = "Walk through the exit doors.";
          status = "At the exit";
        } else if (g?.arrived) {
          return arrive(t.label, `At ${t.label}`, `You're at ${t.label}.`);
        } else if (g) {
          const others = (R.ambiguous ?? []).filter((id) => id !== R.at).map((id) => indoor.guide(t.model, id, t.nodes, facing));
          if (others.some((o) => !o || o.arrived || o.bearing !== g.bearing)) {
            view = { arrow: "scan", instruction: "WHICH DOOR?", detail: short(`${R.atLabel} has 2 doors: face the next sign or door`, 42) };
            kind = "unknown"; phase = "looking"; status = `Near ${R.atLabel}`;
            spoken = `${R.atLabel} has two doors. Look at the next door or sign so I can place you.`;
          } else {
            view = { arrow: g.arrow, instruction: g.instruction, detail: short(g.detail, 42) };
            bearingOut = g.locked ? null : g.bearing;
            status = short(`Near ${R.atLabel}`, 40);
            spoken = g.spoken;
            if (g.floorHop) R.floor = null; // changing floors: re-confirm the floor from the next plaque
          }
        }
      }
    }

    // 3) No plan for this target (or not placed yet): room-number logic + signs + compass memory.
    if (!view) {
      const ref = seen.find((r) => r.position === "center") ?? [...seen].sort((x, y) => Math.abs(x.num - (t.room?.num ?? 0)) - Math.abs(y.num - (t.room?.num ?? 0)))[0];
      const signArrow = (kinds, test = () => true) => v.signs.find((sg) => kinds.includes(sg.kind) && sg.arrow !== "none" && test(sg))?.arrow ?? "none";
      const inRange = (sg) => {
        if (!t.room) return false;
        const nums = [...sg.text.toUpperCase().matchAll(/([A-Z]{1,2})?\s*-?\s*(\d{3,4})/g)].map((m) => ({ b: m[1], n: Number(m[2]) }));
        if (!nums.length || nums.some((x) => x.b && x.b !== t.room.bldg)) return false;
        const lo = Math.min(...nums.map((x) => x.n)), hi = Math.max(...nums.map((x) => x.n));
        return nums.length === 1 ? lo === t.room.num : t.room.num >= lo && t.room.num <= hi;
      };
      const remembered = (kinds) => kinds.map((k) => R.mem[k]).filter((m) => m && Date.now() - m.ts < 90000).sort((x, y) => y.ts - x.ts)[0];

      if (t.kind !== "room") {
        const sa = signArrow([{ exit: "exit", restroom: "restroom", elevator: "elevator", escalator: "elevator", stairs: "stairs" }[t.kind] ?? "other"]);
        const mem = TARGET_PLACE[t.kind] && remembered(TARGET_PLACE[t.kind]);
        if (sa !== "none") { view = { arrow: DIR_ARROW[sa], instruction: DIR_WORD[sa], detail: `Follow the ${t.label.toLowerCase()} sign` }; status = "Following a sign"; }
        else if (mem && h != null) {
          const w = indoor.relWords(indoor.turnAngle(h, mem.bearing));
          view = { arrow: w.arrow, instruction: w.word, detail: short(`${t.label} was this way${mem.cue ? ": " + mem.cue : ""}`, 42) };
          bearingOut = mem.bearing; status = `Remembered the ${t.label.toLowerCase()}`;
        }
      } else if (!ref) {
        const ta = signArrow(["room_range", "other"], inRange);
        if (ta !== "none") { view = { arrow: DIR_ARROW[ta], instruction: DIR_WORD[ta], detail: `Sign points to ${t.room.label}` }; status = "Following a sign"; }
      } else if (ref.bldg !== t.room.bldg) {
        view = { arrow: "scan", instruction: "OTHER BUILDING", detail: `${t.room.label} is in building ${t.room.bldg}` };
        status = `You're in building ${ref.bldg} (${ref.label})`; kind = "warn";
      } else if (ref.floor !== t.room.floor) {
        const up = t.room.floor > ref.floor, n = Math.abs(t.room.floor - ref.floor);
        const lift = v.places.find((p) => p.kind === "elevators") ?? v.places.find((p) => p.kind === "escalator") ?? v.places.find((p) => p.kind === "stairs");
        const la = signArrow(["elevator", "stairs"]);
        if (lift) {
          view = { arrow: lift.position === "center" ? "straight" : lift.position, instruction: `${lift.kind.toUpperCase()} ${lift.position === "center" ? "AHEAD" : lift.position.toUpperCase()}`, detail: `Go ${up ? "up" : "down"} to floor ${t.room.floor}` };
          if (h != null) bearingOut = norm360(h + POS_OFFSET[lift.position]);
        } else if (la !== "none") view = { arrow: DIR_ARROW[la], instruction: DIR_WORD[la], detail: `Sign to the ${up ? "upper" : "lower"} floors` };
        else view = { arrow: up ? "up" : "down", instruction: up ? "GO UPSTAIRS" : "GO DOWNSTAIRS", detail: `${n} floor${n > 1 ? "s" : ""}, to floor ${t.room.floor}` };
        status = `On floor ${ref.floor} (${ref.label})`;
      } else {
        // Same floor: which way do the numbers grow? From this frame, the compass memory, or the walking order.
        const fk = `${ref.bldg}${ref.floor}`;
        if (v.numbers_increase !== "unknown" && h != null) R.mem.inc[fk] = { bearing: norm360(h + DIR_OFFSET[v.numbers_increase]), ts: Date.now() };
        if (!R.mem.inc[fk] && R.last && R.last.floor === ref.floor && R.last.num !== ref.num && h != null && Date.now() - (R.lastTs ?? 0) < 60000 && Math.abs(ref.num - R.last.num) <= 20) {
          R.mem.inc[fk] = { bearing: norm360(ref.num > R.last.num ? h : h + 180), ts: Date.now(), fromWalking: true };
        }
        const doors = Math.max(1, Math.round(Math.abs(t.room.num - ref.num) / 2));
        const doorsTxt = `${t.room.label}: about ${doors} door${doors > 1 ? "s" : ""}`;
        const ta = signArrow(["room_range", "other"], inRange);
        const inc = R.mem.inc[fk];
        if (ta !== "none") view = { arrow: DIR_ARROW[ta], instruction: DIR_WORD[ta], detail: `Sign points to ${t.room.label}` };
        else if (v.numbers_increase !== "unknown") {
          const way = t.room.num > ref.num ? v.numbers_increase : OPPOSITE[v.numbers_increase];
          view = { arrow: DIR_ARROW[way], instruction: DIR_WORD[way], detail: doorsTxt };
          if (h != null) bearingOut = norm360(h + DIR_OFFSET[way]);
        } else if (inc && h != null && Date.now() - inc.ts < 180000) {
          const want = norm360(inc.bearing + (t.room.num > ref.num ? 0 : 180));
          const w = indoor.relWords(indoor.turnAngle(h, want));
          view = { arrow: w.arrow, instruction: w.word, detail: doorsTxt };
          bearingOut = want;
        } else if (R.last && R.last.floor === ref.floor && R.last.num !== ref.num) {
          const closer = Math.abs(t.room.num - ref.num) < Math.abs(t.room.num - R.last.num);
          view = closer ? { arrow: "straight", instruction: "KEEP GOING", detail: doorsTxt } : { arrow: "back", instruction: "TURN AROUND", detail: `Wrong way · ${doorsTxt}` };
          if (!closer) { s.wrongTurns += 1; entry.result = "wrong-turn"; }
        } else {
          view = { arrow: "scan", instruction: "WALK & LOOK", detail: `${t.room.label} is ${t.room.num < ref.num ? "lower" : "higher"} than ${ref.label}` };
          kind = "unknown";
        }
        status = `Seeing ${ref.label}`;
      }
      if (ref) { R.last = ref; R.lastTs = Date.now(); }
    }

    if (!view) {
      view = { arrow: "scan", instruction: "LOOK AROUND", detail: t.model ? "Face a room number or the turnstiles" : t.kind === "exit" ? "Turn to find doors outside" : t.kind === "room" ? "Face a room number" : `Look for ${t.label.toLowerCase()} signs` };
      kind = "unknown"; phase = "looking";
      status = t.model ? "Finding you on the City Tech plan" : `No ${t.kind === "room" ? "room number" : t.label.toLowerCase()} in view yet`;
    }

    // Speak only when the instruction changes (or every 15 s while it holds), not on every frame.
    const key = `${view.instruction}|${phase}`;
    let say = "";
    // Keep talking while they walk: say it when it changes, then repeat it every 6 s (every 12 s while still
    // looking for a first landmark). The HUD skips a line identical to its last one: alternate a trailing space.
    const repeatMs = phase === "looking" ? 12000 : 6000;
    if (key !== R.spokenKey || Date.now() - (R.spokenAt ?? 0) > repeatMs) {
      R.sayFlip = !R.sayFlip;
      say = (spoken || `${view.instruction.toLowerCase()}. ${view.detail}.`) + (R.sayFlip ? " " : "");
      R.spokenKey = key; R.spokenAt = Date.now();
    }
    entry.result = entry.result ?? (phase === "looking" ? "unverified" : "located");
    entry.label = entry.label ?? (R.atLabel ?? seen[0]?.label ?? (v.places[0]?.kind.replace("_", " ") || "nothing recognised"));
    s.roomView = view;
    return finish(emit(kind, status, {
      speak: say,
      phoneDetail: `${status}. ${view.instruction}: ${view.detail}.`,
      navExtra: { phase, target: t.label, seen: seenOut, aheadBearing: bearingOut },
    }));
  }

  async function planObserve(image) {
    busy = true;
    const frame = s.frames.push(image) - 1;
    if (s.frames.length > MAX_FRAMES) s.frames[s.frames.length - MAX_FRAMES - 1] = null;
    broadcast(buildCard("pending", "Finding you on the floor plan…"));
    const Guide = z.object({
      located: z.boolean(),
      location: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      seen_text: z.string(),
      arrow: z.enum(["left", "right", "straight", "back", "up", "down", "arrive"]),
      instruction: z.string(),
      detail: z.string(),
      arrived: z.boolean(),
      reason: z.string(),
    });
    const prompt = `Destination: ${s.plan.target}.\n${s.plan.last ? `Last known position: ${s.plan.last}.` : "No position yet."}`;
    const t0 = Date.now();
    let g;
    try {
      g = await askJSON({ system: PLAN_GUIDE_SYSTEM, prompt, images: [s.plan.image, image], schema: Guide, name: "floor_plan_step", effort: "plan" });
    } catch (err) {
      s.history.push({ ts: Date.now(), result: "error", label: err.message, frame });
      emit("unknown", `AI error: ${err.message}`.slice(0, 40));
      throw err;
    } finally {
      busy = false;
    }
    const ms = Date.now() - t0;
    const entry = { ts: Date.now(), frame, ms, confidence: g.confidence, sign_text: g.seen_text, reason: g.reason };
    let card;
    if (!g.located || g.confidence === "low") {
      entry.result = "unverified";
      entry.label = g.seen_text ? `read "${g.seen_text}"` : "couldn't place you";
      s.planView = { arrow: "scan", instruction: "LOOK AROUND", detail: g.detail || "Face a room number or sign" };
      card = emit("unknown", "Can't place you yet", { speak: `I can't place you yet. ${g.detail || "Face a room number."}`, phoneDetail: g.reason });
    } else if (g.arrived) {
      entry.result = "arrived";
      entry.label = s.plan.target;
      s.history.push(entry);
      if (s.plan.outdoorDest) {
        leavePlanForOutdoor(`At ${s.plan.target}`);
        return { guide: g, ms, card: s.lastCard, state: state() };
      }
      s.done = true;
      s.endedAt = Date.now();
      s.finalView = { mode: "indoor", arrow: "arrive", instruction: "ARRIVED", detail: s.plan.target };
      card = emit("arrived", `Arrived: ${s.plan.target}`, { speak: `You've arrived at ${s.plan.target}.` });
      return { guide: g, ms, card, state: state() };
    } else {
      entry.result = "located";
      entry.label = g.location;
      s.plan.last = g.location;
      s.planView = { arrow: g.arrow, instruction: g.instruction.toUpperCase().slice(0, 18), detail: g.detail };
      card = emit(g.confidence === "high" ? "ok" : "unknown", g.location.slice(0, 44), {
        speak: `${g.instruction}. ${g.detail}.`,
        phoneDetail: `${g.location}. ${g.reason}`,
      });
    }
    s.history.push(entry);
    return { guide: g, ms, card, state: state() };
  }

  async function observe(image, text = "", captureHeading) {
    if (!s || s.done) throw Object.assign(new Error("no active trip: start one on the phone"), { status: 409 });
    if (!image) throw Object.assign(new Error("no image"), { status: 400 });
    if (busy) return { busy: true };
    if (s.room && !s.room.done && !s.outdoor) {
      if (inflight >= 2) return { busy: true };
      return indoorObserve(image, captureHeading);
    }
    if (s.plan && !s.outdoor) return planObserve(image);
    const r = route();
    const known = [
      ...r.checkpoints.filter((c) => c.match).map((c) => ({ id: c.id, label: c.label, expect: c.expect })),
      ...(r.offRoute ?? []).map((o) => ({ id: o.id, label: o.label, expect: o.expect })),
    ];
    if (!known.length) throw Object.assign(new Error("this trip has no signs to verify; it follows GPS"), { status: 400 });
    busy = true;

    const frame = s.frames.push(image) - 1;
    if (s.frames.length > MAX_FRAMES) s.frames[s.frames.length - MAX_FRAMES - 1] = null;
    const keepKind = s.offRoute ? "warn" : s.outdoor ? "gps" : s.index < 0 ? "unknown" : "ok";
    broadcast(buildCard("pending", "Verifying sign…"));

    const Verdict = z.object({
      seen_id: z.enum([...known.map((k) => k.id), "none"]),
      confidence: z.enum(["high", "medium", "low"]),
      sign_text: z.string(),
      reason: z.string(),
    });
    const prompt = ["Known landmarks:", ...known.map((k) => `- id "${k.id}": ${k.label}. Looks like: ${k.expect}`), text ? `\nThe wearer said: "${text}"` : ""].join("\n");

    const t0 = Date.now();
    let v;
    try {
      v = await askJSON({ system: VERIFY_SYSTEM, prompt, image, schema: Verdict, name: "checkpoint_verdict" });
    } catch (err) {
      s.history.push({ ts: Date.now(), result: "error", label: err.message, frame });
      emit(keepKind === "ok" ? "unknown" : keepKind, `AI error: ${err.message}`.slice(0, 40));
      throw err;
    } finally {
      busy = false;
    }
    const ms = Date.now() - t0;

    // Hard rule: a landmark only counts if its sign words were actually read.
    const landmark = r.checkpoints.find((c) => c.id === v.seen_id) ?? (r.offRoute ?? []).find((o) => o.id === v.seen_id);
    if (landmark?.match?.length && !landmark.match.some((m) => norm(v.sign_text).includes(norm(m)))) {
      v.reason = `Looked like ${landmark.label} but its sign text wasn't readable. ${v.reason}`;
      v.seen_id = "none";
    }

    const entry = { ts: Date.now(), frame, ms, seen: v.seen_id, confidence: v.confidence, sign_text: v.sign_text, reason: v.reason };
    const prevMode = s.outdoor ? "outdoor" : s.index >= 0 ? cp(s.index).mode : null;
    const j = r.checkpoints.findIndex((c) => c.id === v.seen_id);
    const off = (r.offRoute ?? []).find((o) => o.id === v.seen_id);
    let card;

    if (v.seen_id === "none" || v.confidence === "low") {
      entry.result = "unverified";
      entry.label = v.sign_text ? `read "${v.sign_text}"` : "no sign";
      card = emit(keepKind === "ok" ? "unknown" : keepKind, "Can't verify. Get closer to a sign", {
        speak: "I can't verify where you are. Get closer to a sign.",
        phoneDetail: `Couldn't match a checkpoint. ${v.reason} Last confirmed: ${s.index >= 0 ? cp(s.index).label : "none yet"}.`,
      });
    } else if (off) {
      entry.result = "wrong-turn";
      entry.label = off.label;
      s.offRoute = off.id;
      s.wrongTurns += 1;
      card = emit("warn", `Saw ${off.label}: off route`, {
        speak: `Wrong way. ${off.recover}.`,
        phoneDetail: `You're at ${off.label}, which isn't on your route. ${off.recover}.`,
      });
    } else {
      const wasOff = Boolean(s.offRoute);
      const forward = j > s.index;
      enterCheckpoint(j);
      const c = cp(j);
      const modeChanged = Boolean(prevMode && (s.outdoor ? "outdoor" : c.mode) !== prevMode);
      entry.result = s.done ? "arrived" : wasOff ? "recovered" : forward ? "verified" : "re-verified";
      entry.label = c.label;
      const status = s.done ? `Arrived: ${c.label}` : wasOff ? `Back on route: ${c.label}` : `Verified: ${c.label}`;
      card = s.outdoor
        ? s.lastCard // outdoor leg just started; its card is already showing
        : emit(s.done ? "arrived" : "ok", status, {
            modeChanged,
            speak: s.done ? `You've arrived. ${c.instruction}. ${c.detail}` : `${modeChanged ? c.mode + " mode. " : ""}${c.instruction}. ${c.detail}`,
            phoneDetail: `${status} (read "${v.sign_text}", ${v.confidence} confidence). Next: ${c.instruction.toLowerCase()}${c.detail ? ", " + c.detail : ""}.`,
          });
    }
    s.history.push(entry);
    return { verdict: v, ms, card, state: state() };
  }

  // ---------- route recorder (how indoor routes get made: walk it once, tap at each real sign) ----------

  function recCard(statusText, kind = "unknown") {
    const card = {
      title: "RECORDING",
      lines: [rec.name, statusText],
      speak: "",
      phone_detail: statusText,
      nav: {
        mode: "record", arrow: "scan", instruction: "RECORDING",
        detail: `${rec.name} · ${rec.checkpoints.length} sign${rec.checkpoints.length === 1 ? "" : "s"}`,
        kind, status: `${ICON[kind] ?? ""} ${statusText}`.trim(), dest: "", step: 0, total: 0,
      },
    };
    broadcast(card);
    return card;
  }

  function recState() {
    if (!rec) return { recording: false };
    return {
      recording: true,
      name: rec.name,
      checkpoints: rec.checkpoints.map(({ frame, ...c }) => c),
      offRoute: rec.offRoute.map(({ frame, ...o }) => o),
      pending: rec.pending ? { sign_text: rec.pending.sign_text, kind: rec.pending.kind, description: rec.pending.description, frame: rec.pending.frame } : null,
    };
  }

  function recStart(name) {
    if (s && !s.done) stop();
    rec = { name: String(name || "").trim() || "Recorded route", checkpoints: [], offRoute: [], pending: null, frames: [] };
    recCard("Tap at each sign along the way");
    return recState();
  }

  async function recSnap(image) {
    if (!rec) throw Object.assign(new Error("not recording"), { status: 409 });
    if (busy) return { busy: true };
    busy = true;
    recCard("Reading sign…", "pending");
    const Read = z.object({
      sign_text: z.string(),
      kind: z.enum(["room", "exit", "stairs", "elevator", "hallway", "directory", "station", "platform", "other", "none"]),
      description: z.string(),
    });
    let v;
    try {
      v = await askJSON({ system: READ_SYSTEM, prompt: "Read the most prominent sign in this frame.", image, schema: Read, name: "sign_read" });
    } finally {
      busy = false;
    }
    if (v.kind === "none" || !v.sign_text.trim()) {
      recCard("No sign readable. Get closer, tap again", "warn");
      return { read: v, state: recState() };
    }
    rec.pending = { ...v, frame: rec.frames.push(image) - 1 };
    recCard(`Read "${v.sign_text}". Set direction on phone`, "ok");
    return { read: v, state: recState() };
  }

  function recConfirm({ label, arrow = "straight", detail = "", wrongWay = false }) {
    if (!rec?.pending) throw Object.assign(new Error("no sign captured yet: tap at a sign first"), { status: 409 });
    const p = rec.pending;
    const text = String(label || p.sign_text).trim();
    const id = `${slug(text)}-${rec.checkpoints.length + rec.offRoute.length + 1}`;
    if (wrongWay) {
      rec.offRoute.push({ id, label: text, expect: p.description, match: matchTokens(text), recover: String(detail).trim() || "Turn around", frame: p.frame });
    } else {
      const mode = ["station", "platform"].includes(p.kind) ? "subway" : "indoor";
      const svgArrow = arrow === "elevator" ? "up" : arrow;
      rec.checkpoints.push({ id, mode, label: text, expect: p.description, match: matchTokens(text), arrow: svgArrow, instruction: INSTRUCTION[arrow] ?? "GO STRAIGHT", detail: String(detail).trim(), frame: p.frame });
    }
    rec.pending = null;
    recCard(`Saved "${text}". Walk on, tap the next sign`, "ok");
    return recState();
  }

  function recWalk(place) {
    if (!rec) throw Object.assign(new Error("not recording"), { status: 409 });
    const last = rec.checkpoints[rec.checkpoints.length - 1];
    if (!last) throw Object.assign(new Error("record at least one sign (e.g. the exit) before the outdoor walk"), { status: 409 });
    last.walkTo = { name: place.name, lat: place.lat, lon: place.lon, arriveRadius: 30 };
    recCard(`Outdoor walk to ${place.name} added`, "ok");
    return recState();
  }

  function recUndo() {
    if (!rec) throw Object.assign(new Error("not recording"), { status: 409 });
    if (rec.pending) rec.pending = null;
    else rec.checkpoints.pop();
    recCard("Removed last sign", "unknown");
    return recState();
  }

  async function recSave() {
    if (!rec) throw Object.assign(new Error("not recording"), { status: 409 });
    if (!rec.checkpoints.length) throw Object.assign(new Error("no signs recorded yet"), { status: 400 });
    const routes = await loadRoutes();
    const cps = rec.checkpoints.map(({ frame, ...c }) => c);
    const walk = cps.find((c) => c.walkTo);
    const r = {
      id: `${slug(rec.name)}-${Date.now().toString(36)}`,
      name: rec.name,
      destination: walk ? walk.walkTo.name : cps[cps.length - 1].label,
      recordedAt: new Date().toISOString(),
      checkpoints: cps,
      offRoute: rec.offRoute.map(({ frame, ...o }) => o),
    };
    routes.push(r);
    await saveRoutes(routes);
    rec = null;
    broadcast({ title: "ROUTE SAVED", lines: [r.name, `${cps.length} signs`], speak: "", phone_detail: "" });
    return r;
  }

  function recCancel() {
    rec = null;
    broadcast({ title: "NAVIQ", lines: ["Recording cancelled"], speak: "", phone_detail: "" });
    return recState();
  }

  async function deleteRoute(id) {
    const routes = (await loadRoutes()).filter((r) => r.id !== id);
    await saveRoutes(routes);
    return routes;
  }

  function setHeading(h) {
    if (!Number.isFinite(h)) return { ok: false };
    heading = { deg: norm360(h), ts: Date.now() };
    // Outdoors and standing still: re-check "facing the wrong way?" as they turn, not only on GPS updates.
    const o = s && !s.done ? s.outdoor : null;
    if (o && o.steps?.length && !o.routing && lastFix && Date.now() - (o.evalAt ?? 0) > 1200) updateOutdoor(lastFix);
    return { ok: true, calibrated: cal.n > 0, offset: Math.round(cal.offset) };
  }
  function calibrateFrom(expected, doorId, rawFrame) {
    if (!Number.isFinite(expected)) return;
    const now = Date.now();
    if (cal.lastDoor === doorId && now - cal.lastTs < 20000) return;
    const err = indoor.turnAngle(rawFrame, expected);
    // The first plaque sets the offset outright (nothing to agree with yet); later big swings need a second plaque.
    const largeChange = cal.n > 0 && Math.abs(indoor.turnAngle(cal.offset, err)) > 35;
    const pending = cal.pending;
    if (largeChange && !(pending && pending.doorId !== doorId && now - pending.ts <= 120000 && Math.abs(indoor.turnAngle(pending.err, err)) <= 20)) {
      if (pending?.doorId !== doorId || now - pending.ts > 120000) cal.pending = { doorId, ts: now, err };
      return;
    }
    // A large correction needs agreement from two different plaques. Ordinary adjustments use recent samples.
    cal.errs = largeChange ? [pending.err, err] : [...cal.errs, err].slice(-7);
    const offsets = cal.errs.map((e) => indoor.turnAngle(err, e)).sort((a, b) => a - b);
    const middle = Math.floor(offsets.length / 2);
    const median = offsets.length % 2 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
    cal.offset = indoor.turnAngle(0, norm360(err + median));
    if (largeChange) cal.pending = null;
    cal.lastDoor = doorId; cal.lastTs = now; cal.n += largeChange ? 2 : 1;
    console.log(`[compass] calibrated from plaque: raw ${Math.round(rawFrame)}° should be ${Math.round(expected)}° → offset ${Math.round(cal.offset)}° (n=${cal.n})`);
  }

  // Display-only live preview from the glasses (~3 fps, small), for the phone/laptop camera panel.
  const preview = { image: null, ts: 0 };
  function setPreview(image) { if (typeof image === "string" && image.startsWith("data:image/")) { preview.image = image; preview.ts = Date.now(); } return { ok: true }; }

  function noteFrame(image, source) {
    if (image) { live.frame = image; live.frameTs = Date.now(); live.source = source; }
  }
  function liveInfo() {
    const R = s?.room;
    return {
      ts: live.ts, frameTs: live.frameTs, source: live.source, read: live.read, previewTs: preview.ts,
      view: live.view ?? s?.lastCard?.nav ?? null,
      heading,
      memory: R ? { at: R.atLabel ?? null, increase: R.mem?.inc ?? {}, places: Object.fromEntries(Object.entries(R.mem ?? {}).filter(([k]) => k !== "inc")) } : null,
    };
  }

  // The real plan for the phone's map: image + node positions, plus where the wearer is and the planned path.
  function planInfo() {
    const m = models[0];
    if (!m) return null;
    const R = s?.room;
    return {
      building: m.name, source: m.source, planUpBearing: m.orientation?.planUpBearing ?? 0,
      image: m.image ? { url: "/api/indoor/plan.jpg", width: m.image.width, height: m.image.height } : null,
      nodes: m.nodes.map(({ id, x, y, floor, kind, label, room, near }) => ({ id, x, y, floor, kind, label: label ?? room ?? near ?? null })),
      edges: m.edges.map(([a, b]) => [a, b]),
      trip: R && R.target.model === m ? { target: R.target.label, kind: R.target.kind, targetNodes: R.target.nodes, at: R.ambiguous ? null : R.at ?? null, path: R.ambiguous ? null : R.path ?? null, floor: R.floor ?? null, done: Boolean(R.done), trail: R.trail ?? [], trailPath: (R.trail ?? []).reduce((acc, p) => { if (!acc.length) return [p.id]; const seg = indoor.shortestPath(m, acc.at(-1), [p.id]); return seg ? acc.concat(seg.slice(1)) : acc.concat(p.id); }, []), seenAgoMs: R.seenTs ? Date.now() - R.seenTs : null, candidates: R.ambiguous ?? null, est: estPosition(m, R), stridePx: Math.round(stride.px * 10) / 10, strideLearned: stride.n } : null,
      // Which way they face, in real-world degrees (raw glasses compass + plaque calibration), for the map's cone.
      heading: heading && Date.now() - heading.ts < 4000 ? { deg: Math.round(norm360(heading.deg + indoorOffset())), calibrated: cal.n > 0 || phoneCalFresh(), src: phoneCalFresh() ? "phone compass (glasses for head turns)" : cal.n > 0 ? "glasses compass, calibrated by a door sign" : "glasses compass, not calibrated yet" }
        : phoneFresh() ? { deg: Math.round(phone.deg), calibrated: true, src: "phone compass" } : null,
      read: live.read && Date.now() - live.ts < 15000 ? { rooms: live.read.rooms, places: live.read.places, signs: live.read.signs ?? [], ageMs: Date.now() - live.ts } : null,
      // What the glasses are telling them right now (for the map's instruction banner).
      nav: s && !s.done && s.room && R?.target.model === m && s.roomView ? { instruction: s.roomView.instruction, detail: s.roomView.detail, arrow: s.roomView.arrow } : null,
    };
  }
  const planImageFile = () => (models[0]?.image ? path.join(path.dirname(routesFile), "citytech", models[0].image.file) : null);

  return {
    alignHeading,
    resetCalibration: () => { Object.assign(cal, { offset: 0, n: 0, errs: [], lastDoor: null, lastTs: 0, pending: null }); return { ok: true }; },
    calibration: () => ({ offset: Math.round(cal.offset), samples: cal.n, raw: heading ? Math.round(heading.deg) : null }),
    planInfo, planImageFile,
    noteFrame, liveInfo, setPreview, preview: () => preview, liveFrame: () => live.frame, places: () => indoor.placesList(models),
    setHeading, setPhoneHeading, addSteps,
    get heading() { return heading; },
    loadRoutes, deleteRoute, listPlans, addPlan, planImage, deletePlan,
    start, stop, step, observe, location, state,
    recStart, recSnap, recConfirm, recWalk, recUndo, recSave, recCancel, recState,
    frame: (i) => s?.frames[i] ?? null,
    recFrame: (i) => rec?.frames[i] ?? null,
    get active() { return Boolean(s && !s.done); },
    get recording() { return Boolean(rec); },
  };
}
