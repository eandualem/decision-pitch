import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneScene } from 'three/addons/utils/SkeletonUtils.js';

// The human figure (docs/decisions.md, section 6, "Human figures made in Blender"): one
// skinned mesh and one set of clips, loaded once and cloned for every person on screen.
// Geometry and clips are shared; materials are shared per team colour and per skin and
// hair tone. A person's look is picked from its id, so it is the same in every browser.

export const FIGURE_HEIGHT = 1.8; // m, at scale 1
const SHORTEST = 1.7;
const TALLEST = 1.95;
// m/s: below a shuffle the direction of travel is too uncertain to follow, so the figure
// steps forwards; the direction comes in over this range of speeds.
const SHUFFLE = [0.15, 0.35];
const STILL = 0.4; // m/s below which a one-shot plays with its whole body
// Moving slower than its slowest loop, a figure blends it with standing. It gives the loop
// at least this share once past a shuffle (and a share growing with the speed below), so a
// slow drift takes fewer, lifted steps rather than skimming the grass at a walk's cadence.
const LEAST_STEP = 0.35;
const SET_BLEND = 0.18; // s over which a set (dribble, jockey, shield) comes in or goes
// Moving slowly to the side or back, a figure side-steps (the jockey set's shuffle) rather
// than crossing its feet in a part-blended walk. The two step differently, so it changes
// from one to the other (over SET_BLEND) rather than blending them: it starts shuffling
// past SHUFFLE_SIDE[1] off its facing between SHUFFLE_SPEED[0] and [1], and stops inside
// SHUFFLE_SIDE[0] or outside SHUFFLE_SPEED[2]..[3]. Not on the ball.
const SHUFFLE_SIDE = [55 * Math.PI / 180, 70 * Math.PI / 180];
const SHUFFLE_SPEED = [0.25, 1.7, 0.1, 2.0]; // m/s: on from, on below; off below, off above
export const TOUCH_PHASE = 0.4; // where a loop without a `touch` meets a carried ball
// How much faster or slower than its own pace a stride may go to meet the ball on time.
const STEER = [0.75, 1.3];
const MOST = 0.999; // the largest share of a bone a one-shot takes from the loops

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const ramp = (value, low, high) => smooth(clamp((value - low) / (high - low), 0, 1));
const fract = (value) => value - Math.floor(value);
const mix = (a, b, t) => a + (b - a) * t;

// The directions a loop may name, in radians anticlockwise from the way the figure faces
// (so its left is +pi/2). A loop may give any other `angle`, in degrees, instead.
const DIRECTIONS = {
  forward: 0, forward_left: Math.PI / 4, left: Math.PI / 2, back_left: 3 * Math.PI / 4,
  back: Math.PI, back_right: -3 * Math.PI / 4, right: -Math.PI / 2, forward_right: -Math.PI / 4,
};
// The four ways a figure without loops of its own in that direction borrows forwards.
const AXES = [0, Math.PI / 2, -Math.PI, -Math.PI / 2];
const NAMED = { walk: 'forward', jog: 'forward', sprint: 'forward', backpedal: 'back', strafe_L: 'left', strafe_R: 'right' };
const TAU = 2 * Math.PI;
const SAME = 1e-6; // rad within which two loops travel the same way
// Directions whose feet step differently (walking backwards, and a crossover step back
// and to the side) are not blended part way, where the feet would slide and collide. Each
// footwork blends its own directions, and outside them takes the nearest, turning the
// figure's hips by the angle it misses the travel by (gait.yaw); the figure changes from
// one footwork to another over SWITCH s, once a direction of the other is nearer the
// travel by HYSTERESIS rad.
const SWITCH = 0.15;
const HYSTERESIS = 0.07;
const FOOTWORKS = 4; // at most, in one set
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU); // into [-pi, pi)
const around = (a) => a - TAU * Math.floor(a / TAU); // into [0, 2 pi)

// What a one-shot keeps when it plays over the loops: a play keeps the upper body and the
// kicking (right) leg over a running stride, a gesture only the upper body over a walk.
const ARMS = ['spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R', 'upper_arm_L', 'upper_arm_R',
  'forearm_L', 'forearm_R', 'hand_L', 'hand_R'];
const LAYERS = {
  play: new Set([...ARMS, 'thigh_R', 'shin_R', 'foot_R', 'toe_R']),
  gesture: new Set(ARMS),
};

// Skin tones, lightest first, and the hair colours that go with each. Grey (the last
// colour) is kept for the staff on the touchline.
export const SKINS = ['#f2cfb1', '#e2b48e', '#c99168', '#a8704a', '#80502f', '#5b3720'];
export const HAIRS = ['#15100c', '#2c1d14', '#4b3020', '#6f4a2b', '#a47c47', '#7b3a1d', '#8e8a85'];
const GREY = HAIRS.length - 1;
const HAIR_FOR_SKIN = [[1, 2, 3, 4, 5, 0], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 1], [0, 1, 0, 2], [0, 1, 0], [0, 0, 1]];
const BOOTS = '#151a20';
const SHOES = '#101317';
const TROUSERS = '#252a31';
const UNDERSHIRT = '#eef1f4';
// Weyl sequences: consecutive ids land far apart in each, so a team does not repeat itself.
const SPREAD = [0.6180339887, 0.4142135624, 0.7320508076, 0.2360679775, 0.6457513111, 0.3166247904, 0.6055512755, 0.1231056256, 0.3588989435];

const DEFAULT_REGIONS = ['skin', 'shirt', 'sleeve', 'hands', 'shorts', 'legs', 'socks', 'boots', 'hair', 'number', 'coat', 'trousers', 'trim'];
const SHADOWLESS = new Set(['number', 'eyes']);

// Fetches the figure and its description once. `loader` and `load` are replaceable for tests.
export async function loadFigure(base = './figures/', { loader = new GLTFLoader(), load = loadJson } = {}) {
  const [gltf, info] = await Promise.all([loader.loadAsync(`${base}figure.glb`), load(`${base}figure.json`)]);
  return prepareFigure(gltf.scene, gltf.animations, info);
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

function angleOf(name, clip) {
  if (Number.isFinite(clip.angle)) return wrap(clip.angle * Math.PI / 180);
  const direction = DIRECTIONS[clip.direction ?? NAMED[name]];
  return direction === undefined ? null : wrap(direction);
}

// The loops of `clips` as the page blends them. Index 0 of `loops` is idle, whose weight
// the figure shares between its idle variants (`idles`: loops called idle... that do not
// travel). The moving loops form sets: "run", always first, and any others a loop names
// ("dribble", "jockey", "shield"), each with its stance (a loop of the set that does not
// travel), or idle, as its `rest`. A set's `dirs` are the directions it travels in, by
// angle, each with its loops from slowest to fastest, the rest first. A set fills what it
// lacks from "run": its directions, and in each the speeds above its own, and below them
// too unless it has a stance. A direction "run" has no loops in borrows forward's, so the
// figure always steps somewhere.
export function gait(clips) {
  const loops = [{ name: 'idle', duration: clips.idle?.duration || 1, speed: 0, angle: 0, stride: 0, set: 'run', touch: null }];
  const idles = [];
  const rests = new Map();
  const moving = new Map([['run', []]]);
  for (const [name, clip] of Object.entries(clips)) {
    if (!clip.loop || !(clip.duration > 0)) continue;
    const set = clip.set ?? 'run';
    if (!(clip.speed > 0)) {
      if (set === 'run' && name.startsWith('idle')) idles.push({ name, duration: clip.duration });
      else if (set !== 'run' && !rests.has(set)) {
        rests.set(set, loops.length);
        loops.push({ name, duration: clip.duration, speed: 0, angle: 0, stride: 0, set, touch: null });
      }
      continue;
    }
    const angle = angleOf(name, clip);
    if (angle === null) continue;
    if (!moving.has(set)) moving.set(set, []);
    moving.get(set).push(loops.length);
    loops.push({
      name, duration: clip.duration, speed: clip.speed, angle, stride: clip.speed * clip.duration, set,
      touch: Number.isFinite(clip.touch) ? clip.touch : null, duty: clip.duty > 0 && clip.duty < 1 ? clip.duty : null,
      footwork: typeof clip.footwork === 'string' ? clip.footwork : null,
    });
  }
  // A loop's footwork, when figure.json does not say: a run that has loops back and to the
  // side steps those with its hips turned, and steps backwards only straight back.
  const diagonalBack = loops.some(loop => loop.set === 'run' && loop.speed > 0 && Math.abs(loop.angle) > 5 * Math.PI / 8 && Math.abs(loop.angle) < 7 * Math.PI / 8);
  for (const loop of loops) {
    if (loop.footwork || !(loop.speed > 0)) continue;
    loop.footwork = diagonalBack && loop.set === 'run' && Math.abs(loop.angle) >= 7 * Math.PI / 8 ? 'back' : 'forward';
  }
  idles.sort((a, b) => (a.name === 'idle' ? -1 : b.name === 'idle' ? 1 : a.name < b.name ? -1 : 1));
  const byAngle = (indices) => {
    const found = [];
    for (const i of indices) {
      let dir = found.find(d => Math.abs(wrap(d.angle - loops[i].angle)) < SAME);
      if (!dir) found.push(dir = { angle: loops[i].angle, own: [] });
      dir.own.push(i);
    }
    for (const dir of found) dir.own.sort((a, b) => loops[a].speed - loops[b].speed);
    return found;
  };
  const sorted = (dirs) => dirs.sort((a, b) => a.angle - b.angle);
  // Run: its own directions, and forward's loops in any quarter it leaves empty.
  const run = byAngle(moving.get('run')).map(({ angle, own }) => ({ angle, ladder: [0, ...own], borrowed: false }));
  if (run.length) {
    const ahead = run.reduce((best, dir) => (Math.abs(dir.angle) < Math.abs(best.angle) ? dir : best));
    sorted(run);
    for (let i = 0, n = run.length; i < n; i++) {
      const from = run[i].angle;
      const gap = i + 1 < n ? run[i + 1].angle - from : run[0].angle + TAU - from;
      if (gap <= Math.PI / 2 + SAME) continue;
      for (const axis of AXES) {
        const into = around(axis - from);
        if (into > SAME && into < gap - SAME) run.push({ angle: axis, ladder: ahead.ladder, borrowed: true });
      }
    }
    sorted(run);
  }
  const sets = [{ name: 'run', rest: 0, dirs: run }];
  for (const [name, indices] of [...moving].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (name === 'run') continue;
    const rest = rests.get(name) ?? 0;
    const own = byAngle(indices);
    const dirs = run.map(({ angle, ladder }) => {
      const mine = own.find(d => Math.abs(wrap(d.angle - angle)) < SAME);
      if (!mine) return { angle, ladder: [rest, ...ladder.slice(1)] };
      const slowest = loops[mine.own[0]].speed;
      const fastest = loops[mine.own.at(-1)].speed;
      // With a stance of its own, the set covers the speeds up to its slowest loop itself.
      const before = rests.has(name) ? [] : ladder.slice(1).filter(i => loops[i].speed < slowest);
      const after = ladder.slice(1).filter(i => loops[i].speed > fastest);
      return { angle, ladder: [rest, ...before, ...mine.own, ...after] };
    });
    for (const mine of own) {
      if (!run.some(d => Math.abs(wrap(d.angle - mine.angle)) < SAME)) dirs.push({ angle: mine.angle, ladder: [rest, ...mine.own] });
    }
    sets.push({ name, rest, dirs: sorted(dirs) });
  }
  // A stance whose set has no moving loops still stands in for idle.
  for (const [name, rest] of rests) if (!moving.has(name)) sets.push({ name, rest, dirs: run.map(({ angle, ladder }) => ({ angle, ladder: [rest, ...ladder.slice(1)] })) });
  for (const set of sets) {
    set.ahead = 0;
    set.dirs.forEach((dir, i) => { if (Math.abs(dir.angle) < Math.abs(set.dirs[set.ahead].angle)) set.ahead = i; });
    // Each direction's footwork, that of most of its loops, and the directions of each.
    set.footworks = [];
    for (const dir of set.dirs) {
      const count = new Map();
      for (const i of dir.ladder) if (loops[i].footwork) count.set(loops[i].footwork, (count.get(loops[i].footwork) ?? 0) + 1);
      dir.footwork = [...count].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'forward';
      if (!set.footworks.includes(dir.footwork)) set.footworks.push(dir.footwork);
    }
    set.footworks.length = Math.min(set.footworks.length, FOOTWORKS);
    set.members = set.footworks.map(name => set.dirs.flatMap((dir, i) => (dir.footwork === name ? [i] : [])));
  }
  const forward = run.length ? run[sets[0].ahead].ladder : [0];
  const walk = forward.length > 1 ? loops[forward[1]].speed : 1.5;
  const scratch = 3; // the forward step and the two directions either side of the travel
  return {
    loops, idles, sets, walk, shuffle: SHUFFLE[1], yaw: 0,
    set: Object.fromEntries(sets.map((set, i) => [set.name, i])),
    lower: new Int32Array(scratch), upper: new Int32Array(scratch), t: new Float64Array(scratch),
    stride: new Float64Array(scratch), x: new Float64Array(scratch), y: new Float64Array(scratch),
  };
}

// Blends the loops for a figure moving over the ground at `speed` m/s, travelling at
// `travel` radians from the way it faces (anticlockwise, so +pi/2 is to its left), drawn
// at `scale`. Writes each loop's weight into `weights` (indexed like `gait.loops`, summing
// to 1) and returns the shared cycle's rate in cycles per second. `shares`, indexed like
// `gait.sets`, gives each set but "run" its share (the rest is run's), and `stride` shifts
// where along the speeds the loops blend: below 1 a figure takes shorter, quicker steps.
//
// In each direction a set blends the two loops either side of the speed (over the scale:
// a taller figure's stride is longer). The two directions either side of the travel share
// out so that the blended stride points along the travel, and played at the returned rate
// that stride covers the ground at exactly `speed`, so the planted foot stays put,
// whichever way it goes. Sets blend the same way, their strides added by their shares.
// Below a shuffle the travel is ignored and the figure steps forwards; above it the blends
// cross-fade.
export function blendLoops(gait, speed, travel, scale, weights, shares = null, stride = 1, switching = null) {
  weights.fill(0);
  gait.yaw = 0;
  const { sets } = gait;
  let others = 0;
  if (shares) for (let s = 1; s < sets.length; s++) if (shares[s] > 0) others += shares[s];
  const norm = others > 1 ? 1 / others : 1;
  const moving = speed > 0;
  const pace = speed / scale; // the speed a figure of scale 1 would move at
  let length = 0;
  let turned = 0;
  for (let s = 0; s < sets.length; s++) {
    const share = s === 0 ? Math.max(0, 1 - others) : shares && shares[s] > 0 ? shares[s] * norm : 0;
    if (!(share > 0) || !moving) {
      if (share > 0) weights[sets[s].rest] += share;
      continue;
    }
    const part = share * blendSet(gait, s, pace, travel, stride, weights, share, switching);
    length += part;
    turned += part * gait.yaw;
  }
  gait.yaw = length > 1e-9 ? turned / length : 0;
  return moving && length > 1e-9 ? speed / (scale * length) : 0;
}

// A figure's state for changing footwork (see SWITCH), for blendLoops: for each set, the
// footwork it is changing to (-1 before the first blend) and each footwork's share. `dt`
// is the time since the last blend. Without it, a figure takes the nearest footwork.
export function switchingState(gait) {
  const n = gait.sets.length;
  return { dt: 0, target: new Int32Array(n).fill(-1), shares: new Float32Array(n * FOOTWORKS) };
}

// One set's part of the blend, weighted by `share`; returns its blended stride's length,
// and leaves in gait.yaw the angle its stride misses the travel by.
function blendSet(gait, s, pace, travel, stride, weights, share, switching) {
  gait.yaw = 0;
  const set = gait.sets[s];
  const { dirs } = set;
  if (!dirs.length) {
    weights[set.rest] += share;
    return 0;
  }
  const select = pace * stride;
  const across = ramp(pace, SHUFFLE[0], SHUFFLE[1]);
  let length = 0;
  // Forwards, whatever the travel.
  if (across < 1) {
    pick(gait, dirs[set.ahead].ladder, select, 0);
    place(gait, weights, 0, share * (1 - across));
    length += (1 - across) * gait.stride[0];
  }
  if (across > 0) {
    const heading = wrap(travel);
    const { footworks } = set;
    let along = 0;
    let turned = 0;
    if (footworks.length === 1) along = blendFootwork(gait, set, 0, heading, select, weights, share * across);
    else {
      const shares = footworkShares(set, s, heading, switching);
      for (let f = 0; f < footworks.length; f++) {
        const part = shares[s * FOOTWORKS + f];
        if (!(part > 0)) continue;
        const reach = part * blendFootwork(gait, set, f, heading, select, weights, share * across * part);
        along += reach;
        turned += reach * gait.yaw;
      }
    }
    length += across * along;
    gait.yaw = along > 1e-9 ? across * turned / along : 0; // the hips turn as the steps come round
  }
  return length;
}

const nearest = new Float32Array(FOOTWORKS);
const snapped = new Float32Array(FOOTWORKS * 32); // shares by set, without a switching state

// How much of each footwork set `s` shows for travel `heading`: the one with the direction
// nearest the travel, changed to over time when `switching` is given.
function footworkShares(set, s, heading, switching) {
  const { footworks, members, dirs } = set;
  for (let f = 0; f < footworks.length; f++) {
    nearest[f] = Infinity;
    for (const i of members[f]) nearest[f] = Math.min(nearest[f], Math.abs(wrap(heading - dirs[i].angle)));
  }
  let best = 0;
  for (let f = 1; f < footworks.length; f++) if (nearest[f] < nearest[best]) best = f;
  const base = s * FOOTWORKS;
  const shares = switching ? switching.shares : snapped;
  if (!switching || switching.target[s] < 0) {
    for (let f = 0; f < FOOTWORKS; f++) shares[base + f] = f === best ? 1 : 0;
    if (switching) switching.target[s] = best;
    return shares;
  }
  if (nearest[best] < nearest[switching.target[s]] - HYSTERESIS) switching.target[s] = best;
  const target = switching.target[s];
  const grown = Math.min(1, shares[base + target] + switching.dt / SWITCH);
  let others = 0;
  for (let f = 0; f < footworks.length; f++) if (f !== target) others += shares[base + f];
  for (let f = 0; f < footworks.length; f++) {
    shares[base + f] = f === target ? grown : others > 0 ? shares[base + f] * (1 - grown) / others : 0;
  }
  return shares;
}

// One footwork's part of a set's blend along `heading`, weighted by `weight`: the two of its
// directions either side of the travel share it so that the blended stride points along the
// travel; a travel between two of its directions with another footwork's in between, or more
// than half a turn apart, takes the nearer and leaves the angle it misses by in gait.yaw.
// Returns the blended stride's length.
function blendFootwork(gait, set, f, heading, select, weights, weight) {
  const { dirs } = set;
  const members = set.members[f];
  const n = members.length;
  let k = n - 1;
  for (let m = 0; m < n && dirs[members[m]].angle <= heading; m++) k = m;
  const a = members[k];
  const b = members[(k + 1) % n];
  const from = around(heading - dirs[a].angle);
  const gap = n > 1 ? around(dirs[b].angle - dirs[a].angle) : TAU;
  // Along the travel: it is a sum of the directions either side, a.u + b.v, and each
  // takes a share of the blend in proportion to its part over its stride, so the
  // strides add up along the travel.
  let alongA = 1;
  let alongB = 0;
  gait.yaw = 0;
  if (gap < Math.PI - SAME && (b === (a + 1) % dirs.length || n === dirs.length)) {
    alongA = Math.sin(gap - from) / Math.sin(gap);
    alongB = Math.sin(from) / Math.sin(gap);
  } else if (gap - from < from) {
    alongA = 0;
    alongB = 1;
    gait.yaw = from - gap;
  } else gait.yaw = from;
  pick(gait, dirs[a].ladder, select, 1);
  pick(gait, dirs[b].ladder, select, 2);
  const { stride: strides, x, y } = gait;
  const wa = alongA > 0 && strides[1] > 0 ? alongA / strides[1] : 0;
  const wb = alongB > 0 && strides[2] > 0 ? alongB / strides[2] : 0;
  const total = wa + wb;
  if (!(total > 0)) {
    weights[set.rest] += weight;
    return 0;
  }
  place(gait, weights, 1, weight * wa / total);
  place(gait, weights, 2, weight * wb / total);
  // Loops borrowed from another direction keep its stride: count them along their own.
  return Math.hypot((wa * x[1] + wb * x[2]) / total, (wa * y[1] + wb * y[2]) / total);
}


// The two loops of `ladder` either side of `select` and how far between them it is, with
// the stride they blend to, as a length and as a vector, into slot `j` of the scratch.
function pick(gait, ladder, select, j) {
  const { loops } = gait;
  let k = 1;
  while (k < ladder.length && loops[ladder[k]].speed < select) k++;
  let lower;
  let upper;
  let t;
  if (k === ladder.length) {
    lower = upper = ladder[k - 1];
    t = 1;
  } else {
    lower = ladder[k - 1];
    upper = ladder[k];
    const from = loops[lower].speed;
    t = (select - from) / (loops[upper].speed - from);
    if (k === 1) t = Math.min(1, Math.max(t, LEAST_STEP * Math.min(1, select / SHUFFLE[1])));
  }
  const low = loops[lower];
  const high = loops[upper];
  gait.lower[j] = lower;
  gait.upper[j] = upper;
  gait.t[j] = t;
  gait.stride[j] = low.stride * (1 - t) + high.stride * t;
  gait.x[j] = low.stride * (1 - t) * Math.cos(low.angle) + high.stride * t * Math.cos(high.angle);
  gait.y[j] = low.stride * (1 - t) * Math.sin(low.angle) + high.stride * t * Math.sin(high.angle);
}

function place(gait, weights, j, share) {
  if (!(share > 0)) return;
  weights[gait.lower[j]] += share * (1 - gait.t[j]);
  weights[gait.upper[j]] += share * gait.t[j];
}

// The clip time of a one-shot whose moment of contact lands at u = 0 (s), first seen at
// u = `from`: a wind-up seen too late to play in full plays faster, at most twice as fast,
// and the clip runs at its own pace from contact on.
export function contactTime(u, from, contact) {
  if (u >= 0) return contact + u;
  const rate = from < 0 ? clamp(contact / -from, 1, 2) : 2;
  return Math.max(0, contact + u * rate);
}

// How much of a one-shot shows at `u` s from its contact, between `from` (when it began)
// and `end`: it fades in quickly and out more slowly.
export function envelope(u, from, end, fadeIn = 0.08, fadeOut = 0.25) {
  return Math.min(clamp((u - from) / fadeIn, 0, 1), clamp((end - u) / fadeOut, 0, 1));
}

// The ground speed a one-shot's `speeds` ([[clip time, m/s], ...], piecewise linear) give
// at clip time `time`.
export function speedAt(speeds, time) {
  if (time <= speeds[0][0]) return speeds[0][1];
  for (let i = 1; i < speeds.length; i++) {
    const [t1, v1] = speeds[i];
    if (time <= t1) {
      const [t0, v0] = speeds[i - 1];
      return t1 > t0 ? v0 + (v1 - v0) * (time - t0) / (t1 - t0) : v1;
    }
  }
  return speeds[speeds.length - 1][1];
}

// The first clip time at which falling `speeds` come down to `speed`.
export function timeAt(speeds, speed) {
  if (speed >= speeds[0][1]) return speeds[0][0];
  for (let i = 1; i < speeds.length; i++) {
    const [t1, v1] = speeds[i];
    const [t0, v0] = speeds[i - 1];
    if (speed >= v1 && v0 > v1) return t0 + (t1 - t0) * (v0 - speed) / (v0 - v1);
  }
  return speeds[speeds.length - 1][0];
}

// A string or number seed as a non-negative integer.
function seedOf(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.round(seed));
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash % 1000003;
}

// A number in [0, 1) from integer `n` and stream `k`, by integer arithmetic only, so it is
// the same in every browser and does not follow the look's picks.
function hash01(n, k) {
  let x = Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

// A person's look from its id: height, skin, hair style and colour, sleeves and the build
// and face shape keys, and the way it moves. The same seed gives the same look everywhere. `greying` people
// (the managers and their assistants) are grey-haired about half the time.
export function variation(seed, { hairs = 1, morphs = [], greying = false } = {}) {
  const n = seedOf(seed);
  const at = (k) => fract((n + 1) * SPREAD[k % SPREAD.length] + k * 0.137);
  const skin = Math.floor(at(1) * SKINS.length);
  const hairColours = HAIR_FOR_SKIN[skin];
  const shapes = {};
  // Shape keys of one kind (build_*, face_*, ...) do not stack: at most one of each is set.
  const kinds = new Map();
  for (const name of morphs) {
    const kind = name.split('_')[0];
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(name);
  }
  let k = 5;
  for (const names of kinds.values()) {
    const pick = at(k++);
    const strength = at(k++);
    const index = Math.floor(pick * (names.length + 1)) - 1; // -1: none of this kind
    for (const [i, name] of names.entries()) shapes[name] = i === index ? 0.25 + 0.75 * strength : 0;
  }
  return {
    height: SHORTEST + (TALLEST - SHORTEST) * at(0),
    skin,
    hair: Math.floor(at(2) * Math.max(1, hairs)),
    hairColour: greying && at(8) < 0.5 ? GREY : hairColours[Math.floor(at(3) * hairColours.length)],
    longSleeves: at(4) < 0.22,
    shapes,
    phase: fract(n * 0.7548776662),
    // How it moves: `stride` below 1 takes shorter, quicker steps and above 1 longer,
    // slower ones; `arms` how far out and bent it carries its arms (0 to 1); `lean` how far
    // forwards (+) or upright (-) it holds its back; `idle` which idle it favours.
    style: {
      stride: 0.9 + 0.2 * hash01(n, 1), arms: hash01(n, 2), lean: 2 * hash01(n, 3) - 1, idle: hash01(n, 4),
    },
  };
}

// The colour of each material region for a person in `role`, wearing `colours` (the
// team's shirt, shorts and keeper colours), with `look` from variation().
export function outfit(role, colours, look) {
  const skin = SKINS[look.skin];
  const hair = HAIRS[look.hairColour];
  const shirt = colours.shirt ?? '#c8372d';
  const shorts = colours.shorts ?? '#ffffff';
  if (role === 'keeper') {
    const keeper = colours.keeper ?? '#2f9e44';
    return { skin, hair, shirt: keeper, sleeve: keeper, hands: gloves(keeper), shorts, legs: skin, socks: keeper, boots: BOOTS };
  }
  if (role === 'manager') {
    return {
      skin, hair, shirt: UNDERSHIRT, sleeve: shirt, hands: skin, shorts: TROUSERS, legs: TROUSERS, socks: TROUSERS,
      boots: SHOES, coat: shirt, trousers: TROUSERS, trim: UNDERSHIRT,
    };
  }
  if (role === 'assistant') {
    const trousers = shade(shirt, 0.42);
    return { skin, hair, shirt, sleeve: shirt, hands: skin, shorts: trousers, legs: trousers, socks: trousers, boots: SHOES };
  }
  return { skin, hair, shirt, sleeve: look.longSleeves ? shirt : skin, hands: skin, shorts, legs: skin, socks: shirt, boots: BOOTS };
}

const colour = new THREE.Color();
function shade(hex, factor) {
  return `#${colour.set(hex).multiplyScalar(factor).getHexString()}`;
}
// Gloves stand out from the keeper's shirt.
function gloves(keeper) {
  colour.set(keeper);
  return colour.r * 0.3 + colour.g * 0.59 + colour.b * 0.11 > 0.55 ? '#1d2329' : '#eef2f4';
}

// The shirt number as drawn on the back and above a player.
export function numberCanvas(number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 88px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#17212a';
  ctx.strokeText(String(number), 64, 67);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(number), 64, 67);
  return canvas;
}

const baseName = (name) => String(name ?? '').replace(/[._]\d+$/, '');
// The meshes of a glTF object: itself, or the primitives under it.
function meshesOf(object) {
  const found = [];
  object?.traverse((node) => { if (node.isMesh) found.push(node); });
  return found;
}

// Readies a loaded glTF for cloning: names the parts, the region of every mesh, the clips
// (whole and layered) and the gait. Shared by every figure of every match.
export function prepareFigure(scene, animations, info = {}) {
  const described = info.clips ?? {};
  // The contract's regions, and any more figure.json names.
  const regions = new Set([...DEFAULT_REGIONS, ...(info.materials?.regions ?? []), ...(info.materials?.coat ?? [])]);
  const hairs = info.hair ?? [];
  const morphs = Object.keys(info.morphs ?? {});
  scene.updateMatrixWorld(true);
  // Clips move limbs well beyond the bind pose, so culling uses a sphere around the
  // whole reach of a figure, not the bind pose's bounds.
  const reach = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
  const inverse = new THREE.Matrix4();
  scene.traverse((node) => {
    if (!node.isMesh) return;
    const name = baseName(node.material?.name);
    node.userData.region = regions.has(name) ? name : null;
    node.castShadow = !SHADOWLESS.has(name);
    node.receiveShadow = false;
    if (node.isSkinnedMesh) node.boundingSphere = reach.clone().applyMatrix4(inverse.copy(node.matrixWorld).invert());
    if (node.material?.isMeshStandardMaterial && !node.userData.region) {
      // Fixed materials (the eyes) light like the rest of the scene, and more cheaply.
      const old = node.material;
      node.material = new THREE.MeshLambertMaterial({
        name: old.name, color: old.color, map: old.map, vertexColors: old.vertexColors,
        transparent: old.transparent, side: old.side,
      });
    }
  });
  const clips = new Map();
  for (const clip of animations) if (described[clip.name]) clips.set(clip.name, clip);
  // Each foot's heel, on the ground under it in the rest pose, and ball, the toe joint the
  // foot rolls over, in the foot's own space: the ends of the sole the foot lock holds.
  const soles = ['L', 'R'].map((side) => {
    const foot = scene.getObjectByName(`foot_${side}`);
    const toe = scene.getObjectByName(`toe_${side}`);
    if (!foot || !toe) return { heel: new THREE.Vector3(), ball: new THREE.Vector3(), rise: 0 };
    const ankle = new THREE.Vector3().setFromMatrixPosition(foot.matrixWorld);
    const tip = new THREE.Vector3().setFromMatrixPosition(toe.matrixWorld);
    const toFoot = new THREE.Matrix4().copy(foot.matrixWorld).invert();
    return {
      heel: new THREE.Vector3(ankle.x - (tip.x - ankle.x) * HEEL, 0, ankle.z - (tip.z - ankle.z) * HEEL).applyMatrix4(toFoot),
      ball: new THREE.Vector3(tip.x, tip.y, tip.z).applyMatrix4(toFoot),
      rise: tip.y, // the ball's pivot, the toe joint, is this far above the ground standing
    };
  });
  const steps = gait(described);
  measureReach(scene, clips, steps);
  const axes = poseAxes(scene);
  return {
    scene, info, clips, described, hairs, morphs, soles, axes,
    gait: steps,
    layered: { play: new Map(), gesture: new Map() }, // clips with only that layer's tracks
    twins: new Map(),
    parts: { body: info.body ?? 'body', coat: info.coat ?? 'coat', number: info.number ?? 'number' },
  };
}

// The axes the page turns bones about over the clips, in each bone's own space at rest:
// the back and neck bend forwards about `bend` and turn left about `twist`, an upper arm
// swings out from the side about `out`, and a forearm bends at the elbow about `bend`.
function poseAxes(scene) {
  scene.updateMatrixWorld(true);
  const turn = new THREE.Quaternion();
  const local = (bone, axis) => axis.applyQuaternion(bone.getWorldQuaternion(turn).invert()).normalize();
  const at = (bone) => new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
  const axes = {};
  for (const name of ['spine', 'chest', 'neck']) {
    const bone = scene.getObjectByName(name);
    if (bone) axes[name] = { bend: local(bone, new THREE.Vector3(1, 0, 0)), twist: local(bone, new THREE.Vector3(0, 1, 0)) };
  }
  for (const [side, outwards] of [['L', 1], ['R', -1]]) {
    const upper = scene.getObjectByName(`upper_arm_${side}`);
    const fore = scene.getObjectByName(`forearm_${side}`);
    const hand = scene.getObjectByName(`hand_${side}`);
    if (!upper || !fore || !hand) continue;
    const arm = at(fore).sub(at(upper)).normalize();
    const forearm = at(hand).sub(at(fore)).normalize();
    const out = arm.clone().cross(new THREE.Vector3(outwards, 0, 0));
    const bend = forearm.clone().cross(new THREE.Vector3(0, 0, 1));
    if (out.lengthSq() > 1e-6) axes[`upper_arm_${side}`] = { out: local(upper, out.normalize()) };
    if (bend.lengthSq() > 1e-6) axes[`forearm_${side}`] = { bend: local(fore, bend.normalize()) };
  }
  return axes;
}

export const REACH = 0.6; // m: the toe's reach when a clip cannot tell, at scale 1
const TOE = 0.07; // m from the ball of the foot to the tip of the toes
const REACH_LIMITS = [0.3, 0.8];

// How far ahead of the root each loop's right toe reaches as it swings through to meet a
// carried ball, at its `touch` or just before it plants at half the cycle, at scale 1.
// Measured on a copy of the figure, so the template keeps its rest pose. Idle and the
// stances reach as the slowest forward loop does.
function measureReach(scene, clips, steps) {
  const copy = cloneScene(scene);
  const toe = copy.getObjectByName('toe_R');
  const mixer = new THREE.AnimationMixer(copy);
  const tip = new THREE.Vector3();
  for (const loop of steps.loops) {
    loop.reach = REACH;
    const clip = clips.get(loop.name);
    if (!toe || !clip || !(loop.speed > 0)) continue;
    const action = mixer.clipAction(clip);
    action.play();
    const touch = loop.touch ?? TOUCH_PHASE;
    let most = -Infinity;
    for (let phase = touch - 0.15; phase <= touch + 0.1 + 1e-9; phase += 0.01) {
      action.time = fract(phase) * clip.duration;
      mixer.update(0);
      copy.updateMatrixWorld(true);
      most = Math.max(most, toe.localToWorld(tip.set(0, TOE, 0)).z);
    }
    action.stop();
    if (Number.isFinite(most)) loop.reach = clamp(most, ...REACH_LIMITS);
  }
  const forward = steps.sets[0].dirs[steps.sets[0].ahead]?.ladder;
  if (forward?.length > 1) for (const loop of steps.loops) if (!(loop.speed > 0)) loop.reach = steps.loops[forward[1]].reach;
}

// The clip `name` with only the tracks of `layer`'s bones, made once per figure.
function layeredClip(template, name, layer) {
  const made = template.layered[layer];
  let clip = made.get(name);
  if (!clip) {
    const whole = template.clips.get(name);
    const bones = LAYERS[layer];
    const tracks = whole.tracks.filter(track => bones.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName));
    clip = new THREE.AnimationClip(`${name}:${layer}`, whole.duration, tracks);
    made.set(name, clip);
  }
  return clip;
}

// A copy of `clip` sharing its tracks, for a second action on the same clip.
function twinOf(template, clip) {
  let twin = template.twins.get(clip);
  if (!twin) {
    twin = new THREE.AnimationClip(clip.name, clip.duration, clip.tracks);
    template.twins.set(clip, twin);
  }
  return twin;
}

// Skinned meshes that shared a skeleton in the source share one in the clone, so the
// bones are computed and uploaded once per figure rather than once per material.
function shareSkeletons(source, clone) {
  const sources = [];
  const clones = [];
  source.traverse((node) => { if (node.isSkinnedMesh) sources.push(node); });
  clone.traverse((node) => { if (node.isSkinnedMesh) clones.push(node); });
  const shared = [];
  for (let i = 0; i < sources.length; i++) {
    const match = shared.find(([original]) => sameSkin(original, sources[i].skeleton));
    if (match) clones[i].bind(match[1], clones[i].bindMatrix);
    else shared.push([sources[i].skeleton, clones[i].skeleton]);
  }
}

function sameSkin(a, b) {
  if (a === b) return true;
  if (a.bones.length !== b.bones.length) return false;
  for (let i = 0; i < a.bones.length; i++) {
    if (a.bones[i] !== b.bones[i] || !a.boneInverses[i].equals(b.boneInverses[i])) return false;
  }
  return true;
}

const SLOTS = 4; // one-shots a figure can show at once, fading into each other

// The foot lock. Blended loops whose feet move differently (a walk half into a jog, a
// step half into a side step) leave the planted foot sliding a little, and so does a
// figure turned or leant over its stride. While a foot is planted, by the shared phase and
// the loops' `duty` (the share of the cycle each foot is down: the left from phase 0, the
// right from 0.5), its ankle is held where it landed by bending the hip and knee, and let
// go smoothly before it lifts.
const DUTY = 0.35; // the share of the cycle a foot is down, for a loop that does not say
// Of the stance, over which the lock lets go: it holds the sole while it is on the ground
// and lets go once it lifts, so letting go never drags a foot over the grass.
const LOCK_OUT = [0.95, 1.3];
const LOCK_REACH = [0.2, 0.35]; // m a foot is held over, beyond which the lock gives way
const HOLDING = [0.02, 0.25]; // of the blend travelling, over which the lock comes in
const SWING_LIFT = 0.08; // m a foot in the air lifts at most over the clips, at scale 1
// m a foot in the air keeps its sole above the grass at least, at scale 1, at mid-swing:
// half a sine over the swing, so it comes down to land.
const CLEARANCE = 0.03;
// The pose the page adds over the clips. A body leans into its acceleration, along and
// across its run (a curve is an acceleration across it), as a runner does, by TILT of the
// angle that would balance it, at most TILT_MOST; the acceleration is smoothed over
// ACCELERATION s. Each person carries its back and arms its own way (variation().style).
const TILT = 0.45;
const TILT_MOST = 0.2; // rad
const ACCELERATION = 0.15; // s
const HARDEST = 12; // m/s2: faster changes are a figure placed, not running
const GRAVITY = 9.81;
const POSTURE = [0.03, 0.05]; // rad the back bends forwards, and by how much more or less
const ARMS_OUT = [0.03, 0.12]; // rad the upper arms are held out from the sides, least to most
const ELBOWS = [0, 0.3]; // rad more the elbows bend, least to most
const COUNTER = { chest: 0.5, neck: 0.3 }; // of the hips' turn the chest and neck turn back
// Moves the figure makes of itself from how it moves (one-shots in figure.json, when it
// has them). A turn on the spot (turn_L, turn_R) when it turns faster than TURNING_FAST
// below TURNING_SLOW m/s, its clip time following the turn; a cut (cut_L, cut_R) when its
// run turns faster than CUTTING above CUTTING_SPEED, planting a moment later; a braking
// step (brake) when it slows harder than BRAKING from above BRAKING_SPEED without turning.
const TURNING_FAST = 2.5; // rad/s
const TURNING_SLOW = 1;
const TURNING_DONE = 0.6; // rad/s below which a turn has finished
const CUTTING = 2; // rad/s
const CUTTING_SPEED = 2.5;
const BRAKING = 2.5; // m/s2 (the engine slows a player at 4 at most)
const BRAKING_SPEED = 3;
const BRAKING_AHEAD = 0.6; // rad: a brake is a run stopping, travelling the way it faces
const STOPPED = 0.3; // m/s below which a brake plays out at its own pace
const TURN_MOVING = [0.3, 0.8]; // m/s over which a turn on the spot gives way to the run
// A one-shot's `speeds` (figure.json): the ground speed its planted feet assume through it.
// A cut plays at the rate that matches them to the figure's speed, within these.
const SPEED_RATE = [0.4, 1.5];
const PLANT = 0.1; // s from seeing a cut or a brake to its plant
const MOVE_SHARE = { turn: 1, cut: 0.7, brake: 0.85 }; // of the body each takes
const MOVE_AGAIN = { turn: 0, cut: 0.5, brake: 1 }; // s before the same kind again
const AGAIN_FADE = 0.2; // s a move fades out over when another takes its place
// Above this share of the body, a move's own footfalls say which feet are down, not the
// stride's phase: a sole within GROUNDED of the grass is held from where it came down.
const MOVE_FEET = 0.5;
const GROUNDED = 0.02; // m
// Idle variants (gait.idles): a person stands in its own and changes now and then.
const IDLE_CHANGE = [6, 14]; // s between changes, least and most
const IDLE_FADE = 0.8; // s
const HEEL = 0.35; // the heel's distance behind the ankle, over the ankle-to-toe length
const ROCK = 0.01; // m lower the other end of the sole must be to take the weight
const LIFTED = [0.03, 0.06]; // m up over which a sole is no longer on the ground

const hip = new THREE.Vector3();
const knee = new THREE.Vector3();
const ankle = new THREE.Vector3();
const axis = new THREE.Vector3();
const bend = new THREE.Vector3();
const was = new THREE.Vector3();
const now = new THREE.Vector3();
const turnThigh = new THREE.Quaternion();
const turnShin = new THREE.Quaternion();
const thighTurn = new THREE.Quaternion();
const shinTurn = new THREE.Quaternion();
const footTurn = new THREE.Quaternion();
const parentTurn = new THREE.Quaternion();
const ignored = new THREE.Vector3();
const footAt = new THREE.Vector3();
const footTo = new THREE.Vector3();
const heelAt = new THREE.Vector3();
const ballAt = new THREE.Vector3();

// A bone's world matrix from its parent's, which must be up to date.
function placeBone(bone) {
  bone.updateMatrix();
  bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
}

// Bends the leg `thigh` > `shin` > `foot` (bones whose world matrices, and the thigh's
// parent's, are up to date) so the ankle, the foot's origin, reaches `target` in world
// space, or as near as the leg's length allows. The knee bends the way it already does and
// the foot keeps its world orientation, so the sole stays as the clip has it. Sets the
// bones' quaternions; their world matrices are left for the next scene update.
export function reachFor(thigh, shin, foot, target) {
  hip.setFromMatrixPosition(thigh.matrixWorld);
  knee.setFromMatrixPosition(shin.matrixWorld);
  ankle.setFromMatrixPosition(foot.matrixWorld);
  const upper = hip.distanceTo(knee);
  const lower = knee.distanceTo(ankle);
  axis.subVectors(target, hip);
  const far = axis.length();
  if (!(upper > 1e-6 && lower > 1e-6 && far > 1e-6)) return;
  axis.divideScalar(far);
  const d = clamp(far, Math.abs(upper - lower) + 1e-4, upper + lower - 1e-4);
  thigh.parent.matrixWorld.decompose(ignored, parentTurn, ignored);
  // The way the knee points, square to the new line from the hip: its offset from the
  // line to the ankle, or for a straight leg the way the hips face.
  was.subVectors(ankle, hip).normalize();
  bend.subVectors(knee, hip);
  bend.addScaledVector(was, -bend.dot(was));
  if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).applyQuaternion(parentTurn);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-12) return;
  bend.normalize();
  const reach = (upper * upper - lower * lower + d * d) / (2 * d);
  const rise = Math.sqrt(Math.max(0, upper * upper - reach * reach));
  thigh.matrixWorld.decompose(ignored, thighTurn, ignored);
  shin.matrixWorld.decompose(ignored, shinTurn, ignored);
  foot.matrixWorld.decompose(ignored, footTurn, ignored);
  // The thigh turns onto the new knee...
  was.subVectors(knee, hip).divideScalar(upper);
  now.copy(axis).multiplyScalar(reach).addScaledVector(bend, rise).divideScalar(upper);
  turnThigh.setFromUnitVectors(was, now);
  // ...and the shin, carried round with it, from the new knee onto the target.
  was.subVectors(ankle, knee).divideScalar(lower).applyQuaternion(turnThigh);
  now.copy(axis).multiplyScalar(d - reach).addScaledVector(bend, -rise).normalize();
  turnShin.setFromUnitVectors(was, now);
  thighTurn.premultiply(turnThigh);
  shinTurn.premultiply(turnThigh).premultiply(turnShin);
  thigh.quaternion.copy(parentTurn.invert()).multiply(thighTurn);
  shin.quaternion.copy(thighTurn.invert()).multiply(shinTurn);
  foot.quaternion.copy(shinTurn.invert()).multiply(footTurn);
}

// Makes the people of one match from `template` (see loadFigure). Materials are shared
// between them; dispose() frees them and the people's skeletons. The template's geometry
// and clips are never freed. `footLock: false` leaves the feet as the blend has them, for
// measuring what the lock does.
export function createFigures(template, { footLock = true } = {}) {
  const paints = new Map();
  const owned = new Set();
  const paint = (hex) => {
    let material = paints.get(hex);
    if (!material) {
      material = new THREE.MeshLambertMaterial({ color: hex });
      paints.set(hex, material);
      owned.add(material);
    }
    return material;
  };
  const { gait: steps, parts } = template;

  // One person. `seed` picks its look; `role` is 'outfield', 'keeper', 'manager' or
  // 'assistant'; `colours` are its team's; `number` is printed on its back.
  function create({ seed = 0, role = 'outfield', colours = {}, number = null } = {}) {
    const look = variation(seed, {
      hairs: template.hairs.length, morphs: template.morphs, greying: role === 'manager' || role === 'assistant',
    });
    const palette = outfit(role, colours, look);
    const object = cloneScene(template.scene);
    shareSkeletons(template.scene, object);
    // Each clone has skeletons of its own (one, once shared), with a bone texture each.
    object.traverse((node) => { if (node.isSkinnedMesh) owned.add(node.skeleton); });
    const scale = look.height / FIGURE_HEIGHT;
    object.scale.setScalar(scale);
    const hair = template.hairs[look.hair];
    let canvas = null;
    let numberMaterial = null;
    if (number != null) {
      canvas = numberCanvas(number);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.flipY = false; // glTF's texture convention
      numberMaterial = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
      owned.add(map);
      owned.add(numberMaterial);
    }
    object.traverse((node) => {
      if (template.hairs.includes(node.name)) node.visible = node.name === hair;
      else if (node.name === parts.coat) node.visible = role === 'manager';
      else if (node.name === parts.number) node.visible = numberMaterial !== null;
      if (!node.isMesh) return;
      const region = node.userData.region;
      if (region === 'number') {
        if (numberMaterial) node.material = numberMaterial;
      } else if (region && palette[region]) node.material = paint(palette[region]);
      const dictionary = node.morphTargetDictionary;
      if (dictionary && node.morphTargetInfluences) {
        for (const [name, value] of Object.entries(look.shapes)) {
          if (name in dictionary) node.morphTargetInfluences[dictionary[name]] = value;
        }
      }
    });

    const handBones = ['hand_L', 'hand_R'].map(name => object.getObjectByName(name));
    // The legs the foot lock bends, each with where its foot last landed.
    const legs = ['L', 'R'].map((side, i) => ({
      thigh: object.getObjectByName(`thigh_${side}`), shin: object.getObjectByName(`shin_${side}`),
      foot: object.getObjectByName(`foot_${side}`), start: i * 0.5, ...template.soles[i],
      // Where the end of the sole that bears the weight (0 the heel, 1 the ball) is held.
      contact: new THREE.Vector3(), bearing: 0, down: false, slack: false, held: 0,
    }));
    const lockable = footLock && legs.every(leg => leg.thigh?.parent && leg.shin && leg.foot);
    // The bone the whole skeleton turns about, the hips' parent, and the way up in its
    // parent's space.
    const base = legs[0].thigh?.parent?.parent ?? null;
    // From the figure's own space (+z ahead, +y up) to the base's parent's.
    const toBase = new THREE.Quaternion();
    if (base?.parent) {
      template.scene.updateMatrixWorld(true);
      const rest = template.scene.getObjectByName(base.parent.name);
      if (rest) rest.getWorldQuaternion(toBase).invert();
    }
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(toBase);
    const tiltAxis = new THREE.Vector3();
    // The bones the page bends over the clips, with their axes (poseAxes).
    const { axes } = template;
    const bent = (name) => (axes[name] ? object.getObjectByName(name) : null);
    const [spine, chest, neck] = ['spine', 'chest', 'neck'].map(bent);
    const arms = ['L', 'R'].map(side => ({
      upper: bent(`upper_arm_${side}`), fore: bent(`forearm_${side}`),
      out: axes[`upper_arm_${side}`]?.out, bend: axes[`forearm_${side}`]?.bend,
    }));
    const { style } = look;
    const posture = POSTURE[0] + POSTURE[1] * style.lean;
    const armsOut = mix(ARMS_OUT[0], ARMS_OUT[1], style.arms);
    const elbows = mix(ELBOWS[0], ELBOWS[1], style.arms);
    // The smoothed acceleration over the ground, in the scene (x, z), and the velocity it
    // comes from.
    let ax = 0;
    let az = 0;
    let lastVx = 0;
    let lastVz = 0;
    let moved = false;
    let tilt = 0;
    const switching = switchingState(steps);
    // Bones the page poses over the clips start each frame from their rest, in case no
    // clip keys them.
    const posed = [
      ...(lockable ? legs.flatMap(leg => [leg.thigh, leg.shin, leg.foot]) : []), ...(base ? [base] : []),
      ...[spine, chest, neck].filter(Boolean), ...arms.flatMap(arm => [arm.upper, arm.fore]).filter(Boolean),
    ];
    const rests = posed.map(bone => bone.quaternion.clone());
    const turn = new THREE.Quaternion();
    const palm = new THREE.Vector3();
    const mixer = new THREE.AnimationMixer(object);
    const loops = steps.loops.map(({ name }) => {
      const clip = template.clips.get(name);
      if (!clip) return null;
      const action = mixer.clipAction(clip);
      action.weight = 0;
      action.play();
      return action;
    });
    const weights = new Float32Array(loops.length);
    const setShares = new Float32Array(steps.sets.length); // each set's share, as it comes and goes
    const jockeySet = steps.set.jockey ?? -1;
    let shuffling = false; // side-stepping in the jockey shuffle of its own accord
    // Idle variants: idle's own action and one for each other, the one stood in, the one
    // being changed to and how far.
    const idles = steps.idles.map(({ name }) => {
      if (name === steps.loops[0].name) return loops[0];
      const clip = template.clips.get(name);
      if (!clip) return null;
      const action = mixer.clipAction(clip);
      action.weight = 0;
      action.play();
      return action;
    });
    const idleSeed = seedOf(seed);
    let idleNow = idles.length ? Math.floor(look.style.idle * idles.length) : -1;
    let idleNext = -1;
    let idleFade = 0;
    let idleChanges = 0;
    let idleAt = 0;
    let idleChange = mix(...IDLE_CHANGE, hash01(idleSeed, 100));
    // The move under way (turn, cut or brake), the heading and travel last frame, and when
    // each kind last began.
    const move = { kind: null, name: null, time: 0, turned: 0, total: 0, from: 0, to: 0, began: 0, ending: false, share: 0 };
    const fadingMove = { name: null, time: 0, began: 0, share: 0, turned: 0 }; // one given way, fading out
    const lastMove = { turn: -Infinity, cut: -Infinity, brake: -Infinity };
    let clock = 0;
    let lastYaw = null;
    let lastWay = null;
    // `planted`: a move whose feet plant (a turn, cut or brake), which the foot lock holds.
    const slots = Array.from({ length: SLOTS }, () => ({ name: null, time: 0, share: 0, layer: 'play', planted: false }));
    let acting = 0;
    // One-shot actions by clip, each with the last frame it showed in; those that showed
    // last frame are in `shown`, and stop when a frame passes without them.
    const oneShots = new Map();
    let shown = [];
    let next = [];
    let frame = 0;
    let phase = look.phase;
    let idle = look.phase * steps.loops[0].duration;
    let rate = 0;
    let lastSpeed = 0;
    let lastTravel = 0;
    let shownDuty = DUTY;
    let hips = 0; // rad the skeleton turns so its stride runs along the travel (gait.yaw)

    function action(clip) {
      // The same clip twice in a frame (one fading out as it starts again) plays on a twin.
      if (oneShots.get(clip)?.frame === frame) clip = twinOf(template, clip);
      let entry = oneShots.get(clip);
      if (!entry) {
        entry = { action: mixer.clipAction(clip), frame: -1 };
        oneShots.set(clip, entry);
      }
      if (entry.frame < frame - 1) entry.action.play();
      if (entry.frame !== frame) next.push(entry);
      entry.frame = frame;
      return entry.action;
    }

    // Holds each planted foot where it landed (see reachFor): the end of its sole that
    // bears the weight, the heel as it lands and the ball as it rolls on, is kept where it
    // touched down, and the ankle moves with the clip around it. `moving` is the share of
    // the blend that travels, `duty` its share of the cycle a foot is down, and `taken` the
    // share of each leg a one-shot plays.
    function lockFeet(moving, duty, takenLeft, takenRight, byFoot) {
      let updated = null;
      for (let i = 0; i < 2; i++) {
        const leg = legs[i];
        const cycle = fract(phase - leg.start);
        const into = byFoot ? 0 : cycle / duty; // how far through its stance
        // Held in full once the stride is a fair part of the blend, so a figure drifting
        // slowly keeps its feet too; under a move of its own, whatever the stride.
        const share = (byFoot ? 1 : ramp(moving, ...HOLDING)) * (1 - (i === 0 ? takenLeft : takenRight) / MOST);
        // Stepping with the stride only part of the blend, the foot in the air lifts by the
        // part it lacks, so a slow step clears the grass.
        const swing = !byFoot && cycle >= duty ? (cycle - duty) / (1 - duty) : -1;
        let lift = swing >= 0 && share > 1e-3 ? SWING_LIFT * scale * share * (1 - moving) * Math.sin(Math.PI * swing) : 0;
        const holding = (byFoot || into < LOCK_OUT[1]) && share > 1e-3;
        // In the air, the sole clears the grass, coming down only to land.
        const clear = swing >= 0 && share > 1e-3 ? CLEARANCE * scale * share * Math.sin(Math.PI * swing) : 0;
        leg.held = 0;
        if (!holding) leg.down = leg.slack = false;
        if (!holding && !(lift > 1e-3) && !(clear > 1e-3)) continue;
        const { thigh, shin, foot } = leg;
        if (updated !== thigh.parent) {
          thigh.parent.updateWorldMatrix(true, false);
          updated = thigh.parent;
        }
        placeBone(thigh);
        placeBone(shin);
        placeBone(foot);
        footAt.setFromMatrixPosition(foot.matrixWorld);
        let dx = 0;
        let dz = 0;
        if (byFoot && holding) {
          // Down only while a sole is on the grass; lifted, it is let go, to land again.
          heelAt.copy(leg.heel).applyMatrix4(foot.matrixWorld);
          ballAt.copy(leg.ball).applyMatrix4(foot.matrixWorld);
          if (Math.min(heelAt.y / scale, ballAt.y / scale - leg.rise) > GROUNDED) {
            leg.down = leg.slack = false;
            continue;
          }
        }
        if (holding) hold(leg, into, share);
        if (leg.held > 1e-3) {
          dx = leg.contact.x - (leg.bearing ? ballAt.x : heelAt.x);
          dz = leg.contact.z - (leg.bearing ? ballAt.z : heelAt.z);
        }
        if (clear > 0 && leg.held < 1e-3) {
          // How far the lower end of the sole is below the clearance it should have.
          heelAt.copy(leg.heel).applyMatrix4(foot.matrixWorld);
          ballAt.copy(leg.ball).applyMatrix4(foot.matrixWorld);
          const low = Math.min(heelAt.y, ballAt.y - leg.rise * scale);
          lift = Math.max(lift, clear - low);
        }
        if (!(leg.held > 1e-3) && !(lift > 1e-3)) continue;
        footTo.set(footAt.x + dx * leg.held, footAt.y + lift, footAt.z + dz * leg.held);
        reachFor(thigh, shin, foot, footTo);
      }
    }

    // How far the lock holds `leg`, `into` its stance (in leg.held), and which end of its
    // sole it holds where (leg.bearing, leg.contact; heelAt and ballAt are left where the
    // clip has them).
    function hold(leg, into, share) {
      const { foot } = leg;
      heelAt.copy(leg.heel).applyMatrix4(foot.matrixWorld);
      ballAt.copy(leg.ball).applyMatrix4(foot.matrixWorld);
      // How high each end is off the ground.
      const heelUp = heelAt.y / scale;
      const ballUp = ballAt.y / scale - leg.rise;
      if (!leg.down) {
        leg.down = true;
        leg.slack = false;
        leg.bearing = heelUp <= ballUp ? 0 : 1;
        leg.contact.copy(leg.bearing ? ballAt : heelAt);
      } else if (leg.bearing === 0 && ballUp < heelUp - ROCK) {
        // Rolling onto the ball: it is held where it is now, by the heel's hold.
        leg.bearing = 1;
        leg.contact.set(ballAt.x + leg.contact.x - heelAt.x, 0, ballAt.z + leg.contact.z - heelAt.z);
      } else if (leg.bearing === 1 && heelUp < ballUp - ROCK) {
        leg.bearing = 0;
        leg.contact.set(heelAt.x + leg.contact.x - ballAt.x, 0, heelAt.z + leg.contact.z - ballAt.z);
      }
      const bearing = leg.bearing ? ballAt : heelAt;
      const off = Math.hypot(leg.contact.x - bearing.x, leg.contact.z - bearing.z) / scale;
      if (off >= LOCK_REACH[1]) leg.slack = true;
      if (leg.slack) return;
      // It holds from the moment the foot lands, where it is, so it takes hold without a jump.
      leg.held = share * (1 - ramp(into, ...LOCK_OUT)) * (1 - ramp(off, ...LOCK_REACH))
        * (1 - ramp(leg.bearing ? ballUp : heelUp, ...LIFTED));
    }

    // Shares idle's weight between the idle variants, changing now and then.
    function standIdle(step, weight) {
      if (idleNow < 0) return;
      idleAt += step;
      if (idleNext < 0 && idleAt >= idleChange && idles.length > 1) {
        idleChanges++;
        idleNext = (idleNow + 1 + Math.floor(hash01(idleSeed, 200 + idleChanges) * (idles.length - 1))) % idles.length;
        idleFade = 0;
      }
      if (idleNext >= 0) {
        idleFade = Math.min(1, idleFade + step / IDLE_FADE);
        if (idleFade >= 1) {
          idleNow = idleNext;
          idleNext = -1;
          idleAt = 0;
          idleChange = mix(...IDLE_CHANGE, hash01(idleSeed, 300 + idleChanges));
        }
      }
      const fade = idleNext >= 0 ? smooth(idleFade) : 0;
      for (let i = 0; i < idles.length; i++) {
        const action = idles[i];
        if (!action) continue;
        action.weight = weight * (i === idleNow ? 1 - fade : i === idleNext ? fade : 0);
        action.time = idle % steps.idles[i].duration;
      }
    }

    // Starts and plays the moves a figure makes of itself from how it moves: a turn on the
    // spot, a cut, a braking step (see TURNING_FAST). Each plays whole, over the loops.
    function moves(step, speed, travel) {
      const yaw = object.rotation.y;
      const way = yaw + travel;
      const turning = lastYaw === null || !(step > 0) ? 0 : wrap(yaw - lastYaw) / step;
      const running = lastWay === null || !(step > 0) || speed < 1 ? 0 : wrap(way - lastWay) / step;
      lastYaw = yaw;
      lastWay = way;
      const slowing = -(ax * Math.sin(way) + az * Math.cos(way));
      // A cut: the run turning sharply, or the body turning sharply at a run (the engine
      // turns the body first and the run follows), towards whichever turns faster.
      const cutting = Math.abs(running) > CUTTING || Math.abs(turning) > TURNING_FAST;
      const cutWay = Math.abs(turning) > Math.abs(running) ? turning : running;
      // Another one-shot (a kick, a gesture) takes the body: no move begins under it.
      let others = 0;
      for (let i = 0; i < acting; i++) if (!slots[i].planted) others = Math.max(others, slots[i].share);
      // A brake gives way to a cut, and ends when the figure runs on instead of stopping.
      if (move.kind === 'brake' && ((cutting && speed > CUTTING_SPEED) || (slowing < BRAKING / 3 && speed > TURNING_SLOW * 2))) fade();
      if (!move.kind && others === 0) {
        if (speed < TURNING_SLOW && Math.abs(turning) > TURNING_FAST) begin('turn', turning > 0 ? 'turn_L' : 'turn_R', speed);
        else if (speed > CUTTING_SPEED && cutting) begin('cut', cutWay > 0 ? 'cut_L' : 'cut_R', speed);
        else if (speed > BRAKING_SPEED && slowing > BRAKING && Math.abs(turning) < TURNING_DONE * 2
          && Math.abs(wrap(travel)) < BRAKING_AHEAD) begin('brake', 'brake', speed);
      }
      if (move.kind) playMove(step, speed, turning, others);
      // One given way this frame or lately fades out, so there is never a frame without either.
      if (fadingMove.name) {
        const fading = fadingMove.share * (1 - (clock - fadingMove.began) / AGAIN_FADE) * (1 - others);
        if (fading > 0 && fadingMove.time < template.described[fadingMove.name].duration) {
          person.act(fadingMove.name, fadingMove.time, fading, 'whole', true);
        } else fadingMove.name = null;
        fadingMove.time += step;
      }
    }

    function playMove(step, speed, turning, others) {
      const clip = template.described[move.name];
      if (move.kind === 'turn') {
        // The clip turns as far as the figure does, then steps out of the turn at its own
        // pace; a longer turn begins another.
        const along = Math.sign(move.total) * turning * step;
        if (Math.abs(turning) < TURNING_DONE || along < 0) move.ending = true;
        // Setting off as it comes round, it runs: the turn fades out.
        if (speed > TURN_MOVING[1]) {
          fade();
          return;
        }
        if (!move.ending) {
          move.turned += Math.max(0, along);
          if (move.turned >= Math.abs(move.total)) {
            // Turned as far as its clip, and turning still: the clip begins again, the last
            // fading out under it.
            move.time = move.to;
            fade();
            begin('turn', fadingMove.name, speed, true);
            move.turned = fadingMove.turned - Math.abs(move.total);
          }
          move.time = move.from + (move.to - move.from) * Math.min(1, move.turned / Math.abs(move.total));
        } else move.time += step;
      } else if (move.kind === 'brake' && clip.speeds) {
        // Through the stop at the figure's own speed, and at the clip's pace once stopped.
        move.time = speed > STOPPED ? Math.max(move.time, timeAt(clip.speeds, speed / scale)) : move.time + step;
      } else if (clip.speeds) {
        move.time += step * clamp(speed / scale / Math.max(0.1, speedAt(clip.speeds, move.time)), ...SPEED_RATE);
      } else move.time = contactTime(clock - move.began - PLANT, -PLANT, clip.contact ?? 0);
      const left = clip.duration - move.time;
      if (left <= 0) {
        move.kind = null;
        return;
      }
      move.share = MOVE_SHARE[move.kind] * clamp((clock - move.began) / 0.08, 0, 1) * clamp(left / 0.2, 0, 1)
        * (move.kind === 'turn' ? 1 - ramp(speed, ...TURN_MOVING) : 1);
      person.act(move.name, move.time, move.share * (1 - others), 'whole', true);
    }

    // The move under way fades out over AGAIN_FADE from where it is, making way for another.
    function fade() {
      fadingMove.name = move.name;
      fadingMove.time = move.time;
      fadingMove.share = move.share;
      fadingMove.turned = move.turned;
      fadingMove.began = clock;
      move.kind = null;
    }

    function begin(kind, name, speed, again = false) {
      const clip = template.described[name];
      if (!clip || !template.clips.has(name) || (!again && clock - lastMove[kind] < MOVE_AGAIN[kind])) return;
      move.kind = kind;
      move.name = name;
      move.began = clock;
      move.ending = false;
      move.turned = 0;
      move.total = (Number.isFinite(clip.turn) ? clip.turn : name.endsWith('_L') ? 90 : -90) * Math.PI / 180;
      const window = Array.isArray(clip.turning) ? clip.turning : [0, clip.duration];
      move.from = window[0];
      move.to = window[1];
      if (kind === 'turn') move.time = move.from;
      else if (kind === 'brake' && clip.speeds) move.time = timeAt(clip.speeds, speed / scale);
      else if (clip.speeds) move.time = Math.max(0, (clip.contact ?? 0) - PLANT);
      else move.time = 0;
      lastMove[kind] = clock;
    }

    // Adds the page's pose over the clips: the hips turned to the stride (gait.yaw) with the
    // chest and neck turned back, the body leant into its acceleration from the feet, and
    // the person's own carriage of its back and arms.
    function pose() {
      if (base) {
        if (hips !== 0) base.quaternion.premultiply(turn.setFromAxisAngle(up, hips));
        const yaw = object.rotation.y;
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const across = ax * c - az * sn; // the acceleration to the figure's left
        const ahead = ax * sn + az * c; // and ahead of it
        const hard = Math.hypot(across, ahead);
        tilt = Math.min(TILT_MOST, TILT * Math.atan(hard / GRAVITY));
        if (tilt > 1e-4) {
          // Leaning towards the acceleration: up tips over towards it.
          tiltAxis.set(ahead / hard, 0, -across / hard).applyQuaternion(toBase);
          base.quaternion.premultiply(turn.setFromAxisAngle(tiltAxis, tilt));
        }
      }
      if (spine) spine.quaternion.multiply(turn.setFromAxisAngle(axes.spine.bend, posture));
      if (chest && hips !== 0) chest.quaternion.multiply(turn.setFromAxisAngle(axes.chest.twist, -COUNTER.chest * hips));
      if (neck && hips !== 0) neck.quaternion.multiply(turn.setFromAxisAngle(axes.neck.twist, -COUNTER.neck * hips));
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        if (arm.upper) arm.upper.quaternion.multiply(turn.setFromAxisAngle(arm.out, armsOut));
        if (arm.fore) arm.fore.quaternion.multiply(turn.setFromAxisAngle(arm.bend, elbows));
      }
    }

    const person = {
      object,
      scale,
      height: look.height,
      look,
      numberCanvas: canvas,
      // The shared locomotion phase, in cycles: the left foot plants at 0, the right at 0.5.
      get phase() { return phase; },
      set phase(value) { phase = fract(value); },
      get rate() { return rate; },
      // How far ahead of the feet the right toe reaches through the ball in the stride
      // shown, in metres: each loop's reach by its weight, at this figure's scale.
      reach() {
        let sum = 0;
        for (let i = 0; i < weights.length; i++) sum += weights[i] * steps.loops[i].reach;
        return sum * scale;
      },
      // The phase of the stride shown at which the right boot meets a carried ball: each
      // loop's `touch` by its weight, `fallback` for loops without one.
      touch(fallback = TOUCH_PHASE) {
        let sum = 0;
        for (let i = 0; i < weights.length; i++) if (weights[i] > 0) sum += weights[i] * (steps.loops[i].touch ?? fallback);
        return sum;
      },
      // Clip `name`'s description from figure.json: duration, contact, loop, speed.
      clip: (name) => template.described[name] ?? null,
      // Writes into `target` the point between the palms, in world space, as last posed.
      hands(target) {
        object.updateWorldMatrix(true, true);
        target.set(0, 0, 0);
        for (const bone of handBones) {
          if (!bone) continue;
          // Along the hand bone, a little past the wrist.
          target.add(bone.localToWorld(palm.set(0, 0.07, 0)));
        }
        return target.multiplyScalar(0.5);
      },
      // Shows one-shot `name` at clip time `time` this frame, taking `share` (0..1) of the
      // body from the loops. A 'play' keeps only its upper body and kicking leg over a
      // running stride, a 'gesture' only its upper body over a walk, and 'whole' always
      // plays in full. Call it every frame the one-shot shows, before update(). A `planted`
      // one keeps its feet on the ground, so the foot lock goes on holding them.
      act(name, time, share, layer = 'play', planted = false) {
        if (!(share > 0) || acting >= SLOTS || !template.clips.has(name)) return;
        const slot = slots[acting++];
        slot.name = name;
        slot.time = time;
        slot.share = Math.min(share, MOST);
        slot.layer = layer;
        slot.planted = planted;
      },
      // Advances the loops by `dt` s for a figure moving over the ground at `speed` m/s,
      // travelling `travel` radians from the way it faces (anticlockwise), and poses it.
      // `sets` (optional) gives each loop set by name ({ dribble, jockey, shield }) the
      // share, 0 to 1, it should have: each comes in and goes over a fraction of a second;
      // and `touchIn`, when above 0, the seconds until the boot is to meet the ball.
      update(dt, speed, travel, sets = null) {
        lastSpeed = speed;
        lastTravel = travel;
        const step = Math.max(0, dt);
        const follow = 1 - Math.exp(-step / SET_BLEND);
        const onBall = sets ? Math.max(sets.dribble || 0, sets.shield || 0) > 0.5 : false;
        const off = Math.abs(wrap(travel));
        if (shuffling) shuffling = !onBall && off > SHUFFLE_SIDE[0] && speed > SHUFFLE_SPEED[2] && speed < SHUFFLE_SPEED[3];
        else shuffling = jockeySet > 0 && !onBall && off > SHUFFLE_SIDE[1] && speed > SHUFFLE_SPEED[0] && speed < SHUFFLE_SPEED[1];
        const shuffle = shuffling ? 1 : 0;
        for (let s = 1; s < setShares.length; s++) {
          let target = sets ? clamp(sets[steps.sets[s].name] || 0, 0, 1) : 0;
          if (s === jockeySet) target = Math.max(target, shuffle);
          setShares[s] += (target - setShares[s]) * follow;
        }
        // The acceleration over the ground, from the velocity drawn, in the figure's space.
        const way = object.rotation.y + travel;
        const vx = speed * Math.sin(way);
        const vz = speed * Math.cos(way);
        if (moved && step > 0) {
          let gx = (vx - lastVx) / step;
          let gz = (vz - lastVz) / step;
          const hard = Math.hypot(gx, gz);
          if (hard > HARDEST) {
            gx *= HARDEST / hard;
            gz *= HARDEST / hard;
          }
          const follow = 1 - Math.exp(-step / ACCELERATION);
          ax += (gx - ax) * follow;
          az += (gz - az) * follow;
        }
        lastVx = vx;
        lastVz = vz;
        moved = true;
        switching.dt = step;
        rate = blendLoops(steps, speed, travel, scale, weights, setShares, style.stride, switching);
        hips = steps.yaw;
        // To meet the ball in `touchIn` s, the stride comes to its touch then, at the nearest
        // pace to its own that does it.
        const touchIn = sets?.touchIn ?? 0;
        if (touchIn > 0 && rate > 0) {
          const ahead = fract(person.touch() - phase);
          const cycles = ahead + Math.max(0, Math.round(rate * touchIn - ahead));
          rate = clamp(cycles / touchIn, rate * STEER[0], rate * STEER[1]);
        }
        phase = fract(phase + rate * step);
        idle += step; // the clock of the loops that do not travel
        for (let i = 0; i < loops.length; i++) {
          const loop = loops[i];
          if (!loop) continue;
          const { duration, speed: made } = steps.loops[i];
          loop.weight = weights[i];
          loop.time = made > 0 ? phase * duration : idle % duration;
        }
        standIdle(step, weights[0]);
        clock += step;
        moves(step, speed, travel);
        // Over the loops, which sum to one, a weight of s / (1 - s) takes a share s.
        frame++;
        const still = 1 - ramp(speed, STILL, steps.walk);
        let takenLeft = 0;
        let takenRight = 0;
        let ownMove = 0; // the share of the figure's own moves, which plant their feet
        for (let i = 0; i < acting; i++) {
          const { name, time, share, layer, planted } = slots[i];
          const clip = template.clips.get(name);
          const at = clamp(time, 0, clip.duration);
          const wholeShare = layer === 'whole' ? share : share * still;
          if (!planted) {
            takenLeft = Math.max(takenLeft, wholeShare);
            takenRight = Math.max(takenRight, layer === 'play' ? share : wholeShare);
          } else ownMove += share;
          if (wholeShare > 0) {
            const whole = action(clip);
            whole.time = at;
            whole.weight = wholeShare / (1 - wholeShare);
          }
          if (layer !== 'whole' && wholeShare < share) {
            const part = action(layeredClip(template, name, layer));
            part.time = at;
            part.weight = share / (1 - share) - (wholeShare > 0 ? wholeShare / (1 - wholeShare) : 0);
          }
        }
        for (let i = 0; i < shown.length; i++) if (shown[i].frame !== frame) shown[i].action.stop();
        const swap = shown;
        shown = next;
        next = swap;
        next.length = 0;
        acting = 0;
        for (let i = 0; i < posed.length; i++) posed[i].quaternion.copy(rests[i]);
        mixer.update(0);
        pose();
        if (lockable) {
          let moving = 0;
          let duty = 0;
          for (let i = 0; i < weights.length; i++) {
            const loop = steps.loops[i];
            if (!(weights[i] > 0) || !(loop.speed > 0)) continue;
            moving += weights[i];
            duty += weights[i] * (loop.duty ?? DUTY);
          }
          shownDuty = moving > 0 ? duty / moving : DUTY;
          lockFeet(moving, shownDuty, takenLeft, takenRight, ownMove > MOVE_FEET);
        }
      },
      // What the figure shows, for tests and debugging.
      state() {
        const blend = {};
        steps.loops.forEach((loop, i) => { if (weights[i] > 0) blend[loop.name] = weights[i]; });
        const acts = shown.map(({ action: a }) => ({ name: a.getClip().name, time: a.time, weight: a.weight }));
        const shares = {};
        steps.sets.forEach((set, s) => { if (s > 0 && setShares[s] > 0) shares[set.name] = setShares[s]; });
        return {
          speed: lastSpeed, travel: lastTravel, rate, phase, loops: blend, sets: shares, acts, reach: person.reach(),
          feet: legs.map(leg => leg.held), duty: shownDuty, hips, tilt, style,
          move: move.kind && { kind: move.kind, name: move.name, time: move.time },
          idle: idleNow >= 0 ? steps.idles[idleNow].name : null,
          idles: Object.fromEntries(steps.idles.map((variant, i) => [variant.name, idles[i]?.weight ?? 0]).filter(([, w]) => w > 0)),
        };
      },
    };
    return person;
  }

  return {
    create,
    dispose() {
      for (const value of owned) value.dispose();
      owned.clear();
      paints.clear();
    },
  };
}
