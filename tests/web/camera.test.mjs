import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/camera.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export function', 'function');

const PITCH = { length: 105, width: 68, goalWidth: 7.32, goalHeight: 2.44 };
const AREA_Z = PITCH.width / 2 + 2.5; // where touchline.js puts the managers

function setup(aspect = 16 / 9) {
  const context = { THREE };
  vm.createContext(context);
  vm.runInContext(source, context);
  const camera = new THREE.PerspectiveCamera(40, aspect, 0.2, 600);
  const broadcast = context.createCamera(camera, PITCH);
  const ball = new THREE.Vector3(0, 0.3, 0);
  const scorer = new THREE.Vector3(48, 0, -3);
  const actors = { ballPosition: ball, getPlayerPosition: (id) => (id === 9 ? scorer : null) };
  const managers = [new THREE.Vector3(-5, 0, AREA_Z), new THREE.Vector3(6, 0, AREA_Z)];
  const touchline = { getManagerPosition: (team) => managers[team] ?? null };
  let now = 0;
  const point = new THREE.Vector3();
  return {
    camera, broadcast, ball, actors, touchline, managers,
    get now() { return now; },
    run(seconds, phase = 'play') {
      for (let t = 0; t < seconds; t += 1 / 60) {
        now += 1 / 60;
        broadcast.update(ball, 1 / 60, now, phase);
      }
      camera.updateMatrixWorld(true);
    },
    // Normalised device coordinates of a scene point: in frame when both are within ±1.
    screen(x, y, z) {
      point.set(x, y, z).project(camera);
      return point.clone();
    },
    inFrame(x, y, z, margin = 1) {
      const p = this.screen(x, y, z);
      return Math.abs(p.x) <= margin && Math.abs(p.y) <= margin && p.z < 1;
    },
  };
}

test('the wide shot keeps both technical areas and the far touchline in frame with play in midfield', () => {
  for (const aspect of [16 / 9, 1513 / 784]) {
    for (const [x, z] of [[0, 0], [-20, 10], [15, 25], [10, -15]]) {
      const t = setup(aspect);
      t.ball.set(x, 0.3, z);
      t.run(4);
      for (const side of [-1, 1]) {
        for (const height of [0, 2.9]) {
          assert.ok(t.inFrame(side * 8, height, AREA_Z), `area ${side} at ${height} m, ball (${x}, ${z})`);
        }
      }
      assert.ok(t.inFrame(0, 0, -PITCH.width / 2), 'far touchline');
      assert.ok(t.inFrame(x, 0.3, z, 0.6), 'ball comfortably in frame');
    }
  }
});

test('the ball stays comfortably in frame anywhere on the pitch', () => {
  for (const [x, z] of [[-52, -34], [52, 34], [-40, 30], [45, -30]]) {
    const t = setup();
    t.ball.set(x, 0.3, z);
    t.run(5);
    assert.ok(t.inFrame(x, 0.3, z, 0.85), `ball at (${x}, ${z}): ${t.screen(x, 0.3, z).toArray()}`);
  }
});

test('after the scorer close-up a goal cuts to the scoring manager while the ball is dead, then back', () => {
  const t = setup();
  t.run(1);
  t.broadcast.handleEvent({ kind: 'goal', team: 1, player: 9 }, t.now, t.actors, t.touchline);
  t.run(3, 'kickoff');
  assert.ok(t.camera.position.distanceTo(t.actors.getPlayerPosition(9)) < 30, 'close on the scorer');
  t.run(1, 'kickoff');
  const manager = t.managers[1];
  assert.ok(t.camera.position.distanceTo(manager) < 15, 'cut to the scoring manager');
  const centre = t.screen(manager.x, 1.3, manager.z);
  assert.ok(Math.abs(centre.x) < 0.2 && Math.abs(centre.y) < 0.2, 'framed on the manager');
  assert.ok(t.camera.position.z < manager.z, 'from the pitch, facing the manager');
  t.managers[1].x = 8; // it follows the manager as it walks
  t.run(0.5, 'kickoff');
  assert.ok(Math.abs(t.screen(8, 1.3, manager.z).x) < 0.25);
  t.run(1.5, 'kickoff');
  assert.ok(t.camera.position.distanceTo(t.managers[1]) < 15, 'for 2.5 s');
  t.run(0.4, 'kickoff');
  assert.ok(t.camera.position.y > 40, 'then cuts straight back to the wide shot');
});

test('a reaction shot never runs in open play', () => {
  const t = setup();
  t.run(1);
  t.broadcast.handleEvent({ kind: 'goal', team: 0, player: 9 }, t.now, t.actors, t.touchline);
  t.run(3.5, 'kickoff');
  t.run(1, 'play'); // the kick-off was taken before the close-up ended
  assert.ok(t.camera.position.distanceTo(t.managers[0]) > 30, 'no cut once play restarted');

  const u = setup();
  u.run(1, 'throw_in');
  u.broadcast.handleEvent({ kind: 'substitution', team: 0, off: 8, on: 26 }, u.now, u.actors, u.touchline);
  u.run(0.5, 'throw_in');
  assert.ok(u.camera.position.distanceTo(u.managers[0]) < 15, 'a substitution cuts to its manager');
  u.run(0.1, 'play');
  assert.ok(u.camera.position.y > 40, 'and the restart cuts back at once');
});

test('one reaction shot at a time, and none without the touchline or the drawn phase', () => {
  const t = setup();
  t.run(1, 'throw_in');
  t.broadcast.handleEvent({ kind: 'substitution', team: 0, off: 8, on: 26 }, t.now, t.actors, t.touchline);
  t.run(1.5, 'throw_in');
  t.broadcast.handleEvent({ kind: 'substitution', team: 1, off: 15, on: 30 }, t.now, t.actors, t.touchline);
  t.run(0.5, 'throw_in');
  assert.ok(t.camera.position.distanceTo(t.managers[0]) < 15, 'still on the first manager');
  t.run(0.6, 'throw_in');
  assert.ok(t.camera.position.y > 40, 'and not extended by the second');

  const old = setup();
  old.run(1, 'throw_in');
  old.broadcast.handleEvent({ kind: 'substitution', team: 0 }, old.now, old.actors);
  old.run(0.5, 'throw_in');
  assert.ok(old.camera.position.y > 40, 'no touchline: no cut');

  const unknown = setup();
  unknown.run(1);
  unknown.broadcast.handleEvent({ kind: 'substitution', team: 0 }, unknown.now, unknown.actors, unknown.touchline);
  for (let i = 0; i < 30; i++) unknown.broadcast.update(unknown.ball, 1 / 60, unknown.now + i / 60);
  assert.ok(unknown.camera.position.y > 40, 'no phase: no cut');
});
