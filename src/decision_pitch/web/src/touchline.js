import * as THREE from 'three';
import { createFigures, envelope } from './figures.js';

// Each team's manager, and one figure per assistant model, in a technical area
// beside the halfway line on the touchline nearest the broadcast camera. Home
// stands left of halfway and away right, for both halves. Presentation only:
// the figures react to the messages and events the page already receives.
// They are the same human figure as the players (figures.js): a manager in a
// coat, an assistant in a tracksuit, walking on the figure's loops and making
// its touchline gestures.
const AREA = { offset: 8, half: 4.5, depth: 2.5 }; // metres from halfway and touchline
const WALK = 1.5; // m/s
// Seconds each gesture lasts. A goal reaction outlasts the camera's close-up of the
// scorer, so the reaction shot that follows it still finds the managers reacting.
const GESTURES = { instruct: 2.8, change: 2.6, clap: 2.6, protest: 2.6, celebrate: 6.5, despair: 5.5 };
// The figure's clip for each gesture.
const CLIPS = { instruct: 'instruct', change: 'change', clap: 'clap', protest: 'protest', celebrate: 'cheer', despair: 'despair' };
// A gesture under way gives way only to one of at least its rank: a goal's reaction
// outranks a card's protest, which outranks the rest, so a substitution made at the
// same stoppage as a card does not cut the protest short.
const RANK = { celebrate: 2, despair: 2, protest: 1 };
const rank = (kind) => RANK[kind] ?? 0;
const ASSISTANT_REACTION = 3.5; // s: assistants react more briefly than the manager
const TURN_AWAY = 1.8; // s into despair when a manager turns its back on the pitch
// The instruct clip points the right arm this far right of the way the figure faces, so
// a manager turns this far left of the player it points at.
const POINTING = 0.45; // rad
const FADE_IN = 0.2;
const FADE_OUT = 0.4;
const CUT = 0.3; // s over which a gesture another one interrupts fades out
const LABEL_GAP = 0.45; // m between the top of the head and a name label

export function technicalArea(pitch, team) {
  const x = (team === 0 ? -1 : 1) * AREA.offset;
  return { x, z: pitch.width / 2 + AREA.depth, minX: x - AREA.half, maxX: x + AREA.half };
}

const clamp = THREE.MathUtils.clamp;
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function createTouchline(scene, teams, pitch, figure) {
  const root = new THREE.Group();
  root.name = 'touchline';
  scene.add(root);
  const made = createFigures(figure);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const disc = new THREE.CircleGeometry(1, 24);
  geometries.add(disc);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: '#061b14', transparent: true, opacity: 0.2, depthWrite: false,
  });
  materials.add(shadowMaterial);
  const figures = [];
  const managers = [];

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
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthWrite: false });
    materials.add(spriteMaterial);
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(height * canvas.width / canvas.height, height, 1);
    return sprite;
  }

  function figureFor(team, role, index, name) {
    const colours = teams[team].colours;
    const area = technicalArea(pitch, team);
    const side = area.x < 0 ? -1 : 1;
    const group = new THREE.Group();
    group.name = role === 'manager' ? `manager-${team}` : `assistant-${team}-${index}`;
    root.add(group);
    const shadow = new THREE.Mesh(disc, shadowMaterial);
    shadow.position.y = 0.02;
    shadow.scale.set(0.45, 0.45, 1);
    shadow.rotation.x = -Math.PI / 2;
    group.add(shadow);
    const person = made.create({ seed: group.name, role, colours });
    group.add(person.object);
    if (name) {
      const size = role === 'manager' ? 1.1 : 0.7;
      const tag = label(name, colours.shirt, size);
      tag.position.y = person.height + LABEL_GAP + size / 2;
      group.add(tag);
    }
    // Assistants stand a step back and well to the side, so the camera above the
    // stands sees each figure and label clear of the manager's.
    const back = role === 'manager' ? 0 : 0.9;
    const offset = role === 'manager' ? 0 : (index % 2 === 0 ? -side : side) * 2 * (1 + Math.floor(index / 2));
    const result = {
      team, role, area, group, person, offset,
      x: area.x + offset, z: area.z + back, goal: area.x + offset, vx: 0,
      heading: Math.PI, gesture: null, gestureAt: 0, gestureUntil: -Infinity, target: null, fading: null,
    };
    group.position.set(result.x, 0, result.z);
    group.rotation.y = result.heading;
    figures.push(result);
    return result;
  }

  teams.forEach((team, index) => {
    managers.push(figureFor(index, 'manager', 0, team.manager ?? 'Manager'));
    // One label for each assistant model, on the first figure it helps, with how many.
    const assistants = team.assistants ?? [];
    assistants.forEach((name, i) => {
      const count = assistants.filter(other => other === name).length;
      const first = assistants.indexOf(name) === i;
      figureFor(index, 'assistant', i, first ? (count > 1 ? `${name} ×${count}` : name) : null);
    });
  });

  function gesture(f, kind, now, target = null) {
    if (now < f.gestureUntil && rank(f.gesture) > rank(kind)) return;
    // A gesture still showing fades out under the new one rather than vanishing.
    if (now < f.gestureUntil) f.fading = { kind: f.gesture, at: f.gestureAt, until: f.gestureUntil, cut: now };
    f.gesture = kind;
    f.gestureAt = now;
    f.gestureUntil = now + (f.role === 'manager' ? GESTURES[kind] : Math.min(GESTURES[kind], ASSISTANT_REACTION));
    f.target = target;
  }

  // Plays the clip of gesture `kind` begun at `at` and lasting until `until`, `scale` of it.
  function show(f, kind, at, until, now, scale = 1) {
    const name = CLIPS[kind];
    const clip = f.person.clip(name);
    if (!clip) return;
    const age = now - at;
    const share = envelope(age, 0, until - at, FADE_IN, FADE_OUT) * scale;
    if (share > 0) f.person.act(name, Math.min(age, clip.duration), share, 'gesture');
  }

  // The way a figure turns: towards the player it points at or applauds, away from the
  // pitch in despair, otherwise towards play, and partly into its walk while walking.
  function facing(f, kind, age, ballPosition, actors, walking) {
    if (kind === 'despair' && f.role === 'manager' && age >= TURN_AWAY) return 0; // away from the pitch
    const position = f.target !== null && (kind === 'instruct' || kind === 'change' || kind === 'clap')
      ? actors?.getPlayerPosition?.(f.target) : null;
    const look = position ?? ballPosition;
    let heading = Math.atan2(look.x - f.x, look.z - f.z);
    if (kind === 'instruct' && position) return heading + POINTING;
    if (walking > 0) heading += turn(heading, f.vx > 0 ? Math.PI / 2 : -Math.PI / 2) * 0.6 * walking;
    return heading;
  }

  return {
    update(ballPosition, dt, now, actors) {
      const step = clamp(dt, 0, 0.1);
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
        if (Math.abs(f.vx) < 1e-3 && speed === 0) f.vx = 0;
        f.x += f.vx * step;
        const walking = Math.min(Math.abs(f.vx) / WALK, 1);
        f.heading += turn(f.heading, facing(f, active, age, ballPosition, actors, walking)) * (1 - Math.exp(-step * 6));
        f.group.position.set(f.x, 0, f.z);
        f.group.rotation.y = f.heading;
        if (f.fading) {
          const gone = (now - f.fading.cut) / CUT;
          if (gone >= 1) f.fading = null;
          else show(f, f.fading.kind, f.fading.at, f.fading.until, now, 1 - gone);
        }
        if (active) show(f, active, f.gestureAt, f.gestureUntil, now);
        // Travel against facing: anticlockwise, so +pi/2 is the figure's left.
        const travel = f.vx === 0 ? 0 : turn(f.heading, f.vx > 0 ? Math.PI / 2 : -Math.PI / 2);
        f.person.update(step, Math.abs(f.vx), travel);
      }
    },
    // The manager's drawn position, for a camera reaction shot.
    getManagerPosition(team) {
      return managers[team]?.group.position ?? null;
    },
    // What a figure shows, by its name (manager-0, assistant-1-0, ...), for tests and debugging.
    inspect(name) {
      const f = figures.find(figure => figure.group.name === name);
      return f && { heading: f.heading, x: f.x, z: f.z, gesture: f.gesture, height: f.person.height, ...f.person.state() };
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
      made.dispose();
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      figures.length = 0;
      managers.length = 0;
    },
  };
}
