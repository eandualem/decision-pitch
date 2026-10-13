// The server owns the match. This entry point only routes messages and draws it.
import * as THREE from 'three';
import { createStadium } from './stadium.js';
import { createPlayers } from './players.js';
import { createCamera } from './camera.js';
import { createMoments } from './moments.js';
import { createOverlay } from './overlay.js';

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
let before = null;
let after = null;
let arrived = 0;
let lastFrame = performance.now() / 1000;
let socket;
let reconnectTimer;
let stopped = false;

function resetMatch(message) {
  overlay?.dispose();
  moments?.dispose();
  broadcast?.dispose();
  actors?.dispose();
  stadium?.dispose();
  before = after = null;
  stadium = createStadium(scene, renderer, message.pitch);
  actors = createPlayers(scene, message.teams);
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
    // Restarts may teleport the formation: never sweep players across the field.
    before = after && after.phase === message.phase && after.t < message.t ? after : null;
    after = message;
    arrived = now;
    moments.setSnapshot(message);
    overlay.setSnapshot(message);
  } else if (message.type === 'event' && actors) {
    actors.handleEvent(message, now);
    broadcast.handleEvent(message, now, actors);
    moments.handleEvent(message, now);
    overlay.handleMessage(message);
  } else if (overlay) {
    overlay.handleMessage(message);
  }
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
  if (after) {
    const span = before ? after.t - before.t : 0;
    const alpha = span > 0 ? Math.min(1, (now - arrived) / span) : 1;
    actors.update(before ?? after, after, alpha, dt, now);
    broadcast.update(actors.ballPosition, dt, now);
    moments.update(camera, actors, now);
  }
  renderer.render(scene, camera);
}

resize();
connect();
renderer.setAnimationLoop(draw);
