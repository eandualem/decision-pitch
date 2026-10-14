// Run with node --test tests/web/main.test.mjs; no npm dependencies required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTimeline } from '../../src/decision_pitch/web/src/timeline.js';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');

// The figure loads at once unless a test holds it: `figure.resolve()` / `figure.reject()`.
const FIGURE = { name: 'figure' };
const loaded = () => ({ then(resolve) { resolve(FIGURE); } });
function deferred() {
  const pending = [];
  const result = () => ({ then(resolve, reject) { pending.push({ resolve, reject }); } });
  result.resolve = () => pending.shift().resolve(FIGURE);
  result.reject = (error) => pending.shift().reject(error);
  result.pending = pending;
  return result;
}

function setup(protocol = 'http:', loadFigure = loaded) {
  const calls = [];
  const handlers = {};
  const sockets = [];
  const timers = [];
  let time = 1000;
  let renderLoop;
  const status = { textContent: '' };
  const actors = (...args) => (calls.push(['actors.create', ...args]), {
    ballPosition: { x: 1, y: 2, z: 3 },
    update: (...args) => calls.push(['actors.update', ...args]),
    handleEvent: (...args) => calls.push(['actors.event', ...args]),
    showNumbers: (...args) => calls.push(['actors.numbers', ...args]),
    dispose: () => calls.push(['actors.dispose']),
  });
  const component = (name) => () => ({
    dispose: () => calls.push([`${name}.dispose`]),
    update: (...args) => calls.push([`${name}.update`, ...args]),
    handleEvent: (...args) => calls.push([`${name}.event`, ...args]),
    handleMessage: (...args) => calls.push([`${name}.message`, ...args]),
    setSnapshot: (...args) => calls.push([`${name}.snapshot`, ...args]),
    showLabels: (...args) => calls.push([`${name}.labels`, ...args]),
  });
  const context = {
    THREE: {
      WebGLRenderer: class {
        domElement = {};
        setPixelRatio() {} setSize() {} render() {}
        setAnimationLoop(callback) { renderLoop = callback; }
      },
      Scene: class {}, Color: class {},
      PerspectiveCamera: class {
        constructor(fov) { this.fov = fov; }
        position = { set() {} };
        lookAt() {} updateProjectionMatrix() {}
      },
    },
    createStadium: component('stadium'), createPlayers: actors,
    createCamera: (camera) => {
      calls.push(['camera.create', camera.fov]);
      camera.fov = 20; // a wide shot narrows the lens
      return { ...component('camera')(), wide: false, managers: true };
    },
    createMoments: component('moments'),
    createOverlay: component('overlay'), createTouchline: component('touchline'), createTimeline, loadFigure,
    console: { error: (...args) => calls.push(['console.error', ...args]) },
    document: { getElementById: (id) => id === 'status' ? status : { appendChild() {} } },
    performance: { now: () => time }, devicePixelRatio: 2,
    innerWidth: 1440, innerHeight: 900, location: { protocol, host: 'localhost:8791' },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    WebSocket: class {
      constructor(url) { this.url = url; sockets.push(this); }
      // Real close callbacks are asynchronous and can be deferred while frozen.
      close() { this.closeCalls = (this.closeCalls ?? 0) + 1; }
    },
  };
  vm.runInNewContext(source, context);
  return {
    calls, handlers, sockets, timers, status,
    tick: (ms, frameTime) => { time += ms; renderLoop?.(frameTime); },
    wait: (ms) => { time += ms; },
    send: (message) => sockets.at(-1).onmessage({ data: JSON.stringify(message) }),
    loop: () => renderLoop,
  };
}
const hello = { type: 'hello', pitch: {}, teams: [] };
const snapshot = (t, phase = 'play') => ({ type: 'snapshot', t, phase, players: [], ball: {} });

const named = (calls, name) => calls.filter(([called]) => called === name);

test('draws snapshots a fixed delay behind, blending into a restart', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1)); // arrives at page time 1 s: the clocks are level
  app.wait(100);
  app.send(snapshot(1.1));
  app.tick(50); // 1.15 s on the page draws 1.05 s of match
  let update = named(app.calls, 'actors.update').at(-1);
  assert.equal(update[1].t, 1);
  assert.equal(update[2].t, 1.1);
  assert.ok(Math.abs(update[3] - 0.5) < 1e-9);
  assert.equal(update[6].t, 1.1, 'the newest snapshot is passed on for wind-ups');
  assert.equal(named(app.calls, 'moments.snapshot').at(-1)[1].t, 1, 'the score bar shows the snapshot the drawn match has reached');
  app.wait(50);
  app.send(snapshot(1.2, 'kickoff'));
  app.tick(50); // 1.25 s draws 1.15 s: between a play and a kick-off snapshot
  update = named(app.calls, 'actors.update').at(-1);
  assert.equal(update[1].t, 1.1);
  assert.equal(update[2].t, 1.2, 'play is blended into the restart, not held');
  assert.ok(Math.abs(update[3] - 0.5) < 1e-9);
  app.tick(60);
  update = named(app.calls, 'actors.update').at(-1);
  assert.equal(update[1].phase, 'kickoff');
  const camera = named(app.calls, 'camera.update').at(-1);
  const touchline = named(app.calls, 'touchline.update').at(-1);
  assert.deepEqual(touchline.slice(1, 4), camera.slice(1, 4), 'the managers follow the drawn ball');
  assert.equal(camera[4], 'kickoff', 'the camera knows the drawn phase');
  app.send(snapshot(1.3, 'goal_kick'));
  app.send(snapshot(1.4));
  app.tick(16);
  assert.equal(named(app.calls, 'camera.update').at(-1)[4], 'goal_kick', 'the phase drawn towards, not the newest');
  assert.equal(touchline[4].ballPosition, touchline[1], 'and are given the players');
});

test('a frame is drawn for its own time, not when the code runs', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.wait(100);
  app.send(snapshot(1.1));
  app.tick(66, 1150); // the frame began at 1.15 s; the code runs at 1.166 s
  const update = named(app.calls, 'actors.update').at(-1);
  assert.ok(Math.abs(update[3] - 0.5) < 1e-9, 'drawn at 1.05 s of match');
  assert.equal(update[5], 1.15);
  app.tick(10, 1140); // a frame time that goes back cannot make dt negative
  assert.ok(named(app.calls, 'actors.update').at(-1)[4] >= 0);
});

test('events wait for the drawn match to reach them; decisions and managers do not', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.tick(16);
  const goal = { type: 'event', kind: 'goal', t: 1.05, team: 0, player: 9 };
  app.send(goal);
  app.tick(16);
  for (const name of ['actors.event', 'camera.event', 'moments.event', 'touchline.event', 'overlay.message']) {
    assert.equal(named(app.calls, name).length, 0, `${name} waits`);
  }
  app.wait(100);
  app.send(snapshot(1.1));
  app.tick(60); // the drawn match reaches 1.05 s
  for (const name of ['actors.event', 'camera.event', 'moments.event', 'touchline.event', 'overlay.message']) {
    assert.ok(named(app.calls, name).some(([, message]) => message.kind === 'goal'), name);
  }
  const cut = named(app.calls, 'camera.event').at(-1);
  assert.equal(typeof cut[4].handleMessage, 'function', 'the camera can find the managers');
  const before = app.calls.length;
  app.send({ type: 'decision', player: 9, action: 'pass' });
  app.send({ type: 'manager', team: 0, kind: 'instruction', player: 9, text: 'Press' });
  const routed = app.calls.slice(before).map(([name, message]) => [name, message.type]);
  assert.deepEqual(routed, [
    ['overlay.message', 'decision'], ['overlay.message', 'manager'], ['touchline.message', 'manager'],
    ['camera.message', 'manager'],
  ]);
  const advice = named(app.calls, 'camera.message').at(-1);
  assert.equal(typeof advice[3].handleMessage, 'function', 'the camera can find the manager');
  assert.equal(named(app.calls, 'touchline.message')[0][2], 1.192, 'with the page time');
});

test('events left behind by a stall only update the records', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.tick(16);
  app.send({ type: 'event', kind: 'substitution', t: 1.2, team: 0, off: 9, on: 23 });
  app.send({ type: 'event', kind: 'corner', t: 5.95, team: 1 });
  for (let k = 1; k <= 180; k++) { app.wait(1000 / 30); app.send(snapshot(1 + k / 30)); }
  app.tick(0);
  assert.deepEqual(named(app.calls, 'overlay.message').map(([, m]) => m.kind), ['substitution', 'corner']);
  assert.deepEqual(named(app.calls, 'actors.event').map(([, m, , late]) => [m.kind, late]),
    [['substitution', true], ['corner', false]], 'the players keep their records, and know it is late');
  assert.deepEqual(named(app.calls, 'moments.event').map(([, m]) => m.kind), ['corner']);
  assert.deepEqual(named(app.calls, 'touchline.event').map(([, m]) => m.kind), ['corner']);
});

test('a new hello disposes every old module and clears interpolation state', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.tick(16);
  app.send(hello);
  for (const name of ['stadium', 'actors', 'camera', 'moments', 'overlay', 'touchline']) {
    assert.equal(app.calls.filter(([called]) => called === `${name}.dispose`).length, 1);
  }
  const before = app.calls.length;
  app.tick(16);
  assert.equal(app.calls.length, before);
});

test('secure transport, reconnect and back-forward cache lifecycle', () => {
  const app = setup('https:');
  assert.equal(app.sockets[0].url, 'wss://localhost:8791/ws');
  app.sockets[0].onclose();
  assert.match(app.status.textContent, /reconnecting/);
  app.timers[0]();
  assert.equal(app.sockets.length, 2);
  app.handlers.pagehide();
  assert.equal(app.loop(), null);
  assert.equal(app.timers.length, 1);
  app.handlers.pageshow({ persisted: true });
  assert.equal(app.sockets.length, 3);
  assert.equal(typeof app.loop(), 'function');
});

test('callbacks deferred from a superseded socket cannot affect the restored match', () => {
  const app = setup();
  app.send(hello);
  const original = app.sockets[0];
  app.handlers.pagehide();
  app.handlers.pageshow({ persisted: true });
  const restored = app.sockets[1];
  app.send(hello);
  app.send(snapshot(9));
  const callsBefore = app.calls.length;
  const statusBefore = app.status.textContent;

  original.onopen();
  original.onmessage({ data: JSON.stringify(hello) });
  original.onmessage({ data: JSON.stringify(snapshot(99)) });
  original.onerror();
  original.onclose();

  assert.equal(app.calls.length, callsBefore, 'old messages cannot reset or feed modules');
  assert.equal(app.status.textContent, statusBefore);
  assert.equal(restored.closeCalls ?? 0, 0, 'old errors cannot close the new socket');
  assert.equal(app.timers.length, 0, 'old close cannot schedule another match');
  assert.equal(app.sockets.length, 2);
  app.tick(16);
  assert.equal(app.calls.findLast(([name]) => name === 'actors.update')[2].t, 9);

  // Current connection failures must still recover normally.
  restored.onclose();
  assert.equal(app.timers.length, 1);
  app.timers[0]();
  assert.equal(app.sockets.length, 3);
});

test('a previously queued reconnect cannot replace the restored socket', () => {
  const app = setup();
  app.sockets[0].onclose();
  const queuedRetry = app.timers[0];
  app.handlers.pagehide();
  app.handlers.pageshow({ persisted: true });
  queuedRetry();
  assert.equal(app.sockets.length, 2);
});

test('the match is built once the figure has loaded; what arrives before waits for it', () => {
  const figure = deferred();
  const app = setup('http:', figure);
  app.send(hello);
  app.send(snapshot(1));
  app.wait(100);
  app.send(snapshot(1.1));
  app.send({ type: 'decision', player: 9, action: 'pass' });
  app.tick(16);
  assert.equal(named(app.calls, 'actors.create').length, 0, 'nothing is built before the figure');
  assert.equal(named(app.calls, 'actors.update').length, 0);
  assert.match(app.status.textContent, /Loading players/);
  figure.resolve();
  const [create] = named(app.calls, 'actors.create');
  assert.equal(create[3], FIGURE, 'the players are cloned from the loaded figure');
  assert.equal(named(app.calls, 'overlay.message').at(-1)[1].type, 'decision', 'held messages are replayed in order');
  assert.equal(app.status.textContent, '');
  app.tick(50); // 1.166 s on the page draws 1.066 s of match: the snapshots kept their arrival times
  const update = named(app.calls, 'actors.update').at(-1);
  assert.equal(update[1].t, 1);
  assert.equal(update[2].t, 1.1);
});

test('a hello arriving again while the figure loads replaces the one held', () => {
  const figure = deferred();
  const app = setup('http:', figure);
  app.send({ ...hello, teams: [{ name: 'old' }] });
  app.send(snapshot(1));
  app.send({ ...hello, teams: [{ name: 'new' }] });
  figure.resolve();
  const creates = named(app.calls, 'actors.create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][2][0].name, 'new');
});

test('a figure that fails to load says so and is tried again', () => {
  const figure = deferred();
  const app = setup('http:', figure);
  app.send(hello);
  figure.reject(new Error('404'));
  assert.match(app.status.textContent, /Could not load the players/);
  assert.equal(named(app.calls, 'console.error').length, 1);
  app.timers.at(-1)();
  figure.resolve();
  assert.equal(named(app.calls, 'actors.create').length, 1, 'the held hello builds the match');
});

test('each match\'s camera starts from the same lens, whatever the last match left it at', () => {
  const app = setup();
  app.send(hello);
  app.send(hello); // a reconnect: the server sends a new hello
  assert.deepEqual(named(app.calls, 'camera.create').map(([, fov]) => fov), [40, 40]);
});

test('the numbers above the players and the managers\' labels follow the shot of this frame, after the camera chooses it', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.wait(100);
  app.send(snapshot(1.1));
  app.tick(50);
  const shown = ['actors.update', 'camera.update', 'actors.numbers', 'touchline.labels'];
  const order = app.calls.map(([name]) => name).filter(name => shown.includes(name));
  assert.deepEqual(order.slice(-4), shown);
  assert.equal(named(app.calls, 'actors.numbers').at(-1)[1], false, 'the camera is not on the wide shot');
  assert.equal(named(app.calls, 'touchline.labels').at(-1)[1], true, 'but on the managers');
});
