// The match page: draws the pitch and shows the connection to the match server.
// The full match graphics are built in their own issue; this draws only what the
// `hello` message describes.
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

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { status.textContent = 'Connected'; };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'hello') drawPitch(message.pitch);
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
renderer.setAnimationLoop(() => renderer.render(scene, camera));
