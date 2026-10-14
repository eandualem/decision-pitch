// A stand-in for figure.glb as GLTFLoader returns it, built in code for the page's tests:
// the contract's skeleton, objects, material regions, shape keys and clips, at toy size.
// Every clip moves three marker bones, `hand_L` (upper body), `thigh_R` (kicking leg) and
// `foot_L` (support leg), to [clip code, clip time, 0], so a test can read which clip each
// part of the body shows and at what time. `fixtureGltf({ more: true })` adds the clips
// of natural movement: loops in eight directions, the dribble, jockey and shield sets,
// idle variants, turns, cuts, a brake and the new plays.
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

export const LOOPS = {
  idle: { duration: 2 },
  walk: { duration: 1, speed: 1.5, direction: 'forward' },
  jog: { duration: 0.72, speed: 3.5, direction: 'forward' },
  sprint: { duration: 0.6, speed: 7, direction: 'forward' },
  backpedal: { duration: 0.8, speed: 2, direction: 'back' },
  strafe_L: { duration: 0.8, speed: 2, direction: 'left' },
  strafe_R: { duration: 0.8, speed: 2, direction: 'right' },
};
// Loops in eight directions (the run set's sideways and backwards ones step with the hips
// turned), loop sets with their stances, and idle variants. The side shuffle joins the
// jockey set. `duty` is the share of the cycle each foot is planted.
export const MORE_LOOPS = {
  walk_FL: { duration: 1, speed: 1.5, direction: 'forward_left', duty: 0.6 },
  walk_FR: { duration: 1, speed: 1.5, direction: 'forward_right', duty: 0.6 },
  jog_FL: { duration: 0.7, speed: 4, direction: 'forward_left', duty: 0.4 },
  jog_FR: { duration: 0.7, speed: 4, direction: 'forward_right', duty: 0.4 },
  walk_L: { duration: 0.9, speed: 1.4, direction: 'left', duty: 0.6 },
  walk_R: { duration: 0.9, speed: 1.4, direction: 'right', duty: 0.6 },
  jog_L: { duration: 0.6, speed: 4, direction: 'left', duty: 0.4 },
  jog_R: { duration: 0.6, speed: 4, direction: 'right', duty: 0.4 },
  walk_BL: { duration: 0.9, speed: 1.4, direction: 'back_left', duty: 0.6 },
  walk_BR: { duration: 0.9, speed: 1.4, direction: 'back_right', duty: 0.6 },
  jog_BL: { duration: 0.6, speed: 3.6, direction: 'back_left', duty: 0.4 },
  jog_BR: { duration: 0.6, speed: 3.6, direction: 'back_right', duty: 0.4 },
  walk_B: { duration: 0.8, speed: 1.4, direction: 'back', duty: 0.6 },
  jog_B: { duration: 0.5, speed: 3.6, direction: 'back', duty: 0.4 },
  strafe_L: { duration: 0.8, speed: 2, direction: 'left', set: 'jockey', duty: 0.5 },
  strafe_R: { duration: 0.8, speed: 2, direction: 'right', set: 'jockey', duty: 0.5 },
  dribble_slow: { duration: 0.8, speed: 2.5, direction: 'forward', set: 'dribble', touch: 0.4, duty: 0.5 },
  dribble: { duration: 0.6, speed: 4.5, direction: 'forward', set: 'dribble', touch: 0.4, duty: 0.4 },
  dribble_sprint: { duration: 0.5, speed: 7.5, direction: 'forward', set: 'dribble', touch: 0.4, duty: 0.35 },
  dribble_FL: { duration: 0.62, speed: 4, direction: 'forward_left', set: 'dribble', touch: 0.4, duty: 0.4 },
  dribble_FR: { duration: 0.62, speed: 4, direction: 'forward_right', set: 'dribble', touch: 0.4, duty: 0.4 },
  jockey: { duration: 1.2, set: 'jockey' },
  jockey_B: { duration: 0.7, speed: 1.5, direction: 'back', set: 'jockey', duty: 0.55 },
  jockey_BL: { duration: 0.7, speed: 1.5, direction: 'back_left', set: 'jockey', duty: 0.55 },
  jockey_BR: { duration: 0.7, speed: 1.5, direction: 'back_right', set: 'jockey', duty: 0.55 },
  shield: { duration: 1.5, set: 'shield' },
  shield_B: { duration: 1, speed: 0.8, direction: 'back', set: 'shield', duty: 0.6 },
  shield_L: { duration: 0.9, speed: 1, direction: 'left', set: 'shield', duty: 0.6 },
  shield_R: { duration: 0.9, speed: 1, direction: 'right', set: 'shield', duty: 0.6 },
  idle_shift: { duration: 4 },
  idle_hips: { duration: 5 },
  idle_look: { duration: 3.5 },
};
export const ONE_SHOTS = {
  pass: [1, 0.4], shot: [1.1, 0.45], control: [0.6, 0.2], tackle: [1, 0.35], header: [1, 0.4],
  throw_in: [1.2, 0.5], celebrate: [3, 0.8], keeper_dive_L: [1.4, 0.45], keeper_dive_R: [1.4, 0.45],
  keeper_catch: [1, 0.35], keeper_catch_high: [1, 0.4], instruct: [2.8, 1], change: [2.6, 1],
  clap: [2.6, 1], protest: [2.6, 1], cheer: [3, 1], despair: [3, 1],
};
// Turns, cuts and the brake ([duration, contact, fields]) and the new plays.
export const MORE_ONE_SHOTS = {
  turn_L: [0.6, 0, { turn: 90, turning: [0.05, 0.45] }], turn_R: [0.6, 0, { turn: -90, turning: [0.05, 0.45] }],
  cut_L: [0.8333, 0.22, { turn: 60, turning: [0.22, 0.4783], speeds: [[0, 4], [0.22, 4], [0.4783, 3.49], [0.8333, 3.4]] }],
  cut_R: [0.8333, 0.22, { turn: -60, turning: [0.22, 0.4783], speeds: [[0, 4], [0.22, 4], [0.4783, 3.49], [0.8333, 3.4]] }],
  brake: [2.2333, 0.1, { speeds: [[0, 7.5], [1.875, 0]] }],
  tackle_standing: [0.8, 0.3], cross: [1.1, 0.42], pass_lofted: [1.1, 0.42],
};
export const HAIRS = ['hair_bald', 'hair_buzz', 'hair_short', 'hair_curly', 'hair_swept', 'hair_bun'];
const REGIONS = ['skin', 'shirt', 'sleeve', 'hands', 'shorts', 'legs', 'socks', 'boots'];
const MORPHS = {
  build_slim: ['body', 'coat', 'number'], build_broad: ['body', 'coat', 'number'],
  face_wide: ['body', ...HAIRS], face_long: ['body', ...HAIRS], jaw_strong: ['body', ...HAIRS], nose_big: ['body', ...HAIRS],
};
const BONES = [
  ['root', null, [0, 0, 0]], ['hips', 'root', [0, 0.97, 0]], ['spine', 'hips', [0, 0.1, 0]],
  ['chest', 'spine', [0, 0.18, 0]], ['neck', 'chest', [0, 0.22, 0]], ['head', 'neck', [0, 0.13, 0]],
];
for (const [side, x] of [['L', 1], ['R', -1]]) {
  BONES.push(
    [`shoulder_${side}`, 'chest', [x * 0.03, 0.2, 0]], [`upper_arm_${side}`, `shoulder_${side}`, [x * 0.15, 0, 0]],
    [`forearm_${side}`, `upper_arm_${side}`, [x * 0.2, -0.2, 0]], [`hand_${side}`, `forearm_${side}`, [x * 0.18, -0.18, 0]],
    [`thigh_${side}`, 'hips', [x * 0.095, -0.02, 0]], [`shin_${side}`, `thigh_${side}`, [0, -0.44, 0]],
    [`foot_${side}`, `shin_${side}`, [0, -0.43, 0]], [`toe_${side}`, `foot_${side}`, [0, -0.05, 0.14]],
  );
}
export const CODES = Object.fromEntries([...new Set([...Object.keys(LOOPS), ...Object.keys(ONE_SHOTS), ...Object.keys(MORE_LOOPS),
  ...Object.keys(MORE_ONE_SHOTS)])].map((name, i) => [name, i + 1]));
export const MARKERS = ['hand_L', 'thigh_R', 'foot_L'];

// A clip that also holds a bone at a turn of its own all through: the jockey stance holds
// the left forearm 40 degrees about x, as a settled blend does.
export const HELD = { jockey: { bone: 'forearm_L', turn: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 40 * Math.PI / 180) } };

function clip(name, duration) {
  const code = CODES[name];
  const tracks = MARKERS.map(bone => new THREE.VectorKeyframeTrack(`${bone}.position`, [0, duration], [code, 0, 0, code, duration, 0]));
  const held = HELD[name];
  if (held) tracks.push(new THREE.QuaternionKeyframeTrack(`${held.bone}.quaternion`, [0, duration], [...held.turn.toArray(), ...held.turn.toArray()]));
  return new THREE.AnimationClip(name, duration, tracks);
}

// What GLTFLoader gives for the figure: { scene, animations } and figure.json's contents.
export function fixtureGltf({ more = false } = {}) {
  const scene = new THREE.Group();
  const rig = new THREE.Object3D();
  rig.name = 'rig';
  scene.add(rig);
  const bones = new Map();
  for (const [name, parent, position] of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.fromArray(position);
    (parent ? bones.get(parent) : rig).add(bone);
    bones.set(name, bone);
  }
  const list = [...bones.values()];
  const meshes = [];
  const skinned = (name, materialName, morphs, options = {}) => {
    const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4).fill(1), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    geometry.morphAttributes.position = morphs.map(() => new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    const material = new THREE.MeshStandardMaterial({ name: materialName, ...options });
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = name;
    mesh.morphTargetDictionary = Object.fromEntries(morphs.map((m, i) => [m, i]));
    mesh.morphTargetInfluences = morphs.map(() => 0);
    meshes.push(mesh);
    return mesh;
  };
  const morphsOf = (object) => Object.keys(MORPHS).filter(m => MORPHS[m].includes(object));
  // A mesh with several materials loads as a group of one mesh per material.
  const body = new THREE.Group();
  body.name = 'body';
  rig.add(body);
  for (const [i, region] of [...REGIONS, 'eyes'].entries()) {
    body.add(skinned(i ? `body_${i}` : 'body_0', region, morphsOf('body'), region === 'eyes' ? { vertexColors: true } : {}));
  }
  rig.add(skinned('coat', 'coat', morphsOf('coat')));
  rig.add(skinned('number', 'number', morphsOf('number')));
  for (const hair of HAIRS) rig.add(skinned(hair, 'hair', morphsOf(hair)));
  scene.updateMatrixWorld(true);
  // GLTFLoader gives each mesh its own skeleton over the same bones.
  for (const mesh of meshes) mesh.bind(new THREE.Skeleton(list), mesh.matrixWorld);
  const loops = more ? { ...LOOPS, ...MORE_LOOPS } : LOOPS;
  const oneShots = more ? { ...ONE_SHOTS, ...MORE_ONE_SHOTS } : ONE_SHOTS;
  const animations = [
    ...Object.entries(loops).map(([name, { duration }]) => clip(name, duration)),
    ...Object.entries(oneShots).map(([name, [duration]]) => clip(name, duration)),
  ];
  const clips = {};
  for (const [name, loop] of Object.entries(loops)) clips[name] = { loop: true, ...loop };
  for (const [name, [duration, contact, fields]] of Object.entries(oneShots)) clips[name] = { loop: false, duration, contact, ...fields };
  const info = {
    height: 1.8, armature: 'rig', body: 'body', coat: 'coat', number: 'number', hair: HAIRS,
    materials: { regions: [...REGIONS, 'hair', 'number', 'coat'], fixed: ['eyes'] },
    morphs: MORPHS, clips,
  };
  return { scene, animations, info };
}

// The world position of the bone `name` in `object`.
export function markerOf(object, name) {
  object.updateMatrixWorld(true);
  return object.getObjectByName(name).position;
}
