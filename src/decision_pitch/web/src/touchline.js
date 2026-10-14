import * as THREE from 'three';

// Each team's manager, and one figure per assistant model, in a technical area
// beside the halfway line on the touchline nearest the broadcast camera. Home
// stands left of halfway and away right, for both halves. Presentation only:
// the figures react to the messages and events the page already receives.
const AREA = { offset: 8, half: 4.5, depth: 2.5 }; // metres from halfway and touchline
const WALK = 1.5; // m/s
// Seconds each gesture lasts. A goal reaction outlasts the camera's close-up of the
// scorer, so the reaction shot that follows it still finds the managers reacting.
const GESTURES = { instruct: 2.8, change: 2.6, clap: 2.6, protest: 2.6, celebrate: 6.5, despair: 5.5 };
const REACTIONS = new Set(['celebrate', 'despair']); // a goal outranks other gestures
const ASSISTANT_REACTION = 3.5; // s: assistants react more briefly than the manager

export function technicalArea(pitch, team) {
  const x = (team === 0 ? -1 : 1) * AREA.offset;
  return { x, z: pitch.width / 2 + AREA.depth, minX: x - AREA.half, maxX: x + AREA.half };
}

const clamp = THREE.MathUtils.clamp;
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function createTouchline(scene, teams, pitch) {
  const root = new THREE.Group();
  root.name = 'touchline';
  scene.add(root);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometry = (value) => { geometries.add(value); return value; };
  const material = (value) => { materials.add(value); return value; };
  // Figures of one team share their coat and trouser materials.
  const paints = new Map();
  const paint = (color) => {
    if (!paints.has(color)) paints.set(color, material(new THREE.MeshLambertMaterial({ color })));
    return paints.get(color);
  };
  const box = geometry(new THREE.BoxGeometry(1, 1, 1));
  const head = geometry(new THREE.IcosahedronGeometry(0.23, 1));
  const disc = geometry(new THREE.CircleGeometry(1, 24));
  const shoes = paint('#141b22');
  const shirt = paint('#eef1f4');
  const skin = ['#c58c62', '#8d5d3f', '#e1b08b'].map(paint);
  const shadowMaterial = material(new THREE.MeshBasicMaterial({
    color: '#061b14', transparent: true, opacity: 0.23, depthWrite: false,
  }));
  const figures = [];
  const managers = [];

  function mesh(shape, surface, parent, x, y, z, sx = 1, sy = 1, sz = 1) {
    const result = new THREE.Mesh(shape, surface);
    result.position.set(x, y, z);
    result.scale.set(sx, sy, sz);
    result.castShadow = true;
    parent.add(result);
    return result;
  }

  function label(text, colour, height) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = 'bold 52px sans-serif';
    ctx.font = font;
    const width = Math.ceil(Math.min(ctx.measureText(text).width, 640) + 76);
    canvas.width = width;
    canvas.height = 96;
    ctx.font = font; // resizing a canvas resets its context
    ctx.fillStyle = 'rgba(9, 18, 26, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 8, canvas.width, 80, 18);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillRect(14, 22, 12, 52);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 42, 50, canvas.width - 56);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const sprite = new THREE.Sprite(material(new THREE.SpriteMaterial({ map: texture, depthWrite: false })));
    sprite.scale.set(height * canvas.width / canvas.height, height, 1);
    return sprite;
  }

  function figure(team, role, index, name) {
    const colours = teams[team].colours;
    const area = technicalArea(pitch, team);
    const side = area.x < 0 ? -1 : 1;
    const coat = paint(colours.shirt);
    const trousers = paint(colours.shorts);
    const complexion = skin[(team * 2 + index) % skin.length];
    const group = new THREE.Group();
    group.name = role === 'manager' ? `manager-${team}` : `assistant-${team}-${index}`;
    root.add(group);
    const shadow = mesh(disc, shadowMaterial, group, 0, 0.025, 0, 0.5, 0.5, 1);
    shadow.rotation.x = -Math.PI / 2;
    shadow.castShadow = false;
    const body = new THREE.Group();
    group.add(body);
    // The upper body leans from the hips.
    const torso = new THREE.Group();
    torso.position.y = 0.84;
    body.add(torso);
    // A manager's coat reaches mid-thigh; an assistant wears a short jacket.
    mesh(box, coat, torso, 0, 0.41, 0, 0.62, 0.66, 0.38);
    if (role === 'manager') mesh(box, coat, torso, 0, 0.02, 0, 0.6, 0.3, 0.39);
    else mesh(box, trousers, torso, 0, 0.03, 0, 0.55, 0.2, 0.36);
    mesh(box, shirt, torso, 0, 0.63, 0.19, 0.16, 0.18, 0.02);
    mesh(head, complexion, torso, 0, 0.99, 0);
    const legs = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(s * 0.15, 0.82, 0);
      body.add(leg);
      mesh(box, trousers, leg, 0, -0.2, 0, 0.19, 0.4, 0.21);
      mesh(box, trousers, leg, 0, -0.52, 0, 0.17, 0.3, 0.19);
      mesh(box, shoes, leg, 0, -0.73, 0.06, 0.2, 0.12, 0.33);
      legs.push(leg);
    }
    // arms[0] is the right arm, at -x: bodies face local +z.
    const arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.4, 0.66, 0);
      torso.add(shoulder);
      mesh(box, coat, shoulder, 0, -0.15, 0, 0.19, 0.32, 0.22);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      elbow.rotation.order = 'YXZ'; // bend forward, then swing across the body
      shoulder.add(elbow);
      mesh(box, coat, elbow, 0, -0.12, 0, 0.17, 0.26, 0.19);
      mesh(box, complexion, elbow, 0, -0.3, 0, 0.11, 0.12, 0.12);
      arms.push({ shoulder, elbow, s });
    }
    if (name) {
      const tag = label(name, colours.shirt, role === 'manager' ? 1.1 : 0.7);
      tag.position.y = role === 'manager' ? 3.1 : 2.75;
      group.add(tag);
    }
    // Assistants stand a step back and well to the side, so the camera above the
    // stands sees each figure and label clear of the manager's.
    const back = role === 'manager' ? 0 : 0.9;
    const offset = role === 'manager' ? 0 : (index % 2 === 0 ? -side : side) * 2 * (1 + Math.floor(index / 2));
    const result = {
      team, role, area, group, body, torso, legs, arms, offset,
      x: area.x + offset, z: area.z + back, goal: area.x + offset, vx: 0, stride: index,
      heading: Math.PI, gesture: null, gestureAt: 0, gestureUntil: -Infinity, target: null,
      pose: { legs: [0, 0], sx: [0, 0], sz: [0, 0], ex: [0, 0], ey: [0, 0], ez: [0, 0], lift: 0, lean: 0 },
    };
    group.position.set(result.x, 0, result.z);
    group.rotation.y = result.heading;
    figures.push(result);
    return result;
  }

  teams.forEach((team, index) => {
    managers.push(figure(index, 'manager', 0, team.manager ?? 'Manager'));
    // One label for each assistant model, on the first figure it helps, with how many.
    const assistants = team.assistants ?? [];
    assistants.forEach((name, i) => {
      const count = assistants.filter(other => other === name).length;
      const first = assistants.indexOf(name) === i;
      figure(index, 'assistant', i, first ? (count > 1 ? `${name} ×${count}` : name) : null);
    });
  });

  function gesture(f, kind, now, target = null) {
    const busy = now < f.gestureUntil;
    if (busy && REACTIONS.has(f.gesture) && !REACTIONS.has(kind)) return;
    f.gesture = kind;
    f.gestureAt = now;
    f.gestureUntil = now + (f.role === 'manager' ? GESTURES[kind] : Math.min(GESTURES[kind], ASSISTANT_REACTION));
    f.target = target;
  }

  // The pose a figure is moving towards, in joint angles. Arm index i has side s:
  // -1 right, +1 left. Shoulders turn forward with negative x and outward with s*z.
  function pose(f, kind, age, walking) {
    const p = f.pose;
    p.lift = 0;
    p.lean = 0;
    const swing = Math.sin(f.stride) * walking * 0.5;
    p.legs[0] = swing;
    p.legs[1] = -swing;
    for (let i = 0; i < 2; i++) {
      const s = f.arms[i].s;
      const wave = i === 0 ? 0 : Math.PI;
      if (kind === 'instruct') {
        // Point at the player with the right arm, the left hand on the hip.
        p.sx[i] = i === 0 ? -1.8 + Math.sin(age * 10) * 0.14 : 0;
        p.sz[i] = i === 0 ? 0 : s * 0.55;
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = i === 0 ? 0 : -s * 1.65;
        p.lean = 0.08;
      } else if (kind === 'change') {
        // Forearms rolling round each other: a change is coming.
        p.sx[i] = -1.25 + Math.sin(age * 11 + wave) * 0.32;
        p.sz[i] = -s * 0.12;
        p.ex[i] = -1.0 + Math.cos(age * 11 + wave) * 0.5;
        p.ey[i] = -s * 0.65;
        p.ez[i] = 0;
      } else if (kind === 'clap') {
        p.sx[i] = -1.0;
        p.sz[i] = -s * 0.35;
        p.ex[i] = -1.57;
        p.ey[i] = -s * (0.6 + 0.8 * Math.max(0, Math.sin(age * 11)));
        p.ez[i] = 0;
      } else if (kind === 'protest') {
        // Arms spread, palms up: a card against its own player.
        p.sx[i] = -0.5;
        p.sz[i] = s * (0.85 + Math.sin(age * 6) * 0.15);
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = s * 0.55;
        p.lean = 0.06;
      } else if (kind === 'celebrate' && age >= 3.5) {
        // Then fists clenched and pumped.
        const pump = Math.max(0, Math.sin(age * 8));
        p.sx[i] = -0.25;
        p.sz[i] = s * (1.2 + pump * 0.5);
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = s * 1.75;
        p.lift = pump * 0.06;
      } else if (kind === 'celebrate') {
        const pump = Math.sin(age * 9 + (f.role === 'manager' ? 0 : 1.3));
        p.sx[i] = -0.2 + pump * 0.18;
        p.sz[i] = s * (2.6 + pump * 0.15);
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = s * 0.3 * (1 + pump);
        p.lift = Math.abs(Math.sin(age * 7 + (f.role === 'manager' ? 0 : 0.8))) * 0.3;
      } else if (kind === 'despair' && (age < 1.8 || f.role !== 'manager')) {
        // Hands on head.
        p.sx[i] = -0.3;
        p.sz[i] = s * 2.75;
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = s * 1.9;
        p.lean = -0.05;
      } else if (kind === 'despair') {
        // Turned away, hands on hips, head down.
        p.sx[i] = 0;
        p.sz[i] = s * 0.55;
        p.ex[i] = 0;
        p.ey[i] = 0;
        p.ez[i] = -s * 1.65;
        p.lean = 0.2;
      } else if (f.role === 'manager') {
        // Arms folded, one forearm over the other.
        p.sx[i] = -0.45;
        p.sz[i] = 0;
        p.ex[i] = i === 0 ? -1.45 : -1.3;
        p.ey[i] = -s * 1.25;
        p.ez[i] = 0;
      } else {
        // Hands behind the back.
        p.sx[i] = 0.6;
        p.sz[i] = 0;
        p.ex[i] = -1.35;
        p.ey[i] = -s * 1.4;
        p.ez[i] = 0;
      }
    }
    return p;
  }

  function facing(f, kind, age, ballPosition, actors) {
    if (kind === 'despair' && f.role === 'manager' && age >= 1.8) return 0; // away from the pitch
    const position = f.target !== null && (kind === 'instruct' || kind === 'change' || kind === 'clap')
      ? actors?.getPlayerPosition?.(f.target) : null;
    const look = position ?? ballPosition;
    return Math.atan2(look.x - f.x, look.z - f.z);
  }

  return {
    update(ballPosition, dt, now, actors) {
      const step = clamp(dt, 0, 0.1);
      const ease = 1 - Math.exp(-step * 16);
      for (const f of figures) {
        const active = now < f.gestureUntil ? f.gesture : null;
        const age = now - f.gestureAt;
        // Managers walk to the edge of their area nearest play; assistants keep their place beside them.
        const manager = managers[f.team];
        const wanted = f.role === 'manager'
          ? clamp(ballPosition.x, f.area.minX, f.area.maxX)
          : clamp(manager.x + f.offset, f.area.minX - 1.5, f.area.maxX + 1.5);
        if (Math.abs(wanted - f.goal) > (f.role === 'manager' ? 1.2 : 0.6)) f.goal = wanted;
        const still = active !== null && active !== 'celebrate';
        const distance = f.goal - f.x;
        const speed = still || Math.abs(distance) < 0.06 ? 0 : clamp(distance * 2, -WALK, WALK);
        f.vx += (speed - f.vx) * (1 - Math.exp(-step * 6));
        f.x += f.vx * step;
        f.stride += Math.abs(f.vx) * step * 4.2;
        const walking = Math.min(Math.abs(f.vx) / WALK, 1);
        f.heading += turn(f.heading, facing(f, active, age, ballPosition, actors)) * (1 - Math.exp(-step * 6));
        const p = pose(f, active, age, walking);
        f.group.position.set(f.x, 0, f.z);
        f.group.rotation.y = f.heading;
        f.legs[0].rotation.x += (p.legs[0] - f.legs[0].rotation.x) * ease;
        f.legs[1].rotation.x += (p.legs[1] - f.legs[1].rotation.x) * ease;
        for (let i = 0; i < 2; i++) {
          const { shoulder, elbow } = f.arms[i];
          shoulder.rotation.x += (p.sx[i] - shoulder.rotation.x) * ease;
          shoulder.rotation.z += (p.sz[i] - shoulder.rotation.z) * ease;
          elbow.rotation.x += (p.ex[i] - elbow.rotation.x) * ease;
          elbow.rotation.y += (p.ey[i] - elbow.rotation.y) * ease;
          elbow.rotation.z += (p.ez[i] - elbow.rotation.z) * ease;
        }
        f.body.position.y += (p.lift - f.body.position.y) * ease;
        f.torso.rotation.x += (p.lean - f.torso.rotation.x) * ease;
      }
    },
    // The manager's drawn position, for a camera reaction shot.
    getManagerPosition(team) {
      return managers[team]?.group.position ?? null;
    },
    handleMessage(message, now) {
      if (message.type !== 'manager') return;
      const manager = managers[message.team];
      if (!manager) return;
      if (message.kind === 'instruction') gesture(manager, 'instruct', now, message.player ?? null);
      else if (message.kind === 'substitution') gesture(manager, 'change', now, message.off ?? null);
    },
    handleEvent(event, now) {
      if (event.kind === 'substitution' && managers[event.team]) {
        gesture(managers[event.team], 'clap', now, event.on ?? null);
      } else if ((event.kind === 'yellow' || event.kind === 'red') && managers[event.team]) {
        gesture(managers[event.team], 'protest', now);
      } else if (event.kind === 'goal') {
        for (const f of figures) gesture(f, f.team === event.team ? 'celebrate' : 'despair', now);
      } else if (event.kind === 'half_time' || event.kind === 'full_time') {
        // Applause at the whistles, unless the final one has a winner.
        const [home, away] = event.score ?? [0, 0];
        if (event.kind === 'half_time' || home === away) {
          for (const manager of managers) gesture(manager, 'clap', now);
        } else {
          for (const f of figures) gesture(f, f.team === (home > away ? 0 : 1) ? 'celebrate' : 'despair', now);
        }
      }
    },
    dispose() {
      root.removeFromParent();
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      figures.length = 0;
      managers.length = 0;
      paints.clear();
    },
  };
}
