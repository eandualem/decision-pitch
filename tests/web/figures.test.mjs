// Run with node --test tests/web/figures.test.mjs; no npm dependencies required.
import './three-resolve.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';
import { fixtureGltf, LOOPS, MORE_LOOPS, HAIRS, CODES } from './figure-fixture.mjs';

globalThis.document ??= { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
const figures = await import('../../src/decision_pitch/web/src/figures.js');
const { blendLoops, gait, contactTime, envelope, variation, outfit, prepareFigure, createFigures, loadFigure, reachFor, switchingState } = figures;

const fixture = () => {
  const { scene, animations, info } = fixtureGltf();
  return prepareFigure(scene, animations, info);
};
const describe = () => fixtureGltf().info.clips;
// The figure with the clips of natural movement: eight directions, loop sets and more.
const describeMore = () => fixtureGltf({ more: true }).info.clips;
const fixtureMore = () => {
  const { scene, animations, info } = fixtureGltf({ more: true });
  return prepareFigure(scene, animations, info);
};
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

// The planted foot's velocity against the ground for a blend: each loop's foot moves
// opposite its travel at its speed times its playback rate, and the figure moves at `speed`.
// The figure's hips turn by `steps.yaw`, the angle the blended stride misses the travel by.
function footSlip(steps, weights, rate, scale, speed, travel) {
  travel -= steps.yaw;
  let fx = 0;
  let fy = 0;
  steps.loops.forEach((loop, i) => {
    const playback = rate * loop.duration; // clip seconds per second
    fx -= weights[i] * loop.speed * playback * scale * Math.cos(loop.angle);
    fy -= weights[i] * loop.speed * playback * scale * Math.sin(loop.angle);
  });
  return Math.hypot(fx + speed * Math.cos(travel), fy + speed * Math.sin(travel));
}

test('locomotion weights always sum to one, with idle alone at a standstill', () => {
  const steps = gait(describe());
  const weights = new Float32Array(steps.loops.length);
  assert.equal(blendLoops(steps, 0, 1, 1, weights), 0);
  assert.equal(weights[0], 1, 'idle');
  for (let speed = 0.05; speed < 9.5; speed += 0.15) {
    for (let travel = -Math.PI; travel <= Math.PI; travel += 0.3) {
      blendLoops(steps, speed, travel, 1.04, weights);
      const sum = weights.reduce((a, b) => a + b, 0);
      assert.ok(near(sum, 1, 1e-6), `sum ${sum} at ${speed} m/s, ${travel} rad`);
      assert.ok(weights.every(w => w >= 0));
    }
  }
});

test('a loop at the speed it was made for plays alone at its own pace, over the figure scale', () => {
  const steps = gait(describe());
  const weights = new Float32Array(steps.loops.length);
  for (const name of ['walk', 'jog', 'sprint']) {
    for (const scale of [1.7 / 1.8, 1, 1.95 / 1.8]) {
      // Its clip speed times the figure's scale is the speed it was made for.
      const rate = blendLoops(steps, LOOPS[name].speed * scale, 0, scale, weights);
      const i = steps.loops.findIndex(loop => loop.name === name);
      assert.ok(near(weights[i], 1), `${name} alone`);
      assert.ok(near(rate * LOOPS[name].duration, 1), `${name} plays at its own pace`);
      const faster = blendLoops(steps, LOOPS.sprint.speed * scale * 1.2, 0, scale, weights);
      assert.ok(near(faster * LOOPS.sprint.duration, 1.2), 'beyond the sprint it plays at speed / (clip speed x scale)');
    }
  }
  const back = steps.loops.findIndex(loop => loop.name === 'backpedal');
  const rate = blendLoops(steps, 2.5 + 0.1, Math.PI, 1, weights);
  assert.ok(near(weights[back], 1), 'backwards, beyond the walk, it backpedals');
  assert.ok(near(rate * LOOPS.backpedal.duration, 2.6 / 2), 'faster than made for, it plays faster');
});

test('feet stay planted at every speed and direction, through the blend boundaries', () => {
  const steps = gait(describe());
  const weights = new Float32Array(steps.loops.length);
  for (const scale of [1.7 / 1.8, 1.95 / 1.8]) {
    for (let speed = 0.02; speed <= 9; speed += 0.07) {
      // Ignoring the travel below a shuffle, the figure steps forwards, so check forwards there.
      const pace = speed / scale;
      const travels = pace <= steps.shuffle ? [0] : [0, 0.4, 1.2, Math.PI / 2, 2.2, Math.PI, -0.7, -Math.PI / 2, -2.6];
      for (const travel of travels) {
        const rate = blendLoops(steps, speed, travel, scale, weights);
        const slip = footSlip(steps, weights, rate, scale, speed, travel);
        assert.ok(slip < 1e-6 * speed, `slip ${slip} m/s at ${speed.toFixed(2)} m/s, travel ${travel}`);
      }
    }
  }
});

test('the blend changes smoothly with speed and travel', () => {
  const steps = gait(describe());
  const a = new Float32Array(steps.loops.length);
  const b = new Float32Array(steps.loops.length);
  for (const travel of [0, 0.9, Math.PI / 2, Math.PI]) {
    for (let speed = 0; speed < 9; speed += 0.01) {
      const ra = blendLoops(steps, speed, travel, 1, a);
      const rb = blendLoops(steps, speed + 0.01, travel, 1, b);
      for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.02, `weight jump at ${speed} m/s`);
      if (speed > 0.05) assert.ok(Math.abs(ra - rb) < 0.05, `rate jump at ${speed} m/s: ${ra} -> ${rb}`);
    }
  }
  for (let travel = -Math.PI; travel < Math.PI; travel += 0.01) {
    blendLoops(steps, 4, travel, 1, a);
    blendLoops(steps, 4, travel + 0.01, 1, b);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.03, `weight jump at ${travel} rad`);
  }
});

test('below a shuffle the travel is ignored; above it a slow sideways or backwards move steps that way', () => {
  const steps = gait(describe());
  const weights = new Float32Array(steps.loops.length);
  const shown = () => steps.loops.filter((_, i) => weights[i] > 1e-9).map(loop => loop.name);
  blendLoops(steps, 0.1, Math.PI / 2, 1, weights);
  assert.deepEqual(shown(), ['idle', 'walk'], 'barely moving: a step forwards');
  for (const speed of [1, 1.5, 2]) {
    let rate = blendLoops(steps, speed, Math.PI / 2, 1, weights);
    assert.deepEqual(shown(), ['idle', 'strafe_L'].slice(speed >= 2 ? 1 : 0), `${speed} m/s to its left`);
    assert.ok(footSlip(steps, weights, rate, 1, speed, Math.PI / 2) < 1e-6, 'planted');
    rate = blendLoops(steps, speed, Math.PI, 1, weights);
    assert.deepEqual(shown(), ['idle', 'backpedal'].slice(speed >= 2 ? 1 : 0), `${speed} m/s backwards`);
    assert.ok(footSlip(steps, weights, rate, 1, speed, Math.PI) < 1e-6, 'planted');
    rate = blendLoops(steps, speed, 2.4, 1, weights);
    assert.ok(!shown().some(name => ['walk', 'jog', 'sprint'].includes(name)), 'never forwards against a backwards move');
    assert.ok(footSlip(steps, weights, rate, 1, speed, 2.4) < 1e-6, 'planted on a diagonal');
  }
  blendLoops(steps, 4, Math.PI / 2, 1, weights);
  assert.ok(near(weights[steps.loops.findIndex(loop => loop.name === 'strafe_L')], 1), 'sideways at a run, it strafes');
});

test('a figure without sideways or backwards loops runs forwards instead', () => {
  const clips = describe();
  delete clips.strafe_L;
  delete clips.strafe_R;
  delete clips.backpedal;
  const steps = gait(clips);
  const weights = new Float32Array(steps.loops.length);
  const rate = blendLoops(steps, 4, Math.PI / 2, 1, weights);
  assert.ok(near(weights.reduce((x, y) => x + y, 0), 1, 1e-6));
  assert.ok(rate > 0);
});

test('with loops in eight directions, feet stay planted at any angle and speed, and the blend is smooth', () => {
  const steps = gait(describeMore());
  const weights = new Float32Array(steps.loops.length);
  const before = new Float32Array(steps.loops.length);
  const names = (w) => steps.loops.filter((_, i) => w[i] > 1e-9).map(loop => loop.name);
  for (const stride of [0.9, 1, 1.1]) {
    for (const scale of [1.7 / 1.8, 1.95 / 1.8]) {
      for (let speed = 0.4; speed <= 9; speed += 0.13) {
        for (let travel = -Math.PI; travel < Math.PI; travel += 0.11) {
          const rate = blendLoops(steps, speed, travel, scale, weights, null, stride);
          const sum = weights.reduce((x, y) => x + y, 0);
          assert.ok(near(sum, 1, 1e-6) && weights.every(w => w >= 0), `sum ${sum}`);
          const slip = footSlip(steps, weights, rate, scale, speed, travel);
          assert.ok(slip < 1e-6 * speed, `slip ${slip} m/s at ${speed.toFixed(2)} m/s, travel ${travel.toFixed(2)}, stride ${stride}`);
        }
      }
    }
  }
  // Turning steadily, as a figure does over time, the blend never jumps.
  const switching = switchingState(steps);
  switching.dt = 0.003;
  blendLoops(steps, 3, -Math.PI, 1, before, null, 1, switching);
  let yaw = steps.yaw;
  for (let travel = -Math.PI + 0.01; travel < Math.PI; travel += 0.01) {
    blendLoops(steps, 3, travel, 1, weights, null, 1, switching);
    for (let i = 0; i < weights.length; i++) assert.ok(Math.abs(weights[i] - before[i]) < 0.04, `weight jump at ${travel} rad`);
    assert.ok(Math.abs(steps.yaw - yaw) < 0.05, `the hips jump at ${travel} rad: ${yaw} -> ${steps.yaw}`);
    before.set(weights);
    yaw = steps.yaw;
  }
  for (let speed = 0; speed < 9; speed += 0.01) {
    const ra = blendLoops(steps, speed, 2.1, 1, before);
    const rb = blendLoops(steps, speed + 0.01, 2.1, 1, weights);
    for (let i = 0; i < weights.length; i++) assert.ok(Math.abs(weights[i] - before[i]) < 0.02, `weight jump at ${speed} m/s`);
    if (speed > 0.05) assert.ok(Math.abs(ra - rb) < 0.05, `rate jump at ${speed} m/s`);
  }
  // A diagonal at the speed it was made for plays alone at its own pace; halfway between
  // two directions, both play, and nothing travels against the move.
  const rate = blendLoops(steps, MORE_LOOPS.jog_BL.speed, 3 * Math.PI / 4, 1, weights);
  assert.deepEqual(names(weights), ['jog_BL']);
  assert.ok(near(rate * MORE_LOOPS.jog_BL.duration, 1));
  blendLoops(steps, 2.5, 5 * Math.PI / 8, 1, weights);
  assert.ok(!names(weights).includes('strafe_L'), 'the side shuffle is the jockey\'s, not the run\'s');
  const angles = new Set(steps.loops.filter((loop, i) => weights[i] > 1e-9 && loop.speed > 0).map(loop => Math.round(loop.angle * 4 / Math.PI)));
  assert.deepEqual([...angles].sort(), [2, 3], `left and back-left only: ${names(weights)}`);
});

test('walking backwards and stepping back to the side are never blended part way: the figure changes over time', () => {
  const steps = gait(describeMore());
  const weights = new Float32Array(steps.loops.length);
  const footwork = () => new Set(steps.loops.filter((loop, i) => weights[i] > 1e-6 && loop.speed > 0).map(loop => loop.footwork));
  const deg = (d) => d * Math.PI / 180;
  // Without a state, the footwork of the nearest direction, its hips turned to the travel.
  let rate = blendLoops(steps, 2, deg(165), 1, weights);
  assert.deepEqual([...footwork()], ['back']);
  assert.ok(near(steps.yaw, deg(-15), 1e-9), `the hips turn by what straight back misses: ${steps.yaw}`);
  assert.ok(footSlip(steps, weights, rate, 1, 2, deg(165)) < 1e-6, 'planted');
  rate = blendLoops(steps, 2, deg(150), 1, weights);
  assert.deepEqual([...footwork()], ['forward']);
  assert.ok(near(steps.yaw, deg(15), 1e-9), 'or by what back to the side misses');
  assert.ok(footSlip(steps, weights, rate, 1, 2, deg(150)) < 1e-6, 'planted');
  // With one, it keeps its footwork just past the middle, and changes over SWITCH s.
  const switching = switchingState(steps);
  switching.dt = 1 / 60;
  blendLoops(steps, 2, deg(140), 1, weights, null, 1, switching);
  blendLoops(steps, 2, deg(159), 1, weights, null, 1, switching);
  assert.deepEqual([...footwork()], ['forward'], 'just past the middle it keeps stepping back to the side');
  let frames = 0;
  while (footwork().has('forward')) {
    blendLoops(steps, 2, deg(165), 1, weights, null, 1, switching);
    frames++;
    assert.ok(frames < 30, 'it changes within half a second');
  }
  assert.ok(frames >= 8, `over a few frames, not at once: ${frames}`);
  rate = blendLoops(steps, 2, deg(165), 1, weights, null, 1, switching);
  assert.deepEqual([...footwork()], ['back']);
  assert.ok(footSlip(steps, weights, rate, 1, 2, deg(165)) < 1e-6, 'planted once changed');
});

test('a loop may travel at any angle, which wins over its named direction', () => {
  const clips = describe();
  clips.lunge_L = { loop: true, duration: 0.8, speed: 2, direction: 'forward', angle: 120 };
  const steps = gait(clips);
  const lunge = steps.loops.findIndex(loop => loop.name === 'lunge_L');
  assert.ok(near(steps.loops[lunge].angle, 2 * Math.PI / 3));
  const weights = new Float32Array(steps.loops.length);
  const rate = blendLoops(steps, 2, 2 * Math.PI / 3, 1, weights);
  assert.ok(near(weights[lunge], 1), 'alone along its own angle');
  assert.ok(near(rate * 0.8, 1));
  for (let travel = -Math.PI; travel < Math.PI; travel += 0.05) {
    const r = blendLoops(steps, 2.2, travel, 1, weights);
    assert.ok(footSlip(steps, weights, r, 1, 2.2, travel) < 1e-6, `planted at ${travel}`);
  }
});

test('a shorter stride takes quicker steps over the same ground, a longer one slower steps', () => {
  const steps = gait(describe());
  const weights = new Float32Array(steps.loops.length);
  const speed = 2.5;
  const short = blendLoops(steps, speed, 0, 1, weights, null, 0.9);
  assert.ok(footSlip(steps, weights, short, 1, speed, 0) < 1e-6);
  const usual = blendLoops(steps, speed, 0, 1, weights);
  const long = blendLoops(steps, speed, 0, 1, weights, null, 1.1);
  assert.ok(footSlip(steps, weights, long, 1, speed, 0) < 1e-6);
  assert.ok(short > usual * 1.02 && long < usual * 0.98, `cadence ${short} / ${usual} / ${long}`);
});

test('a loop set takes its share of the blend, fills what it lacks from the run, and keeps the feet planted', () => {
  const steps = gait(describeMore());
  const weights = new Float32Array(steps.loops.length);
  const mix = new Float32Array(steps.sets.length);
  const index = (name) => steps.loops.findIndex(loop => loop.name === name);
  const shown = () => steps.loops.filter((_, i) => weights[i] > 1e-9).map(loop => loop.name).sort();
  assert.deepEqual(steps.sets.map(set => set.name), ['run', 'dribble', 'jockey', 'shield']);
  const { dribble, jockey, shield } = steps.set;
  mix[dribble] = 1;
  let rate = blendLoops(steps, MORE_LOOPS.dribble.speed, 0, 1, weights, mix);
  assert.deepEqual(shown(), ['dribble'], 'a dribble at its speed');
  assert.ok(near(rate * MORE_LOOPS.dribble.duration, 1));
  blendLoops(steps, 1, 0, 1, weights, mix);
  assert.deepEqual(shown(), ['idle', 'walk'], 'slower than its slowest, the run walks with the ball');
  blendLoops(steps, 3, Math.PI, 1, weights, mix);
  assert.deepEqual(shown(), ['backpedal', 'jog_B'], 'a direction it has no loops for comes from the run');
  mix[dribble] = 0;
  mix[jockey] = 1;
  blendLoops(steps, 0, 0, 1, weights, mix);
  assert.deepEqual(shown(), ['jockey'], 'standing, the set stands in its stance');
  blendLoops(steps, 1, Math.PI, 1, weights, mix);
  assert.deepEqual(shown(), ['jockey', 'jockey_B'], 'backing off slowly, from the stance');
  blendLoops(steps, 2, Math.PI / 2, 1, weights, mix);
  assert.deepEqual(shown(), ['strafe_L'], 'side-stepping, it shuffles');
  blendLoops(steps, 5, Math.PI, 1, weights, mix);
  assert.deepEqual(shown(), ['jog_B'], 'faster than its fastest, the run takes over');
  mix[jockey] = 0;
  mix[shield] = 1;
  blendLoops(steps, 0.8, Math.PI, 1, weights, mix);
  assert.deepEqual(shown(), ['shield_B']);
  // Cross-fading between sets, at any speed and angle, the feet stay planted.
  for (const share of [0.25, 0.5, 0.8]) {
    mix.fill(0);
    mix[dribble] = share;
    mix[jockey] = (1 - share) / 2;
    for (let speed = 0.4; speed < 8; speed += 0.3) {
      for (let travel = -Math.PI; travel < Math.PI; travel += 0.2) {
        rate = blendLoops(steps, speed, travel, 1.02, weights, mix);
        assert.ok(near(weights.reduce((x, y) => x + y, 0), 1, 1e-6));
        assert.ok(footSlip(steps, weights, rate, 1.02, speed, travel) < 1e-6 * speed, `planted at ${speed} m/s, ${travel} rad`);
      }
    }
  }
  // Shares over one between them are scaled down to one, and the run gives way.
  mix.fill(0);
  mix[dribble] = 1;
  mix[shield] = 1;
  blendLoops(steps, 0.8, 0, 1, weights, mix);
  assert.ok(near(weights.reduce((x, y) => x + y, 0), 1, 1e-6));
  assert.equal(weights[index('walk')] > 0 && weights[index('dribble_slow')] === 0, true);
});

test('a figure fades a loop set in and out, keeps the stances on their own clock, and meets the ball at the touch', () => {
  const { scene, animations, info } = fixtureGltf({ more: true });
  for (const name of ['dribble_slow', 'dribble', 'dribble_sprint']) info.clips[name].touch = 0.3;
  const made = createFigures(prepareFigure(scene, animations, info));
  const person = made.create({ seed: 3 });
  const sets = { dribble: 1, jockey: 0, shield: 0 };
  person.update(1 / 60, 4.5 * person.scale, 0, sets);
  assert.ok(person.state().sets.dribble > 0 && person.state().sets.dribble < 0.15, 'it comes in, not at once');
  for (let i = 0; i < 60; i++) person.update(1 / 60, 4.5 * person.scale, 0, sets);
  assert.ok(person.state().sets.dribble > 0.99, 'and is all there a second later');
  assert.ok(person.state().loops.dribble > 0.99, `dribbling: ${JSON.stringify(person.state().loops)}`);
  assert.ok(near(person.touch(), 0.3, 0.005), 'the dribble meets the ball at its touch');
  person.update(1 / 60, 3.5 * person.scale, 0, sets);
  sets.dribble = 0;
  for (let i = 0; i < 60; i++) person.update(1 / 60, 3.5 * person.scale, 0, sets);
  assert.ok(near(person.touch(), 0.4, 0.005), 'a loop without a touch meets it at 0.4');
  assert.ok(near(person.touch(0.45), 0.45, 0.005), 'or where the page says');
  sets.jockey = 1;
  for (let i = 0; i < 90; i++) person.update(1 / 60, 0, 0, sets);
  const foot = person.object.getObjectByName('foot_L').position;
  assert.ok(near(foot.x, CODES.jockey, 0.05), 'standing in the jockey stance');
  const at = foot.y;
  person.update(0.3, 0, 0, sets);
  assert.ok(near(foot.y, (at + 0.3) % MORE_LOOPS.jockey.duration, 0.01), `which runs on its own clock while the stride stands still: ${at} -> ${foot.y}`);
  made.dispose();
});

test('a late-seen wind-up plays faster, at most twice, and contact lands on the touch', () => {
  assert.equal(contactTime(0, -0.1, 0.4), 0.4);
  assert.ok(near(contactTime(0.2, -0.1, 0.4), 0.6), 'its own pace after contact');
  assert.ok(near(contactTime(-0.1, -0.1, 0.4), 0.2), 'seen 0.1 s ahead: half the wind-up at twice the pace');
  assert.ok(near(contactTime(-0.3, -0.3, 0.4), 0), 'seen 0.3 s ahead: all of it, a third faster');
  assert.equal(contactTime(-0.9, -0.9, 0.4), 0, 'seen early: it waits at the start');
  let last = -1;
  for (let u = -0.1; u <= 0.5; u += 0.01) {
    const time = contactTime(u, -0.1, 0.4);
    assert.ok(time >= last, 'never goes back');
    last = time;
  }
  assert.equal(envelope(-0.1, -0.1, 0.6), 0);
  assert.equal(envelope(0, -0.1, 0.6), 1);
  assert.equal(envelope(0.6, -0.1, 0.6), 0);
});

test('a person looks the same for the same id, and 22 players do not repeat each other', () => {
  const options = { hairs: HAIRS.length, morphs: ['build_slim', 'build_broad', 'face_wide', 'face_long', 'jaw_strong', 'nose_big'] };
  assert.deepEqual(variation(7, options), variation(7, options));
  assert.deepEqual(variation('manager-1', options), variation('manager-1', options));
  const staff = Array.from({ length: 40 }, (_, i) => variation(`assistant-${i}`, { ...options, greying: true }));
  assert.ok(staff.filter(l => l.hairColour === 6).length >= 10, 'staff on the touchline are often grey');
  assert.notDeepEqual(variation('manager-0', options), variation('manager-1', options));
  const looks = Array.from({ length: 22 }, (_, i) => variation(i + 1, options));
  for (const look of looks) {
    assert.ok(look.height >= 1.7 && look.height <= 1.95, `height ${look.height}`);
    assert.ok(look.hair >= 0 && look.hair < HAIRS.length);
    assert.ok(!(look.shapes.build_slim > 0 && look.shapes.build_broad > 0), 'one build at a time');
    assert.ok(!(look.shapes.face_wide > 0 && look.shapes.face_long > 0), 'one face shape at a time');
  }
  assert.equal(looks.filter(l => l.hairColour === 6).length, 0, 'no grey-haired players');
  const keys = looks.map(l => `${l.skin}/${l.hair}/${l.hairColour}/${l.height.toFixed(2)}`);
  assert.equal(new Set(keys).size, 22, 'no two alike');
  for (const team of [looks.slice(0, 11), looks.slice(11)]) {
    assert.ok(new Set(team.map(l => l.skin)).size >= 4, 'a range of skin tones in each team');
    assert.ok(new Set(team.map(l => l.hair)).size >= 4, 'a range of hair styles in each team');
    const heights = team.map(l => l.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) > 0.15, 'a range of heights');
  }
});

test('kits are painted by region for players, keepers, managers and assistants', () => {
  const look = variation(3, { hairs: 6 });
  const colours = { shirt: '#1f5fbf', shorts: '#ffffff', keeper: '#f2c230' };
  const player = outfit('outfield', colours, { ...look, longSleeves: false });
  assert.equal(player.shirt, '#1f5fbf');
  assert.equal(player.socks, '#1f5fbf', 'socks take the shirt colour');
  assert.equal(player.sleeve, player.skin, 'short sleeves');
  assert.equal(player.legs, player.skin);
  assert.equal(outfit('outfield', colours, { ...look, longSleeves: true }).sleeve, '#1f5fbf');
  const keeper = outfit('keeper', colours, look);
  assert.equal(keeper.shirt, '#f2c230');
  assert.equal(keeper.sleeve, '#f2c230', 'long sleeves');
  assert.notEqual(keeper.hands, keeper.skin, 'gloves');
  const manager = outfit('manager', colours, look);
  assert.equal(manager.coat, '#1f5fbf');
  assert.equal(manager.shorts, manager.legs, 'trousers');
  assert.equal(manager.trousers, manager.legs, 'the jacket\'s trousers match');
  assert.notEqual(manager.trousers, manager.coat, 'a jacket in the team colour over dark trousers');
  assert.notEqual(manager.trim, manager.coat, 'a light collar and zip on the jacket');
  assert.equal(manager.legs, manager.socks);
  const assistant = outfit('assistant', colours, look);
  assert.equal(assistant.sleeve, '#1f5fbf', 'a tracksuit top');
  assert.equal(assistant.shorts, assistant.socks, 'tracksuit trousers');
});

test('clones share geometry, clips and team materials, and show one hair style', () => {
  const template = fixture();
  const made = createFigures(template);
  const colours = { shirt: '#1f5fbf', shorts: '#ffffff', keeper: '#f2c230' };
  const a = made.create({ seed: 1, colours, number: 4 });
  const b = made.create({ seed: 2, colours, number: 5 });
  const other = made.create({ seed: 3, colours: { shirt: '#e0562b', shorts: '#111111' }, number: 6 });
  const shirtOf = (person) => person.object.getObjectByName('body').children.find(m => m.userData.region === 'shirt');
  assert.equal(shirtOf(a).geometry, template.scene.getObjectByName('body').children[1].geometry, 'geometry is shared');
  assert.equal(shirtOf(a).material, shirtOf(b).material, 'one shirt material per team colour');
  assert.notEqual(shirtOf(a).material, shirtOf(other).material);
  assert.equal(shirtOf(a).material.color.getHexString(), '1f5fbf');
  for (const person of [a, b, other]) {
    const shown = HAIRS.filter(name => person.object.getObjectByName(name).visible);
    assert.deepEqual(shown, [HAIRS[person.look.hair]], 'exactly one hair style');
    assert.equal(person.object.getObjectByName('coat').visible, false, 'no coat on a player');
    const skeletons = new Set();
    person.object.traverse(node => { if (node.isSkinnedMesh) skeletons.add(node.skeleton); });
    assert.equal(skeletons.size, 1, 'one skeleton per figure');
    assert.ok(near(person.object.scale.x, person.height / 1.8));
  }
  const number = a.object.getObjectByName('number');
  assert.equal(number.material.map.flipY, false, 'glTF texture convention');
  assert.equal(number.castShadow, false);
  assert.equal(a.object.getObjectByName('body').children.find(m => m.material.name === 'eyes').castShadow, false);
  assert.ok(number.boundingSphere.radius > 2, 'culled by the whole reach of a figure');
  const manager = made.create({ seed: 'manager-0', role: 'manager', colours });
  assert.equal(manager.object.getObjectByName('coat').visible, true);
  assert.equal(manager.object.getObjectByName('number').visible, false, 'no number on a manager');
  // Shape keys follow the look on every mesh that has them.
  const look = variation(1, { hairs: HAIRS.length, morphs: template.morphs });
  const build = Object.entries(look.shapes).find(([name, value]) => name.startsWith('build') && value > 0);
  if (build) {
    for (const name of ['coat', 'number']) {
      const mesh = a.object.getObjectByName(name);
      assert.ok(near(mesh.morphTargetInfluences[mesh.morphTargetDictionary[build[0]]], build[1]), `${name} follows the build`);
    }
  }
  let disposed = 0;
  shirtOf(a).material.addEventListener('dispose', () => disposed++);
  made.dispose();
  assert.equal(disposed, 1);
  assert.ok(template.scene.getObjectByName('body').children[1].geometry.attributes.position, 'template untouched');
});

test('a one-shot plays whole near a standstill and only its upper body and kicking leg at a run', () => {
  const made = createFigures(fixture());
  const person = made.create({ seed: 1 });
  const marker = (name) => person.object.getObjectByName(name).position;
  person.act('pass', 0.4, 1);
  person.update(1 / 60, 0, 0);
  for (const bone of ['hand_L', 'thigh_R', 'foot_L']) {
    assert.ok(near(marker(bone).x, CODES.pass, 0.02), `${bone} shows the pass at a standstill: ${marker(bone).x}`);
    assert.ok(near(marker(bone).y, 0.4, 0.01), 'at its clip time');
  }
  for (let i = 0; i < 30; i++) person.update(1 / 60, 5, 0); // run
  person.act('pass', 0.4, 1);
  person.update(1 / 60, 5, 0);
  assert.ok(near(marker('hand_L').x, CODES.pass, 0.02), 'the arms play the pass');
  assert.ok(near(marker('thigh_R').x, CODES.pass, 0.02), 'so does the kicking leg');
  assert.ok(marker('foot_L').x < CODES.sprint + 0.01 && marker('foot_L').x > CODES.jog - 0.01, `the support leg keeps running: ${marker('foot_L').x}`);
  person.act('instruct', 1, 1, 'gesture');
  person.update(1 / 60, 1.5, 0); // a walk
  assert.ok(near(marker('hand_L').x, CODES.instruct, 0.02), 'a gesture moves the arms');
  assert.ok(near(marker('thigh_R').x, CODES.walk, 0.02), 'over the walk');
  person.update(1 / 60, 1.5, 0);
  assert.ok(near(marker('hand_L').x, CODES.walk, 0.02), 'a one-shot not shown this frame stops');
  assert.deepEqual(person.state().acts, []);
  person.act('keeper_dive_L', 0.5, 1, 'whole');
  person.update(1 / 60, 6, Math.PI / 2);
  assert.ok(near(marker('foot_L').x, CODES.keeper_dive_L, 0.02), 'a whole one-shot plays in full at any speed');
  person.act('pass', 0.2, 0.5);
  person.update(1 / 60, 0, 0);
  assert.ok(near(marker('foot_L').x, (CODES.pass + CODES.idle) / 2, 0.02), `a share blends with the loops: ${marker('foot_L').x}`);
});

test('the loops advance on one shared phase at the rate that plants the feet', () => {
  const made = createFigures(fixture());
  const person = made.create({ seed: 5 });
  person.phase = 0;
  person.update(0.1, LOOPS.jog.speed * person.scale, 0);
  assert.ok(near(person.phase, 0.1 / LOOPS.jog.duration), `one jog cycle per ${LOOPS.jog.duration} s at its speed`);
  const marker = person.object.getObjectByName('foot_L').position;
  assert.ok(near(marker.x, CODES.jog), 'jogging');
  assert.ok(near(marker.y, person.phase * LOOPS.jog.duration, 1e-6), 'at the shared phase');
  person.update(0.25, 0, 0);
  assert.ok(near(person.phase, 0.1 / LOOPS.jog.duration), 'the phase holds when it stops');
});

test('the figure loads once from the glTF and its description', async () => {
  const gltf = fixtureGltf();
  const requested = [];
  const loader = { loadAsync: async (url) => { requested.push(url); return { scene: gltf.scene, animations: gltf.animations }; } };
  const load = async (url) => { requested.push(url); return gltf.info; };
  const template = await loadFigure('./figures/', { loader, load });
  assert.deepEqual(requested, ['./figures/figure.glb', './figures/figure.json']);
  assert.equal(template.clips.size, Object.keys(gltf.info.clips).length);
  assert.deepEqual(template.hairs, HAIRS);
  const failing = { loadAsync: async () => { throw new Error('missing'); } };
  await assert.rejects(loadFigure('./figures/', { loader: failing, load }), /missing/);
});

test('the shadow-casting and culling choices hold for the template', () => {
  const template = fixture();
  const eyes = template.scene.getObjectByName('body').children.find(m => m.material.name === 'eyes');
  assert.ok(eyes.material.isMeshLambertMaterial, 'fixed materials light cheaply');
  assert.ok(eyes.material.vertexColors, 'and keep their vertex colours');
  assert.ok(template.scene.getObjectByName('body').children[1].castShadow);
  assert.ok(THREE.MathUtils.isPowerOfTwo(4)); // three resolves through the vendored copy
});

test('the same clip twice in a frame plays twice, as when a pass fades out as the next begins', () => {
  const made = createFigures(fixture());
  const person = made.create({ seed: 4 });
  person.act('pass', 0.7, 0.4);
  person.act('pass', 0.1, 0.6);
  person.update(1 / 60, 0, 0);
  const acts = person.state().acts.filter(a => a.name === 'pass').map(a => a.time).sort();
  assert.deepEqual(acts, [0.1, 0.7]);
});

// The built figure, when it is there: tests/web runs before the first build too.
const built = new URL('../../src/decision_pitch/web/figures/', import.meta.url);
const hasFigure = existsSync(new URL('figure.glb', built)) && existsSync(new URL('figure.json', built));

async function builtFigure() {
  const { GLTFLoader } = await import('../../src/decision_pitch/web/vendor/three/addons/loaders/GLTFLoader.js');
  const data = readFileSync(new URL('figure.glb', built));
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  return prepareFigure(gltf.scene, gltf.animations, JSON.parse(readFileSync(new URL('figure.json', built), 'utf8')));
}

test('the built figure has every clip the page plays', { skip: !hasFigure && 'figure.glb is not built yet' }, async () => {
  const template = await builtFigure();
  for (const name of ['idle', 'walk', 'jog', 'sprint', 'backpedal', 'strafe_L', 'strafe_R', 'pass', 'shot', 'control',
    'tackle', 'throw_in', 'celebrate', 'keeper_dive_L', 'keeper_dive_R', 'keeper_catch', 'keeper_catch_high']) {
    assert.ok(template.clips.has(name), `${name} is in the .glb and figure.json`);
  }
  for (const loop of template.gait.loops.slice(1)) if (loop.speed > 0 || loop.set === 'run') assert.ok(loop.stride > 0, `${loop.name} travels`);
});

// Runs a built figure over the ground at `speed` along `travel` (from its facing) and
// returns the largest speed of a planted boot's lowest point, the point of the sole on the
// grass (it rolls from heel to toe, but that point itself must not move), in mid-stance:
// every loop plants the left foot at phase 0 and the right at 0.5.
// `ground` is how fast the figure really moves, when it is not `speed`, and `footLock`
// whether the page holds its planted feet.
function plantedSlip(template, seed, speed, travel = 0, { ground = speed, footLock = true } = {}) {
  const made = createFigures(template, { footLock });
  const person = made.create({ seed });
  const group = new THREE.Group();
  group.add(person.object);
  const facing = 0.7; // any direction: the figure faces it and travels `travel` from it
  person.object.rotation.y = facing + Math.PI / 2;
  const boots = [];
  person.object.traverse(node => { if (node.isSkinnedMesh && node.userData.region === 'boots') boots.push(node); });
  // Each boot vertex, by the side of the bone that carries it most.
  const sides = [[], []];
  for (const mesh of boots) {
    const { skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < skinIndex.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, best)) best = k;
      const bone = mesh.skeleton.bones[skinIndex.getComponent(i, best)].name;
      if (bone.endsWith('_L')) sides[0].push([mesh, i]);
      else if (bone.endsWith('_R')) sides[1].push([mesh, i]);
    }
  }
  const before = sides.map(list => new Float64Array(list.length * 3));
  const now = sides.map(list => new Float64Array(list.length * 3));
  const point = new THREE.Vector3();
  const dt = 1 / 240;
  let worst = 0;
  for (let i = 0; i < 480; i++) {
    const t = i * dt;
    group.position.set(Math.cos(facing + travel) * ground * t, 0, -Math.sin(facing + travel) * ground * t);
    person.update(dt, speed, travel);
    group.updateMatrixWorld(true);
    sides.forEach((list, side) => {
      let lowest = 0;
      list.forEach(([mesh, index], j) => {
        mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
        point.toArray(now[side], j * 3);
        if (point.y < now[side][lowest * 3 + 1]) lowest = j;
      });
      const stance = (person.phase - side * 0.5 + 1) % 1;
      if (i > 120 && stance > 0.03 && stance < 0.15 && now[side][lowest * 3 + 1] < 0.02) {
        const dx = now[side][lowest * 3] - before[side][lowest * 3];
        const dz = now[side][lowest * 3 + 2] - before[side][lowest * 3 + 2];
        worst = Math.max(worst, Math.hypot(dx, dz) / dt);
      }
      before[side].set(now[side]);
    });
  }
  made.dispose();
  return worst;
}

test('built figure: the planted foot stays put at every speed and height', { skip: !hasFigure && 'figure.glb is not built yet' }, async () => {
  const template = await builtFigure();
  // Seeds whose looks are the shortest and the tallest of the first hundred ids.
  const looks = Array.from({ length: 100 }, (_, id) => ({ id, height: variation(id, { hairs: template.hairs.length, morphs: template.morphs }).height }));
  looks.sort((a, b) => a.height - b.height);
  for (const { id, height } of [looks[0], looks.at(-1)]) {
    for (const speed of [1, 3, 5, 7.5]) {
      const slip = plantedSlip(template, id, speed);
      assert.ok(slip < Math.max(0.15, speed * 0.08), `${height.toFixed(2)} m figure at ${speed} m/s: a planted foot slides at ${slip.toFixed(3)} m/s`);
    }
    for (const travel of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const slip = plantedSlip(template, id, 2, travel);
      assert.ok(slip < 0.25, `${height.toFixed(2)} m figure at 2 m/s, travel ${travel.toFixed(2)}: slides at ${slip.toFixed(3)} m/s`);
    }
  }
});

test('built figure: the foot lock holds a planted foot that the stride alone would slide', { skip: !hasFigure && 'figure.glb is not built yet' }, async () => {
  const template = await builtFigure();
  // Moving 15% slower than its stride, every planted foot slides forwards, unless held.
  for (const [speed, travel] of [[3, 0], [2, Math.PI / 2], [5, -0.6]]) {
    const loose = plantedSlip(template, 7, speed, travel, { ground: speed * 0.85, footLock: false });
    const held = plantedSlip(template, 7, speed, travel, { ground: speed * 0.85 });
    assert.ok(loose > speed * 0.1, `without the lock it slides at ${loose.toFixed(3)} m/s`);
    assert.ok(held < Math.max(0.12, loose * 0.25), `${speed} m/s, travel ${travel}: held, it slides at ${held.toFixed(3)} m/s (${loose.toFixed(3)} loose)`);
  }
  // It lets go standing still and when a one-shot moves the whole body.
  const made = createFigures(template);
  const person = made.create({ seed: 3 });
  const group = new THREE.Group();
  group.add(person.object);
  let most = 0;
  for (let i = 0; i < 60; i++) {
    group.position.z = 3 * i / 60;
    person.update(1 / 60, 3, 0);
    most = Math.max(most, ...person.state().feet);
  }
  assert.ok(most > 0.9, `a foot is held at a jog: ${most}`);
  person.act('tackle', 0.5, 1, 'whole');
  person.update(1 / 60, 3, 0);
  assert.deepEqual(person.state().feet, [0, 0], 'not under a slide tackle');
  for (let i = 0; i < 30; i++) person.update(1 / 60, 0, 0);
  assert.deepEqual(person.state().feet, [0, 0], 'nor standing');
  made.dispose();
});

test('a leg bends to put the ankle on a target, the knee bending its own way and the foot keeping its turn', () => {
  const root = new THREE.Group();
  root.position.set(3, 0, -2);
  root.rotation.y = 0.7;
  root.scale.setScalar(1.05);
  const bone = (parent, position, rotation) => {
    const result = new THREE.Bone();
    result.position.fromArray(position);
    result.rotation.fromArray(rotation);
    parent.add(result);
    return result;
  };
  const hips = bone(root, [0, 0.97, 0], [-1.2, 0, 0]);
  const thigh = bone(hips, [0.1, 0, 0.02], [0.3, 0.2, 2.9]);
  const shin = bone(thigh, [0, 0.44, 0], [-0.4, 0, 0]);
  const foot = bone(shin, [0, 0.43, 0], [1.1, 0, 0]);
  const world = (object) => new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  root.updateMatrixWorld(true);
  const ankle = world(foot);
  const turn = foot.getWorldQuaternion(new THREE.Quaternion());
  const bendOf = () => {
    const [h, k, a] = [world(thigh), world(shin), world(foot)];
    const line = a.clone().sub(h).normalize();
    const off = k.clone().sub(h);
    return off.sub(line.multiplyScalar(off.dot(line))).normalize();
  };
  const bend = bendOf();
  const target = ankle.clone().add(new THREE.Vector3(0.08, 0.04, -0.06));
  reachFor(thigh, shin, foot, target);
  root.updateMatrixWorld(true);
  assert.ok(world(foot).distanceTo(target) < 1e-6, 'the ankle is on the target');
  assert.ok(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(turn) < 1e-6, 'the foot keeps its turn');
  assert.ok(near(world(thigh).distanceTo(world(shin)), 0.44 * 1.05, 1e-6) && near(world(shin).distanceTo(world(foot)), 0.43 * 1.05, 1e-6), 'bones keep their length');
  assert.ok(bendOf().dot(bend) > 0.9, 'the knee bends the way it did');
  // Out of reach, the leg straightens towards it.
  const far = world(thigh).add(new THREE.Vector3(0, -2, 0.3));
  reachFor(thigh, shin, foot, far);
  root.updateMatrixWorld(true);
  const reach = world(foot).sub(world(thigh));
  assert.ok(reach.length() > 0.87 * 1.05 - 1e-3, 'stretched out');
  assert.ok(reach.normalize().dot(far.sub(world(thigh)).normalize()) > 0.999, 'towards the target');
});

test('hair, number and coat are painted even when figure.json lists only the kit regions', () => {
  const { scene, animations, info } = fixtureGltf();
  info.materials.regions = ['skin', 'shirt', 'sleeve', 'hands', 'shorts', 'legs', 'socks', 'boots'];
  const made = createFigures(prepareFigure(scene, animations, info));
  const person = made.create({ seed: 2, role: 'manager', colours: { shirt: '#1f5fbf', shorts: '#ffffff' } });
  assert.equal(person.object.getObjectByName('coat').material.color.getHexString(), '1f5fbf');
  const hair = person.object.getObjectByName(HAIRS[person.look.hair]);
  assert.equal(`#${hair.material.color.getHexString()}`, figures.HAIRS[person.look.hairColour]);
});

test('built figure: the toe reaches through the carried ball as far as each loop takes it', { skip: !hasFigure && 'figure.glb is not built yet' }, async () => {
  const template = await builtFigure();
  const reach = Object.fromEntries(template.gait.loops.map(loop => [loop.name, loop.reach]));
  for (const name of ['walk', 'jog', 'sprint']) assert.ok(reach[name] > 0.45 && reach[name] < 0.75, `${name} reaches ${reach[name]}`);
  const made = createFigures(template);
  const person = made.create({ seed: 7 });
  person.update(1 / 60, template.described.sprint.speed * person.scale, 0);
  assert.ok(Math.abs(person.reach() - reach.sprint * person.scale) < 1e-9, 'a sprint reaches as the sprint does');
  person.update(1 / 60, (template.described.walk.speed + template.described.jog.speed) / 2 * person.scale, 0);
  const between = person.reach() / person.scale;
  assert.ok(between > Math.min(reach.walk, reach.jog) - 1e-9 && between < Math.max(reach.walk, reach.jog) + 1e-9, 'between a walk and a jog');
});

test('disposing a match frees each person\'s skeleton, and not the template\'s', () => {
  const template = fixture();
  const made = createFigures(template);
  const people = [made.create({ seed: 1 }), made.create({ seed: 2, role: 'manager' })];
  const freed = new Set();
  const skeletons = new Set();
  for (const person of people) {
    person.object.traverse(node => {
      if (!node.isSkinnedMesh || skeletons.has(node.skeleton)) return;
      skeletons.add(node.skeleton);
      const own = node.skeleton.dispose.bind(node.skeleton);
      node.skeleton.dispose = () => { freed.add(node.skeleton); own(); };
    });
  }
  let templateFreed = 0;
  template.scene.traverse(node => { if (node.isSkinnedMesh) node.skeleton.dispose = () => templateFreed++; });
  made.dispose();
  assert.equal(skeletons.size, 2, 'one skeleton per person');
  assert.ok([...skeletons].every(skeleton => freed.has(skeleton)) && freed.size === skeletons.size, 'each freed once');
  assert.equal(templateFreed, 0);
});
