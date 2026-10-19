import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

class Element {
  children = [];
  style = {};
  dataset = {};
  hidden = false;
  append(...nodes) {
    this.children.push(...nodes);
    for (const node of nodes) node.parent = this;
  }
  setAttribute() {}
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
}

const source = readFileSync(new URL('../../src/decision_pitch/web/src/moments.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export function', 'function');

function setup() {
  let reloads = 0;
  const document = { body: new Element(), createElement: () => new Element() };
  const context = { THREE, document, location: { reload: () => reloads++ } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const moments = context.createMoments(null, [
    { name: 'Home', players: [{ id: 1, number: 1, name: 'One' }], bench: [{ id: 3, number: 12, name: 'Reserve' }] },
    { name: 'Away', players: [{ id: 2, number: 2, name: 'Two' }] },
  ]);
  const root = document.body.children[0];
  const banner = root.children[1];
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.2, 600);
  camera.position.set(0, 53, 64);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return {
    moments, root, banner, document, reloads: () => reloads,
    event: (kind, now, fields = {}) => moments.handleEvent({ kind, team: 0, player: 1, ...fields }, now),
    frame: now => moments.update(camera, { getPlayerPosition: () => null }, now),
    snapshot: players => moments.setSnapshot({ players, score: [0, 0], clock: '00:01', phase: 'play', period: 1 }),
  };
}

test('goals immediately supersede a full restart queue', () => {
  const ui = setup();
  ui.event('corner', 1);
  for (let i = 0; i < 8; i++) ui.event('throw_in', 1.1);
  ui.event('goal', 1.2);
  assert.equal(ui.banner.dataset.kind, 'goal');
  ui.frame(6.3);
  assert.equal(ui.banner.hidden, true, 'old restarts must not replay after the decisive moment');
});

test('the final result persists after restarts and offers a fresh match, even without the event', () => {
  for (const viaSnapshot of [false, true]) {
    const ui = setup();
    const again = ui.banner.children[3];
    assert.equal(again.hidden, true);
    ui.event('corner', 1);
    ui.event('throw_in', 1.1);
    if (viaSnapshot) {
      ui.moments.setSnapshot({ players: [], score: [1, 1], clock: '90+04:00', phase: 'full_time', period: 2 });
    } else ui.event('full_time', 1.2, { score: [2, 1] });
    ui.event('corner', 1.3); // a stale event must not replace the final result
    ui.frame(600);
    assert.equal(ui.banner.hidden, false);
    assert.equal(ui.banner.dataset.kind, 'full_time');
    assert.equal(ui.banner.children[0].textContent, 'FULL-TIME');
    assert.equal(ui.banner.children[1].textContent, viaSnapshot ? 'Home 1 : 1 Away' : 'Home 2 : 1 Away');
    assert.equal(ui.banner.children[2].hidden, true);
    assert.equal(again.hidden, false);
    assert.equal(again.textContent, 'Play again');
    again.onclick();
    assert.equal(again.disabled, true);
    assert.equal(ui.reloads(), 1);
    ui.moments.dispose();
    assert.equal(ui.document.body.children.length, 0);
  }
});

test('offence and restart in one socket burst remain individually readable', () => {
  for (const kind of ['foul', 'offside']) {
    const ui = setup();
    ui.event(kind, 1, { player: 2 });
    ui.event('free_kick', 1, { indirect: true });
    assert.equal(ui.banner.dataset.kind, kind);
    assert.equal(ui.banner.children[2].textContent, 'Away / 2 · Two');
    ui.frame(3.6);
    assert.equal(ui.banner.children[1].textContent, 'Indirect free kick');
  }
});

test('second-yellow and red banners retain event order', () => {
  const ui = setup();
  ui.event('yellow', 1);
  ui.event('red', 1);
  assert.equal(ui.banner.dataset.kind, 'yellow');
  ui.frame(3.6);
  assert.equal(ui.banner.dataset.kind, 'red');
});

test('dismissal between snapshots before first frame retains a visible card', () => {
  const ui = setup();
  ui.snapshot([{ id: 1, x: 0, y: 0 }]);
  ui.event('red', 1);
  ui.snapshot([]);
  ui.frame(1.016);
  const card = ui.root.children.find(node => node.className === 'player-card red');
  assert.ok(card);
  assert.equal(card.hidden, false);
  assert.equal(card.style.left, '50%');
  ui.frame(8.1);
  assert.equal(ui.root.children.includes(card), false);
  ui.moments.dispose();
  assert.equal(ui.document.body.children.length, 0);
});

test('substitution banner resolves the incoming bench player', () => {
  const ui = setup();
  ui.event('substitution', 1, { off: 1, on: 3 });
  assert.equal(ui.banner.children[2].textContent, 'Home / 1 · One → 12 · Reserve');
});

test('the referee counts down the last five seconds a goalkeeper holds the ball', () => {
  const ui = setup();
  const count = ui.root.children[0].children.at(-1);
  const held = seconds => ui.moments.setSnapshot({ players: [], score: [0, 0], clock: '10:00', phase: 'play', period: 1, ball: { held: seconds } });
  held(2.5);
  assert.equal(count.hidden, true);
  held(5.2);
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, 'Keeper 3');
  ui.snapshot([]);
  assert.equal(count.hidden, true, 'released');
});

test('added time shows the minutes the referee adds', () => {
  const ui = setup();
  ui.moments.handleEvent({ kind: 'added_time', team: null, minutes: 2 }, 1);
  assert.equal(ui.banner.dataset.kind, 'added_time');
  assert.equal(ui.banner.children[2].textContent, '+2 min');
});
