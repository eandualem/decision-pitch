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
  const others = []; // other players near the scorer, for the close-up to keep clear of
  const look = { yaw: null }; // the scorer's drawn facing, when a test sets it
  const actors = {
    ballPosition: ball,
    getPlayerPosition: (id) => (id === 9 ? scorer : others[id - 100] ?? null),
    getPlayerFacing: (id) => (id === 9 ? look.yaw : null),
    getPlayerVelocity: (id, out) => (id === 9 && look.velocity ? out.copy(look.velocity) : null),
    forEachPlayerPosition(visit) {
      visit(9, scorer);
      others.forEach((position, i) => visit(100 + i, position));
    },
  };
  const managers = [new THREE.Vector3(-5, 0, AREA_Z), new THREE.Vector3(6, 0, AREA_Z)];
  const touchline = { getManagerPosition: (team) => managers[team] ?? null };
  let now = 0;
  const point = new THREE.Vector3();
  return {
    camera, broadcast, ball, actors, touchline, managers, scorer, others, look,
    get now() { return now; },
    event(kind, fields = {}) { broadcast.handleEvent({ type: 'event', kind, ...fields }, now, actors, touchline); },
    message(team, kind = 'instruction') { broadcast.handleMessage({ type: 'manager', team, kind }, now, touchline); },
    // The manager the camera is on, or -1 for none.
    on() { return managers.findIndex(manager => camera.position.distanceTo(manager) < 15); },
    wide() { return camera.fov < 30 && camera.position.y > 15; },
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

test('the wide shot follows play from the stand like a broadcast main camera', () => {
  const down = THREE.MathUtils.degToRad(22);
  for (const [x, z] of [[0, 0], [-20, 10], [15, 25], [60, -40]]) {
    const t = setup();
    t.ball.set(x, 0.3, z);
    t.run(8);
    // It follows part of the ball's way, but keeps the ball well inside the frame.
    const lookZ = Math.max(z - 12, Math.min(z + 30, Math.max(-PITCH.width * 0.35, Math.min(PITCH.width * 0.35, z * 0.55))));
    const side = 15 - 0.3 * Math.max(0, z - lookZ);
    const lookX = Math.max(x - side, Math.min(x + side, Math.max(-PITCH.length * 0.42, Math.min(PITCH.length * 0.42, x * 0.85))));
    const expected = new THREE.Vector3(lookX, 72 * Math.sin(down), lookZ + 72 * Math.cos(down));
    assert.ok(t.camera.position.distanceTo(expected) < 0.02, `ball (${x}, ${z}): ${t.camera.position.toArray()}`);
    const centre = t.screen(lookX, 0, lookZ);
    assert.ok(Math.abs(centre.x) < 0.01 && Math.abs(centre.y) < 0.01, 'aimed at the look point');
    assert.ok(Math.abs(t.camera.fov - 22) < 1e-6, 'through a longer lens than the close-ups');
    // A player at the look point stands about 43 px tall in a 720p frame.
    const height = (t.screen(lookX, 1.8, lookZ).y - t.screen(lookX, 0, lookZ).y) / 2 * 720;
    assert.ok(height > 40 && height < 47, `a player ${height.toFixed(1)} px tall`);
    // And the frame shows about 50 m of pitch across at that depth.
    const across = 2 * 72 * Math.tan(THREE.MathUtils.degToRad(11)) * (16 / 9);
    assert.ok(across > 45 && across < 52, `${across.toFixed(1)} m across`);
  }
});

test('the play around the ball stays in frame, and a fast switch of play never leaves it', () => {
  for (const [x, z] of [[-52, -34], [52, 34], [0, 30], [30, -30]]) {
    const t = setup();
    t.ball.set(x, 0.3, z);
    t.run(5);
    for (const [dx, dz] of [[12, 0], [-12, 0], [0, 10], [0, -10]]) {
      const px = Math.max(-52.5, Math.min(52.5, x + dx));
      const pz = Math.max(-34, Math.min(34, z + dz));
      assert.ok(t.inFrame(px, 1.8, pz, 0.95), `a player ${dx}, ${dz} from the ball at (${x}, ${z})`);
    }
  }
  // Long balls and switches across the pitch at the speed of a driven pass.
  for (const [[x0, z0], [x1, z1], speed] of [[[-45, 30], [45, -30], 30], [[0, -30], [0, 30], 25], [[30, 20], [-35, -20], 30]]) {
    const t = setup();
    t.ball.set(x0, 0.3, z0);
    t.run(3);
    const time = Math.hypot(x1 - x0, z1 - z0) / speed;
    let worst = 0;
    let pulled = 0;
    for (let s = 0; s <= time + 1; s += 1 / 60) {
      const f = Math.min(1, s / time);
      t.ball.set(x0 + (x1 - x0) * f, 0.3 + Math.sin(Math.PI * f) * 6, z0 + (z1 - z0) * f);
      t.run(1 / 60);
      const p = t.screen(t.ball.x, t.ball.y, t.ball.z);
      worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
      pulled = Math.max(pulled, t.camera.position.y);
    }
    assert.ok(worst < 0.9, `ball in frame across ${x0},${z0} -> ${x1},${z1}: ${worst}`);
    assert.ok(pulled > 28, 'the shot pulls back a little for a fast ball');
  }
});

test('a ball placed for a restart is not led as if it had been kicked', () => {
  const t = setup();
  t.ball.set(-30, 0.3, 10);
  t.run(3);
  t.ball.set(0, 0.3, 0); // the kick-off spot, in one frame
  t.run(6);
  const down = THREE.MathUtils.degToRad(22);
  const spot = new THREE.Vector3(0, 72 * Math.sin(down), 72 * Math.cos(down));
  assert.ok(t.camera.position.distanceTo(spot) < 0.05, `settled on the spot: ${t.camera.position.toArray()}`);
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
  assert.ok(t.broadcast.wide);
  t.event('goal', { team: 1, player: 9 });
  t.run(3, 'kickoff');
  assert.ok(t.camera.position.distanceTo(t.actors.getPlayerPosition(9)) < 30, 'close on the scorer');
  assert.ok(!t.broadcast.wide, 'the close-up is not the wide shot');
  t.run(1, 'kickoff');
  assert.equal(t.on(), 1, 'cut to the scoring manager');
  assert.equal(t.camera.fov, 40, 'through the close-ups\' lens');
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
    t.run(3, 'half_time');
    assert.ok(both(t) && !t.broadcast.wide, 'for the whole break, longer than a cutaway');
    t.run(1 / 60, 'kickoff');
    assert.ok(t.wide() && t.broadcast.wide, 'back on the wide shot as the second half kicks off');
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

  const snapshot = setup();
  snapshot.run(1);
  snapshot.event('substitution', { team: 1 });
  for (let i = 1; i <= 30; i++) snapshot.broadcast.update(snapshot.ball, 1 / 60, snapshot.now + i / 60, { phase: 'goal_kick' });
  assert.equal(snapshot.on(), 1, 'the drawn snapshot serves as well as its phase');

  const unknown = setup();
  unknown.run(1);
  unknown.event('substitution', { team: 0 });
  for (let i = 0; i < 30; i++) unknown.broadcast.update(unknown.ball, 1 / 60, unknown.now + i / 60);
  assert.ok(unknown.wide(), 'no phase: no cut');
});

test('each match starts from the page\'s own lens, whatever the last one left', () => {
  const first = setup();
  first.run(2);
  assert.ok(first.camera.fov < 30, 'the wide shot narrows the lens');
  first.broadcast.dispose();
  assert.equal(first.camera.fov, 40, 'and dispose hands it back');
  // The same page camera for the next match, after a hello or a reconnect.
  const context = { THREE };
  vm.createContext(context);
  vm.runInContext(source, context);
  first.camera.fov = 22; // even if it was left narrow
  first.camera.updateProjectionMatrix();
  const next = context.createCamera(first.camera, PITCH);
  const actors = { ballPosition: new THREE.Vector3(), getPlayerPosition: () => new THREE.Vector3(10, 0, 5) };
  next.handleEvent({ type: 'event', kind: 'goal', team: 0, player: 9 }, 0, actors, null);
  for (let i = 1; i <= 60; i++) next.update(actors.ballPosition, 1 / 60, i / 60, 'kickoff');
  assert.ok(Math.abs(first.camera.fov - 30) < 0.5, `the goal close-up through its own lens, not the wide one: ${first.camera.fov}`);
});

// The close-up's framing, measured: the scorer's share of the frame's height, the camera's
// distance over the ground, and how clear it keeps of everything around it.
function closeUpCheck(t) {
  const { scorer } = t;
  const feet = t.screen(scorer.x, 0, scorer.z);
  const head = t.screen(scorer.x, 1.8, scorer.z);
  const share = (head.y - feet.y) / 2;
  const distance = Math.hypot(t.camera.position.x - scorer.x, t.camera.position.z - scorer.z);
  const nearest = Math.min(Infinity, ...t.others.map(o => Math.hypot(o.x - t.camera.position.x, o.z - t.camera.position.z)));
  const framed = [feet, head].every(p => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1);
  return { share, distance, nearest, framed, position: t.camera.position.clone() };
}

const insideGoal = (p) => Math.abs(p.x) > PITCH.length / 2 - 0.6 && Math.abs(p.x) < PITCH.length / 2 + 2.8 &&
  Math.abs(p.z) < PITCH.goalWidth / 2 + 0.6 && p.y < PITCH.goalHeight + 0.6;

test('the scorer close-up fills about half the frame from 6-8 m, a little low, and follows the celebration', () => {
  const t = setup();
  t.scorer.set(20, 0, -5);
  t.run(1);
  t.event('goal', { team: 1, player: 9 });
  let worst = 1;
  for (let s = 0; s < 3.7; s += 1 / 60) {
    // The scorer runs off to celebrate at 4 m/s.
    t.scorer.x += 4 / 60;
    t.run(1 / 60, 'kickoff');
    const c = closeUpCheck(t);
    if (s > 0.3) assert.ok(c.framed, `scorer framed at ${s.toFixed(2)} s`);
    if (s > 1.2) {
      assert.ok(c.share > 0.4 && c.share < 0.6, `about half the frame's height: ${c.share.toFixed(2)}`);
      assert.ok(c.distance > 6 && c.distance < 8, `6-8 m away: ${c.distance.toFixed(2)}`);
      worst = Math.min(worst, c.share);
      assert.ok(t.camera.position.y > 0.5 && t.camera.position.y < 1.8, 'a little low, never under the pitch');
    }
  }
  assert.ok(Math.abs(t.camera.fov - 30) < 0.5, 'through the close-up lens');
  assert.ok(t.camera.position.z > t.scorer.z, 'from the broadcast camera\'s side');
});

test('the close-up keeps clear of the goal, the stands and the players round the scorer', () => {
  const cases = [
    ['beside a post at the byline', [51.5, 0, 4.5], []],
    ['in the goalmouth', [50, 0, 0.5], []],
    ['at a corner flag', [52, 0, 33.5], []],
    ['at the far corner flag', [-52, 0, -33.5], []],
    ['in a crowd', [40, 0, 2], [[40, 0, 4], [41.5, 0, 3.5], [38.5, 0, 3.5], [40, 0, 9], [43, 0, 7]]],
  ];
  for (const [name, at, crowd] of cases) {
    const t = setup();
    t.scorer.fromArray(at);
    t.others.push(...crowd.map(p => new THREE.Vector3().fromArray(p)));
    t.run(1);
    t.event('goal', { team: 0, player: 9 });
    for (let s = 0; s < 3.7; s += 1 / 60) {
      t.run(1 / 60, 'kickoff');
      const c = closeUpCheck(t);
      const where = `${name} at ${s.toFixed(2)} s: ${c.position.toArray().map(v => v.toFixed(1))}`;
      if (s > 1.2) {
        assert.ok(c.nearest > 1.1, `clear of the players, ${where}`);
        assert.ok(!insideGoal(c.position), `not in the goal, ${where}`);
        assert.ok(Math.abs(c.position.x) < PITCH.length / 2 + 4.5 && Math.abs(c.position.z) < PITCH.width / 2 + 1.5, `over the pitch, ${where}`);
        assert.ok(c.framed, `scorer framed, ${where}`);
      }
    }
  }
});

test('the close-up films the scorer from the front, and comes round again when it turns', () => {
  const t = setup();
  // The scorer faces the centre of the pitch (-x), standing well inside it.
  t.scorer.set(30, 0, 5);
  t.look.yaw = -Math.PI / 2;
  t.run(1);
  t.event('goal', { team: 1, player: 9 });
  const front = () => {
    const side = t.camera.position.clone().sub(t.scorer).setY(0).normalize();
    return side.dot(new THREE.Vector3(Math.sin(t.look.yaw), 0, Math.cos(t.look.yaw)));
  };
  t.run(1, 'kickoff');
  assert.ok(front() > Math.cos(Math.PI / 3), `in front of the scorer: ${front().toFixed(2)}`);
  // It turns its back on the camera (towards +x) and stays so.
  t.look.yaw = Math.PI / 2;
  t.run(1.5, 'kickoff');
  assert.ok(front() > Math.cos(Math.PI / 3), `round to its face again: ${front().toFixed(2)}`);
  const c = closeUpCheck(t);
  assert.ok(c.framed && c.share > 0.4 && c.share < 0.6, 'still framed at half the frame');
});

test('the close-up cuts in once and holds: no second cut as the scorer drifts near the goal', () => {
  // At a goal, the scorer stands beside the goal it scored in and drifts along the byline
  // (the first goal of the seed-0 match): the side the camera opens on comes close to the
  // area behind the goal, and the camera comes in closer rather than cutting away again.
  for (const known of [false, true]) {
  const t = setup();
  t.scorer.set(44.9, 0, 1.66);
  // Whether or not the page tells the camera where the scorer is heading.
  if (known) t.look.velocity = new THREE.Vector3(2.4, 0, -0.9);
  t.run(1);
  t.event('goal', { team: 1, player: 9 });
  t.run(1 / 60, 'kickoff');
  let last = t.camera.position.clone();
  // A shot holds for a second before any cut to a reverse angle.
  for (let s = 0; s < 0.9; s += 1 / 60) {
    if (s < 0.6) t.scorer.add(new THREE.Vector3(2.4 / 60, 0, -0.9 / 60));
    t.run(1 / 60, 'kickoff');
    const jump = t.camera.position.distanceTo(last);
    assert.ok(jump < 0.5, `no cut ${s.toFixed(2)} s into the close-up: the camera jumped ${jump.toFixed(2)} m`);
    assert.ok(!insideGoal(t.camera.position) && !(Math.abs(t.camera.position.x) > PITCH.length / 2 - 0.3 &&
      Math.abs(t.camera.position.z) < PITCH.goalWidth / 2 + 2), 'never behind the goal');
    last = t.camera.position.clone();
  }
  }
});

test('a fast clearance stays in the wide shot on wide, square and portrait screens', () => {
  for (const aspect of [16 / 9, 4 / 3, 1, 0.6]) {
    for (const heading of [Math.PI / 2, Math.PI * 0.75, Math.PI, Math.PI * 1.25]) {
      const t = setup(aspect);
      t.ball.set(35, 0.11, 30);
      t.run(4);
      // Cleared at 26 m/s with a 0.5 rad loft, bouncing on.
      let vx = 26 * Math.cos(0.5) * Math.cos(heading);
      let vz = -26 * Math.cos(0.5) * Math.sin(heading);
      let vy = 26 * Math.sin(0.5);
      let worst = 0;
      for (let i = 0; i < 6 * 60; i++) {
        t.ball.x += vx / 60;
        t.ball.z += vz / 60;
        t.ball.y += vy / 60;
        vy -= 9.81 / 60;
        if (t.ball.y < 0.11) {
          t.ball.y = 0.11;
          vy = -vy * 0.55;
          vx *= 0.85;
          vz *= 0.85;
        }
        if (Math.abs(t.ball.x) > 52 || Math.abs(t.ball.z) > 34) break;
        t.run(1 / 60);
        const p = t.screen(t.ball.x, t.ball.y, t.ball.z);
        worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
      }
      assert.ok(worst <= 0.91, `aspect ${aspect.toFixed(2)}, heading ${Math.round(heading * 57.3)}: ball reached ${worst.toFixed(2)} of the half-frame`);
    }
  }
});
