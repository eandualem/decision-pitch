// The server owns the match. This entry point only routes messages and draws it.
import * as THREE from 'three';
import { createStadium } from './stadium.js';
import { createPlayers } from './players.js';
import { createCamera } from './camera.js';
import { createMoments } from './moments.js';
import { createOverlay } from './overlay.js';
import { createTouchline } from './touchline.js';
import { createTimeline } from './timeline.js';

const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101f2b);
const camera = new THREE.PerspectiveCamera(40, 1, 0.2, 600);
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

function resetMatch(message) {
  overlay?.dispose();
  moments?.dispose();
  broadcast?.dispose();
  touchline?.dispose();
  actors?.dispose();
  stadium?.dispose();
  timeline.reset();
  shown = null;
  stadium = createStadium(scene, renderer, message.pitch);
  actors = createPlayers(scene, message.teams);
  touchline = createTouchline(scene, message.teams, message.pitch);
  broadcast = createCamera(camera, message.pitch);
  moments = createMoments(scene, message.teams);
  overlay = createOverlay(message.teams);
  status.textContent = '';
}

function receive(message) {
  const now = performance.now() / 1000;
  if (message.type === 'hello') {
    resetMatch(message);
  } else if (message.type === 'snapshot' && actors) {
    timeline.push(message, now);
  } else if (message.type === 'event' && actors) {
    timeline.pushEvent(message, now);
  } else if (message.type === 'manager' && touchline) {
    overlay.handleMessage(message);
    touchline.handleMessage(message, now);
  } else if (overlay) {
    overlay.handleMessage(message);
  }
}

// An event the drawn match has reached. One left behind by a stall only updates the
// overlay's records: its moment has passed.
function show(event, now, late) {
  if (!late) {
    actors.handleEvent(event, now);
    broadcast.handleEvent(event, now, actors, touchline);
    moments.handleEvent(event, now);
    touchline.handleEvent(event, now);
  }
  overlay.handleMessage(event);
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

function draw() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastFrame, 0.1);
  lastFrame = now;
  const frame = actors && timeline.sample(now);
  if (frame) {
    if (frame.after !== shown) {
      shown = frame.after;
      moments.setSnapshot(shown);
      overlay.setSnapshot(shown);
    }
    for (const event of timeline.release()) show(event, now, timeline.late(event));
    actors.update(frame.before, frame.after, frame.alpha, dt, now, frame.latest);
    broadcast.update(actors.ballPosition, dt, now, frame.after.phase);
    touchline.update(actors.ballPosition, dt, now, actors);
    moments.update(camera, actors, now);
  }
  renderer.render(scene, camera);
}

resize();
connect();
renderer.setAnimationLoop(draw);
