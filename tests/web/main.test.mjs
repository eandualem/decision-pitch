// Run with node --test tests/web/main.test.mjs; no npm dependencies required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');

function setup(protocol = 'http:') {
  const calls = [];
  const handlers = {};
  const sockets = [];
  const timers = [];
  let time = 1000;
  let renderLoop;
  const status = { textContent: '' };
  const actors = () => ({
    ballPosition: { x: 1, y: 2, z: 3 },
    update: (...args) => calls.push(['actors.update', ...args]),
    handleEvent: (...args) => calls.push(['actors.event', ...args]),
    dispose: () => calls.push(['actors.dispose']),
  });
  const component = (name) => () => ({
    dispose: () => calls.push([`${name}.dispose`]),
    update: (...args) => calls.push([`${name}.update`, ...args]),
    handleEvent: (...args) => calls.push([`${name}.event`, ...args]),
    handleMessage: (...args) => calls.push([`${name}.message`, ...args]),
    setSnapshot: (...args) => calls.push([`${name}.snapshot`, ...args]),
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
        position = { set() {} };
        lookAt() {} updateProjectionMatrix() {}
      },
    },
    createStadium: component('stadium'), createPlayers: actors,
    createCamera: component('camera'), createMoments: component('moments'),
    createOverlay: component('overlay'),
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
    tick: (ms) => { time += ms; renderLoop?.(); },
    send: (message) => sockets.at(-1).onmessage({ data: JSON.stringify(message) }),
    loop: () => renderLoop,
  };
}
const hello = { type: 'hello', pitch: {}, teams: [] };
const snapshot = (t, phase = 'play') => ({ type: 'snapshot', t, phase, players: [], ball: {} });

test('routes stream messages and interpolates snapshots without crossing restart boundaries', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.send(snapshot(1.1));
  app.tick(50);
  const update = app.calls.findLast(([name]) => name === 'actors.update');
  assert.equal(update[1].t, 1);
  assert.equal(update[2].t, 1.1);
  assert.ok(Math.abs(update[3] - 0.5) < 1e-9);
  app.send(snapshot(1.2, 'kickoff'));
  app.tick(10);
  const restart = app.calls.findLast(([name]) => name === 'actors.update');
  assert.equal(restart[1], restart[2]);
  const event = { type: 'event', kind: 'goal', player: 9 };
  app.send(event);
  for (const name of ['actors.event', 'camera.event', 'moments.event', 'overlay.message']) {
    assert.ok(app.calls.some(([called, message]) => called === name && message.kind === 'goal'));
  }
  for (const type of ['decision', 'manager', 'substitution']) app.send({ type });
  assert.equal(app.calls.filter(([name]) => name === 'overlay.message').length, 4);
});

test('a new hello disposes every old module and clears interpolation state', () => {
  const app = setup();
  app.send(hello);
  app.send(snapshot(1));
  app.tick(16);
  app.send(hello);
  for (const name of ['stadium', 'actors', 'camera', 'moments', 'overlay']) {
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
