// What the human figures cost to draw: 22 players (with their benches, hidden) and six
// touchline figures (two managers, four assistants) built from the exported figure, moved
// for a few seconds of synthetic play with kicks, a dive, a goal and the managers' gestures.
//
//   node --import ./tests/web/three-resolve.mjs tests/web/measure-figures.mjs [figure dir] [frames] [--no-lock]
//
// --no-lock leaves the players' feet unlocked (figures.js), to measure what the lock costs.
//
// Reports the draw calls the renderer would make for them (every figure in view, plus the
// shadow pass), their triangles, the skeletons uploaded per frame, and the CPU time of a
// frame: the players' and touchline's update, the scene's matrices and the bone matrices.
// The GPU's share needs the page: tests/web/measure-page.js measures it in the browser.
import { readFileSync } from 'node:fs';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

const web = new URL('../../src/decision_pitch/web/', import.meta.url);
const args = process.argv.slice(2).filter(arg => arg !== '--no-lock');
const footLock = !process.argv.includes('--no-lock');
const dir = args[0] ? new URL(`${args[0].replace(/\/?$/, '/')}`, `file://${process.cwd()}/`) : new URL('figures/', web);
const frames = Number(args[1] ?? 900);

const context2d = {
  measureText: (text) => ({ width: text.length * 28 }), beginPath() {}, roundRect() {}, fill() {}, fillRect() {},
  fillText() {}, strokeText() {},
};
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => context2d }) };
const { GLTFLoader } = await import('../../src/decision_pitch/web/vendor/three/addons/loaders/GLTFLoader.js');
const { prepareFigure } = await import(new URL('src/figures.js', web).href);
const { createPlayers } = await import(new URL('src/players.js', web).href);
const { createTouchline } = await import(new URL('src/touchline.js', web).href);

const data = readFileSync(new URL('figure.glb', dir));
const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
const info = JSON.parse(readFileSync(new URL('figure.json', dir), 'utf8'));
const figure = prepareFigure(gltf.scene, gltf.animations, info);

const PITCH = { length: 105, width: 68, goalWidth: 7.32, goalHeight: 2.44 };
const squad = (team) => Array.from({ length: 16 }, (_, i) => ({
  id: team * 100 + i + 1, number: i + 1, name: `P${i + 1}`, position: i === 0 ? 'GK' : 'MF',
}));
const teams = [0, 1].map(team => {
  const players = squad(team);
  return {
    name: team ? 'Away' : 'Home', colours: team ? { shirt: '#e0562b', shorts: '#1b1b1b', keeper: '#3fbf6f' } : { shirt: '#1f5fbf', shorts: '#ffffff', keeper: '#f2c230' },
    players: players.slice(0, 11), bench: players.slice(11), manager: team ? 'Away manager' : 'Home manager',
    assistants: ['Assistant one', 'Assistant two'],
  };
});
const scene = new THREE.Scene();
const players = createPlayers(scene, teams, figure, { footLock });
const touchline = createTouchline(scene, teams, PITCH, figure);
const onPitch = teams.flatMap(team => team.players);

// Snapshots at 30 a second: everyone runs a loop of their own at their own pace, a kick
// every half second, the home keeper diving for a while, and the ball moving about.
const STEP = 1 / 30;
function snapshot(k) {
  const t = 1 + k * STEP;
  const touches = [];
  const kicker = onPitch[1 + (Math.floor(t * 2) % 10)];
  const kickAt = Math.floor(t * 2) / 2 + 1 / 60;
  if (t - kickAt < 0.5) touches.push({ player: kicker.id, kind: 'kick', t: kickAt, x: 0, y: 0, z: 0.11 });
  return {
    type: 'snapshot', t, period: 1, phase: 'play', score: [0, 0],
    ball: { x: Math.sin(t) * 20, y: Math.cos(t * 0.7) * 15, z: 0.11, owner: null, touches },
    players: onPitch.map((p, i) => {
      const speed = 0.5 + (i % 8);
      const radius = 4 + (i % 5);
      const a = (t * speed) / radius + i;
      return {
        id: p.id, x: (i - 11) * 4 + Math.cos(a) * radius, y: ((i * 7) % 50) - 25 + Math.sin(a) * radius,
        heading: a + Math.PI / 2, speed, action: 'move', ...(i === 0 && t % 6 < 1 ? { dive: true } : {}),
      };
    }),
  };
}

const skeletons = new Set();
function bones() {
  // As the renderer does once per frame for each skeleton it draws.
  skeletons.clear();
  scene.traverseVisible((node) => { if (node.isSkinnedMesh) skeletons.add(node.skeleton); });
  for (const skeleton of skeletons) skeleton.update();
}

const times = [];
const dt = 1 / 60;
for (let i = 0; i < frames; i++) {
  const now = 1 + i * dt;
  const k = Math.floor((now - 1) / STEP);
  const before = snapshot(k);
  const after = snapshot(k + 1);
  if (i === 300) {
    players.handleEvent({ kind: 'goal', team: 0 }, now);
    touchline.handleEvent({ kind: 'goal', team: 0 }, now);
  }
  if (i % 240 === 120) touchline.handleMessage({ type: 'manager', team: (i / 240) & 1, kind: 'instruction', player: onPitch[3].id }, now);
  const start = performance.now();
  players.update(before, after, (now - before.t) / STEP, dt, now, snapshot(k + 4));
  touchline.update(players.ballPosition, dt, now, players);
  scene.updateMatrixWorld();
  bones();
  times.push(performance.now() - start);
}

// Draw calls as WebGLRenderer makes them, with every figure in view: one per visible mesh
// (per material group when it has several) and sprite, and again for each mesh that casts
// a shadow in the shadow pass.
function count(root) {
  const out = { draws: 0, shadowDraws: 0, triangles: 0, skinned: 0 };
  root.traverseVisible((node) => {
    if (node.isSprite) out.draws++;
    if (!node.isMesh) return;
    const groups = Array.isArray(node.material) ? node.geometry.groups.length : 1;
    out.draws += groups;
    if (node.castShadow) out.shadowDraws += groups;
    const index = node.geometry.index;
    out.triangles += (index ? index.count : node.geometry.attributes.position.count) / 3;
    if (node.isSkinnedMesh) out.skinned++;
  });
  return out;
}
const [playerRoot, touchlineRoot] = [scene.children[0], scene.getObjectByName('touchline')];
const sorted = [...times].slice(60).sort((a, b) => a - b);
const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2);
const report = {
  figure: { file: new URL('figure.glb', dir).pathname, bytes: data.byteLength, clips: figure.clips.size, hair: figure.hairs.length, morphs: figure.morphs.length },
  people: { players: onPitch.length, benchHidden: teams.reduce((n, t) => n + t.bench.length, 0), touchline: touchlineRoot ? touchlineRoot.children.length : 0 },
  players: count(playerRoot),
  touchline: touchlineRoot ? count(touchlineRoot) : null,
  skeletonsPerFrame: skeletons.size,
  cpuFrameMs: { median: pick(0.5), p95: pick(0.95), p99: pick(0.99), worst: sorted.at(-1).toFixed(2), frames: sorted.length },
};
const total = [report.players, report.touchline].filter(Boolean);
report.total = { draws: total.reduce((n, c) => n + c.draws, 0), shadowDraws: total.reduce((n, c) => n + c.shadowDraws, 0), triangles: total.reduce((n, c) => n + c.triangles, 0) };
console.log(JSON.stringify(report, null, 1));
players.dispose();
touchline.dispose();
