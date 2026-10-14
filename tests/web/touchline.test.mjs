// Run with node --test tests/web/touchline.test.mjs; no npm dependencies required.
import './three-resolve.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';
import { fixtureGltf } from './figure-fixture.mjs';

const texts = [];
const context2d = {
  measureText: (text) => ({ width: text.length * 28 }),
  beginPath() {}, roundRect() {}, fill() {}, fillRect() {}, fillText(text) { texts.push(text); }, strokeText() {},
};
globalThis.document ??= { createElement: () => ({ getContext: () => context2d }) };
const { prepareFigure } = await import('../../src/decision_pitch/web/src/figures.js');
const { createTouchline, technicalArea } = await import('../../src/decision_pitch/web/src/touchline.js');

const figure = (() => {
  const { scene, animations, info } = fixtureGltf();
  return prepareFigure(scene, animations, info);
})();

const PITCH = { length: 105, width: 68, goalWidth: 7.32, goalHeight: 2.44 };
const TEAMS = [
  { name: 'Harbour', colours: { shirt: '#1f5fbf', shorts: '#ffffff', keeper: '#f2c230' }, manager: 'Built-in' },
  { name: 'Ridge', colours: { shirt: '#e0562b', shorts: '#1b1b1b', keeper: '#3fbf6f' },
    manager: 'gpt-5.4-mini', assistants: ['gpt-5.4-nano', 'gpt-5.4-nano'] },
];
const POINTING = 0.45; // rad: the instruct clip points the right arm this far right of facing

function setup(teams = TEAMS) {
  texts.length = 0;
  const scene = new THREE.Scene();
  const touchline = createTouchline(scene, teams, PITCH, figure);
  const players = new Map();
  const actors = { getPlayerPosition: (id) => players.get(id) ?? null };
  const ball = new THREE.Vector3();
  let now = 0;
  const find = (name) => scene.getObjectByName(name);
  // The gestures a figure shows, by clip name, with their clip times and weights.
  const acts = (name) => touchline.inspect(name).acts.filter(a => a.weight > 0);
  const showing = (name) => [...new Set(acts(name).map(a => a.name.split(':')[0]))];
  return {
    scene, touchline, players, actors, ball, find, acts, showing, texts,
    get now() { return now; },
    run(seconds, step = 1 / 60) {
      for (let t = 0; t < seconds - 1e-9; t += step) {
        now += step;
        touchline.update(ball, step, now, actors);
      }
    },
  };
}

const heading = (figure, target, offset = 0) => {
  const angle = figure.rotation.y - offset;
  const facing = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
  return facing.dot(target.clone().sub(figure.position).setY(0).normalize());
};

test('each team has a labelled manager in its own technical area beside the halfway line', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const away = t.find('manager-1');
    assert.ok(home && away, 'one manager each');
    assert.ok(home.position.x < 0 && away.position.x > 0, 'home left of halfway, away right');
    for (const [name, manager] of [['manager-0', home], ['manager-1', away]]) {
      assert.ok(manager.position.z > PITCH.width / 2 + 1, 'outside the near touchline');
      assert.ok(Math.abs(manager.position.x) < 15, 'beside the halfway line');
      const labels = manager.children.filter(child => child.isSprite);
      assert.equal(labels.length, 1, 'a name label');
      const height = t.touchline.inspect(name).height;
      assert.ok(height >= 1.7 && height <= 1.95, `a person's height: ${height}`);
      assert.ok(labels[0].position.y - labels[0].scale.y / 2 > height + 0.3, 'the label clears the head');
      assert.ok(manager.children.some(child => child.getObjectByName?.('rig')), 'the human figure');
    }
  } finally {
    t.touchline.dispose();
  }
});

test('assistant figures stand behind the manager only for listed assistant models', () => {
  const t = setup();
  try {
    assert.equal(t.find('assistant-0-0'), undefined, 'the built-in manager works alone');
    const first = t.find('assistant-1-0');
    const second = t.find('assistant-1-1');
    assert.ok(first && second, 'one figure per assistant model');
    assert.equal(t.find('assistant-1-2'), undefined);
    const manager = t.find('manager-1');
    for (const assistant of [first, second]) {
      assert.ok(assistant.position.z > manager.position.z, 'a step behind, away from the pitch');
      assert.ok(Math.abs(assistant.position.x - manager.position.x) < 4);
    }
    assert.ok(Math.abs(first.position.x - second.position.x) > 2, 'side by side, not stacked');
    const labels = [first, second].map(assistant => assistant.children.filter(child => child.isSprite).length);
    assert.deepEqual(labels, [1, 0], 'one label for the assistant model both run on');
    assert.deepEqual(t.texts, ['Built-in', 'gpt-5.4-mini', 'gpt-5.4-nano ×2']);
    assert.equal(t.scene.getObjectByName('touchline').children.length, 4);
  } finally {
    t.touchline.dispose();
  }
});

test('a manager walks along its technical area after the ball on the walk loop and faces play', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const away = t.find('manager-1');
    const homeArea = technicalArea(PITCH, 0);
    const awayArea = technicalArea(PITCH, 1);
    t.ball.set(-40, 0.3, 10);
    t.run(1);
    const walking = t.touchline.inspect('manager-0');
    assert.ok(walking.speed > 1, `walking: ${walking.speed}`);
    const loops = Object.entries(walking.loops).filter(([name]) => name !== 'idle');
    assert.ok(loops.reduce((sum, [, w]) => sum + w, 0) > 0.9, `on the loops: ${JSON.stringify(walking.loops)}`);
    assert.ok(walking.rate > 0, 'the stride keeps time with the walk');
    t.run(7);
    assert.ok(Math.abs(home.position.x - homeArea.minX) < 0.2, `home at the edge nearest play: ${home.position.x}`);
    assert.ok(Math.abs(away.position.x - awayArea.minX) < 0.2, 'away walks towards play but stays in its area');
    assert.ok(heading(home, t.ball) > 0.98 && heading(away, t.ball) > 0.98, 'both face the ball');
    assert.deepEqual(t.touchline.inspect('manager-0').loops, { idle: 1 }, 'standing still');
    t.ball.set(30, 0.3, -20);
    t.run(12);
    assert.ok(Math.abs(home.position.x - homeArea.maxX) < 0.2);
    assert.ok(Math.abs(away.position.x - Math.min(30, awayArea.maxX)) < 0.2);
    assert.ok(heading(home, t.ball) > 0.98);
    const before = home.position.x;
    t.ball.x = 30.5; // play moving a little does not set the manager pacing
    t.run(1);
    assert.equal(home.position.x, before);
  } finally {
    t.touchline.dispose();
  }
});

test('an instruction has the manager point at its player; other messages are ignored', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const player = new THREE.Vector3(-30, 0, 25);
    t.players.set(7, player);
    t.ball.set(-8, 0.3, -10); // in front of the home manager, who stays where it is
    t.run(2);
    assert.deepEqual(t.showing('manager-0'), [], 'standing at rest');
    t.touchline.handleMessage({ type: 'decision', player: 7, model: 'Laya', action: 'pass', ms: 180 }, t.now);
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'instruction', player: 15, text: 'Press.' }, t.now);
    t.touchline.handleMessage({ type: 'manager', team: 0, kind: 'instruction', player: 7, text: 'Stay wide.' }, t.now);
    t.run(1.2);
    const [instruct] = t.acts('manager-0');
    assert.equal(instruct.name.split(':')[0], 'instruct');
    assert.ok(instruct.weight > 0.9 && Math.abs(instruct.time - 1.2) < 0.05, `the clip, at its time: ${JSON.stringify(instruct)}`);
    assert.ok(heading(home, player, POINTING) > 0.97, 'the pointing arm aims at the instructed player');
    assert.ok(heading(home, player) < 0.95, 'the body turned so the arm, not the chest, points');
    assert.deepEqual(t.showing('manager-1'), ['instruct']);
    assert.ok(heading(t.find('manager-1'), t.ball) > 0.98, 'a manager whose player is not drawn keeps watching play');
    t.run(3);
    assert.ok(heading(home, t.ball) > 0.98, 'back to watching play');
    assert.deepEqual(t.showing('manager-0'), [], 'and at rest');
  } finally {
    t.touchline.dispose();
  }
});

test('a substitution request signals a change, and the substitution made is applauded', () => {
  const t = setup();
  try {
    t.ball.set(0, 0.3, 0);
    t.run(1);
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'substitution', off: 15, on: 30, model: 'laya', text: '' }, t.now);
    t.run(0.6);
    assert.deepEqual(t.showing('manager-1'), ['change']);
    assert.deepEqual(t.showing('manager-0'), []);
    t.run(3);
    assert.deepEqual(t.showing('manager-1'), [], 'the change signal is over');
    const coming = new THREE.Vector3(20, 0, 30);
    t.players.set(30, coming);
    t.touchline.handleEvent({ type: 'event', kind: 'substitution', team: 1, off: 15, on: 30, model: 'Laya' }, t.now);
    t.run(1);
    assert.deepEqual(t.showing('manager-1'), ['clap']);
    assert.ok(heading(t.find('manager-1'), coming) > 0.97, 'applauding the player coming on');
    assert.deepEqual(t.showing('manager-0'), [], 'the other manager is unmoved');
  } finally {
    t.touchline.dispose();
  }
});

test('a card against its player has the manager protest', () => {
  const t = setup();
  try {
    t.ball.set(0, 0.3, 0);
    t.run(1);
    t.touchline.handleEvent({ type: 'event', kind: 'yellow', t: 20, team: 0, player: 4 }, t.now);
    t.run(0.1);
    const early = t.acts('manager-0')[0].weight;
    t.run(0.7);
    const [protest] = t.acts('manager-0');
    assert.equal(protest.name.split(':')[0], 'protest');
    assert.ok(early < protest.weight, 'the gesture fades in');
    assert.deepEqual(t.showing('manager-1'), [], 'the other manager stays at rest');
    t.run(2.5);
    assert.deepEqual(t.showing('manager-0'), []);
  } finally {
    t.touchline.dispose();
  }
});

test('a substitution at the stoppage of a card does not cut the protest short', () => {
  const t = setup();
  try {
    t.ball.set(0, 0.3, 0);
    t.run(1);
    t.touchline.handleEvent({ type: 'event', kind: 'red', t: 20, team: 0, player: 4 }, t.now);
    t.run(1 / 60);
    t.touchline.handleEvent({ type: 'event', kind: 'substitution', t: 20, team: 0, off: 8, on: 26 }, t.now);
    t.touchline.handleMessage({ type: 'manager', team: 0, kind: 'instruction', player: 7, text: 'Calm.' }, t.now);
    for (const at of [0.8, 1.6, 2.4]) {
      t.run(0.8);
      assert.deepEqual(t.showing('manager-0'), ['protest'], `still protesting after ${at} s`);
    }
    t.touchline.handleEvent({ type: 'event', kind: 'goal', t: 30, team: 1, player: 20 }, t.now);
    t.run(0.1);
    assert.deepEqual(t.showing('manager-0').sort(), ['despair', 'protest'], 'the protest fades under the goal');
    t.run(0.7);
    assert.deepEqual(t.showing('manager-0'), ['despair'], 'a goal still interrupts it');
  } finally {
    t.touchline.dispose();
  }
});

test('a goal sets the scoring staff cheering and the other manager in despair', () => {
  const t = setup();
  try {
    t.ball.set(-8, 0.3, 0);
    t.run(1);
    t.touchline.handleEvent({ type: 'event', kind: 'goal', t: 30, team: 1, player: 20 }, t.now);
    t.run(1.0);
    for (const name of ['manager-1', 'assistant-1-0', 'assistant-1-1']) {
      assert.deepEqual(t.showing(name), ['cheer'], `${name} cheers`);
    }
    assert.deepEqual(t.showing('manager-0'), ['despair']);
    const home = t.find('manager-0');
    // An instruction does not interrupt a goal reaction.
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'instruction', player: 15, text: 'Again.' }, t.now);
    t.run(0.2);
    assert.deepEqual(t.showing('manager-1'), ['cheer']);
    t.run(1.6);
    assert.ok(Math.cos(home.rotation.y) > 0.9, 'then turns away from the pitch');
    t.run(4);
    for (const name of ['manager-0', 'manager-1', 'assistant-1-0']) {
      assert.deepEqual(t.showing(name), [], `${name} back at rest`);
    }
    assert.ok(heading(home, t.ball) > 0.98);
  } finally {
    t.touchline.dispose();
  }
});

test('the managers applaud at half time and a level full time; a winner celebrates', () => {
  for (const [kind, score] of [['half_time', [1, 0]], ['full_time', [2, 2]], ['full_time', undefined]]) {
    const t = setup();
    try {
      t.run(1);
      t.touchline.handleEvent({ type: 'event', kind, team: null, score }, t.now);
      t.run(0.5);
      assert.deepEqual([t.showing('manager-0'), t.showing('manager-1')], [['clap'], ['clap']], `${kind} ${score}: both applaud`);
    } finally {
      t.touchline.dispose();
    }
  }
  const t = setup();
  try {
    t.run(1);
    t.touchline.handleEvent({ type: 'event', kind: 'full_time', team: null, score: [0, 1] }, t.now);
    t.run(1);
    for (const name of ['manager-1', 'assistant-1-0', 'assistant-1-1']) {
      assert.deepEqual(t.showing(name), ['cheer'], `${name} celebrates the win`);
    }
    assert.deepEqual(t.showing('manager-0'), ['despair'], 'the loser despairs');
  } finally {
    t.touchline.dispose();
  }
});

test('dispose removes the touchline and releases what it made, not the shared figure', () => {
  const t = setup();
  const shared = new Set();
  figure.scene.traverse((object) => {
    for (const item of [object.geometry, object.material]) if (item) shared.add(item);
  });
  const disposed = new Set();
  const owned = new Set();
  t.scene.traverse((object) => {
    // three.js shares one quad among all sprites; the module must leave it alone.
    for (const item of [object.isSprite ? null : object.geometry, object.material, object.material?.map]) {
      if (item && !owned.has(item)) {
        owned.add(item);
        item.addEventListener('dispose', () => disposed.add(item));
      }
    }
  });
  t.run(1);
  t.touchline.handleEvent({ type: 'event', kind: 'goal', team: 0 }, t.now);
  t.run(1);
  t.touchline.dispose();
  assert.equal(t.scene.children.length, 0, 'removed from the scene');
  const made = [...owned].filter(item => !shared.has(item));
  assert.ok(made.length > 8);
  assert.deepEqual(made.filter(item => !disposed.has(item)), [], 'every material, label texture and shadow released');
  assert.deepEqual([...owned].filter(item => shared.has(item) && disposed.has(item)), [], 'the figure template kept');
});

test('a hello without a manager name or assistants still gets a labelled manager', () => {
  const t = setup(TEAMS.map(({ manager, assistants, ...team }) => team));
  try {
    assert.ok(t.find('manager-0') && t.find('manager-1'));
    assert.equal(t.scene.getObjectByName('touchline').children.length, 2);
    assert.deepEqual(t.texts, ['Manager', 'Manager']);
  } finally {
    t.touchline.dispose();
  }
});
