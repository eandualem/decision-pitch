// Run with node --test tests/web/figures.test.mjs; no npm dependencies required.
import './three-resolve.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';
import { fixtureGltf, LOOPS, HAIRS, CODES } from './figure-fixture.mjs';

globalThis.document ??= { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
const figures = await import('../../src/decision_pitch/web/src/figures.js');
const { blendLoops, gait, contactTime, envelope, variation, outfit, prepareFigure, createFigures, loadFigure } = figures;

const fixture = () => {
  const { scene, animations, info } = fixtureGltf();
  return prepareFigure(scene, animations, info);
};
const describe = () => fixtureGltf().info.clips;
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

// The planted foot's velocity against the ground for a blend: each loop's foot moves
// opposite its travel at its speed times its playback rate, and the figure moves at `speed`.
function footSlip(steps, weights, rate, scale, speed, travel) {
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
  for (const loop of template.gait.loops.slice(1)) assert.ok(loop.stride > 0, `${loop.name} travels`);
});

// Runs a built figure over the ground at `speed` along `travel` (from its facing) and
// returns the largest speed of a planted boot's lowest point, the point of the sole on the
// grass (it rolls from heel to toe, but that point itself must not move), in mid-stance:
// every loop plants the left foot at phase 0 and the right at 0.5.
function plantedSlip(template, seed, speed, travel = 0) {
  const made = createFigures(template);
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
    group.position.set(Math.cos(facing + travel) * speed * t, 0, -Math.sin(facing + travel) * speed * t);
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
