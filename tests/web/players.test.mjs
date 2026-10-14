// Run with node --test tests/web/players.test.mjs; no npm dependencies required.
import './three-resolve.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';
import { fixtureGltf, ONE_SHOTS } from './figure-fixture.mjs';

globalThis.document ??= { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
const { prepareFigure } = await import('../../src/decision_pitch/web/src/figures.js');
const { createPlayers, track, reach, touchClip, DRIBBLE } = await import('../../src/decision_pitch/web/src/players.js');
const STEP = 1 / 30;
const figure = (() => {
  const { scene, animations, info } = fixtureGltf();
  return prepareFigure(scene, animations, info);
})();

function setup() {
  const scene = new THREE.Scene();
  const actors = createPlayers(scene, [{
    colours: { shirt: '#123456', shorts: '#ffffff', keeper: '#ffcc00' },
    players: [{ id: 1, number: 1, position: 'GK' }, { id: 2, number: 9, position: 'FW' }],
  }], figure);
  const root = scene.children[0];
  const view = (id, index) => ({
    group: root.children[index],
    state: () => actors.inspect(id),
    facing: () => actors.inspect(id).facing,
    // The one-shot whose clip name starts with `name`, whole or layered, if it shows.
    act: (name) => actors.inspect(id).acts.find(a => a.name.split(':')[0] === name && a.weight > 0),
    acting: () => actors.inspect(id).acts.filter(a => a.weight > 0).map(a => a.name.split(':')[0]),
  });
  const ball = root.children.find(child => child.isGroup && child.children[0]?.geometry?.type === 'IcosahedronGeometry');
  const keeper = view(1, 0);
  return {
    scene, actors, ball, shell: ball.children[0], keeper, forward: view(2, 1), ...keeper,
    // A frame of the goalkeeper running along +x at 6 m/s, drawn between two snapshots.
    frame(phase, now) {
      const x = (now - 1) * 6;
      const before = { phase, t: now - 0.1, period: 1, players: [{ id: 1, x, y: 0, heading: 0, speed: 6, action: 'move' }], ball: { x: 30, y: 0, z: 0.11, owner: null, touches: [] } };
      const after = { ...before, t: now, players: [{ ...before.players[0], x: x + 0.6 }] };
      actors.update(before, after, 0.5, 0.1, now);
    },
  };
}

// The kick a player shows, the pass or the shot, with its moment of contact.
const kickOf = (view) => {
  const shown = view.act('pass') ?? view.act('shot');
  return shown && { ...shown, contact: ONE_SHOTS[shown.name.split(':')[0]][1] };
};
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
      for (const now of [1, 1.1, 1.2, 1.3]) {
        player.frame('play', now);
        reference.frame('play', now);
      }
      assert.ok(player.state().rate > 0 && !player.state().loops.idle, 'running before the whistle');
      const stride = player.state().phase;
      for (const now of [1.4, 1.5, 1.6, 1.7]) {
        player.frame(phase, now);
        assert.deepEqual(player.state().loops, { idle: 1 }, 'standing, not running');
        assert.equal(player.state().phase, stride, 'the stride does not advance while stopped');
      }
      player.frame('play', 2);
      reference.frame('play', 2);
      assert.ok(player.state().rate > 0, 'running resumes');
      assert.ok(Math.abs(player.state().phase - stride) < 0.2, 'from where the stride stopped');
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
      assert.ok(kickOf(ui), 'the kick is under way');
      const whistle = { ...kicked, phase };
      ui.actors.update(whistle, whistle, 1, 0.016, 1.1);
      assert.deepEqual(ui.acting(), [], 'in-progress kick stops at whistle');
      ui.actors.handleEvent({ kind: 'goal', team: 0 }, 1.1);
      ui.actors.update(whistle, whistle, 1, 0.1, 1.5);
      assert.ok(ui.act('celebrate'), 'the goal celebration remains');
      assert.ok(Math.abs(ui.act('celebrate').time - 0.4) < 1e-9, 'played from the goal');
      ui.actors.update(whistle, whistle, 1, 0.1, 6);
      assert.deepEqual(ui.acting(), [], 'celebration expires to a standing pose');
    } finally {
      ui.actors.dispose();
    }
  });
}

test('track eases between keys and runs straight into a linear key', () => {
  const keys = [[0, 0], [1, 1], [2, 3, 'linear']];
  assert.equal(track(keys, -1), 0);
  assert.equal(track(keys, 0.5), 0.5);
  assert.ok(track(keys, 0.25) < 0.25, 'eased');
  assert.equal(track(keys, 1.5), 2, 'linear');
  assert.equal(track(keys, 3), 3);
});

test('a carried ball stays at the drawn feet between snapshots', () => {
  const ui = setup();
  // The boot's reach at the touch, and the ball's radius: its back meets the toe.
  const dribble = 0.62 * ui.forward.state().scale + 0.11;
  // The engine's ball is a little off where it should be: the drawn one still never slides.
  const a = snap(1, [player(2, 0, 0, { speed: 6 })], { x: 0.6, y: 0, owner: 2 });
  const b = snap(1 + STEP, [player(2, 0.2, 0.05, { speed: 6, heading: 0.3 })], { x: 0.78, y: 0.27, owner: 2 });
  for (let i = 0; i <= 10; i++) {
    ui.actors.update(a, b, i / 10, 1 / 60, 1 + i / 60);
    const feet = ui.forward.group.position;
    const heading = ui.forward.facing();
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
  assert.equal(ui.ball.position.y, 0.11, 'the ball, at its real size, sits on the grass');
  assert.deepEqual([ui.ball.position.x, ui.ball.position.z], [3, -4]);
  const air = setup();
  const flight = snap(1 + STEP, [], { x: 3.5, y: 4, z: 2.11 });
  air.actors.update(flight, flight, 1, 0.016, 1.1);
  assert.ok(Math.abs(air.ball.position.y - 2.11) < 1e-9, 'its height above the grass is as sent');
});

test('a rolling ball turns by the distance over its drawn radius; in the air it keeps spinning', () => {
  const ui = setup();
  const a = snap(1, [], { x: 0, y: 0 });
  const b = snap(1 + STEP, [], { x: 0.2, y: 0 });
  ui.actors.update(a, b, 0, 1 / 60, 1);
  const start = ui.shell.quaternion.clone();
  ui.actors.update(a, b, 1, 1 / 60, 1 + 1 / 60);
  const turned = start.clone().invert().premultiply(ui.shell.quaternion);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(turned.w)));
  assert.ok(Math.abs(angle - 0.2 / 0.11) < 1e-6, `rolled ${angle} rad`);
  const axis = new THREE.Vector3(turned.x, turned.y, turned.z).normalize().multiplyScalar(Math.sign(turned.w));
  assert.ok(axis.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, 'about the axis across its travel');
  const up = snap(1 + 2 * STEP, [], { x: 0.2, y: 0, z: 1.5 });
  const before = ui.shell.quaternion.clone();
  ui.actors.update(up, up, 1, 1 / 60, 1.05);
  ui.actors.update(up, up, 1, 1 / 60, 1.07);
  assert.ok(ui.shell.quaternion.angleTo(before) > 0.5, 'a ball in the air keeps its spin');
  const rest = snap(1 + 3 * STEP, [], { x: 0.2, y: 0 });
  ui.actors.update(rest, rest, 1, 1 / 60, 1.1);
  const still = ui.shell.quaternion.clone();
  ui.actors.update(rest, rest, 1, 1 / 60, 1.12);
  assert.ok(ui.shell.quaternion.angleTo(still) < 1e-9, 'a ball at rest on the grass is still');
});

test('a kick: the clip winds up, meets the ball as it leaves and follows through', () => {
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
  assert.equal(kickOf(ui.forward), undefined, 'standing, before the wind-up');
  ui.actors.update(z, a, 0.6, 1 / 60, 0.94, b);
  const windup = kickOf(ui.forward);
  const contactTime = windup.contact;
  assert.ok(windup.time < contactTime - 0.05, `winding up: ${windup.time}`);
  assert.ok(!windup.name.includes(':'), 'the whole clip at a standstill');
  const contact = touch.t - 1 / 60;
  const at = (time) => {
    const alpha = (time - a.t) / STEP;
    ui.actors.update(alpha <= 1 ? a : b, alpha <= 1 ? b : c, alpha <= 1 ? alpha : alpha - 1, 1 / 60, time, c);
    return { clip: kickOf(ui.forward).time, ball: ui.ball.position.x };
  };
  const early = at(contact - 0.01);
  assert.ok(Math.abs(early.ball - 0.6) < 1e-9, 'the ball waits at the boot until contact');
  const met = at(contact);
  assert.ok(Math.abs(met.ball - 0.6) < 1e-9, 'contact at the touch point');
  assert.ok(Math.abs(met.clip - contactTime) < 1e-9, `the clip's contact lands on the touch: ${met.clip}`);
  const gone = at(contact + 0.01);
  assert.ok(gone.ball > 0.6, 'the ball leaves on contact');
  assert.ok(Math.abs(gone.clip - contactTime - 0.01) < 1e-9, 'and the clip follows through at its own pace');
});

test('a kick that leaves fast plays the shot, a slower one the pass', () => {
  for (const [speed, clip] of [[24, 'shot'], [10, 'pass']]) {
    const ui = setup();
    const touch = { player: 2, kind: 'kick', t: 2 + 1 / 60, x: 0.6, y: 0, z: 0.11 };
    const a = snap(2, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2 });
    const b = snap(2 + STEP, [player(2, 0, 0)], { x: 0.6 + speed * STEP, y: 0, touches: [touch] });
    ui.actors.update(a, a, 1, 1 / 60, 1.95, b);
    ui.actors.update(a, b, 0.4, 1 / 60, 2.01, b);
    assert.deepEqual(ui.forward.acting(), [clip], `${speed} m/s`);
  }
});

test('each touch plays its clip', () => {
  assert.equal(touchClip('kick', { speed: 25 }), 'shot');
  assert.equal(touchClip('kick', { speed: 12 }), 'pass');
  assert.equal(touchClip('kick'), 'pass', 'a kick whose speed is not known yet');
  assert.equal(touchClip('control'), 'control');
  assert.equal(touchClip('deflect'), 'control');
  assert.equal(touchClip('tackle'), 'tackle');
  assert.equal(touchClip('throw'), 'throw_in');
  assert.equal(touchClip('save', { lateral: 1.2, height: 0.6 }), 'keeper_dive_L', 'beyond its reach to its left');
  assert.equal(touchClip('save', { lateral: -1.2, height: 0.6 }), 'keeper_dive_R');
  assert.equal(touchClip('catch', { lateral: -0.2, height: 0.6, diving: true }), 'keeper_dive_R', 'already diving');
  assert.equal(touchClip('catch', { lateral: 0.1, height: 0.11 }), 'keeper_catch');
  assert.equal(touchClip('catch', { lateral: 0.1, height: 2.2 }), 'keeper_catch_high');
  assert.equal(reach(0.3, 1, false), 'keeper_catch');
  assert.equal(touchClip('header'), null, 'the engine has no headers yet');
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
      facing: ui.forward.facing(),
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

// A kicker at (51.7, 0) facing +x, carrying the ball, kicks it at once; the snapshot that
// first reports the kick is `next`. The page holds the last snapshot of play across a
// restart, as the timeline does, and sees `next` 0.1 s ahead. Returns the drawn facings.
function kickInto(ui, next) {
  const t0 = 2;
  const kicker = player(2, 51.7, 0);
  const shots = [
    snap(t0 - 3 * STEP, [kicker], { x: 52.3, y: 0, owner: 2 }),
    snap(t0 - 2 * STEP, [kicker], { x: 52.3, y: 0, owner: 2 }),
    snap(t0 - STEP, [kicker], { x: 52.3, y: 0, owner: 2 }),
    snap(t0, [kicker], { x: 52.3, y: 0, owner: 2 }),
    next,
  ];
  const facings = [];
  let swung = false;
  for (let time = t0 - 3 * STEP; time <= t0 + STEP + 0.3; time += 1 / 120) {
    const i = Math.min(shots.length - 1, Math.floor((time - shots[0].t) / STEP + 1e-9));
    const a = shots[i];
    const b = shots[i + 1]?.phase === 'play' ? shots[i + 1] : a; // held across a restart
    const latest = shots.findLast(s => s.t <= time + 0.1);
    ui.actors.update(a, b, b === a ? 1 : (time - a.t) / STEP, 1 / 120, time, latest);
    facings.push(ui.forward.facing());
    swung ||= (kickOf(ui.forward)?.weight ?? 0) > 1;
  }
  return { facings, swung };
}

test('a kick straight into the goal or out of play does not turn the kicker to the restart', () => {
  const kick = { player: 2, kind: 'kick', t: 2 + 1 / 60, x: 52.3, y: 0, z: 0.11 };
  const restarts = [
    snap(2 + STEP, [player(2, 51.8, 0)], { x: 0, y: 0, touches: [kick] }, 'kickoff'), // a goal
    snap(2 + STEP, [player(2, 51.8, 0)], { x: -30, y: -34, touches: [kick] }, 'throw_in'),
  ];
  for (const next of restarts) {
    const ui = setup();
    const { facings, swung } = kickInto(ui, next);
    assert.ok(swung, `${next.phase}: the kick is still shown`);
    for (const facing of facings) assert.ok(turnBetween(facing, 0) < 0.05, `${next.phase}: no turn, got ${facing}`);
  }
});

test('a kick blocked at once does not turn the kicker towards the rebound', () => {
  const ui = setup();
  const kick = { player: 2, kind: 'kick', t: 2 + 1 / 60, x: 52.3, y: 0, z: 0.11 };
  const block = { player: 1, kind: 'deflect', t: 2 + 2 / 60, x: 52.6, y: 0, z: 0.11 };
  const next = snap(2 + STEP, [player(2, 51.8, 0), player(1, 53, 0)], { x: 51.5, y: 2, touches: [kick, block] });
  const { facings, swung } = kickInto(ui, next);
  assert.ok(swung);
  for (const facing of facings) assert.ok(turnBetween(facing, 0) < 0.05, `no turn, got ${facing}`);
});

test('a pass along the run needs no turn', () => {
  const ui = setup();
  for (const frame of pass(ui, 0.1)) assert.ok(turnBetween(frame.facing, 0) < 0.11);
});

test('control, tackle and deflection each play their clip at the moment of contact', () => {
  for (const [kind, clip] of [['control', 'control'], ['tackle', 'tackle'], ['deflect', 'control']]) {
    const ui = setup();
    const touch = { player: 2, kind, t: 2, x: 0.6, y: 0, z: 0.11 };
    const s = snap(2, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] });
    const before = snap(1.9, [player(2, 0, 0)], { x: 2, y: 0 });
    ui.actors.update(before, s, 0.5, 1 / 60, 1);
    ui.actors.update(s, s, 1, 1 / 60, 1.1);
    ui.actors.update(s, snap(2.1, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] }), 0.5, 1 / 60, 1.15);
    const shown = ui.forward.act(clip);
    assert.ok(shown, `${kind}: plays ${clip}`);
    assert.ok(Math.abs(shown.time - ONE_SHOTS[clip][1] - (2.05 - (2 - 1 / 60))) < 1e-6, `${kind}: timed to its contact`);
    ui.actors.update(s, snap(2.1, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] }), 1, 1 / 60, 2);
    const late = snap(3, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [touch] });
    ui.actors.update(late, late, 1, 1 / 60, 3);
    assert.deepEqual(ui.forward.acting(), [], `${kind}: the clip ends`);
  }
});

test('a throw-in plays the throw just before the ball leaves the hands', () => {
  const ui = setup();
  const touch = { player: 2, kind: 'throw', t: 2, x: 0, y: 34, z: 0.11 };
  const waiting = snap(1.9, [player(2, 0, 33.5)], { x: 0, y: 34, owner: 2 }, 'throw_in');
  const thrown = snap(2, [player(2, 0, 33.5)], { x: 0, y: 33.8, touches: [touch] });
  ui.actors.update(waiting, waiting, 1, 1 / 60, 1, thrown);
  ui.actors.update(waiting, waiting, 1, 1 / 60, 1.1, thrown);
  // 0.02 s before the ball leaves the hands
  const alpha = (2 - 1 / 60 - 0.02 - 1.9) / 0.1;
  ui.actors.update({ ...waiting, phase: 'play' }, thrown, alpha, 1 / 60, 1.17, thrown);
  const shown = ui.forward.act('throw_in');
  assert.ok(shown, 'throwing');
  // Seen 0.08 s ahead, its wind-up plays at twice its pace.
  assert.ok(Math.abs(shown.time - (ONE_SHOTS.throw_in[1] - 2 * 0.02)) < 1e-6, `just before release: ${shown.time}`);
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

test('a goalkeeper dives across to a save on its left, at full stretch as it meets the ball', () => {
  const ui = setup();
  // Facing +x, its left is +y: the ball meets it 1.2 m to its left.
  const at = keeperTouch(ui, { player: 1, kind: 'save', t: 2, x: 0.3, y: 1.2, z: 0.6 }, [0, 0], { x: 4, y: 1.3, z: 0.7 });
  const [duration, contact] = ONE_SHOTS.keeper_dive_L;
  at(0);
  const meeting = ui.keeper.act('keeper_dive_L');
  assert.ok(meeting, 'diving to its left');
  assert.equal(meeting.name, 'keeper_dive_L', 'with its whole body');
  assert.ok(Math.abs(meeting.time - contact) < 0.03, `full stretch at contact: ${meeting.time}`);
  at(0.2);
  assert.ok(Math.abs(ui.keeper.act('keeper_dive_L').time - contact - 0.2) < 0.03, 'then at its own pace');
  at(duration - contact + 0.1);
  assert.deepEqual(ui.keeper.acting(), [], 'and it gets up');
});

test('a goalkeeper gathers a ball straight at it without diving', () => {
  const ui = setup();
  const at = keeperTouch(ui, { player: 1, kind: 'catch', t: 2, x: 0.7, y: 0.1, z: 0.11 }, [0, 0], { x: 2, y: 0.1 });
  at(0.1);
  assert.deepEqual(ui.keeper.acting(), ['keeper_catch']);
});

test('a goalkeeper reaches up for a high ball', () => {
  const ui = setup();
  const at = keeperTouch(ui, { player: 1, kind: 'catch', t: 2, x: 0.5, y: 0, z: 2.2 }, [0, 0], { x: 3, y: 0, z: 2.4 });
  at(0.1);
  assert.deepEqual(ui.keeper.acting(), ['keeper_catch_high']);
});

test('a goalkeeper the engine marks diving leaves its feet without a touch', () => {
  const ui = setup();
  for (let i = 0; i < 10; i++) {
    const a = snap(1 + i * STEP, [player(1, 0, i * 0.1, { dive: true })], { x: 10, y: 0, z: 0.5 });
    const b = snap(1 + (i + 1) * STEP, [player(1, 0, (i + 1) * 0.1, { dive: true })], { x: 9, y: 0, z: 0.5 });
    ui.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  // Moving to its left (+y) as it faces the ball (+x): it dives to its left.
  assert.deepEqual(ui.keeper.acting(), ['keeper_dive_L']);
  for (let i = 0; i < 90; i++) {
    const rest = snap(2 + i / 60, [player(1, 0, 1)], { x: 9, y: 0, z: 0.5 });
    ui.actors.update(rest, rest, 1, 1 / 60, 2 + i / 60);
  }
  assert.deepEqual(ui.keeper.acting(), [], 'and gets up again');
});

test('a save after the dive began times the dive\'s full stretch to the touch', () => {
  const ui = setup();
  const [, contact] = ONE_SHOTS.keeper_dive_R;
  const shots = [];
  for (let i = 0; i <= 12; i++) shots.push(snap(1 + i * STEP, [player(1, 0, -i * 0.12, { dive: true })], { x: 10 - i, y: -1 }));
  const save = { player: 1, kind: 'save', t: 1 + 10 * STEP, x: 0.5, y: -1.3, z: 0.4 };
  for (const shot of shots.slice(9)) shot.ball.touches = [save];
  let met = null;
  for (let time = 1; time <= 1 + 11 * STEP; time += 1 / 120) {
    const i = Math.min(shots.length - 2, Math.floor((time - 1) / STEP + 1e-9));
    const latest = shots.findLast(s => s.t <= time + 0.1);
    ui.actors.update(shots[i], shots[i + 1], (time - shots[i].t) / STEP, 1 / 120, time, latest);
    if (!met && time >= save.t - 1 / 60) met = ui.keeper.act('keeper_dive_R');
  }
  assert.ok(met, 'diving to its right');
  assert.ok(Math.abs(met.time - contact) < 0.04, `at full stretch as it meets the ball: ${met.time}`);
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
    assert.deepEqual(duel.forward.act('tackle'), single.forward.act('tackle'), `one lunge at ${time}`);
  }
  assert.ok(duel.keeper.act('tackle'), 'the other player lunges once too');
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
  assert.ok(kickOf(ui.forward), 'the kicker swung');
});

test('a goalkeeper running along its line turns to face the shot and dives across it', () => {
  const ui = setup();
  // The engine has it facing +y, the way it runs along its line; the shot comes from +x.
  for (let i = 0; i < 12; i++) {
    const a = snap(1 + i * STEP, [player(1, 0, i * 0.12, { heading: Math.PI / 2, dive: true })], { x: 12 - i, y: 1 });
    const b = snap(1 + (i + 1) * STEP, [player(1, 0, (i + 1) * 0.12, { heading: Math.PI / 2, dive: true })], { x: 11 - i, y: 1 });
    ui.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  const facing = ui.keeper.facing();
  assert.ok(Math.abs(facing - Math.atan2(1, 6)) < 0.2, `faces the shot: ${facing}`);
  assert.equal(ui.keeper.group.children[1].rotation.y, facing + Math.PI / 2, 'the figure turns with it');
  // Moving to its left as it faces the shot (+y): it dives to its left.
  assert.deepEqual(ui.keeper.acting(), ['keeper_dive_L']);
  for (let i = 0; i < 120; i++) {
    const rest = snap(2 + i / 60, [player(1, 0, 1.5, { heading: Math.PI / 2 })], { x: 30, y: 0 });
    ui.actors.update(rest, rest, 1, 1 / 60, 2 + i / 60);
  }
  assert.ok(Math.abs(ui.keeper.facing() - Math.PI / 2) < 0.05, 'and turns back to its run');
});

test('a goalkeeper catching a ball at full reach and kicking it at once draws no jump', () => {
  const ui = setup();
  // The engine meets the ball 1.5 m out, pulls it to 0.6 m ahead in the same step and
  // kicks it the next: both touches reach the page in one snapshot.
  const t0 = 2;
  const keeperAt = [player(1, 0, 0)];
  const caught = { player: 1, kind: 'catch', t: t0 + 1 / 60, x: 1.5, y: 0, z: 0.11 };
  const kicked = { player: 1, kind: 'kick', t: t0 + 2 / 60, x: 0.6, y: 0, z: 0.11 };
  const shots = [
    snap(t0 - STEP, keeperAt, { x: 1.5 + 10 * STEP, y: 0 }),
    snap(t0, keeperAt, { x: 1.5, y: 0 }),
    snap(t0 + STEP, keeperAt, { x: 0.6, y: 0.33, touches: [caught, kicked] }),
    snap(t0 + 2 * STEP, keeperAt, { x: 0.6, y: 0.99, touches: [caught, kicked] }),
  ];
  let last = null;
  let most = 0;
  for (let time = t0 - STEP; time <= t0 + 2 * STEP + 1e-9; time += 1 / 60) {
    const i = Math.min(shots.length - 2, Math.floor((time - shots[0].t) / STEP + 1e-9));
    ui.actors.update(shots[i], shots[i + 1], (time - shots[i].t) / STEP, 1 / 60, time, shots.at(-1));
    if (last) most = Math.max(most, ui.ball.position.distanceTo(last));
    last = ui.ball.position.clone();
  }
  assert.ok(most < 0.45, `largest step in a 60 Hz frame: ${most}`);
});

test('a touch from before the page joined is not replayed', () => {
  const ui = setup();
  const touch = { player: 2, kind: 'kick', t: 1, x: 0.6, y: 0, z: 0.11 };
  const s = snap(9, [player(2, 0, 0)], { x: 20, y: 0, touches: [touch] });
  ui.actors.update(s, s, 1, 1 / 60, 1);
  ui.actors.update(s, s, 1, 1 / 60, 1.1);
  assert.deepEqual(ui.forward.acting(), []);
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

test('the stride follows the drawn movement: speed and the direction against the facing', () => {
  const ui = setup();
  // Running along +x at 6 m/s, facing the way it runs.
  for (let i = 0; i < 30; i++) {
    const a = snap(1 + i * STEP, [player(2, i * 0.2, 0, { speed: 6 })], { x: 30, y: 0 });
    const b = snap(1 + (i + 1) * STEP, [player(2, (i + 1) * 0.2, 0, { speed: 6 })], { x: 30, y: 0 });
    ui.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  let state = ui.forward.state();
  assert.ok(Math.abs(state.speed - 6) < 0.05, `drawn speed ${state.speed}`);
  assert.ok(Math.abs(state.travel) < 1e-6, 'forwards');
  assert.deepEqual(Object.keys(state.loops).sort(), ['jog', 'sprint']);
  // Moving to its left (+y) at 3 m/s while the engine still has it facing +x.
  const side = setup();
  for (let i = 0; i < 30; i++) {
    const a = snap(1 + i * STEP, [player(2, 0, i * 0.1, { speed: 3 })], { x: 30, y: 0 });
    const b = snap(1 + (i + 1) * STEP, [player(2, 0, (i + 1) * 0.1, { speed: 3 })], { x: 30, y: 0 });
    side.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  state = side.forward.state();
  assert.ok(Math.abs(state.travel - Math.PI / 2) < 1e-6, `to its left: ${state.travel}`);
  assert.ok(state.loops.strafe_L > 0.5, `side-stepping: ${JSON.stringify(state.loops)}`);
  // A snapshot it is missing from hides it, and a hidden figure is not animated.
  const gone = snap(3, [], { x: 30, y: 0 });
  side.actors.update(gone, gone, 1, STEP, 3);
  const hidden = side.forward.state();
  side.actors.update(gone, gone, 1, STEP, 3.1);
  assert.equal(hidden.visible, false);
  assert.deepEqual(side.forward.state(), hidden);
});

test('a goal: the scoring team celebrates, the other does not', () => {
  const scene = new THREE.Scene();
  const actors = createPlayers(scene, [
    { colours: { shirt: '#123456', shorts: '#ffffff', keeper: '#ffcc00' }, players: [{ id: 1, number: 9, position: 'FW' }] },
    { colours: { shirt: '#654321', shorts: '#000000', keeper: '#00ccff' }, players: [{ id: 2, number: 4, position: 'DF' }] },
  ], figure);
  const s = snap(5, [player(1, 0, 0), player(2, 5, 0)], { x: 0, y: 0 }, 'kickoff');
  actors.handleEvent({ kind: 'goal', team: 1 }, 10);
  actors.update(s, s, 1, 1 / 60, 10.5);
  assert.deepEqual(actors.inspect(1).acts, []);
  assert.deepEqual(actors.inspect(2).acts.map(a => a.name), ['celebrate']);
  actors.dispose();
});

test('the ball is drawn at the engine\'s size, with a crisp shadow beneath it', () => {
  const ui = setup();
  const s = snap(1, [], { x: 2, y: 3 });
  ui.actors.update(s, s, 1, 1 / 60, 1);
  const geometry = ui.shell.geometry;
  geometry.computeBoundingSphere();
  assert.ok(Math.abs(geometry.boundingSphere.radius - 0.11) < 1e-6, 'a 0.11 m radius');
  assert.ok(geometry.attributes.color, 'its panels are vertex colours on one mesh');
  const shadow = ui.scene.children[0].children.find(child => child.isMesh && Math.abs(child.position.x - 2) < 1e-9);
  assert.ok(shadow.material.opacity >= 0.55, 'dark on the grass');
});

test('a pose cut short by a kick fades out under it', () => {
  const ui = setup();
  const control = { player: 2, kind: 'control', t: 2, x: 0.6, y: 0, z: 0.11 };
  const kick = { player: 2, kind: 'kick', t: 2.1, x: 0.6, y: 0, z: 0.11 };
  const a = snap(1.95, [player(2, 0, 0)], { x: 1, y: 0 });
  const b = snap(2, [player(2, 0, 0)], { x: 0.6, y: 0, owner: 2, touches: [control] });
  const c = snap(2.1, [player(2, 0, 0)], { x: 1.2, y: 0, touches: [control, kick] });
  ui.actors.update(a, b, 0.9, 1 / 60, 1.995, b);
  ui.actors.update(b, b, 1, 1 / 60, 2.01, c); // the kick is seen and cuts the control short
  ui.actors.update(b, c, 0.3, 1 / 60, 2.04, c);
  assert.deepEqual(ui.forward.acting().sort(), ['control', 'pass'], 'both show for a moment');
  const d = snap(2.2, [player(2, 0, 0)], { x: 3, y: 0, touches: [control, kick] });
  ui.actors.update(c, d, 0.5, 1 / 60, 2.2, d);
  assert.ok(!ui.forward.acting().includes('control') && kickOf(ui.forward), `then only the kick: ${ui.forward.acting()}`);
});

test('a throw-in: the taker holds the ball in its hands and lets it go on the throw', () => {
  const ui = setup();
  const hands = () => {
    const figure = ui.forward.group.children[1];
    figure.updateWorldMatrix(true, true);
    const point = new THREE.Vector3();
    for (const name of ['hand_L', 'hand_R']) point.add(figure.getObjectByName(name).localToWorld(new THREE.Vector3(0, 0.07, 0)));
    return point.multiplyScalar(0.5);
  };
  const waiting = (t) => snap(t, [player(2, 0, 33.4)], { x: 0, y: 34 }, 'throw_in');
  for (let i = 0; i <= 30; i++) ui.actors.update(waiting(1 + i / 60), waiting(1 + (i + 1) / 60), 0.5, 1 / 60, 1 + i / 60);
  assert.ok(ui.forward.act('throw_in'), 'it takes up the throw');
  assert.ok(ui.ball.position.distanceTo(hands()) < 1e-6, 'the ball is in its hands');
  // The throw: the ball leaves from the touchline, rising.
  const touch = { player: 2, kind: 'throw', t: 1.6, x: 0, y: 34, z: 0.12 };
  const flight = (t) => snap(t, [player(2, 0, 33.4)], { x: 0, y: 34 - 8 * (t - 1.6 + 1 / 60), z: 0.12 + 4 * (t - 1.6 + 1 / 60), touches: [touch] });
  ui.actors.update(waiting(1.55), waiting(1.55), 1, 1 / 60, 1.55, flight(1.6));
  const contact = touch.t - 1 / 60;
  let time = 1.55;
  for (; time < contact - 1e-9; time += 1 / 120) {
    ui.actors.update(waiting(1.55), flight(1.6), (time - 1.55) / 0.05, 1 / 120, time, flight(1.6));
  }
  assert.ok(ui.ball.position.distanceTo(hands()) < 0.05, 'in its hands until the release');
  for (let t = time; t < 2.2; t += 1 / 60) {
    const a = flight(Math.floor(t * 30) / 30);
    const b = flight(Math.floor(t * 30) / 30 + 1 / 30);
    ui.actors.update(a, b, (t - a.t) * 30, 1 / 60, t, b);
  }
  const path = flight(2.2);
  assert.ok(Math.abs(ui.ball.position.z + path.ball.y) < 0.3, `then on its path: ${ui.ball.position.z} vs ${-path.ball.y}`);
});

test('a celebration over a run moves the upper body; a slide tackle moves the whole body', () => {
  const ui = setup();
  ui.actors.handleEvent({ kind: 'goal', team: 0 }, 1);
  for (let i = 0; i < 30; i++) {
    const a = snap(1 + i * STEP, [player(2, i * 0.2, 0, { speed: 6 })], { x: 30, y: 0 });
    const b = snap(1 + (i + 1) * STEP, [player(2, (i + 1) * 0.2, 0, { speed: 6 })], { x: 30, y: 0 });
    ui.actors.update(a, b, 0.5, STEP, 1 + i * STEP);
  }
  assert.deepEqual(ui.forward.state().acts.map(a => a.name), ['celebrate:gesture']);
  const tackler = setup();
  const touch = { player: 2, kind: 'tackle', t: 2, x: 6.6, y: 0, z: 0.11 };
  for (let i = 0; i < 36; i++) {
    const t = 1 + i * STEP;
    const a = snap(t, [player(2, i * 0.2, 0, { speed: 6 })], { x: 8, y: 0, touches: t >= 2 ? [touch] : [] });
    const b = snap(t + STEP, [player(2, (i + 1) * 0.2, 0, { speed: 6 })], { x: 8, y: 0, touches: t + STEP >= 2 ? [touch] : [] });
    tackler.actors.update(a, b, 0.5, STEP, t + STEP / 2, b);
  }
  assert.ok(tackler.forward.state().acts.some(a => a.name === 'tackle'), 'the whole slide, at a run');
});

test('a goalkeeper holds the ball it caught at its chest until it kicks it', () => {
  const ui = setup();
  const catchIt = { player: 1, kind: 'catch', t: 2, x: 0.7, y: 0.1, z: 0.11 };
  const kick = { player: 1, kind: 'kick', t: 4, x: 0.6, y: 0, z: 0.11 };
  const at = (t) => {
    const touches = [catchIt, ...(t >= 4 ? [kick] : [])];
    const owner = t >= 2 && t < 4 ? 1 : null;
    const ball = t < 2 ? { x: 0.7 + (2 - t) * 10, y: 0.1 } : t < 4 ? { x: 0.6, y: 0, owner } : { x: 0.6 + (t - 4 + 1 / 60) * 20, y: 0 };
    return snap(t, [player(1, 0, 0)], { ...ball, touches });
  };
  let shown = null;
  const run = (from, to) => {
    for (let t = from; t < to; t += 1 / 60) {
      const a = at(Math.floor(t * 30 + 1e-9) / 30);
      const b = at(Math.floor(t * 30 + 1e-9) / 30 + 1 / 30);
      ui.actors.update(a, b, (t - a.t) * 30, 1 / 60, t, at(Math.floor(t * 30 + 1e-9) / 30 + 0.1));
      shown = ui.keeper.act('keeper_catch');
    }
  };
  run(1.8, 3.5); // well past the end of the catch
  assert.ok(shown, 'still holding');
  assert.equal(shown.time, ONE_SHOTS.keeper_catch[0], 'at the clip\'s end');
  const figure = ui.keeper.group.children[1];
  figure.updateWorldMatrix(true, true);
  const hands = new THREE.Vector3();
  for (const name of ['hand_L', 'hand_R']) hands.add(figure.getObjectByName(name).localToWorld(new THREE.Vector3(0, 0.07, 0)));
  assert.ok(ui.ball.position.distanceTo(hands.multiplyScalar(0.5)) < 1e-6, 'the ball in its hands');
  run(3.5, 4.4);
  assert.equal(ui.keeper.act('keeper_catch'), undefined, 'it lets go to kick');
  assert.ok(kickOf(ui.keeper), 'and kicks');
});
