// A stand-in for figure.glb as GLTFLoader returns it, built in code for the page's tests:
// the contract's skeleton, objects, material regions, shape keys and clips, at toy size.
// Every clip moves three marker bones, `hand_L` (upper body), `thigh_R` (kicking leg) and
// `foot_L` (support leg), to [clip code, clip time, 0], so a test can read which clip each
// part of the body shows and at what time.
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
export const ONE_SHOTS = {
  pass: [1, 0.4], shot: [1.1, 0.45], control: [0.6, 0.2], tackle: [1, 0.35], header: [1, 0.4],
  throw_in: [1.2, 0.5], celebrate: [3, 0.8], keeper_dive_L: [1.4, 0.45], keeper_dive_R: [1.4, 0.45],
  keeper_catch: [1, 0.35], keeper_catch_high: [1, 0.4], instruct: [2.8, 1], change: [2.6, 1],
  clap: [2.6, 1], protest: [2.6, 1], cheer: [3, 1], despair: [3, 1],
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
export const CODES = Object.fromEntries([...Object.keys(LOOPS), ...Object.keys(ONE_SHOTS)].map((name, i) => [name, i + 1]));
export const MARKERS = ['hand_L', 'thigh_R', 'foot_L'];

function clip(name, duration) {
  const code = CODES[name];
  const tracks = MARKERS.map(bone => new THREE.VectorKeyframeTrack(`${bone}.position`, [0, duration], [code, 0, 0, code, duration, 0]));
  return new THREE.AnimationClip(name, duration, tracks);
}

// What GLTFLoader gives for the figure: { scene, animations } and figure.json's contents.
export function fixtureGltf() {
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
  const animations = [
    ...Object.entries(LOOPS).map(([name, { duration }]) => clip(name, duration)),
    ...Object.entries(ONE_SHOTS).map(([name, [duration]]) => clip(name, duration)),
  ];
  const clips = {};
  for (const [name, loop] of Object.entries(LOOPS)) clips[name] = { loop: true, ...loop };
  for (const [name, [duration, contact]] of Object.entries(ONE_SHOTS)) clips[name] = { loop: false, duration, contact };
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
