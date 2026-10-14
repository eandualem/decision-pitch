import * as THREE from 'three';
import { technicalArea } from './touchline.js';

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
  box(0, -0.06, 0, length + 16, 0.1, width + 16, lambert(0x326c49));

  // One vertex-coloured mesh for the mowing stripes.
  const turfPositions = [];
  const turfColors = [];
  const stripeColors = [new THREE.Color(0x408b55), new THREE.Color(0x367c49)];
  const stripes = 20;
  for (let i = 0; i < stripes; i++) {
    const left = -hl + length * i / stripes;
    const right = -hl + length * (i + 1) / stripes;
    turfPositions.push(left, 0, -hw, left, 0, hw, right, 0, hw,
      left, 0, -hw, right, 0, hw, right, 0, -hw);
    for (let vertex = 0; vertex < 6; vertex++) {
      const c = stripeColors[i % 2];
      turfColors.push(c.r, c.g, c.b);
    }
  }
  const turfGeometry = geometry(new THREE.BufferGeometry());
  turfGeometry.setAttribute('position', new THREE.Float32BufferAttribute(turfPositions, 3));
  turfGeometry.setAttribute('color', new THREE.Float32BufferAttribute(turfColors, 3));
  turfGeometry.computeVertexNormals();
  const turf = new THREE.Mesh(turfGeometry,
    material(new THREE.MeshLambertMaterial({ vertexColors: true })));
  turf.receiveShadow = true;
  root.add(turf);

  // Real-width painted ribbons, rather than implementation-dependent GL lines.
  const paint = [];
  function segment(x1, z1, x2, z2, thickness = 0.12) {
    const distance = Math.hypot(x2 - x1, z2 - z1);
    if (!distance) return;
    const dx = -(z2 - z1) / distance * thickness / 2;
    const dz = (x2 - x1) / distance * thickness / 2;
    paint.push(x1 + dx, 0.016, z1 + dz, x2 + dx, 0.016, z2 + dz,
      x2 - dx, 0.016, z2 - dz, x1 + dx, 0.016, z1 + dz,
      x2 - dx, 0.016, z2 - dz, x1 - dx, 0.016, z1 - dz);
  }
  function arc(x, z, radius, start = 0, end = Math.PI * 2) {
    const steps = Math.max(12, Math.ceil((end - start) * radius * 3));
    for (let i = 0; i < steps; i++) {
      const a = start + (end - start) * i / steps;
      const b = start + (end - start) * (i + 1) / steps;
      segment(x + radius * Math.cos(a), z + radius * Math.sin(a),
        x + radius * Math.cos(b), z + radius * Math.sin(b));
    }
  }
  function spot(x, z) { arc(x, z, 0.055); }
  segment(-hl, -hw, hl, -hw);
  segment(hl, -hw, hl, hw);
  segment(hl, hw, -hl, hw);
  segment(-hl, hw, -hl, -hw);
  segment(0, -hw, 0, hw);
  arc(0, 0, 9.15);
  spot(0, 0);
  const penaltyArc = Math.acos(5.5 / 9.15);
  for (const side of [-1, 1]) {
    for (const [depth, halfWidth] of [[16.5, 20.16], [5.5, 9.16]]) {
      const x = side * (hl - depth);
      segment(side * hl, -halfWidth, x, -halfWidth);
      segment(x, -halfWidth, x, halfWidth);
      segment(x, halfWidth, side * hl, halfWidth);
    }
    const spotX = side * (hl - 11);
    spot(spotX, 0);
    const angle = side === -1 ? 0 : Math.PI;
    arc(spotX, 0, 9.15, angle - penaltyArc, angle + penaltyArc);
    for (const end of [-1, 1]) {
      const start = side === -1 ? (end === -1 ? 0 : -Math.PI / 2)
        : (end === -1 ? Math.PI / 2 : Math.PI);
      arc(side * hl, end * hw, 1, start, start + Math.PI / 2);
    }
  }
  // Each technical area: a dashed box from a metre off the touchline to its dugout.
  for (const team of [0, 1]) {
    const area = technicalArea(pitch, team);
    const front = hw + 1;
    const back = area.z + DUGOUT.gap;
    const left = area.minX - 0.5;
    const right = area.maxX + 0.5;
    for (let x = left; x < right; x += 0.85) segment(x, front, Math.min(x + 0.5, right), front, 0.1);
    for (const x of [left, right]) {
      for (let z = front; z < back; z += 0.85) segment(x, z, x, Math.min(z + 0.5, back), 0.1);
    }
  }
  const paintGeometry = geometry(new THREE.BufferGeometry());
  paintGeometry.setAttribute('position', new THREE.Float32BufferAttribute(paint, 3));
  const markings = new THREE.Mesh(paintGeometry,
    material(new THREE.MeshBasicMaterial({ color: 0xe6edda, side: THREE.DoubleSide })));
  root.add(markings);

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
