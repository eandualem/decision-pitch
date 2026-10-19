// The server owns the match. This entry point only routes messages and draws it.
import * as THREE from 'three';
import { createStadium } from './stadium.js';
import { createPlayers } from './players.js';
import { createCamera } from './camera.js';
import { createMoments } from './moments.js';
import { createOverlay } from './overlay.js';
import { createTouchline } from './touchline.js';
import { createTimeline } from './timeline.js';
import { loadFigure } from './figures.js';

const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101f2b);
const LENS = 40; // degrees: the vertical field of view each match's camera starts from
const camera = new THREE.PerspectiveCamera(LENS, 1, 0.2, 600);
camera.position.set(0, 62, 88);
camera.lookAt(0, 0, 0);

let stadium;
let actors;
let broadcast;
let moments;
let overlay;
let touchline;
// Snapshots and events are drawn a short, fixed delay behind the newest, so uneven
// arrival never shows (docs/decisions.md, section 6).
const timeline = createTimeline();
let shown = null; // the snapshot the score bar and overlay last showed
let lastFrame = performance.now() / 1000;
let socket;
let reconnectTimer;
let stopped = false;
let pausedAt = null;
let pausedTotal = 0;
let rosterTeams = new Map();
const viewTime = real => (pausedAt ?? real) - pausedTotal;
// The human figure every person on the pitch is a clone of, loaded once before the first
// match is built. A hello that arrives first waits for it, with what follows it.
let figure = null;
let held = [];
const HOLD = 900; // messages kept while it loads: half a minute of snapshots

function resetMatch(message) {
  overlay?.dispose();
  moments?.dispose();
  broadcast?.dispose();
  touchline?.dispose();
  actors?.dispose();
  stadium?.dispose();
  timeline.reset();
  shown = null;
  pausedAt = null;
  pausedTotal = 0;
  lastFrame = performance.now() / 1000;
  rosterTeams = new Map(message.teams.flatMap((team, index) =>
    [...team.players, ...(team.bench ?? [])].map(p => [p.id, index])));
  stadium = createStadium(scene, renderer, message.pitch);
  actors = createPlayers(scene, message.teams, figure);
  touchline = createTouchline(scene, message.teams, message.pitch, figure);
  // The camera is kept between matches; the last one's shots may have changed its lens.
  camera.fov = LENS;
  camera.updateProjectionMatrix();
  broadcast = createCamera(camera, message.pitch);
  moments = createMoments(scene, message.teams);
  overlay = createOverlay(message.teams, visible => actors.setInspectionVisible(visible), paused => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'pause', paused }));
  });
  status.textContent = '';
}

function receive(message, now = performance.now() / 1000) {
  if (message.type === 'pause' && actors) {
    if (message.paused && pausedAt === null) pausedAt = now;
    else if (!message.paused && pausedAt !== null) { pausedTotal += now - pausedAt; pausedAt = null; }
    lastFrame = viewTime(now);
    overlay.setPaused(message.paused);
    return;
  }
  if (!figure) {
    if (message.type === 'hello') {
      held = [[message, now]];
      status.textContent = 'Loading players…';
    } else if (held.length) {
      held.push([message, now]);
      if (held.length > HOLD) held.splice(1, 1); // keep the hello
    }
    return;
  }
  if (message.type === 'hello') {
    resetMatch(message);
  } else if (message.type === 'snapshot' && actors) {
    timeline.push(message, viewTime(now));
  } else if (message.type === 'event' && actors) {
    timeline.pushEvent(message, viewTime(now));
  } else if (message.type === 'decision' && actors) {
    actors.handleDecision(message, viewTime(now));
    overlay.handleMessage(message);
  } else if (message.type === 'manager' && touchline) {
    overlay.handleMessage(message);
    touchline.handleMessage(message, viewTime(now));
    broadcast.handleMessage(message, viewTime(now), touchline);
  } else if (overlay) {
    overlay.handleMessage(message);
  }
}

// An event the drawn match has reached. One left behind by a stall only updates the
// overlay's records and who takes the next throw-in: its moment has passed.
function show(event, now, late) {
  actors.handleEvent(event, now, late);
  moments.handleEvent(event, now, late);
  if (!late) {
    broadcast.handleEvent(event, now, actors, touchline);
    touchline.handleEvent(event, now);
  }
  overlay.handleMessage(event);
}

// Messages that waited for the figure are replayed with the times they arrived, so the
// timeline places them as if the match had been built when they came.
function load() {
  loadFigure().then((loaded) => {
    figure = loaded;
    const waiting = held;
    held = [];
    for (const [message, at] of waiting) receive(message, at);
  }, (error) => {
    console.error('Could not load the figures', error);
    status.textContent = 'Could not load the players · retrying…';
    setTimeout(load, 3000);
  });
}

function connect() {
  if (stopped) return;
  status.textContent = 'Connecting to match…';
  const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = connection;
  // A frozen page can deliver an old socket's callbacks after pageshow reconnects.
  const isCurrent = () => !stopped && socket === connection;
  connection.onopen = () => {
    if (isCurrent()) status.textContent = 'Waiting for match…';
  };
  connection.onmessage = (event) => {
    if (isCurrent()) receive(JSON.parse(event.data));
  };
  connection.onclose = () => {
    if (!isCurrent()) return;
    status.textContent = 'Connection lost · reconnecting…';
    reconnectTimer = setTimeout(() => { if (isCurrent()) connect(); }, 1000);
  };
  connection.onerror = () => { if (isCurrent()) connection.close(); };
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

addEventListener('resize', resize);
addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  renderer.setAnimationLoop(null);
});
// A page restored from the browser's back-forward cache keeps its scene alive.
addEventListener('pageshow', (event) => {
  if (event.persisted) {
    stopped = false;
    lastFrame = performance.now() / 1000;
    connect();
    renderer.setAnimationLoop(draw);
  }
});

// Animation runs on the frame's own time, not the moment this code gets to run: under
// load the two can be a frame apart, which would show as uneven motion.
function draw(frameTime) {
  const now = viewTime((frameTime ?? performance.now()) / 1000);
  const dt = Math.max(0, Math.min(now - lastFrame, 0.1));
  lastFrame = now;
  const frame = actors && timeline.sample(now);
  if (frame) {
    // The snapshot the drawn match has reached: a goal's new score waits for its moment.
    if (frame.before !== shown) {
      shown = frame.before;
      moments.setSnapshot(shown);
      overlay.setSnapshot(shown);
      const carrier = shown.players.find(p => p.id === shown.ball.owner);
      const defender = carrier && shown.players.filter(p => rosterTeams.get(p.id) !== rosterTeams.get(carrier.id))
        .reduce((best, p) => !best || Math.hypot(p.x - carrier.x, p.y - carrier.y) < Math.hypot(best.x - carrier.x, best.y - carrier.y) ? p : best, null);
      actors.highlight(carrier?.id ?? null, defender?.id ?? null);
      overlay.highlight(carrier?.id ?? null, defender?.id ?? null);
    }
    for (const event of timeline.release()) show(event, now, timeline.late(event));
    actors.update(frame.before, frame.after, frame.alpha, dt, now, frame.latest);
    broadcast.update(actors.ballPosition, dt, now, frame.after.phase);
    actors.showNumbers(broadcast.wide); // by this frame's shot, after a cut too
    touchline.showLabels(broadcast.managers);
    touchline.update(actors.ballPosition, dt, now, actors);
    moments.update(camera, actors, now);
  }
  renderer.render(scene, camera);
}

resize();
load();
connect();
renderer.setAnimationLoop(draw);
