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
    event(kind, fields = {}) { broadcast.handleEvent({ type: 'event', kind, ...fields }, now, actors, touchline); },
    message(team, kind = 'instruction') { broadcast.handleMessage({ type: 'manager', team, kind }, now, touchline); },
    // The manager the camera is on, or -1 for none.
    on() { return managers.findIndex(manager => camera.position.distanceTo(manager) < 15); },
    wide() { return camera.position.y > 40; },
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

test('the wide shot follows play from the stand, at the same distance as before the touchline', () => {
  for (const [x, z] of [[0, 0], [-20, 10], [15, 25], [60, -40]]) {
    const t = setup();
    t.ball.set(x, 0.3, z);
    t.run(6);
    const lookX = Math.max(-PITCH.length * 0.32, Math.min(PITCH.length * 0.32, x * 0.65));
    const lookZ = Math.max(-PITCH.width * 0.2, Math.min(PITCH.width * 0.2, z * 0.34));
    assert.ok(t.camera.position.distanceTo(new THREE.Vector3(lookX, 53, lookZ + 64)) < 0.01, `ball (${x}, ${z})`);
    const centre = t.screen(lookX, 0, lookZ);
    assert.ok(Math.abs(centre.x) < 0.01 && Math.abs(centre.y) < 0.01, 'aimed at the look point');
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
  t.event('goal', { team: 1, player: 9 });
  t.run(3, 'kickoff');
  assert.ok(t.camera.position.distanceTo(t.actors.getPlayerPosition(9)) < 30, 'close on the scorer');
  t.run(1, 'kickoff');
  assert.equal(t.on(), 1, 'cut to the scoring manager');
  const manager = t.managers[1];
  const centre = t.screen(manager.x, 1.3, manager.z);
  assert.ok(Math.abs(centre.x) < 0.2 && Math.abs(centre.y) < 0.2, 'framed on the manager');
  assert.ok(t.camera.position.z < manager.z, 'from the pitch, facing the manager');
  t.managers[1].x = 8; // it follows the manager as it walks
  t.run(0.5, 'kickoff');
  assert.ok(Math.abs(t.screen(8, 1.3, manager.z).x) < 0.25);
  t.run(1.4, 'kickoff');
  assert.equal(t.on(), 1, 'for 2.5 s');
  t.run(0.4, 'kickoff');
  assert.ok(t.wide(), 'then cuts straight back to the wide shot');
});

test('a shot waits for the drawn match to reach its stoppage, and ends when drawn play restarts', () => {
  // The event can be released while the last snapshot of play is still drawn.
  const t = setup();
  t.run(1);
  t.event('goal_kick', { team: 1 });
  t.run(0.1, 'play');
  assert.ok(t.wide());
  t.run(0.5, 'goal_kick');
  assert.equal(t.on(), 0, 'shown once the goal kick is drawn');
  t.run(0.1, 'play');
  assert.ok(t.wide(), 'and gone the frame play restarts');

  // Dropped if the drawn match does not reach a stoppage, without using up a turn.
  const u = setup();
  u.run(1);
  u.event('corner', { team: 0 });
  u.run(1, 'play');
  assert.ok(u.wide());
  u.event('goal_kick', { team: 1 });
  u.run(0.5, 'goal_kick');
  assert.equal(u.on(), 0, 'the home manager still has the first turn');

  // A goal kicked off before the close-up ends gets no manager shot.
  const v = setup();
  v.run(1);
  v.event('goal', { team: 0, player: 9 });
  v.run(3.5, 'kickoff');
  v.run(1, 'play');
  assert.ok(v.wide(), 'no cut once play restarted');
});

test('no shot at a throw-in, even for a substitution or a card', () => {
  const t = setup();
  t.run(1);
  t.event('throw_in', { team: 0 });
  t.event('substitution', { team: 0, off: 8, on: 26 });
  t.run(0.5, 'throw_in');
  assert.ok(t.wide());
  t.run(0.5, 'play');
  t.event('foul', { team: 1, player: 4, fouled: 15 });
  t.event('yellow', { team: 0, player: 4 });
  t.run(0.1, 'play');
  t.run(0.5, 'throw_in');
  assert.ok(t.wide(), 'a card does not cut once the stoppage drawn is a throw-in');
});

test('a card cuts at once to the manager of the carded player', () => {
  const t = setup();
  t.run(1);
  t.event('foul', { team: 0, player: 15, fouled: 7 });
  t.event('yellow', { team: 1, player: 15 });
  t.event('free_kick', { team: 0 });
  t.run(0.3, 'free_kick');
  assert.equal(t.on(), 1, 'the carded team manager');
  t.run(1.8, 'free_kick');
  t.run(0.1, 'play');
  assert.ok(t.wide(), 'back to play when the free kick is taken');
});

test('ordinary restarts cut to the managers in turn, at most once every 25 s, never at a throw-in', () => {
  const t = setup();
  const restart = (kind, phase) => {
    t.event(kind, { team: 0 });
    t.run(0.5, phase);
    const shot = t.on();
    t.run(3, 'play');
    return shot;
  };
  t.run(1);
  assert.equal(restart('throw_in', 'throw_in'), -1, 'a throw-in is taken too quickly');
  assert.equal(restart('goal_kick', 'goal_kick'), 0, 'first restart: home manager');
  t.run(10);
  assert.equal(restart('corner', 'corner'), -1, 'too soon after the last touchline shot');
  t.run(10);
  assert.equal(restart('free_kick', 'free_kick'), 1, 'then the away manager');
  t.run(26);
  t.event('substitution', { team: 0 });
  t.run(1, 'goal_kick');
  assert.equal(t.on(), 0, 'substitutions are not rate-limited');
  t.run(2, 'play');
  assert.equal(restart('corner', 'corner'), -1, 'and count as the last touchline shot');
  assert.equal(restart('penalty', 'penalty'), -1, 'a penalty stays on the penalty');
});

test('a substitution or card during a restart shot takes it over', () => {
  const t = setup();
  t.run(1);
  t.event('goal_kick', { team: 1 });
  t.run(1, 'goal_kick');
  assert.equal(t.on(), 0, 'the restart shot');
  t.event('substitution', { team: 1, off: 15, on: 30 });
  t.run(1.5, 'goal_kick');
  assert.equal(t.on(), 1, 'now the substituting manager');
  t.event('yellow', { team: 0, player: 4 });
  t.run(0.8, 'goal_kick');
  assert.equal(t.on(), 1, 'a card does not interrupt a substitution');
  t.run(0.4, 'goal_kick');
  assert.ok(t.wide(), 'nor extend it past its own 2.5 s');
});

test('the whistles: both managers at half time and a level finish, the winner at full time', () => {
  const both = (t) => [0, 1].every(team => {
    const manager = t.managers[team];
    return t.inFrame(manager.x, 0, manager.z, 0.9) && t.inFrame(manager.x, 2.9, manager.z, 0.9);
  });
  for (const aspect of [16 / 9, 0.6]) {
    const t = setup(aspect);
    t.run(1);
    t.event('half_time', { team: null, score: [1, 0] });
    t.run(0.5, 'half_time');
    assert.ok(t.camera.position.y < 10 && both(t), `half time: a two-shot at ${aspect}`);
    t.run(1.5, 'kickoff');
    assert.ok(!t.wide(), 'held into the second-half kick-off');
    t.run(1, 'kickoff');
    assert.ok(t.wide());
  }
  const level = setup();
  level.run(1);
  level.event('full_time', { team: null, score: [2, 2] });
  level.run(0.5, 'full_time');
  assert.ok(level.camera.position.y < 10 && both(level), 'level: both managers');

  const won = setup();
  won.run(1);
  won.event('full_time', { team: null, score: [0, 1] });
  won.run(3.5, 'full_time');
  assert.equal(won.on(), 1, 'the winning manager, for longer than a cutaway');
  won.run(1, 'full_time');
  assert.ok(won.wide());
});

test('a manager message cuts to that manager only during a long stoppage', () => {
  const t = setup();
  t.run(1, 'goal_kick');
  t.message(1, 'substitution');
  t.run(0.5, 'goal_kick');
  assert.equal(t.on(), 1, 'during a goal kick');
  t.run(2.5, 'play');
  for (const phase of ['play', 'free_kick', 'throw_in']) {
    t.run(0.5, phase);
    t.message(0);
    t.run(0.5, phase);
    assert.ok(t.wide(), `not during ${phase}`);
  }
  t.event('goal', { team: 1, player: 9 });
  t.run(1, 'kickoff');
  t.message(0);
  t.run(2.85, 'kickoff');
  assert.equal(t.on(), 1, 'nor in place of a goal reaction');
});

test('one shot at a time, and none without the touchline or the drawn phase', () => {
  const t = setup();
  t.run(1, 'goal_kick');
  t.event('substitution', { team: 0, off: 8, on: 26 });
  t.run(1.5, 'goal_kick');
  t.event('substitution', { team: 1, off: 15, on: 30 });
  t.run(0.5, 'goal_kick');
  assert.equal(t.on(), 0, 'still on the first manager');
  t.run(0.6, 'goal_kick');
  assert.ok(t.wide(), 'and not extended by the second');

  const old = setup();
  old.run(1, 'goal_kick');
  old.broadcast.handleEvent({ kind: 'substitution', team: 0 }, old.now, old.actors);
  old.run(0.5, 'goal_kick');
  assert.ok(old.wide(), 'no touchline: no cut');

  const unknown = setup();
  unknown.run(1);
  unknown.event('substitution', { team: 0 });
  for (let i = 0; i < 30; i++) unknown.broadcast.update(unknown.ball, 1 / 60, unknown.now + i / 60);
  assert.ok(unknown.wide(), 'no phase: no cut');
});
