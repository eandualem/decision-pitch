// The match page: draws the pitch, the players and the ball from the match server's
// snapshots, interpolating between them. The full match graphics are built in their
// own issue; this is the plain view they replace.
import * as THREE from 'three';

const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1a12);
scene.add(new THREE.HemisphereLight(0xffffff, 0x223322, 2.5));

const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 500);
camera.position.set(0, 62, 88);
camera.lookAt(0, 0, 0);

let pitch = null;
let teams = [];
const players = new Map(); // id -> mesh
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.3, 16, 12), // drawn larger than life so it can be seen
  new THREE.MeshLambertMaterial({ color: 0xffffff }),
);
scene.add(ball);
let before = null; // the last two snapshots and when the second arrived
let after = null;
let arrived = 0;

// Match coordinates (x along the length, y across, z up; see docs/protocol.md)
// map to three.js as x -> x, y -> -z, z -> y.
function drawPitch({ length, width, goalWidth }) {
  if (pitch) scene.remove(pitch);
  pitch = new THREE.Group();
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(length + 8, width + 8),
    new THREE.MeshLambertMaterial({ color: 0x2f7d3a }),
  );
  grass.rotation.x = -Math.PI / 2;
  pitch.add(grass);

  const white = new THREE.LineBasicMaterial({ color: 0xffffff });
  const line = (points) =>
    pitch.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, 0.02, -y))),
      white,
    ));
  const [hl, hw] = [length / 2, width / 2];
  line([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]]);
  line([[0, -hw], [0, hw]]);
  line(Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return [9.15 * Math.cos(a), 9.15 * Math.sin(a)];
  }));
  for (const s of [-1, 1]) {
    const box = (depth, half) =>
      line([[s * hl, -half], [s * (hl - depth), -half], [s * (hl - depth), half], [s * hl, half]]);
    box(16.5, 20.16);
    box(5.5, 9.16);
    line([[s * hl, -goalWidth / 2], [s * (hl + 2), -goalWidth / 2], [s * (hl + 2), goalWidth / 2], [s * hl, goalWidth / 2]]);
  }
  scene.add(pitch);
}

function drawPlayers(teamList) {
  for (const mesh of players.values()) scene.remove(mesh);
  players.clear();
  teams = teamList;
  teams.forEach((team) => {
    for (const p of team.players) {
      const colour = p.position === 'GK' ? team.colours.keeper : team.colours.shirt;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 1.8, 16),
        new THREE.MeshLambertMaterial({ color: colour }),
      );
      mesh.position.y = 0.9;
      players.set(p.id, mesh);
      scene.add(mesh);
    }
  });
}

function showScore(snapshot) {
  const [home, away] = teams.map((t) => t.name);
  const phase = snapshot.phase === 'play' ? '' : ` · ${snapshot.phase.replace('_', ' ')}`;
  status.textContent = `${home} ${snapshot.score[0]} – ${snapshot.score[1]} ${away} · ${snapshot.clock}${phase}`;
}

function draw() {
  if (!after) return;
  const span = before ? after.t - before.t : 0;
  const k = span > 0 ? Math.min(1, (performance.now() - arrived) / 1000 / span) : 1;
  const from = before ?? after;
  const mix = (a, b) => a + (b - a) * k;
  const fromPlayers = new Map(from.players.map((p) => [p.id, p]));
  for (const p of after.players) {
    const mesh = players.get(p.id);
    const q = fromPlayers.get(p.id) ?? p;
    if (mesh) mesh.position.set(mix(q.x, p.x), 0.9, -mix(q.y, p.y));
  }
  ball.position.set(mix(from.ball.x, after.ball.x), Math.max(0.3, mix(from.ball.z, after.ball.z)), -mix(from.ball.y, after.ball.y));
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { status.textContent = 'Connected'; };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'hello') {
      drawPitch(message.pitch);
      drawPlayers(message.teams);
      before = after = null;
    } else if (message.type === 'snapshot') {
      before = after;
      after = message;
      arrived = performance.now();
      showScore(message);
    }
  };
  ws.onclose = () => {
    status.textContent = 'Disconnected, retrying…';
    setTimeout(connect, 1000);
  };
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

addEventListener('resize', resize);
resize();
connect();
renderer.setAnimationLoop(() => {
  draw();
  renderer.render(scene, camera);
});
