// Indoor guidance from the live camera + the glasses compass, routed on a real building plan when we have one.
//
// Each camera frame is read by the vision model (rooms it can read, places it can see such as turnstiles,
// elevators, exit doors). Here, plain code:
//   1. anchors the wearer on the plan: a readable room plaque or a recognised place → a plan node
//   2. finds the shortest walk on the plan to the target (room door, exit, bathrooms, elevators…)
//   3. turns the next leg into a compass bearing (from the plan's real orientation), then into
//      TURN LEFT / TURN RIGHT / GO STRAIGHT / TURN AROUND using the way the wearer's head faces.
// Nothing is recorded or simulated: the plan is City Tech's published floor plan (data/citytech/).

import fs from "node:fs";
import path from "node:path";

const rad = (d) => (d * Math.PI) / 180;
export const turnAngle = (a, b) => ((b - a + 540) % 360) - 180; // signed degrees, + = clockwise (right)

export function loadModels(dir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!Array.isArray(m.nodes) || !Array.isArray(m.edges)) continue;
      m.byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
      m.adj = Object.fromEntries(m.nodes.map((n) => [n.id, []]));
      for (const [a, b, cue, cost] of m.edges) {
        if (!m.byId[a] || !m.byId[b]) continue;
        const len = cost ?? Math.hypot(m.byId[a].x - m.byId[b].x, m.byId[a].y - m.byId[b].y);
        m.adj[a].push({ to: b, len, cue });
        m.adj[b].push({ to: a, len, cue });
      }
      out.push(m);
    } catch (err) {
      console.error(`[indoor] bad model ${f}: ${err.message}`);
    }
  }
  return out;
}

// Compass bearing of the plan vector a→b (plan y grows downward).
export function planBearing(model, a, b) {
  const A = model.byId[a], B = model.byId[b];
  if (A.floor !== B.floor) return null; // escalator/elevator hop: no walking direction
  const theta = (Math.atan2(B.x - A.x, -(B.y - A.y)) * 180) / Math.PI;
  return (((model.orientation?.planUpBearing ?? 0) + theta) % 360 + 360) % 360;
}

// Room number → building/floor/number. "A105" → { label: "A105", bldg: "A", num: 105, floor: 1 }.
export function parseRoom(t) {
  const m = /([A-Z]{1,2})\s*-?\s*(\d{3,4})\b/.exec(String(t).toUpperCase());
  if (!m) return null;
  const num = Number(m[2]);
  return { label: m[1] + m[2], bldg: m[1], num, floor: Math.floor(num / 100) };
}

const KIND_WORDS = [
  [/\b(exit|way out|main entrance|entrance|leave|outside|jay st(reet)?)\b/i, "exit"],
  [/\b(rest ?rooms?|bath ?rooms?|toilets?|washrooms?|wc|men'?s|women'?s)\b/i, "restroom"],
  [/\b(elevators?|lifts?)\b/i, "elevator"],
  [/\bescalators?\b/i, "escalator"],
  [/\b(stairs?|staircase|stairwell)\b/i, "stairs"],
  [/\b(theater|theatre|gym|auditorium)\b/i, "theater"],
];
const KIND_LABEL = { exit: "Exit", restroom: "Bathrooms", elevator: "Elevators", escalator: "Escalator", stairs: "Stairs", theater: "Theater" };

/** What the wearer asked for → a target. Uses a building model's places when it has them. */
export function resolveTarget(text, models, { exit = false } = {}) {
  const q = String(text ?? "").trim();
  const kind = exit ? "exit" : KIND_WORDS.find(([re]) => re.test(q))?.[1] ?? null;
  const room = kind ? null : parseRoom(q);
  if (!kind && !room) return null;
  for (const model of models) {
    const place = model.places?.find((p) => (room ? p.id === room.label : p.id === kind));
    if (place) {
      return { label: place.label, kind: room ? "room" : kind, room, place: place.id, nodes: place.nodes, model };
    }
  }
  return { label: room ? room.label : KIND_LABEL[kind], kind: room ? "room" : kind, room, place: null, nodes: null, model: null };
}

// Vision "place" kinds → plan node kinds.
const PLACE_TO_NODE = { exit_doors: "exit", turnstiles: "turnstiles", elevators: "elevators", escalator: "escalator", stairs: "stairs", restroom: "restroom", info_desk: "lobby" };

function nearestByPath(model, from, ids) {
  if (!from || ids.length < 2) return ids[0];
  const d = dijkstra(model, from);
  return [...ids].sort((a, b) => (d.dist[a] ?? Infinity) - (d.dist[b] ?? Infinity))[0];
}

/**
 * Where the wearer is on the plan, from one camera read. A readable room plaque is the strongest anchor
 * (you can only read it up close); a recognised place counts as close only if the model says so.
 */
export function anchorFromRead(model, read, prevAt, verifiedFloor = null) {
  const inView = new Set([...(read.rooms ?? []).map((r) => parseRoom(r.label)?.label).filter(Boolean), ...(read.places ?? []).map((p) => PLACE_TO_NODE[p.kind] ?? p.kind)]);
  for (const r of read.rooms ?? []) {
    const p = parseRoom(r.label);
    if (!p || p.bldg !== model.building) continue;
    const doors = model.nodes.filter((n) => n.kind === "door" && n.room === p.label);
    if (!doors.length) continue;
    let id = null, ambiguous = null;
    if (doors.length === 1) id = doors[0].id;
    else if (prevAt) id = nearestByPath(model, prevAt, doors.map((d) => d.id)); // continuity with where we were
    else {
      // Which door? Whatever else is in view next to it on the plan (bathrooms → north door, A103 → south…).
      const scored = doors.map((d) => ({ id: d.id, score: (d.context ?? []).filter((c) => inView.has(c)).length })).sort((x, y) => y.score - x.score);
      if (scored[0].score > (scored[1]?.score ?? 0)) id = scored[0].id;
      else { id = scored[0].id; ambiguous = doors.map((d) => d.id); }
    }
    const floor = model.byId[id].floor;
    return { id, close: Boolean(r.close), via: "room", label: p.label, position: r.position, floor, ambiguous };
  }
  const order = ["exit_doors", "turnstiles", "elevators", "escalator", "restroom", "stairs", "info_desk"];
  const places = [...(read.places ?? [])].sort((a, b) => (b.close - a.close) || order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const pl of places) {
    const nk = PLACE_TO_NODE[pl.kind];
    let nodes = model.nodes.filter((n) => n.kind === nk);
    if (!nodes.length) continue;
    // Elevators/escalators exist on several floors: only usable once the floor is confirmed.
    const floors = new Set(nodes.map((n) => n.floor));
    if (floors.size > 1) {
      if (verifiedFloor == null) continue;
      nodes = nodes.filter((n) => n.floor === verifiedFloor);
      if (!nodes.length) continue;
    }
    const ids = nodes.map((n) => n.id);
    // The main turnstiles are the ones you meet coming in from Jay Street; prefer them unless we were near the theater.
    const id = nk === "turnstiles" && !prevAt?.startsWith("theater") ? "turnstiles" : nearestByPath(model, prevAt, ids);
    return { id, close: Boolean(pl.close), via: "place", label: model.byId[id].label ?? pl.kind, position: pl.position, kind: pl.kind, floor: model.byId[id].floor, floorUnique: floors.size === 1 };
  }
  return null;
}

export function dijkstra(model, from) {
  const dist = { [from]: 0 }, prev = {}, done = new Set();
  const q = [from];
  while (q.length) {
    q.sort((a, b) => dist[a] - dist[b]);
    const u = q.shift();
    if (done.has(u)) continue;
    done.add(u);
    for (const e of model.adj[u] ?? []) {
      const nd = dist[u] + e.len;
      if (nd < (dist[e.to] ?? Infinity)) { dist[e.to] = nd; prev[e.to] = u; q.push(e.to); }
    }
  }
  return { dist, prev };
}

export function shortestPath(model, from, targets) {
  const { dist, prev } = dijkstra(model, from);
  const t = [...targets].filter((id) => dist[id] != null).sort((a, b) => dist[a] - dist[b])[0];
  if (!t) return null;
  const p = [t];
  while (p[0] !== from) p.unshift(prev[p[0]]);
  return p;
}

// Split a node path into legs: straight runs, merged while the direction changes by < 30°.
function legsOf(model, p) {
  const legs = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = model.byId[p[i]], b = model.byId[p[i + 1]];
    const edge = model.adj[p[i]].find((e) => e.to === p[i + 1]);
    const bear = planBearing(model, p[i], p[i + 1]);
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    const last = legs[legs.length - 1];
    if (last && bear != null && last.bearing != null && Math.abs(turnAngle(last.bearing, bear)) < 30 && !edge?.cue) {
      last.to = p[i + 1]; last.len += len; last.nodes.push(p[i + 1]);
    } else {
      legs.push({ from: p[i], to: p[i + 1], bearing: bear, len, cue: edge?.cue ?? null, floorHop: bear == null, nodes: [p[i], p[i + 1]] });
    }
  }
  return legs;
}

const STUB = 45; // plan units: a door to its corridor spot, a few steps

export function relWords(rel) {
  const a = Math.abs(rel);
  if (a <= 30) return { arrow: "straight", word: "GO STRAIGHT", spoken: "go straight" };
  if (a >= 140) return { arrow: "back", word: "TURN AROUND", spoken: "turn around" };
  return rel > 0 ? { arrow: "right", word: "TURN RIGHT", spoken: "turn right" } : { arrow: "left", word: "TURN LEFT", spoken: "turn left" };
}

const placeName = (model, id) => {
  const n = model.byId[id];
  return n.label ?? (n.kind === "door" ? n.room : n.near) ?? "the corridor";
};

/**
 * Next move from `at` to the nearest of `targets`.
 * heading: compass degrees the head faces, or null if the compass is stale.
 */
export function guide(model, at, targets, heading, { anchorJustSeen = true, followed = new Set() } = {}) {
  if (targets.includes(at)) return { arrived: true };
  const p = shortestPath(model, at, targets);
  if (!p) return null;
  const legs = legsOf(model, p);
  let i = 0;
  while (i < legs.length - 1 && legs[i].len < STUB && !legs[i].floorHop) i++; // skip door→corridor stubs
  const cur = legs[i];
  const rest = legs.slice(i + 1).filter((l) => l.len >= STUB || l.floorHop);
  const next = rest[0];
  const targetNode = model.byId[p[p.length - 1]];
  const targetName = targetNode.kind === "door" ? targetNode.room : targetNode.label;

  if (cur.floorHop) {
    const up = model.byId[cur.to].floor > model.byId[cur.from].floor;
    const via = model.byId[cur.from].kind === "escalator" ? "escalator" : "elevator";
    const floor = model.byId[cur.to].floor;
    const instruction = via === "elevator" ? "TAKE ELEVATOR" : up ? "ESCALATOR UP" : "ESCALATOR DOWN";
    return { arrived: false, bearing: null, arrow: up ? "up" : "down", instruction, detail: `${up ? "Up" : "Down"} to floor ${floor}`, spoken: `Take the ${via} ${up ? "up" : "down"} to floor ${floor}.`, path: p, floorHop: true };
  }

  // Stale anchor: the camera last recognised e.g. the turnstiles, but the head now points along the NEXT leg
  // (you've walked through and turned). Treat a short current leg as done when that happens.
  let ci = i, cur2 = cur, rest2 = rest;
  // Only when the camera did NOT just see the anchor: reading a door plaque means you face the door, which
  // says nothing about having walked on.
  for (let hop = 0; hop < 2 && heading != null && !anchorJustSeen; hop++) {
    const nx = rest2[0];
    if (!nx || nx.floorHop || cur2.bearing == null || cur2.len >= 140) break;
    if (!followed.has(`${cur2.from}>${cur2.to}`)) break; // they never faced along this leg: haven't walked it
    if (Math.abs(turnAngle(heading, nx.bearing)) < 40 && Math.abs(turnAngle(heading, cur2.bearing)) > 50) {
      ci = legs.indexOf(nx); cur2 = nx; rest2 = rest2.slice(1);
    } else break;
  }
  return describe(model, p, legs, ci, cur2, rest2, heading, targetName);
}

function describe(model, p, legs, i, cur, rest, heading, targetName) {
  const next = rest[0];
  // What to say after this leg: the next turn, or where the target is.
  let then = "";
  const finalStub = legs[legs.length - 1];
  if (!next) {
    // Final approach: which side is the target on as you walk this leg?
    let side = "";
    if (finalStub && finalStub !== cur && finalStub.bearing != null && cur.bearing != null) {
      const r = turnAngle(cur.bearing, finalStub.bearing);
      side = Math.abs(r) < 30 ? "ahead" : r > 0 ? "on your right" : "on your left";
    } else side = "ahead";
    then = `${targetName} ${side}`;
  } else if (next.floorHop) {
    const up = model.byId[next.to].floor > model.byId[next.from].floor;
    then = `then the ${model.byId[next.from].kind === "escalator" ? "escalator" : "elevator"} ${up ? "up" : "down"} to floor ${model.byId[next.to].floor}`;
  } else {
    const r = turnAngle(cur.bearing, next.bearing);
    const w = Math.abs(r) < 30 ? "straight on" : r > 0 ? "right" : "left";
    const into = model.byId[next.from].into;
    then = w === "straight on"
      ? `then ${next.cue ?? `on past ${placeName(model, next.from)}`}`
      : next.cue ? `then ${w} ${next.cue}` : into ? `then ${w} into ${into}` : `then ${w} at ${placeName(model, next.from)}`;
  }

  if (heading == null || cur.bearing == null) {
    // No compass: say where to head by landmark instead of left/right.
    const toward = placeName(model, cur.to);
    return { arrived: false, bearing: cur.bearing, arrow: "straight", instruction: `TO ${toward.replace(/^the /, "").toUpperCase()}`.slice(0, 18), detail: then, spoken: `Head to ${toward}, ${then}.`, path: p, compass: false };
  }
  const rel = turnAngle(heading, cur.bearing);
  const w = relWords(rel);
  const detail = cur.cue ? `${cur.cue}, ${then}` : then;
  return { arrived: false, bearing: Math.round(cur.bearing), rel: Math.round(rel), arrow: w.arrow, instruction: w.word, detail, spoken: `${w.spoken}. ${detail}.`, path: p, compass: true, legKey: `${cur.from}>${cur.to}` };
}

/** Places a phone UI can offer as one-tap destinations. */
export function placesList(models) {
  return models.flatMap((m) => (m.places ?? []).map((p) => ({ id: p.id, label: p.label, kind: p.kind, building: m.name })));
}
