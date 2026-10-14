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
const SIDEWAYS = 1; // m/s above a walk over which the direction of travel comes in
const STILL = 0.4; // m/s below which a one-shot plays with its whole body
const MOST = 0.999; // the largest share of a bone a one-shot takes from the loops

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const ramp = (value, low, high) => smooth(clamp((value - low) / (high - low), 0, 1));
const fract = (value) => value - Math.floor(value);

// The directions loops travel in, anticlockwise from the way the figure faces (so its
// left is +pi/2), in the order of `gait().groups`.
const DIRECTIONS = ['forward', 'left', 'back', 'right'];
const ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const NAMED = { walk: 'forward', jog: 'forward', sprint: 'forward', backpedal: 'back', strafe_L: 'left', strafe_R: 'right' };

// What a one-shot keeps when it plays over the loops: a play keeps the upper body and the
// kicking (right) leg over a running stride, a gesture only the upper body over a walk.
const ARMS = ['spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R', 'upper_arm_L', 'upper_arm_R',
  'forearm_L', 'forearm_R', 'hand_L', 'hand_R'];
const LAYERS = {
  play: new Set([...ARMS, 'thigh_R', 'shin_R', 'foot_R', 'toe_R']),
  gesture: new Set(ARMS),
};

// Skin tones, lightest first, and the hair colours that go with each.
export const SKINS = ['#f2cfb1', '#e2b48e', '#c99168', '#a8704a', '#80502f', '#5b3720'];
export const HAIRS = ['#15100c', '#2c1d14', '#4b3020', '#6f4a2b', '#a47c47', '#7b3a1d', '#8e8a85'];
const HAIR_FOR_SKIN = [[1, 2, 3, 4, 5, 0, 6], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 1, 6], [0, 1, 0, 2, 6], [0, 1, 0, 6], [0, 0, 1, 6]];
const BOOTS = '#151a20';
const SHOES = '#101317';
const TROUSERS = '#252a31';
const UNDERSHIRT = '#eef1f4';
// Weyl sequences: consecutive ids land far apart in each, so a team does not repeat itself.
const SPREAD = [0.6180339887, 0.4142135624, 0.7320508076, 0.2360679775, 0.6457513111, 0.3166247904, 0.6055512755, 0.1231056256, 0.3588989435];

const DEFAULT_REGIONS = ['skin', 'shirt', 'sleeve', 'hands', 'shorts', 'legs', 'socks', 'boots', 'hair', 'number', 'coat'];
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

// The loops grouped by the direction they travel, each group from slowest to fastest, with
// the stride each covers in one cycle. Index 0 is idle. A direction without loops of its
// own borrows the forward ones.
export function gait(clips) {
  const loops = [{ name: 'idle', duration: clips.idle?.duration || 1, speed: 0, angle: 0, stride: 0 }];
  const groups = DIRECTIONS.map(() => []);
  for (const [name, clip] of Object.entries(clips)) {
    const direction = DIRECTIONS.indexOf(clip.direction ?? NAMED[name]);
    if (!clip.loop || !(clip.speed > 0) || !(clip.duration > 0) || direction < 0) continue;
    groups[direction].push(loops.length);
    loops.push({ name, duration: clip.duration, speed: clip.speed, angle: ANGLES[direction], stride: clip.speed * clip.duration });
  }
  for (const group of groups) group.sort((a, b) => loops[a].speed - loops[b].speed);
  for (let d = 1; d < groups.length; d++) if (!groups[d].length) groups[d] = groups[0];
  const walk = groups[0].length ? loops[groups[0][0]].speed : 1.5;
  return { loops, groups, walk, lower: new Int32Array(4), upper: new Int32Array(4), t: new Float64Array(4), stride: new Float64Array(4) };
}

// Blends the loops for a figure moving over the ground at `speed` m/s, travelling at
// `travel` radians from the way it faces (anticlockwise, so +pi/2 is to its left), drawn
// at `scale`. Writes each loop's weight into `weights` (indexed like `gait.loops`, summing
// to 1) and returns the shared cycle's rate in cycles per second.
//
// Each direction blends the two loops either side of the speed (over the scale: a taller
// figure's stride is longer). The directions share out so that the blended stride points
// along the travel, and played at the returned rate that stride covers the ground at
// exactly `speed`, so the planted foot stays put. At a walk's pace or less the travel is
// ignored and the figure walks forwards; just above it the two blends cross-fade.
export function blendLoops(gait, speed, travel, scale, weights) {
  weights.fill(0);
  if (!(speed > 0)) {
    weights[0] = 1;
    return 0;
  }
  const { loops, groups, lower, upper, t, stride } = gait;
  const pace = speed / scale; // the speed a figure of scale 1 would move at
  for (let d = 0; d < 4; d++) {
    const group = groups[d];
    if (!group.length) {
      lower[d] = upper[d] = 0;
      t[d] = 0;
      stride[d] = 0;
      continue;
    }
    let k = 0;
    while (k < group.length && loops[group[k]].speed < pace) k++;
    if (k === group.length) {
      lower[d] = upper[d] = group[k - 1];
      t[d] = 1;
    } else {
      lower[d] = k > 0 ? group[k - 1] : 0;
      upper[d] = group[k];
      const from = loops[lower[d]].speed;
      t[d] = (pace - from) / (loops[upper[d]].speed - from);
    }
    stride[d] = loops[lower[d]].stride * (1 - t[d]) + loops[upper[d]].stride * t[d];
  }
  const across = ramp(pace, gait.walk, gait.walk + SIDEWAYS);
  // Forwards, whatever the travel.
  let length = (1 - across) * stride[0];
  add(gait, weights, 0, 1 - across);
  if (across > 0) {
    // Along the travel: each direction's share of it over its stride, so the strides add
    // up along the travel, and the blended stride is as long as their sum's reciprocal.
    const c = Math.cos(travel);
    const s = Math.sin(travel);
    let total = 0;
    for (let d = 0; d < 4; d++) {
      const along = d === 0 ? c : d === 1 ? s : d === 2 ? -c : -s;
      if (along > 0 && stride[d] > 0) total += along / stride[d];
    }
    if (total > 0) {
      for (let d = 0; d < 4; d++) {
        const along = d === 0 ? c : d === 1 ? s : d === 2 ? -c : -s;
        if (along > 0 && stride[d] > 0) add(gait, weights, d, across * along / stride[d] / total);
      }
      // Loops borrowed from another direction keep its stride: count them along their own.
      let dx = 0;
      let dy = 0;
      for (let d = 0; d < 4; d++) {
        const along = d === 0 ? c : d === 1 ? s : d === 2 ? -c : -s;
        if (!(along > 0 && stride[d] > 0)) continue;
        const angle = loops[upper[d]].angle;
        const share = along / stride[d] / total;
        dx += share * stride[d] * Math.cos(angle);
        dy += share * stride[d] * Math.sin(angle);
      }
      length += across * Math.hypot(dx, dy);
    } else {
      add(gait, weights, 0, across);
      length += across * stride[0];
    }
  }
  return length > 1e-9 ? speed / (scale * length) : 0;
}

function add(gait, weights, d, share) {
  if (!(share > 0)) return;
  weights[gait.lower[d]] += share * (1 - gait.t[d]);
  weights[gait.upper[d]] += share * gait.t[d];
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
// and face shape keys. The same seed gives the same look everywhere.
export function variation(seed, { hairs = 1, morphs = [] } = {}) {
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
    hairColour: hairColours[Math.floor(at(3) * hairColours.length)],
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
    return { skin, hair, shirt: UNDERSHIRT, sleeve: shirt, hands: skin, shorts: TROUSERS, legs: TROUSERS, socks: TROUSERS, boots: SHOES, coat: shirt };
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
  const regions = new Set(info.materials?.regions ?? DEFAULT_REGIONS);
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
  return {
    scene, info, clips, described, hairs, morphs,
    gait: gait(described),
    layered: { play: new Map(), gesture: new Map() }, // clips with only that layer's tracks
    parts: { body: info.body ?? 'body', coat: info.coat ?? 'coat', number: info.number ?? 'number' },
  };
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

// Makes the people of one match from `template` (see loadFigure). Materials are shared
// between them and freed by dispose(); the template's geometry and clips are never freed.
export function createFigures(template) {
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
    const look = variation(seed, { hairs: template.hairs.length, morphs: template.morphs });
    const palette = outfit(role, colours, look);
    const object = cloneScene(template.scene);
    shareSkeletons(template.scene, object);
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

    function action(clip) {
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
      // Clip `name`'s description from figure.json: duration, contact, loop, speed.
      clip: (name) => template.described[name] ?? null,
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
      update(dt, speed, travel) {
        lastSpeed = speed;
        lastTravel = travel;
        rate = blendLoops(steps, speed, travel, scale, weights);
        phase = fract(phase + rate * Math.max(0, dt));
        idle = (idle + Math.max(0, dt)) % steps.loops[0].duration;
        for (let i = 0; i < loops.length; i++) {
          const loop = loops[i];
          if (!loop) continue;
          loop.weight = weights[i];
          loop.time = i === 0 ? idle : phase * steps.loops[i].duration;
        }
        // Over the loops, which sum to one, a weight of s / (1 - s) takes a share s.
        frame++;
        const still = 1 - ramp(speed, STILL, steps.walk);
        for (let i = 0; i < acting; i++) {
          const { name, time, share, layer } = slots[i];
          const clip = template.clips.get(name);
          const at = clamp(time, 0, clip.duration);
          const wholeShare = layer === 'whole' ? share : share * still;
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
        mixer.update(0);
      },
      // What the figure shows, for tests and debugging.
      state() {
        const blend = {};
        steps.loops.forEach((loop, i) => { if (weights[i] > 0) blend[loop.name] = weights[i]; });
        const acts = shown.map(({ action: a }) => ({ name: a.getClip().name, time: a.time, weight: a.weight }));
        return { speed: lastSpeed, travel: lastTravel, rate, phase, loops: blend, acts };
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
