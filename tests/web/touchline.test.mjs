import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/touchline.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replaceAll('export function', 'function');

const PITCH = { length: 105, width: 68, goalWidth: 7.32, goalHeight: 2.44 };
const TEAMS = [
  { name: 'Harbour', colours: { shirt: '#1f5fbf', shorts: '#ffffff', keeper: '#f2c230' }, manager: 'Built-in' },
  { name: 'Ridge', colours: { shirt: '#e0562b', shorts: '#1b1b1b', keeper: '#3fbf6f' },
    manager: 'gpt-5.4-mini', assistants: ['gpt-5.4-nano', 'gpt-5.4-nano'] },
];

function setup(teams = TEAMS) {
  const canvases = [];
  const context2d = {
    measureText: (text) => ({ width: text.length * 28 }),
    beginPath() {}, roundRect() {}, fill() {}, fillRect() {}, fillText(text) { this.text = text; },
  };
  const document = {
    createElement: () => {
      const canvas = { getContext: () => context2d };
      canvases.push(canvas);
      return canvas;
    },
  };
  const context = { THREE, document };
  vm.createContext(context);
  vm.runInContext(source, context);
  const scene = new THREE.Scene();
  const touchline = context.createTouchline(scene, teams, PITCH);
  const players = new Map();
  const actors = { getPlayerPosition: (id) => players.get(id) ?? null };
  const ball = new THREE.Vector3();
  let now = 0;
  const world = new THREE.Vector3();
  const find = (name) => scene.getObjectByName(name);
  const shoulders = (name) => find(name).children[1].children[0].children.filter(child => child.isGroup);
  // The figure's hands, the right first, in scene coordinates.
  const hands = (name) => {
    scene.updateMatrixWorld(true);
    return shoulders(name)
      .map(shoulder => shoulder.children.find(child => child.isGroup).children[1].getWorldPosition(world).clone());
  };
  return {
    scene, touchline, players, actors, ball, find, hands, shoulders, technicalArea: context.technicalArea,
    get now() { return now; },
    run(seconds, step = 1 / 60) {
      for (let t = 0; t < seconds; t += step) {
        now += step;
        touchline.update(ball, step, now, actors);
      }
    },
  };
}

const heading = (figure, target) => {
  const facing = new THREE.Vector3(Math.sin(figure.rotation.y), 0, Math.cos(figure.rotation.y));
  return facing.dot(target.clone().sub(figure.position).setY(0).normalize());
};

test('each team has a labelled manager in its own technical area beside the halfway line', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const away = t.find('manager-1');
    assert.ok(home && away, 'one manager each');
    assert.ok(home.position.x < 0 && away.position.x > 0, 'home left of halfway, away right');
    for (const manager of [home, away]) {
      assert.ok(manager.position.z > PITCH.width / 2 + 1, 'outside the near touchline');
      assert.ok(Math.abs(manager.position.x) < 15, 'beside the halfway line');
      assert.equal(manager.children.filter(child => child.isSprite).length, 1, 'a name label');
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
    assert.notEqual(first.position.x, second.position.x, 'side by side, not stacked');
    assert.equal(t.scene.getObjectByName('touchline').children.length, 4);
  } finally {
    t.touchline.dispose();
  }
});

test('a manager follows the ball along its technical area and faces play', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const away = t.find('manager-1');
    const homeArea = t.technicalArea(PITCH, 0);
    const awayArea = t.technicalArea(PITCH, 1);
    t.ball.set(-40, 0.3, 10);
    t.run(8);
    assert.ok(Math.abs(home.position.x - homeArea.minX) < 0.2, `home at the edge nearest play: ${home.position.x}`);
    assert.ok(Math.abs(away.position.x - awayArea.minX) < 0.2, 'away walks towards play but stays in its area');
    assert.ok(heading(home, t.ball) > 0.98 && heading(away, t.ball) > 0.98, 'both face the ball');
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

test('an instruction turns the manager to point at its player; other messages are ignored', () => {
  const t = setup();
  try {
    const home = t.find('manager-0');
    const player = new THREE.Vector3(-30, 0, 25);
    t.players.set(7, player);
    t.ball.set(10, 0.3, -10);
    t.run(2);
    const resting = t.hands('manager-0');
    assert.ok(resting.every(hand => hand.y < 1.4), 'arms folded at rest');
    t.touchline.handleMessage({ type: 'decision', player: 7, model: 'Laya', action: 'pass', ms: 180 }, t.now);
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'instruction', player: 15, text: 'Press.' }, t.now);
    t.touchline.handleMessage({ type: 'manager', team: 0, kind: 'instruction', player: 7, text: 'Stay wide.' }, t.now);
    t.run(1.2);
    assert.ok(heading(home, player) > 0.97, 'turned towards the instructed player, not the ball');
    const [right] = t.hands('manager-0');
    const shoulder = t.shoulders('manager-0')[0].getWorldPosition(new THREE.Vector3());
    const arm = right.clone().sub(shoulder);
    assert.ok(arm.length() > 0.5 && right.y > 1.45, 'right arm raised and extended');
    assert.ok(arm.setY(0).normalize().dot(player.clone().sub(home.position).setY(0).normalize()) > 0.9,
      'pointing at the player');
    assert.ok(heading(t.find('manager-1'), t.ball) > 0.98, 'a manager whose player is not drawn keeps watching play');
    t.run(3);
    assert.ok(heading(home, t.ball) > 0.98, 'back to watching play');
    assert.ok(t.hands('manager-0').every(hand => hand.y < 1.4), 'arms folded again');
  } finally {
    t.touchline.dispose();
  }
});

test('a substitution request rolls the arms, and the substitution made is applauded', () => {
  const t = setup();
  try {
    t.ball.set(0, 0.3, 0);
    t.run(1);
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'substitution', off: 15, on: 30, model: 'laya', text: '' }, t.now);
    t.run(0.6);
    const first = t.hands('manager-1');
    t.run(0.13);
    const second = t.hands('manager-1');
    const manager = t.find('manager-1').position;
    for (const hand of [...first, ...second]) {
      assert.ok(hand.y > 1.0 && hand.y < 1.9, 'hands in front of the chest');
    }
    assert.ok(first.some((hand, i) => hand.distanceTo(second[i]) > 0.08), 'and rolling');
    assert.ok(first.every(hand => hand.distanceTo(manager.clone().setY(hand.y)) > 0.25), 'reaching forward');
    t.run(3);
    t.touchline.handleEvent({ type: 'event', kind: 'substitution', team: 1, off: 15, on: 30, model: 'Laya' }, t.now);
    let closest = Infinity;
    for (let i = 0; i < 40; i++) {
      t.run(1 / 60);
      const [right, left] = t.hands('manager-1');
      closest = Math.min(closest, right.distanceTo(left));
    }
    assert.ok(closest < 0.2, `hands meet in a clap: ${closest}`);
    const [right, left] = t.hands('manager-0');
    assert.ok(right.distanceTo(left) > 0.15 && right.y < 1.4, 'the other manager is unmoved');
  } finally {
    t.touchline.dispose();
  }
});

test('a goal sets the scoring staff celebrating and the other manager holding its head', () => {
  const t = setup();
  try {
    t.ball.set(0, 0.3, 0);
    t.run(1);
    t.touchline.handleEvent({ type: 'event', kind: 'goal', t: 30, team: 1, player: 20 }, t.now);
    t.run(1.0);
    for (const name of ['manager-1', 'assistant-1-0', 'assistant-1-1']) {
      assert.ok(t.hands(name).every(hand => hand.y > 2.0), `${name} arms up`);
    }
    const home = t.find('manager-0');
    const head = new THREE.Vector3();
    home.children[1].children[0].children[3].getWorldPosition(head);
    assert.ok(t.hands('manager-0').every(hand => hand.distanceTo(head) < 0.4), 'hands on head');
    // An instruction does not interrupt a goal reaction.
    t.touchline.handleMessage({ type: 'manager', team: 1, kind: 'instruction', player: 15, text: 'Again.' }, t.now);
    t.run(0.2);
    assert.ok(t.hands('manager-1').every(hand => hand.y > 2.0));
    t.run(1.6);
    assert.ok(Math.cos(home.rotation.y) > 0.9, 'then turns away from the pitch');
    t.run(4);
    for (const name of ['manager-0', 'manager-1', 'assistant-1-0']) {
      assert.ok(t.hands(name).every(hand => hand.y < 1.4), `${name} back at rest`);
    }
    assert.ok(heading(home, t.ball) > 0.98);
  } finally {
    t.touchline.dispose();
  }
});

test('dispose removes the touchline and releases everything it created', () => {
  const t = setup();
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
  assert.ok(owned.size > 10);
  assert.equal(disposed.size, owned.size, 'every geometry, material and label texture released');
});

test('a hello without a manager name or assistants still gets a labelled manager', () => {
  const t = setup(TEAMS.map(({ manager, assistants, ...team }) => team));
  try {
    assert.ok(t.find('manager-0') && t.find('manager-1'));
    assert.equal(t.scene.getObjectByName('touchline').children.length, 2);
  } finally {
    t.touchline.dispose();
  }
});
