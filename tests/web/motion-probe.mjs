// The probe tests/web/motion_replay.py adds to the match page: it pins the camera on a
// station or a player and measures how the figures move. Presentation tooling only; it
// reads the page's state and never changes the match. Keys (press h to show them):
//
//   0 the page's own camera      o overview          n / p next or previous station
//   f / F follow the next or previous player of the station (in a live match: the play)
//   v the follow camera's side: fixed (from the near touchline), side, front, behind
//   [ ] closer or further        m measure 10 s      h the panel
//
// URL: ?view=overview | station:NAME | follow:ID | follow:play, &side=fixed|side|front|behind,
// &hud=0. From a browser tool: `await __motion.measure(10)` returns the numbers below.
//
// Foot sliding: a foot is planted while the ball of the foot (the toe bone's joint) is
// within 1 cm of the lowest it has been over the last 1.5 s. `drift` is how far a planted
// foot moves over the ground from plant to lift (cm, per stance of 4 frames or more);
// `skate` its speed while planted (cm/s); `sliding` the share of planted frames it moves
// faster than 20 cm/s, which shows in a close-up; `ratio` the planted feet's travel over
// the body's while it moves (0 is planted, 1 is skating along with the body). Lockstep: for neighbours within 4 m moving
// alike (both faster than 0.8 m/s, velocities within 0.8 m/s), how often their strides are
// within 0.05 of a cycle of each other, and each one's cadence, stride, lean and arm swing.
import * as THREE from 'three';

const PLANTED = 0.01; // m above the foot's recent lowest: the foot flat, not landing or lifting
const MEMORY = 90; // frames of recent heights (1.5 s at 60 fps)
const NEAR = 4; // m: neighbours
const ALIKE = 0.8; // m/s
const STEP_APART = 0.05; // of a cycle
const SHORTEST = 4; // frames a stance lasts to count its drift
const VISIBLE = 20; // cm/s a planted foot slides at that shows
const SIDES = ['fixed', 'side', 'front', 'behind'];

const params = new URLSearchParams(location.search);
const pitch = await new Promise((resolve) => {
  (function wait() { if (window.__pitch?.renderer) resolve(window.__pitch); else setTimeout(wait, 50); })();
});
const info = await fetch('./__motion/stations').then(r => r.json()).catch(() => ({ live: true, stations: [] }));
const stations = info.stations;
const names = new Map();
for (const s of stations) for (const [i, id] of s.players.entries()) names.set(id, `${s.name}${s.players.length > 1 ? ` ${i + 1}` : ''}`);

const view = { mode: 'game', station: 0, id: null, side: params.get('side') ?? 'fixed', distance: 6 };
const asked = params.get('view');
if (asked === 'overview') view.mode = 'overview';
else if (asked?.startsWith('station:')) {
  view.mode = 'station';
  view.station = Math.max(0, stations.findIndex(s => s.name === asked.slice(8)));
} else if (asked?.startsWith('follow:')) {
  view.mode = 'follow';
  view.id = asked.slice(7) === 'play' ? 'play' : Number(asked.slice(7));
}
// The station a followed player belongs to, for the panel and f/F.
const stationOf = (id) => Math.max(0, stations.findIndex(s => s.players.includes(id)));
if (view.mode === 'follow' && view.id !== 'play') view.station = stationOf(view.id);

// ---- What each figure shows, found by its drawn position.
const bodies = new Map(); // id -> { group, bones, feet: [..], last }
let bodiesOf = null;
function body(id) {
  const actors = pitch.actors;
  if (bodiesOf !== actors) {
    bodies.clear();
    bodiesOf = actors;
  }
  const at = actors?.getPlayerPosition(id);
  if (!at) return null;
  let entry = bodies.get(id);
  if (!entry || entry.group.position !== at) {
    let group = null;
    pitch.scene.traverse((node) => { if (!group && node.position === at) group = node; });
    if (!group) return null;
    const bone = (name) => group.getObjectByName(name);
    entry = {
      group, hips: bone('hips'), head: bone('head'), hand: bone('hand_L'),
      feet: ['toe_L', 'toe_R'].map(name => ({ bone: bone(name), heights: [], planted: 0, last: new THREE.Vector3(), start: new THREE.Vector3() })),
      last: new THREE.Vector3().copy(at), seen: false,
    };
    bodies.set(id, entry);
  }
  return entry;
}

// ---- Measuring.
const v = new THREE.Vector3();
const w = new THREE.Vector3();
let record = null;
function newRecord(seconds) {
  return { until: performance.now() / 1000 + seconds, seconds, players: new Map(), pairs: new Map(), frames: 0 };
}
function stats(id) {
  let s = record.players.get(id);
  if (!s) {
    s = { drift: [], skate: [], footPath: 0, bodyPath: 0, moving: 0, lean: [], swing: [], stride: [], rate: [], handMin: Infinity, handMax: -Infinity, handCycle: 0 };
    record.players.set(id, s);
  }
  return s;
}

function measureFrame(dt) {
  const actors = pitch.actors;
  if (!actors || !(dt > 0)) return;
  const seen = [];
  actors.forEachPlayerPosition((id) => seen.push(id));
  const states = new Map();
  for (const id of seen) {
    const b = body(id);
    if (!b) continue;
    const state = actors.inspect(id);
    states.set(id, state);
    const moved = Math.hypot(b.group.position.x - b.last.x, b.group.position.z - b.last.z);
    const jumped = !b.seen || moved > 1; // placed, not moved
    b.last.copy(b.group.position);
    b.seen = true;
    const s = record && stats(id);
    for (const foot of b.feet) {
      if (!foot.bone) continue;
      foot.bone.getWorldPosition(v);
      foot.heights.push(v.y);
      if (foot.heights.length > MEMORY) foot.heights.shift();
      const low = Math.min(...foot.heights);
      const planted = !jumped && v.y < low + PLANTED;
      if (planted && foot.planted) {
        const slip = Math.hypot(v.x - foot.last.x, v.z - foot.last.z);
        if (s) {
          s.footPath += slip;
          if (state.speed > 0.3) s.bodyPath += moved;
          s.skate.push(slip / dt * 100);
        }
      } else if (planted) foot.start.copy(v);
      else if (foot.planted >= SHORTEST && s) s.drift.push(Math.hypot(foot.last.x - foot.start.x, foot.last.z - foot.start.z) * 100);
      foot.planted = planted ? foot.planted + 1 : 0;
      foot.last.copy(v);
    }
    if (!s || state.speed < 0.8 || jumped) continue;
    s.moving++;
    if (state.rate > 0) {
      s.rate.push(state.rate);
      s.stride.push(state.speed / state.rate);
    }
    // Lean: the hips-to-head line from upright, forwards along the travel (degrees).
    if (b.hips && b.head) {
      b.hips.getWorldPosition(v);
      b.head.getWorldPosition(w);
      const velocity = actors.getPlayerVelocity(id, new THREE.Vector3());
      const travel = Math.atan2(-velocity.z, velocity.x); // on the pitch, anticlockwise from +x
      const along = (w.x - v.x) * Math.cos(travel) + -(w.z - v.z) * Math.sin(travel);
      s.lean.push(THREE.MathUtils.radToDeg(Math.atan2(along, w.y - v.y)));
      if (b.hand) {
        b.hand.getWorldPosition(w);
        const reach = (w.x - v.x) * Math.cos(travel) + -(w.z - v.z) * Math.sin(travel);
        s.handMin = Math.min(s.handMin, reach);
        s.handMax = Math.max(s.handMax, reach);
        s.handCycle += state.rate * dt;
        if (s.handCycle >= 1) {
          s.swing.push(s.handMax - s.handMin);
          s.handMin = Infinity;
          s.handMax = -Infinity;
          s.handCycle = 0;
        }
      }
    }
  }
  if (!record) return;
  record.frames++;
  // Neighbours moving alike.
  const vel = new Map();
  for (const id of states.keys()) vel.set(id, actors.getPlayerVelocity(id, new THREE.Vector3()));
  const ids = [...states.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = actors.getPlayerPosition(a);
      const pb = actors.getPlayerPosition(b);
      if (pa.distanceTo(pb) > NEAR) continue;
      const sa = states.get(a);
      const sb = states.get(b);
      if (sa.speed < ALIKE || sb.speed < ALIKE || vel.get(a).distanceTo(vel.get(b)) > ALIKE) continue;
      const key = `${a}-${b}`;
      let pair = record.pairs.get(key);
      if (!pair) record.pairs.set(key, pair = { frames: 0, together: 0, apart: 0, rates: 0 });
      const d = Math.abs(((sa.phase - sb.phase) % 1 + 1.5) % 1 - 0.5);
      pair.frames++;
      pair.apart += d;
      if (d < STEP_APART) pair.together++;
      pair.rates += Math.abs(sa.rate - sb.rate) / Math.max(1e-6, (sa.rate + sb.rate) / 2);
    }
  }
}

const quantile = (list, q) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2);
};
const share = (skate) => (skate.length ? +(skate.filter(x => x > VISIBLE).length / skate.length).toFixed(3) : null);
const mean = (list) => (list.length ? +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(3) : null);

function report(rec) {
  const players = {};
  const all = { drift: [], skate: [], footPath: 0, bodyPath: 0 };
  for (const [id, s] of rec.players) {
    all.drift.push(...s.drift);
    all.skate.push(...s.skate);
    all.footPath += s.footPath;
    all.bodyPath += s.bodyPath;
    players[id] = {
      name: names.get(id) ?? null,
      stances: s.drift.length,
      drift: { median: quantile(s.drift, 0.5), p90: quantile(s.drift, 0.9), most: quantile(s.drift, 1) },
      skate: { median: quantile(s.skate, 0.5), p90: quantile(s.skate, 0.9) }, sliding: share(s.skate),
      ratio: s.bodyPath > 0.5 ? +(s.footPath / s.bodyPath).toFixed(3) : null,
      moving: s.moving,
      cadence: mean(s.rate), stride: mean(s.stride), lean: mean(s.lean), swing: mean(s.swing),
    };
  }
  const pairs = {};
  for (const [key, p] of rec.pairs) {
    if (p.frames < 30) continue;
    pairs[key] = { frames: p.frames, inStep: +(p.together / p.frames).toFixed(3), apart: +(p.apart / p.frames).toFixed(3), cadenceDiff: +(p.rates / p.frames).toFixed(3) };
  }
  const groups = {};
  for (const s of stations) {
    const list = s.players.map(id => rec.players.get(id)).filter(Boolean);
    if (!list.length) continue;
    const drift = list.flatMap(x => x.drift);
    const foot = list.reduce((n, x) => n + x.footPath, 0);
    const moved = list.reduce((n, x) => n + x.bodyPath, 0);
    groups[s.name] = {
      stances: drift.length, driftMedian: quantile(drift, 0.5), driftP90: quantile(drift, 0.9), driftMost: quantile(drift, 1),
      skateP90: quantile(list.flatMap(x => x.skate), 0.9), sliding: share(list.flatMap(x => x.skate)),
      ratio: moved > 0.5 ? +(foot / moved).toFixed(3) : null,
    };
  }
  return {
    seconds: rec.seconds, frames: rec.frames,
    all: {
      stances: all.drift.length, driftMedian: quantile(all.drift, 0.5), driftP90: quantile(all.drift, 0.9), driftMost: quantile(all.drift, 1),
      skateMedian: quantile(all.skate, 0.5), skateP90: quantile(all.skate, 0.9), sliding: share(all.skate), ratio: all.bodyPath > 0.5 ? +(all.footPath / all.bodyPath).toFixed(3) : null,
    },
    stations: groups, pairs, players,
  };
}

let finished = null;
let lastReport = null;
function measure(seconds = 10) {
  record = newRecord(seconds);
  return new Promise((resolve) => { finished = resolve; });
}

// ---- Cameras.
const look = new THREE.Vector3();
const eye = new THREE.Vector3();
const followed = new THREE.Vector3();
let followedReady = false;
let camYaw = null;
let playId = null;
let playSince = 0;
const scenePoint = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

function chooseCamera(dt) {
  const { camera, actors } = pitch;
  if (view.mode === 'game' || !actors) return;
  actors.showNumbers(view.mode === 'overview');
  if (view.mode === 'overview') {
    const centre = info.live ? scenePoint(0, -4) : scenePoint(-27, -5);
    camera.fov = 42;
    camera.position.copy(centre).add(new THREE.Vector3(0, info.live ? 72 : 70, info.live ? 58 : 34));
    camera.updateProjectionMatrix();
    camera.lookAt(centre);
    return;
  }
  if (view.mode === 'station') {
    const s = stations[view.station];
    if (!s) return;
    const centre = scenePoint(s.centre[0], s.centre[1], 0.6);
    camera.fov = 32;
    camera.position.copy(centre).add(new THREE.Vector3(0, 6, 17));
    camera.updateProjectionMatrix();
    camera.lookAt(centre);
    return;
  }
  // Follow: a player of the station, or in play the player nearest the ball.
  let id = view.id;
  if (id === 'play') {
    const ball = actors.ballPosition;
    let best = null;
    let bestD = Infinity;
    actors.forEachPlayerPosition((pid, at) => {
      const d = Math.hypot(at.x - ball.x, at.z - ball.z);
      if (d < bestD) { bestD = d; best = pid; }
    });
    playSince += dt;
    const current = playId != null ? actors.getPlayerPosition(playId) : null;
    const currentD = current ? Math.hypot(current.x - ball.x, current.z - ball.z) : Infinity;
    if (best != null && (playId == null || !current || (best !== playId && currentD - bestD > 2 && playSince > 1.5))) {
      playId = best;
      playSince = 0;
    }
    id = playId;
  }
  const at = id != null ? actors.getPlayerPosition(id) : null;
  if (!at) return;
  const k = followedReady ? 1 - Math.exp(-dt * 6) : 1;
  followed.lerp(at, k);
  followedReady = true;
  const yaw = actors.getPlayerFacing(id) ?? 0;
  const offset = { fixed: null, side: yaw - Math.PI / 2, front: yaw, behind: yaw + Math.PI }[view.side];
  const want = offset == null ? 0 : offset; // fixed: from +z, the near touchline
  camYaw = camYaw == null ? want : camYaw + Math.atan2(Math.sin(want - camYaw), Math.cos(want - camYaw)) * (1 - Math.exp(-dt * 2.5));
  look.copy(followed).setY(0.95);
  eye.set(Math.sin(camYaw) * view.distance, 1.35, Math.cos(camYaw) * view.distance).add(followed);
  camera.fov = 32;
  camera.position.copy(eye);
  camera.updateProjectionMatrix();
  camera.lookAt(look);
}

// ---- The panel.
const panel = document.createElement('pre');
panel.style.cssText = 'position:fixed;left:8px;top:64px;z-index:20;margin:0;padding:8px 10px;max-width:46vw;'
  + 'background:rgba(8,14,20,.78);color:#dfe8ee;font:12px/1.35 ui-monospace,Menlo,monospace;border-radius:6px;pointer-events:none;white-space:pre-wrap';
panel.hidden = params.get('hud') === '0';
document.body.appendChild(panel);
let panelAt = 0;
let fps = 60;
const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r));
function drawPanel(now) {
  if (panel.hidden || now - panelAt < 0.2) return;
  panelAt = now;
  const lines = [`motion probe · ${info.live ? 'live match' : 'scripted'} · ${fps.toFixed(0)} fps · view ${view.mode}${view.mode === 'follow' ? ` (${view.side})` : ''}`];
  const s = stations[view.station];
  if (s && view.mode !== 'game' && view.mode !== 'overview' && view.id !== 'play') lines.push(`station ${s.name}: ${s.shows}`);
  const id = view.id === 'play' ? playId : view.id;
  const state = id != null ? pitch.actors?.inspect(id) : null;
  if (state) {
    const loops = Object.entries(state.loops ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, x]) => `${n} ${x.toFixed(2)}`).join(', ');
    lines.push(`player ${id} ${names.get(id) ?? ''}: ${state.speed.toFixed(2)} m/s, travel ${deg(state.travel)}°, ${state.rate.toFixed(2)} cycles/s, phase ${state.phase.toFixed(2)}`);
    lines.push(`  loops ${loops}`);
    const acts = (state.acts ?? []).filter(a => a.weight > 0).map(a => `${a.name} ${a.time.toFixed(2)}s ${a.weight.toFixed(2)}`).join(', ');
    if (acts) lines.push(`  acts ${acts}`);
  }
  if (record) lines.push(`measuring… ${(record.until - now).toFixed(1)} s`);
  else if (lastReport) {
    const a = lastReport.all;
    lines.push(`last measure: drift median ${a.driftMedian} cm, p90 ${a.driftP90}; sliding ${a.sliding}; ratio ${a.ratio} (console has the rest)`);
  }
  lines.push('keys: 0 page camera · o overview · n/p station · f/F follow · v side · [ ] distance · m measure 10 s · h panel');
  panel.textContent = lines.join('\n');
}

addEventListener('keydown', (event) => {
  const key = event.key;
  if (key === 'h') panel.hidden = !panel.hidden;
  else if (key === '0') view.mode = 'game';
  else if (key === 'o') view.mode = 'overview';
  else if (key === 'n' || key === 'p') {
    view.mode = 'station';
    if (stations.length) view.station = (view.station + (key === 'n' ? 1 : stations.length - 1)) % stations.length;
  } else if (key === 'f' || key === 'F') {
    const ids = stations[view.station]?.players ?? [];
    if (info.live || !ids.length) view.id = 'play';
    else {
      const at = ids.indexOf(view.id);
      view.id = ids[at < 0 ? 0 : (at + (key === 'f' ? 1 : ids.length - 1)) % ids.length];
    }
    view.mode = 'follow';
    followedReady = false;
    camYaw = null;
  } else if (key === 'v') {
    view.side = SIDES[(SIDES.indexOf(view.side) + 1) % SIDES.length];
    camYaw = null;
  } else if (key === '[') view.distance = Math.max(2.5, view.distance - 1);
  else if (key === ']') view.distance = Math.min(30, view.distance + 1);
  else if (key === 'm' && !record) {
    measure(10).then((result) => console.log('[motion]', JSON.stringify(result)));
  }
});

// ---- Every frame, after the page has posed the figures and before it draws them.
const render = pitch.renderer.render.bind(pitch.renderer);
let last = performance.now() / 1000;
pitch.renderer.render = (scene, camera) => {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - last);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  measureFrame(dt);
  if (record && now >= record.until) {
    lastReport = report(record);
    record = null;
    finished?.(lastReport);
    finished = null;
  }
  chooseCamera(dt);
  drawPanel(now);
  render(scene, camera);
};

window.__motion = {
  measure,
  view: (mode, { station, id, side, distance } = {}) => {
    view.mode = mode;
    if (station != null) view.station = Math.max(0, stations.findIndex(s => s.name === station));
    if (id != null) {
      view.id = id;
      if (station == null && id !== 'play') view.station = stationOf(id);
    }
    if (side) view.side = side;
    if (distance) view.distance = distance;
    followedReady = false;
    camYaw = null;
  },
  stations: () => stations,
  state: (id) => pitch.actors?.inspect(id),
};
