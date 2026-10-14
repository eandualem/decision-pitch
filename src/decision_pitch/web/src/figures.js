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
const SET_BLEND = 0.18; // s over which a set (dribble, jockey, shield) comes in or goes
export const TOUCH_PHASE = 0.4; // where a loop without a `touch` meets a carried ball
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
    });
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
  }
  const forward = run.length ? run[sets[0].ahead].ladder : [0];
  const walk = forward.length > 1 ? loops[forward[1]].speed : 1.5;
  const scratch = 3; // the forward step and the two directions either side of the travel
  return {
    loops, idles, sets, walk, shuffle: SHUFFLE[1],
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
export function blendLoops(gait, speed, travel, scale, weights, shares = null, stride = 1) {
  weights.fill(0);
  const { sets } = gait;
  let others = 0;
  if (shares) for (let s = 1; s < sets.length; s++) if (shares[s] > 0) others += shares[s];
  const norm = others > 1 ? 1 / others : 1;
  const moving = speed > 0;
  const pace = speed / scale; // the speed a figure of scale 1 would move at
  let length = 0;
  for (let s = 0; s < sets.length; s++) {
    const share = s === 0 ? Math.max(0, 1 - others) : shares && shares[s] > 0 ? shares[s] * norm : 0;
    if (!(share > 0)) continue;
    if (moving) length += share * blendSet(gait, sets[s], pace, travel, stride, weights, share);
    else weights[sets[s].rest] += share;
  }
  return moving && length > 1e-9 ? speed / (scale * length) : 0;
}

// One set's part of the blend, weighted by `share`; returns its blended stride's length.
function blendSet(gait, set, pace, travel, stride, weights, share) {
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
    // Along the travel: it is a sum of the directions either side, a.u + b.v, and each
    // takes a share of the blend in proportion to its part over its stride, so the
    // strides add up along the travel.
    const n = dirs.length;
    const heading = wrap(travel);
    let a = n - 1;
    for (let i = 0; i < n && dirs[i].angle <= heading; i++) a = i;
    const b = (a + 1) % n;
    const from = around(heading - dirs[a].angle);
    const gap = n > 1 ? around(dirs[b].angle - dirs[a].angle) : TAU;
    let alongA = 1;
    let alongB = 0;
    if (gap < Math.PI - SAME) {
      alongA = Math.sin(gap - from) / Math.sin(gap);
      alongB = Math.sin(from) / Math.sin(gap);
    } else if (gap - from < from) {
      alongA = 0;
      alongB = 1;
    }
    pick(gait, dirs[a].ladder, select, 1);
    pick(gait, dirs[b].ladder, select, 2);
    const { stride: strides, x, y } = gait;
    const wa = alongA > 0 && strides[1] > 0 ? alongA / strides[1] : 0;
    const wb = alongB > 0 && strides[2] > 0 ? alongB / strides[2] : 0;
    const total = wa + wb;
    if (total > 0) {
      place(gait, weights, 1, share * across * wa / total);
      place(gait, weights, 2, share * across * wb / total);
      // Loops borrowed from another direction keep its stride: count them along their own.
      length += across * Math.hypot((wa * x[1] + wb * x[2]) / total, (wa * y[1] + wb * y[2]) / total);
    } else weights[set.rest] += share * across;
  }
  return length;
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

// A string or number seed as a non-negative integer.
function seedOf(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.abs(Math.round(seed));
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash % 1000003;
}

// A person's look from its id: height, skin, hair style and colour, sleeves and the build
// and face shape keys. The same seed gives the same look everywhere. `greying` people
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
  return {
    scene, info, clips, described, hairs, morphs, soles,
    gait: steps,
    layered: { play: new Map(), gesture: new Map() }, // clips with only that layer's tracks
    twins: new Map(),
    parts: { body: info.body ?? 'body', coat: info.coat ?? 'coat', number: info.number ?? 'number' },
  };
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
const LOCK_REACH = [0.12, 0.25]; // m a foot is held over, beyond which the lock gives way
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
    // Bones the page poses over the clips start each frame from their rest, in case no
    // clip keys them.
    const posed = lockable ? legs.flatMap(leg => [leg.thigh, leg.shin, leg.foot]) : [];
    const rests = posed.map(bone => bone.quaternion.clone());
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
    const slots = Array.from({ length: SLOTS }, () => ({ name: null, time: 0, share: 0, layer: 'play' }));
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
    function lockFeet(moving, duty, takenLeft, takenRight) {
      let updated = null;
      for (let i = 0; i < 2; i++) {
        const leg = legs[i];
        const into = fract(phase - leg.start) / duty; // how far through its stance
        const share = moving * (1 - (i === 0 ? takenLeft : takenRight));
        leg.held = 0;
        if (!(into < LOCK_OUT[1]) || !(share > 1e-3)) {
          leg.down = leg.slack = false;
          continue;
        }
        const { thigh, shin, foot } = leg;
        if (updated !== thigh.parent) {
          thigh.parent.updateWorldMatrix(true, false);
          updated = thigh.parent;
        }
        placeBone(thigh);
        placeBone(shin);
        placeBone(foot);
        footAt.setFromMatrixPosition(foot.matrixWorld);
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
        const up = leg.bearing ? ballUp : heelUp;
        const dx = leg.contact.x - bearing.x;
        const dz = leg.contact.z - bearing.z;
        const off = Math.hypot(dx, dz) / scale;
        if (off >= LOCK_REACH[1]) leg.slack = true;
        if (leg.slack) continue;
        // It holds from the moment the foot lands, where it is, so it takes hold without a jump.
        leg.held = share * (1 - ramp(into, ...LOCK_OUT)) * (1 - ramp(off, ...LOCK_REACH))
          * (1 - ramp(up, ...LIFTED));
        if (!(leg.held > 1e-3)) continue;
        footTo.set(footAt.x + dx * leg.held, footAt.y, footAt.z + dz * leg.held);
        reachFor(thigh, shin, foot, footTo);
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
      // plays in full. Call it every frame the one-shot shows, before update().
      act(name, time, share, layer = 'play') {
        if (!(share > 0) || acting >= SLOTS || !template.clips.has(name)) return;
        const slot = slots[acting++];
        slot.name = name;
        slot.time = time;
        slot.share = Math.min(share, MOST);
        slot.layer = layer;
      },
      // Advances the loops by `dt` s for a figure moving over the ground at `speed` m/s,
      // travelling `travel` radians from the way it faces (anticlockwise), and poses it.
      // `sets` (optional) gives each loop set by name ({ dribble, jockey, shield }) the
      // share, 0 to 1, it should have: each comes in and goes over a fraction of a second.
      update(dt, speed, travel, sets = null) {
        lastSpeed = speed;
        lastTravel = travel;
        const step = Math.max(0, dt);
        const follow = 1 - Math.exp(-step / SET_BLEND);
        for (let s = 1; s < setShares.length; s++) {
          const target = sets ? clamp(sets[steps.sets[s].name] || 0, 0, 1) : 0;
          setShares[s] += (target - setShares[s]) * follow;
        }
        rate = blendLoops(steps, speed, travel, scale, weights, setShares);
        phase = fract(phase + rate * step);
        idle += step; // the clock of the loops that do not travel
        for (let i = 0; i < loops.length; i++) {
          const loop = loops[i];
          if (!loop) continue;
          const { duration, speed: made } = steps.loops[i];
          loop.weight = weights[i];
          loop.time = made > 0 ? phase * duration : idle % duration;
        }
        // Over the loops, which sum to one, a weight of s / (1 - s) takes a share s.
        frame++;
        const still = 1 - ramp(speed, STILL, steps.walk);
        let takenLeft = 0;
        let takenRight = 0;
        for (let i = 0; i < acting; i++) {
          const { name, time, share, layer } = slots[i];
          const clip = template.clips.get(name);
          const at = clamp(time, 0, clip.duration);
          const wholeShare = layer === 'whole' ? share : share * still;
          takenLeft = Math.max(takenLeft, wholeShare);
          takenRight = Math.max(takenRight, layer === 'play' ? share : wholeShare);
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
          lockFeet(moving, shownDuty, takenLeft, takenRight);
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
          feet: legs.map(leg => leg.held), duty: shownDuty,
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
