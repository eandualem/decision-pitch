import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';
import { continuous } from '../../src/decision_pitch/web/src/timeline.js';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/players.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const STEP = 1 / 30;

function setup() {
  const document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  const context = { THREE, document, continuous };
  vm.createContext(context);
  vm.runInContext(source, context);
  const scene = new THREE.Scene();
  const actors = context.createPlayers(scene, [{
    colours: { shirt: '#123456', shorts: '#ffffff', keeper: '#ffcc00' },
    players: [{ id: 1, number: 1, position: 'GK' }, { id: 2, number: 9, position: 'FW' }],
  }]);
  const root = scene.children[0];
  const parts = (index) => {
    const group = root.children[index];
    const body = group.children[1];
    return { group, body, limbs: body.children.filter(child => child.isGroup) };
  };
  const ball = root.children.find(child => child.isGroup && child.children[0]?.geometry?.type === 'IcosahedronGeometry');
  return {
    context, scene, actors, ball, shell: ball.children[0], keeper: parts(0), forward: parts(1),
    ...parts(0),
    frame(phase, now, action = 'move') {
      const snapshot = {
        phase, t: 1, period: 1,
        players: [{ id: 1, x: 0, y: 0, heading: 0, speed: 6, action }],
        ball: { x: 0, y: 0, z: 0.11, owner: null, touches: [] },
      };
      actors.update(snapshot, snapshot, 1, 0.1, now);
    },
  };
}

const player = (id, x, y, fields = {}) => ({ id, x, y, heading: 0, speed: 0, action: 'move', ...fields });
const snap = (t, players, ball, phase = 'play') => ({
  phase, t, period: 1, players, ball: { z: 0.11, owner: null, touches: [], ...ball },
});
const worldOf = (object) => object.getWorldPosition(new THREE.Vector3());

for (const phase of ['half_time', 'full_time']) {
  test(`${phase} suppresses retained locomotion and preserves stride for resumed play`, () => {
    const player = setup();
    const reference = setup();
    try {
      player.frame('play', 1);
      reference.frame('play', 1);
      assert.ok(Math.abs(player.limbs[0].rotation.x) > 0.1, 'running before whistle');
      for (const now of [1.1, 1.2, 1.3, 1.4]) {
        player.frame(phase, now);
        for (const limb of player.limbs) assert.ok(limb.rotation.x === 0, 'no running swing');
        assert.equal(player.body.position.y, 0, 'no running bounce');
      }
      player.frame('play', 2);
      reference.frame('play', 2);
      assert.equal(player.limbs[0].rotation.x, reference.limbs[0].rotation.x, 'stride did not advance while stopped');
      assert.equal(player.body.position.y, reference.body.position.y);
      assert.ok(Math.abs(player.limbs[0].rotation.x) > 0.01, 'running resumes');
    } finally {
      player.actors.dispose();
      reference.actors.dispose();
    }
  });

  test(`${phase} retains intentional celebration but stops a kick in progress`, () => {
    const ui = setup();
    try {
      const touch = { player: 1, kind: 'kick', t: 1, x: 0.6, y: 0, z: 0.11 };
      const ready = snap(0.9, [player(1, 0, 0)], { x: 0.6, y: 0, owner: 1 });
      const kicked = snap(1, [player(1, 0, 0)], { x: 0.9, y: 0, touches: [touch] });
      ui.actors.update(ready, ready, 1, 0.016, 0.9, kicked);
      ui.actors.update(ready, kicked, 0.95, 0.016, 0.995, kicked);
      assert.ok(ui.limbs[1].rotation.x < -0.3, `the kick is under way: ${ui.limbs[1].rotation.x}`);
      const whistle = { ...kicked, phase };
      ui.actors.update(whistle, whistle, 1, 0.016, 1.1);
      assert.ok(ui.limbs[1].rotation.x === 0, 'in-progress kick stops at whistle');
      ui.actors.handleEvent({ kind: 'goal', team: 0 }, 1.1);
      ui.actors.update(whistle, whistle, 1, 0.1, 1.2);
      assert.ok(ui.body.position.y > 0, 'goal bounce remains intentional');
      assert.ok(Math.abs(ui.limbs[2].rotation.z) > 2, 'celebration arms raised');
      for (const limb of ui.limbs) assert.ok(limb.rotation.x === 0);
      ui.actors.update(whistle, whistle, 1, 0.1, 6);
      assert.equal(ui.body.position.y, 0, 'celebration expires to a standing pose');
    } finally {
      ui.actors.dispose();
    }
  });
}

test('track eases between keys and runs straight into a linear key', () => {
  const ui = setup();
  const { track } = ui.context;
  const keys = [[0, 0], [1, 1], [2, 3, 'linear']];
  assert.equal(track(keys, -1), 0);
  assert.equal(track(keys, 0.5), 0.5);
  assert.ok(track(keys, 0.25) < 0.25, 'eased');
  assert.equal(track(keys, 1.5), 2, 'linear');
  assert.equal(track(keys, 3), 3);
});

test('a carried ball stays at the drawn feet between snapshots', () => {
  const ui = setup();
  const dribble = vm.runInContext('DRIBBLE', ui.context);
  // The engine's ball is a little off where it should be: the drawn one still never slides.
  const a = snap(1, [player(2, 0, 0, { speed: 6 })], { x: 0.6, y: 0, owner: 2 });
  const b = snap(1 + STEP, [player(2, 0.2, 0.05, { speed: 6, heading: 0.3 })], { x: 0.78, y: 0.27, owner: 2 });
  for (let i = 0; i <= 10; i++) {
    ui.actors.update(a, b, i / 10, 1 / 60, 1 + i / 60);
    const feet = ui.forward.group.position;
    const heading = ui.forward.body.rotation.y - Math.PI / 2;
    const dx = ui.ball.position.x - feet.x;
    const dz = ui.ball.position.z - feet.z;
    const ahead = dx * Math.cos(heading) - dz * Math.sin(heading);
    const side = dx * Math.sin(heading) + dz * Math.cos(heading);
    assert.ok(ahead >= dribble - 1e-9 && ahead <= dribble + 0.15, `just ahead of the feet: ${ahead}`);
    assert.ok(Math.abs(side) < 1e-9, `straight ahead: ${side}`);
  }
});

test('the touch rhythm moves a carried ball with the stride, not against it', () => {
  const ui = setup();
  const aheads = [];
  for (let i = 0; i < 60; i++) {
    const t = 1 + i * STEP;
    const a = snap(t, [player(2, i * 0.2, 0, { speed: 6 })], { x: i * 0.2 + 0.6, y: 0, owner: 2 });
    const b = snap(t + STEP, [player(2, (i + 1) * 0.2, 0, { speed: 6 })], { x: (i + 1) * 0.2 + 0.6, y: 0, owner: 2 });
    ui.actors.update(a, b, 0.5, STEP, t);
    aheads.push(ui.ball.position.x - ui.forward.group.position.x);
  }
  const most = Math.max(...aheads.slice(5));
  const least = Math.min(...aheads.slice(5));
  assert.ok(most - least > 0.05 && most - least < 0.16, `a gentle touch rhythm: ${least}..${most}`);
  for (let i = 6; i < aheads.length; i++) assert.ok(Math.abs(aheads[i] - aheads[i - 1]) < 0.05, 'no jumps');
});

test('the ball keeps the engine height: on the grass at rest and raised in flight', () => {
  const ui = setup();
  const ground = snap(1, [], { x: 3, y: 4 });
  ui.actors.update(ground, ground, 1, 0.016, 1);
  assert.equal(ui.ball.position.y, 0.3, 'the enlarged ball sits on the grass');
  assert.deepEqual([ui.ball.position.x, ui.ball.position.z], [3, -4]);
  const flight = snap(1 + STEP, [], { x: 3.5, y: 4, z: 2.11 });
  ui.actors.update(flight, flight, 1, 0.016, 1.1);
  assert.ok(Math.abs(ui.ball.position.y - 2.3) < 1e-9, 'its height above the grass is as sent');
});

test('a rolling ball turns by the distance over its drawn radius; in the air it keeps spinning', () => {
  const ui = setup();
  const a = snap(1, [], { x: 0, y: 0 });
  const b = snap(1 + STEP, [], { x: 0.6, y: 0 });
  ui.actors.update(a, b, 0, 1 / 60, 1);
  const start = ui.shell.quaternion.clone();
  ui.actors.update(a, b, 1, 1 / 60, 1 + 1 / 60);
  const turned = start.clone().invert().premultiply(ui.shell.quaternion);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(turned.w)));
  assert.ok(Math.abs(angle - 0.6 / 0.3) < 1e-6, `rolled ${angle} rad`);
  const axis = new THREE.Vector3(turned.x, turned.y, turned.z).normalize().multiplyScalar(Math.sign(turned.w));
  assert.ok(axis.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, 'about the axis across its travel');
  const up = snap(1 + 2 * STEP, [], { x: 0.6, y: 0, z: 1.5 });
  const before = ui.shell.quaternion.clone();
  ui.actors.update(up, up, 1, 1 / 60, 1.05);
  ui.actors.update(up, up, 1, 1 / 60, 1.07);
  assert.ok(ui.shell.quaternion.angleTo(before) > 0.5, 'a ball in the air keeps its spin');
  const rest = snap(1 + 3 * STEP, [], { x: 0.6, y: 0 });
  ui.actors.update(rest, rest, 1, 1 / 60, 1.1);
  const still = ui.shell.quaternion.clone();
  ui.actors.update(rest, rest, 1, 1 / 60, 1.12);
  assert.ok(ui.shell.quaternion.angleTo(still) < 1e-9, 'a ball at rest on the grass is still');
});

test('a kick: the leg winds up, meets the ball as it leaves and follows through', () => {
  const ui = setup();
  const t0 = 1;
  const contactT = t0 + STEP;
  const touch = { player: 2, kind: 'kick', t: contactT, x: 0.6, y: 0, z: 0.11 };
  const a = snap(t0, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2 });
  const b = snap(contactT, [player(2, 0, 0)], { x: 0.9, y: 0, touches: [touch] });
  const c = snap(contactT + STEP, [player(2, 0, 0)], { x: 1.5, y: 0, touches: [touch] });
  // The newest snapshot already has the kick 0.1 s before the drawn match reaches it.
  const z = snap(t0 - 3 * STEP, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2 });
  ui.actors.update(z, a, 0, 1 / 60, 0.9, b);
  assert.equal(ui.forward.limbs[1].rotation.x + 0, 0, 'standing, before the wind-up');
  ui.actors.update(z, a, 0.6, 1 / 60, 0.94, b);
  assert.ok(ui.forward.limbs[1].rotation.x > 0.3, `leg drawn back: ${ui.forward.limbs[1].rotation.x}`);
  const contact = touch.t - 1 / 60;
  const at = (time) => {
    const alpha = (time - a.t) / STEP;
    ui.actors.update(alpha <= 1 ? a : b, alpha <= 1 ? b : c, alpha <= 1 ? alpha : alpha - 1, 1 / 60, time, c);
    return { leg: ui.forward.limbs[1].rotation.x, ball: ui.ball.position.x };
  };
  const early = at(contact - 0.01);
  assert.ok(Math.abs(early.ball - 0.6) < 1e-9, 'the ball waits at the boot until contact');
  const met = at(contact);
  assert.ok(Math.abs(met.ball - 0.6) < 1e-9, 'contact at the touch point');
  assert.ok(met.leg < -0.2 && met.leg > early.leg - 1, `swinging through: ${met.leg}`);
  const gone = at(contact + 0.01);
  assert.ok(gone.ball > 0.6, 'the ball leaves on contact');
  assert.ok(gone.leg < met.leg, 'the leg follows through');
});

// A dribbler running along +x passes at `direction` (radians): the drawn match from 0.1 s
// before the kick, with the snapshot after the kick already in hand, as the page has it.
function pass(ui, direction, speed = 18) {
  const t0 = 2;
  const touch = { player: 2, kind: 'kick', t: t0 + STEP, x: 0.6, y: 0, z: 0.11 };
  const runner = (t) => player(2, (t - t0) * 6, 0, { speed: 6 });
  const away = (t) => ({ x: 0.6 + Math.cos(direction) * speed * (t - touch.t + 1 / 60), y: Math.sin(direction) * speed * (t - touch.t + 1 / 60) });
  const shots = [
    snap(t0 - 3 * STEP, [runner(t0 - 3 * STEP)], { x: 0, y: 0, owner: 2 }),
    snap(t0 - 2 * STEP, [runner(t0 - 2 * STEP)], { x: 0.2, y: 0, owner: 2 }),
    snap(t0 - STEP, [runner(t0 - STEP)], { x: 0.4, y: 0, owner: 2 }),
    snap(t0, [runner(t0)], { x: 0.6, y: 0, owner: 2 }),
    snap(touch.t, [runner(touch.t)], { ...away(touch.t), touches: [touch] }),
    snap(t0 + 2 * STEP, [runner(t0 + 2 * STEP)], { ...away(t0 + 2 * STEP), touches: [touch] }),
    snap(t0 + 3 * STEP, [runner(t0 + 3 * STEP)], { ...away(t0 + 3 * STEP), touches: [touch] }),
  ];
  const frames = [];
  // The page draws 0.1 s behind the newest snapshot, so it sees the kick that far ahead.
  for (let time = t0 - 3 * STEP; time <= t0 + 3 * STEP + 1e-9; time += 1 / 240) {
    const i = Math.min(shots.length - 2, Math.floor((time - shots[0].t) / STEP + 1e-9));
    const latest = shots.findLast(s => s.t <= time + 0.1);
    ui.actors.update(shots[i], shots[i + 1], (time - shots[i].t) / STEP, 1 / 240, time, latest);
    frames.push({
      time, contact: touch.t - 1 / 60,
      facing: ui.forward.body.rotation.y - Math.PI / 2,
      ball: ui.ball.position.clone(), feet: ui.forward.group.position.clone(),
    });
  }
  return frames;
}
const turnBetween = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

test('a dribbler passing backwards turns into the pass with the ball and kicks it away', () => {
  const ui = setup();
  const frames = pass(ui, Math.PI);
  const contact = frames.find(f => f.time >= f.contact);
  assert.ok(turnBetween(contact.facing, Math.PI) < 0.2, `faces the pass at contact: ${contact.facing}`);
  const dx = contact.ball.x - contact.feet.x;
  const dz = contact.ball.z - contact.feet.z;
  const ahead = dx * Math.cos(contact.facing) - dz * Math.sin(contact.facing);
  assert.ok(ahead > 0.45, `the ball is in front of the turned kicker: ${ahead}`);
  const after = frames.filter(f => f.time >= contact.time);
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i].ball.x < after[i - 1].ball.x + 1e-9, `the ball only goes the way it was kicked, frame ${i}`);
  }
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].ball.distanceTo(frames[i - 1].ball) < 0.25, `no jump at frame ${i}`);
  }
  assert.ok(turnBetween(frames.at(-1).facing, Math.PI) < turnBetween(0, Math.PI), 'turning back to its run afterwards');
});

test('a pass along the run needs no turn', () => {
  const ui = setup();
  for (const frame of pass(ui, 0.1)) assert.ok(turnBetween(frame.facing, 0) < 0.11);
});

test('control, tackle and deflection each move the toucher at the moment of contact', () => {
  for (const kind of ['control', 'tackle', 'deflect']) {
    const ui = setup();
    const touch = { player: 2, kind, t: 2, x: 0.6, y: 0, z: 0.11 };
    const s = snap(2, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] });
    const before = snap(1.9, [player(2, 0, 0)], { x: 2, y: 0 });
    ui.actors.update(before, s, 0.5, 1 / 60, 1);
    const resting = ui.forward.limbs[1].rotation.x;
    ui.actors.update(s, s, 1, 1 / 60, 1.1);
    ui.actors.update(s, snap(2.1, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] }), 0.5, 1 / 60, 1.15);
    assert.ok(ui.forward.limbs[1].rotation.x < resting - 0.2, `${kind}: the leg goes to the ball`);
    ui.actors.update(s, snap(2.1, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] }), 1, 1 / 60, 2);
    const late = snap(3, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] });
    ui.actors.update(late, late, 1, 1 / 60, 3);
    assert.equal(ui.forward.limbs[1].rotation.x + 0, 0, `${kind}: the pose ends`);
  }
});

test('a throw-in swings both arms over the head', () => {
  const ui = setup();
  const touch = { player: 2, kind: 'throw', t: 2, x: 0, y: 34, z: 0.11 };
  const waiting = snap(1.9, [player(2, 0, 33.5)], { x: 0, y: 34, owner: 2 }, 'throw_in');
  const thrown = snap(2, [player(2, 0, 33.5)], { x: 0, y: 33.8, touches: [touch] });
  ui.actors.update(waiting, waiting, 1, 1 / 60, 1, thrown);
  ui.actors.update(waiting, waiting, 1, 1 / 60, 1.1, thrown);
  // 0.02 s before the ball leaves the hands
  const alpha = (2 - 1 / 60 - 0.02 - 1.9) / 0.1;
  ui.actors.update({ ...waiting, phase: 'play' }, thrown, alpha, 1 / 60, 1.17, thrown);
  assert.ok(ui.forward.limbs[2].rotation.x < -1.5 && ui.forward.limbs[3].rotation.x < -1.5, 'both arms high');
});

// Renders a goalkeeper touch from 0.1 s before contact to `after` s past it, as the page would.
function keeperTouch(ui, touch, keeperAt, ball) {
  const before = snap(touch.t - 0.1, [player(1, ...keeperAt)], ball);
  const after = snap(touch.t, [player(1, ...keeperAt)], { x: touch.x, y: touch.y, z: touch.z, touches: [touch] });
  const later = snap(touch.t + 1.5, [player(1, ...keeperAt)], { x: touch.x, y: touch.y, z: touch.z, touches: [touch] });
  ui.actors.update(before, before, 1, 1 / 60, 1, after);
  return (since) => {
    const time = touch.t - 1 / 60 + since;
    if (time <= touch.t) ui.actors.update(before, after, (time - before.t) / 0.1, 1 / 60, 1 + since, later);
    else ui.actors.update(after, later, (time - touch.t) / 1.5, 1 / 60, 1 + since, later);
  };
}

test('a goalkeeper reaches across to a save on its left and dives the right way', () => {
  const ui = setup();
  const head = ui.keeper.body.children[2];
  // Facing +x, its left is +y: the ball meets it 1.2 m to its left.
  const at = keeperTouch(ui, { player: 1, kind: 'save', t: 2, x: 0.3, y: 1.2, z: 0.6 }, [0, 0], { x: 4, y: 1.3, z: 0.7 });
  const standing = worldOf(head);
  at(0);
  const meeting = worldOf(head);
  at(0.2);
  const reaching = worldOf(head);
  // Match +y is three.js −z.
  assert.ok(standing.z - meeting.z > 0.5, `across to the ball at contact: ${standing.z - meeting.z}`);
  assert.ok(standing.z - reaching.z > 0.8, `full stretch after: ${standing.z - reaching.z}`);
  assert.ok(reaching.y < standing.y, 'it leaves its feet sideways');
  assert.ok(ui.keeper.limbs[2].rotation.x < -2, 'arms stretched');
  at(1.2);
  assert.ok(Math.abs(ui.keeper.body.rotation.z) < 1e-9, 'and it gets up');
});

test('a goalkeeper gathers a ball straight at it without diving', () => {
  const ui = setup();
  const at = keeperTouch(ui, { player: 1, kind: 'catch', t: 2, x: 0.7, y: 0.1, z: 0.11 }, [0, 0], { x: 2, y: 0.1 });
  at(0.1);
  assert.equal(ui.keeper.body.rotation.z, 0, 'no dive');
  assert.ok(ui.keeper.body.rotation.x > 0.2, 'bends to the ball');
});

test('a goalkeeper reaches up for a high ball', () => {
  const ui = setup();
  const at = keeperTouch(ui, { player: 1, kind: 'catch', t: 2, x: 0.5, y: 0, z: 2.2 }, [0, 0], { x: 3, y: 0, z: 2.4 });
  at(0.1);
  assert.equal(ui.keeper.body.rotation.z, 0, 'no dive');
  assert.ok(ui.keeper.limbs[2].rotation.x < -2.5 && ui.keeper.body.position.y > 0.2, 'arms up, off the ground');
});

test('a diving goalkeeper leans into its dive', () => {
  const ui = setup();
  for (let i = 0; i < 10; i++) {
    const a = snap(1 + i * STEP, [player(1, 0, i * 0.1, { dive: true })], { x: 10, y: 0, z: 0.5 });
    const b = snap(1 + (i + 1) * STEP, [player(1, 0, (i + 1) * 0.1, { dive: true })], { x: 9, y: 0, z: 0.5 });
    ui.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  // Moving to its left (+y): it rolls left, which is negative about its forward axis.
  assert.ok(ui.keeper.body.rotation.z < -0.3, `leaning left: ${ui.keeper.body.rotation.z}`);
  const rest = snap(2, [player(1, 0, 1)], { x: 9, y: 0, z: 0.5 });
  for (let i = 0; i < 60; i++) ui.actors.update(rest, rest, 1, 1 / 60, 2 + i / 60);
  assert.ok(Math.abs(ui.keeper.body.rotation.z) < 0.02, 'and gets up again');
});

test('players trading the ball in a duel do not restart their lunge on every exchange', () => {
  const duel = setup();
  const single = setup();
  const tackle = (player, t) => ({ player, kind: 'tackle', t, x: 0.5, y: 0, z: 0.11 });
  const first = tackle(2, 2);
  const exchanges = [first, tackle(1, 2 + 1 / 60), tackle(2, 2 + 2 / 60), tackle(1, 2 + 3 / 60), tackle(2, 2 + 4 / 60)];
  const players = [player(1, 1, 0, { heading: Math.PI }), player(2, 0, 0)];
  const a = snap(1.9, players, { x: 0.5, y: 0, owner: 1 });
  for (let i = 0; i <= 30; i++) {
    const time = 1.9 + i / 100;
    const shown = exchanges.filter(t => t.t <= time + 0.1);
    const b = snap(2.2, players, { x: 0.5, y: 0, owner: 2, touches: shown });
    duel.actors.update(a, b, (time - 1.9) / 0.3, 1 / 100, time, b);
    single.actors.update(a, { ...b, ball: { ...b.ball, touches: [first] } }, (time - 1.9) / 0.3, 1 / 100, time, b);
    assert.equal(duel.forward.limbs[1].rotation.x, single.forward.limbs[1].rotation.x, `one lunge at ${time}`);
  }
  assert.ok(duel.keeper.limbs[1].rotation.x < -0.5, 'the other player lunges once too');
});

test('a kick blocked within one snapshot shows the swing and the ball meets both players', () => {
  const ui = setup();
  const kick = { player: 2, kind: 'kick', t: 2 - 1 / 60, x: 0.6, y: 0, z: 0.11 };
  const block = { player: 1, kind: 'deflect', t: 2, x: 1.0, y: 0, z: 0.11 };
  const players = [player(1, 1.4, 0, { heading: Math.PI }), player(2, 0, 0)];
  const a = snap(2 - STEP, players, { x: 0.6, y: 0, owner: 2 });
  const b = snap(2, players, { x: 0.8, y: 0.3, touches: [kick, block] });
  const ballAt = (time) => {
    ui.actors.update(a, b, (time - a.t) / STEP, 1 / 240, time, b);
    return ui.ball.position.x;
  };
  ballAt(a.t);
  assert.ok(Math.abs(ballAt(kick.t - 1 / 60) - 0.6) < 1e-9, 'at the kicker\'s boot at the kick');
  assert.ok(Math.abs(ballAt(block.t - 1 / 60) - 1.0) < 1e-9, 'at the blocker at the block');
  ballAt(2);
  assert.ok(ui.forward.limbs[1].rotation.x < -0.2, 'the kicker swung');
});

test('a touch from before the page joined is not replayed', () => {
  const ui = setup();
  const touch = { player: 2, kind: 'kick', t: 1, x: 0.6, y: 0, z: 0.11 };
  const s = snap(9, [player(2, 0, 0)], { x: 20, y: 0, touches: [touch] });
  ui.actors.update(s, s, 1, 1 / 60, 1);
  ui.actors.update(s, s, 1, 1 / 60, 1.1);
  assert.equal(ui.forward.limbs[1].rotation.x + 0, 0);
});

test('picking up a loose ball settles it onto the feet without a jump', () => {
  const ui = setup();
  const touch = { player: 2, kind: 'control', t: 1 + STEP, x: 0.9, y: 0.1, z: 0.11 };
  const frames = [
    snap(1, [player(2, 0, 0, { speed: 3 })], { x: 1.05, y: 0.12 }),
    snap(1 + STEP, [player(2, 0.1, 0, { speed: 3 })], { x: 0.7, y: 0, owner: 2, touches: [touch] }),
    snap(1 + 2 * STEP, [player(2, 0.2, 0, { speed: 3 })], { x: 0.8, y: 0, owner: 2, touches: [touch] }),
    snap(1 + 3 * STEP, [player(2, 0.3, 0, { speed: 3 })], { x: 0.9, y: 0, owner: 2, touches: [touch] }),
  ];
  let last = null;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      ui.actors.update(frames[i], frames[i + 1], j / 4, STEP / 4, 1 + (i * 4 + j) / 120);
      const here = ui.ball.position.clone();
      if (last) assert.ok(here.distanceTo(last) < 0.25, `no jump: ${here.distanceTo(last)}`);
      last = here;
    }
  }
});
