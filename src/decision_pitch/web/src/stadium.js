import * as THREE from 'three';
import { technicalArea } from './touchline.js';
import { createGrass } from './grass.js';

const DUGOUT = { gap: 3.3, depth: 1.4, width: 8, height: 1.8 }; // m behind a manager's spot

// All dimensions are metres. Stadium details are shared or instanced so they
// cost a fixed number of draw calls, independent of the number of seats.
export function createStadium(scene, renderer, pitch) {
  const { length, width, goalWidth, goalHeight } = pitch;
  const hl = length / 2;
  const hw = width / 2;
  const root = new THREE.Group();
  root.name = 'stadium';
  scene.add(root);
  const geometries = new Set();
  const materials = new Set();
  const geometry = (value) => { geometries.add(value); return value; };
  const material = (value) => { materials.add(value); return value; };
  const lambert = (color) => material(new THREE.MeshLambertMaterial({ color }));
  const cube = geometry(new THREE.BoxGeometry(1, 1, 1));
  const concrete = lambert(0x344550);
  const trim = lambert(0x152731);
  const white = lambert(0xe8f0e7);
  const previous = {
    background: scene.background, fog: scene.fog,
    shadows: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type,
  };
  scene.background = new THREE.Color(0xadc6d2);
  scene.fog = new THREE.Fog(0xadc6d2, 180, 330);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const hemisphere = new THREE.HemisphereLight(0xe1f2ff, 0x52643b, 2.2);
  const sun = new THREE.DirectionalLight(0xffefd8, 2.6);
  sun.position.set(-35, 75, 32);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -(hl + 22);
  sun.shadow.camera.right = hl + 22;
  sun.shadow.camera.top = hw + 30;
  sun.shadow.camera.bottom = -(hw + 30);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 180;
  sun.shadow.normalBias = 0.06;
  sun.shadow.bias = -0.00015;
  root.add(hemisphere, sun, sun.target);

  function box(x, y, z, sx, sy, sz, mat) {
    const mesh = new THREE.Mesh(cube, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    root.add(mesh);
    return mesh;
  }
  box(0, -0.3, 0, length + 38, 0.5, width + 40, trim);
  // The grass, with its mowing stripes and painted lines, out to the advertising wall.
  const grass = createGrass(root, renderer, pitch, [0, 1].map((team) => {
    const area = technicalArea(pitch, team);
    return { minX: area.minX, maxX: area.maxX, back: area.z + DUGOUT.gap };
  }));

  // Both goals share one line-segment mesh for the net. Its muted colour keeps
  // it readable without obscuring the ball or creating a dense white shimmer.
  const netPoints = [];
  const netLine = (a, b) => netPoints.push(...a, ...b);
  const depth = 2.2;
  for (const side of [-1, 1]) {
    const front = side * hl;
    const back = side * (hl + depth);
    for (const z of [-goalWidth / 2, goalWidth / 2]) {
      box(front, goalHeight / 2, z, 0.14, goalHeight, 0.14, white);
      box(back, goalHeight / 2, z, 0.07, goalHeight, 0.07, white);
      box((front + back) / 2, goalHeight, z, depth, 0.07, 0.07, white);
      box((front + back) / 2, 0.04, z, depth, 0.07, 0.07, white);
    }
    box(front, goalHeight, 0, 0.14, 0.14, goalWidth + 0.14, white);
    box(back, goalHeight, 0, 0.07, 0.07, goalWidth, white);
    const columns = Math.ceil(goalWidth / 0.32);
    const rows = Math.ceil(goalHeight / 0.32);
    for (let i = 0; i <= columns; i++) {
      const z = -goalWidth / 2 + goalWidth * i / columns;
      netLine([back, 0, z], [back, goalHeight, z]);
      netLine([front, goalHeight, z], [back, goalHeight, z]);
    }
    for (let i = 0; i <= rows; i++) {
      const y = goalHeight * i / rows;
      netLine([back, y, -goalWidth / 2], [back, y, goalWidth / 2]);
      for (const z of [-goalWidth / 2, goalWidth / 2]) {
        netLine([front, y, z], [back, y, z]);
      }
    }
    for (let i = 1; i < 7; i++) {
      const x = front + (back - front) * i / 7;
      netLine([x, goalHeight, -goalWidth / 2], [x, goalHeight, goalWidth / 2]);
      for (const z of [-goalWidth / 2, goalWidth / 2]) netLine([x, 0, z], [x, goalHeight, z]);
    }
  }
  const netGeometry = geometry(new THREE.BufferGeometry());
  netGeometry.setAttribute('position', new THREE.Float32BufferAttribute(netPoints, 3));
  root.add(new THREE.LineSegments(netGeometry,
    material(new THREE.LineBasicMaterial({ color: 0xb3c1be, transparent: true, opacity: 0.6 }))));

  function instances(items, mat) {
    const mesh = new THREE.InstancedMesh(cube, mat, items.length);
    const transform = new THREE.Object3D();
    items.forEach(([x, y, z, sx, sy, sz, color], i) => {
      transform.position.set(x, y, z);
      transform.scale.set(sx, sy, sz);
      transform.updateMatrix();
      mesh.setMatrixAt(i, transform.matrix);
      if (color !== undefined) mesh.setColorAt(i, new THREE.Color(color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    return mesh;
  }
  const terraces = [];
  const seats = [];
  const seatPalette = [0x49707c, 0x315462, 0x92a8a7, 0x67878a];
  for (const side of [-1, 1]) {
    // Low front tiers retain a clear view from the broadcast camera.
    for (let tier = 0; tier < 5; tier++) {
      const height = 0.65 + tier * 0.72;
      const z = side * (hw + 10 + tier * 1.5);
      terraces.push([0, height / 2, z, length + 8, height, 1.5]);
      for (let seat = 0; seat < 84; seat++) {
        if (seat % 21 < 2) continue; // access aisles
        seats.push([(seat - 41.5) * (length / 84), height + 0.2, z,
          0.7, 0.4, 0.65, seatPalette[(seat * 7 + tier * 3) % seatPalette.length]]);
      }
    }
    // The same tiers behind each goal, short of the floodlights at the corners.
    for (let tier = 0; tier < 5; tier++) {
      const height = 0.65 + tier * 0.72;
      const x = side * (hl + 10 + tier * 1.5);
      terraces.push([x, height / 2, 0, 1.5, height, width + 18]);
      for (let seat = 0; seat < 69; seat++) {
        if (seat % 23 < 2) continue; // access aisles
        seats.push([x, height + 0.2, (seat - 34) * ((width + 18) / 69),
          0.65, 0.4, 0.7, seatPalette[(seat * 5 + tier * 3 + 1) % seatPalette.length]]);
      }
    }
    box(0, 0.48, side * (hw + 7.5), length + 8, 0.96, 0.18, concrete);
    box(side * (hl + 8), 0.48, 0, 0.18, 0.96, width + 15, concrete);
  }
  instances(terraces, concrete);
  instances(seats, lambert(0xffffff));

  const poles = [];
  const lamps = [];
  for (const x of [-hl - 10, hl + 10]) {
    for (const z of [-hw - 11, hw + 11]) {
      poles.push([x, 8, z, 0.35, 16, 0.35]);
      poles.push([x, 16, z, 4.3, 1.5, 0.35]);
      for (let col = 0; col < 6; col++) {
        for (let row = 0; row < 2; row++) {
          lamps.push([x + (col - 2.5) * 0.65, 15.65 + row * 0.7,
            z - Math.sign(z) * 0.22, 0.48, 0.48, 0.12]);
        }
      }
    }
  }
  // Dugouts behind the technical areas: low enough that the camera sees over them
  // to the figures in front, one instanced mesh, no shadows.
  const dugouts = [];
  for (const team of [0, 1]) {
    const { x, z } = technicalArea(pitch, team);
    const front = z + DUGOUT.gap;
    const depth = DUGOUT.depth;
    const half = DUGOUT.width / 2;
    dugouts.push([x, DUGOUT.height / 2, front + depth, DUGOUT.width, DUGOUT.height, 0.14, 0x1b2b35]);
    dugouts.push([x, DUGOUT.height, front + depth / 2, DUGOUT.width + 0.3, 0.1, depth + 0.3, 0x2f4553]);
    for (const end of [-1, 1]) {
      dugouts.push([x + end * half, DUGOUT.height / 2, front + depth / 2, 0.12, DUGOUT.height, depth, 0x1b2b35]);
    }
    dugouts.push([x, 0.45, front + depth - 0.45, DUGOUT.width - 0.4, 0.1, 0.5, 0x3a4c57]);
    dugouts.push([x, 0.75, front + depth - 0.16, DUGOUT.width - 0.4, 0.5, 0.08, 0x3a4c57]);
  }
  instances(dugouts, lambert(0xffffff));
  instances(poles, concrete);
  instances(lamps, material(new THREE.MeshBasicMaterial({ color: 0xfff2d5 })));
  const flagMaterial = lambert(0xf1ca59);
  for (const x of [-hl, hl]) {
    for (const z of [-hw, hw]) {
      box(x, 0.75, z, 0.055, 1.5, 0.055, white);
      box(x + 0.18, 1.32, z, 0.36, 0.25, 0.035, flagMaterial);
    }
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      grass.dispose();
      // InstancedMesh owns GPU instance buffers in addition to its geometry.
      root.traverse((object) => { if (object.isInstancedMesh) object.dispose(); });
      geometries.forEach((value) => value.dispose());
      materials.forEach((value) => value.dispose());
      sun.shadow.dispose();
      scene.background = previous.background;
      scene.fog = previous.fog;
      renderer.shadowMap.enabled = previous.shadows;
      renderer.shadowMap.type = previous.shadowType;
    },
  };
}
