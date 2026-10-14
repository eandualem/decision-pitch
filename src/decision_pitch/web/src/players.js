import * as THREE from 'three';
import { continuous } from './timeline.js';

// Bodies face local +z. Match headings turn anticlockwise from match +x.
const mix = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const NONE = [];
const smooth = (t) => t * t * (3 - 2 * t);

export const DRIBBLE = 0.6; // m ahead of a player's centre that the engine carries the ball
const BALL_RADIUS = 0.11; // the engine's ball
const DRAWN_RADIUS = 0.3; // enlarged to read on a broadcast camera
// s: the engine's step. A touch is where the ball was as the step that records it began,
// and the ball has moved on for the whole step by the touch's time.
const STEP = 1 / 60;
const LOOSE = 0.5; // m between a carried ball and the drawn feet beyond which it is drawn as sent
const SETTLE = 0.15; // s for the drawn ball to settle onto a new path without a jump
// m/s: faster than any kick. A path this fast is the engine pulling a ball it has just
// taken to the feet within one step, and is settled onto rather than drawn as a jump.
const SNAP = 40;
const FASTEST = 35; // m/s: no kick leaves faster (the engine's cap is 30)

// Where `keys` ([u, value] pairs, u ascending) are at `u`: eased between each pair, or
// straight into a key marked 'linear', for a swing that does not slow through contact.
export function track(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [u1, v1, ease] = keys[i];
    if (u <= u1) {
      const [u0, v0] = keys[i - 1];
      const f = (u - u0) / (u1 - u0);
      return mix(v0, v1, ease === 'linear' ? f : smooth(f));
    }
  }
  return keys.at(-1)[1];
}

// Each touch's pose, around the moment of contact (u = 0, in s). Leg and arm angles turn
// about the body's x axis: negative swings forwards. `reach` is a goalkeeper's.
const KICK = [[-0.2, 0], [-0.07, 0.9], [0.05, -1.4, 'linear'], [0.45, 0]]; // the foot meets the ball at 0
const POSES = {
  kick: { end: 0.45, leg: KICK, arm: [[-0.2, 0], [0, -0.8], [0.45, 0]], pitch: [[-0.2, 0], [0, -0.12], [0.45, 0]] },
  control: { end: 0.3, leg: [[-0.12, 0], [0, -0.6], [0.3, 0]] },
  tackle: { end: 0.55, leg: [[-0.15, 0], [0, -1.25], [0.2, -1.2], [0.55, 0]], pitch: [[-0.15, 0], [0, 0.3], [0.55, 0]], lift: [[-0.15, 0], [0, -0.12], [0.55, 0]] },
  deflect: { end: 0.35, leg: [[-0.08, 0], [0, -0.45], [0.35, 0]], pitch: [[-0.08, 0], [0, -0.18], [0.35, 0]] },
  throw: { end: 0.5, arms: [[-0.25, 0], [-0.1, -3.4], [0, -2.5], [0.2, -1.2], [0.5, 0]], pitch: [[-0.25, 0], [-0.1, -0.15], [0, 0.12], [0.5, 0]] },
};
const KEEPER_POSE = { end: 0.95, envelope: [[-0.16, 0], [0, 1], [0.4, 1], [0.95, 0]] };
// The engine kicks the ball wherever it is aimed, whichever way the kicker faces. The
// drawn body turns into the kick as it winds up, so the swing sends the ball where it goes.
const TURN = [[-0.14, 0], [-0.04, 1], [0.12, 1], [0.45, 0]];
// A touch interrupts a player's pose only once that pose has played this long, or if it
// matters more: two players trading the ball in a duel do not twitch with every exchange.
const REPOSE = 0.25; // s
const WEIGHT = { control: 0, tackle: 0, deflect: 0, kick: 1, throw: 1, save: 1, catch: 1 };

// What a goalkeeper does to reach the ball at `lateral` m to its left and `height` m up.
export function reach(lateral, height, diving) {
  if (diving || Math.abs(lateral) > 0.7) {
    const roll = -Math.sign(lateral || 1) * Math.min(1.35, Math.asin(clamp(Math.abs(lateral) / 2.2, 0, 1)) + 0.55);
    return { roll, arms: -2.9, pitch: 0, lift: 0.15 };
  }
  if (height > 1.6) return { roll: 0, arms: -3, pitch: 0, lift: 0.3 };
  if (height > 0.8) return { roll: 0, arms: -1.6, pitch: 0.1, lift: 0 };
  return { roll: 0, arms: -0.9, pitch: 0.45, lift: -0.08 };
}

export function createPlayers(scene, teams) {
  const root = new THREE.Group();
  scene.add(root);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometry = (value) => { geometries.add(value); return value; };
  const material = (value) => { materials.add(value); return value; };
  const paint = (color) => material(new THREE.MeshLambertMaterial({ color }));
  const box = geometry(new THREE.BoxGeometry(1, 1, 1));
  const head = geometry(new THREE.IcosahedronGeometry(0.23, 1));
  const disc = geometry(new THREE.CircleGeometry(1, 24));
  const numberPlane = geometry(new THREE.PlaneGeometry(0.42, 0.48));
  const boots = paint('#17212a');
  const skin = ['#d9a477', '#ad7650', '#764c35', '#e8bb96'].map(paint);
  const shadowMaterial = material(new THREE.MeshBasicMaterial({
    color: '#061b14', transparent: true, opacity: 0.23, depthWrite: false,
  }));
  const actors = new Map();
  const previous = new Map();
  let previousSnapshot = null;

  function mesh(shape, surface, parent, x, y, z, sx = 1, sy = 1, sz = 1) {
    const result = new THREE.Mesh(shape, surface);
    result.position.set(x, y, z);
    result.scale.set(sx, sy, sz);
    result.castShadow = true;
    parent.add(result);
    return result;
  }

  function shadow(parent, size) {
    const result = mesh(disc, shadowMaterial, parent, 0, 0.025, 0, size, size, 1);
    result.rotation.x = -Math.PI / 2;
    result.castShadow = false;
    return result;
  }

  function numberTexture(number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 88px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#17212a';
    ctx.strokeText(String(number), 64, 67);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(number), 64, 67);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    return texture;
  }

  teams.forEach((team, teamIndex) => {
    const shirt = paint(team.colours.shirt);
    const shorts = paint(team.colours.shorts);
    const keeper = paint(team.colours.keeper);
    [...team.players, ...(team.bench || [])].forEach((player, index) => {
      const group = new THREE.Group();
      group.visible = false;
      root.add(group);
      shadow(group, 0.55);
      const body = new THREE.Group();
      group.add(body);
      const kit = player.position === 'GK' ? keeper : shirt;
      const complexion = skin[index % skin.length];
      mesh(box, kit, body, 0, 1.24, 0, 0.64, 0.65, 0.37);
      mesh(box, shorts, body, 0, 0.87, 0, 0.57, 0.22, 0.36);
      mesh(head, complexion, body, 0, 1.82, 0);
      const limbs = [];
      for (const side of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(side * 0.17, 0.84, 0);
        body.add(leg);
        mesh(box, complexion, leg, 0, -0.19, 0, 0.18, 0.34, 0.2);
        mesh(box, kit, leg, 0, -0.49, 0, 0.19, 0.3, 0.21);
        mesh(box, boots, leg, 0, -0.7, 0.08, 0.23, 0.14, 0.36);
        limbs.push(leg);
      }
      for (const side of [-1, 1]) {
        const arm = new THREE.Group();
        arm.position.set(side * 0.4, 1.5, 0);
        body.add(arm);
        mesh(box, kit, arm, 0, -0.12, 0, 0.2, 0.3, 0.24);
        mesh(box, complexion, arm, 0, -0.39, 0, 0.16, 0.32, 0.18);
        if (player.position === 'GK') mesh(box, shorts, arm, 0, -0.57, 0, 0.21, 0.16, 0.23);
        limbs.push(arm);
      }
      const numberMap = numberTexture(player.number);
      const numberMaterial = material(new THREE.MeshBasicMaterial({
        map: numberMap, transparent: true, depthWrite: false,
      }));
      for (const side of [-1, 1]) {
        const printedNumber = mesh(numberPlane, numberMaterial, body, 0, 1.24, side * 0.192);
        printedNumber.rotation.y = side < 0 ? Math.PI : 0;
        printedNumber.castShadow = false;
      }
      const badge = new THREE.Sprite(material(new THREE.SpriteMaterial({
        map: numberMap, depthWrite: false,
      })));
      badge.position.y = 2.4;
      badge.scale.set(0.88, 0.88, 1);
      group.add(badge);
      body.rotation.order = 'YXZ'; // turn to face, then lean forwards, then roll sideways
      actors.set(player.id, {
        group, body, limbs, team: teamIndex, stride: index * 0.8, heading: 0, pace: 0,
        celebrateUntil: -Infinity, pose: null, lean: 0, facing: 0, faceYaw: 0, guard: 0,
      });
    });
  });

  // Faceted white shell and dark pentagonal panels use only procedural geometry.
  const ball = new THREE.Group();
  root.add(ball);
  const shell = mesh(geometry(new THREE.IcosahedronGeometry(DRAWN_RADIUS, 2)), paint('#fff9df'), ball, 0, 0, 0);
  const panelShape = geometry(new THREE.CircleGeometry(0.082, 5));
  const panelMaterial = paint('#263344');
  const normal = new THREE.Vector3();
  for (let i = 0; i < 12; i++) {
    const y = 1 - (i + 0.5) / 6;
    const radius = Math.sqrt(1 - y * y);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    normal.set(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
    const panel = mesh(panelShape, panelMaterial, shell, normal.x * 0.299, normal.y * 0.299, normal.z * 0.299);
    panel.lookAt(normal);
  }
  const ballShadow = shadow(root, 0.4);
  // The ball's opacity varies independently of the players' contact shadows.
  ballShadow.material = material(shadowMaterial.clone());
  ball.visible = ballShadow.visible = false;
  let ballReady = false;
  let carried = false; // drawn at its carrier's feet last frame
  const settle = new THREE.Vector3(); // the drawn ball's offset from a new path when it changed
  const applied = new THREE.Vector3(); // what was left of it last frame
  let settleAt = -Infinity;
  let ballTime = -Infinity; // the drawn match's time last frame
  const travel = new THREE.Vector3();
  const spinAxis = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const turn = new THREE.Quaternion();
  let spinRate = 0; // rad/s
  const seen = new Map(); // touches already posed, by time and player, with their time

  // Start the pose for each touch the engine reports, timed to its moment of contact. A
  // touch in a snapshot still ahead of the render time gets its wind-up.
  function notice(snapshot, time) {
    for (const touch of snapshot?.ball?.touches ?? NONE) {
      // The engine records at most one touch per player per step.
      const key = Math.round(touch.t * 1000) * 4096 + touch.player;
      if (seen.has(key)) continue;
      seen.set(key, touch.t);
      if (seen.size > 32) for (const [old, t] of seen) if (t < time - 2) seen.delete(old);
      startPose(touch, snapshot, time);
    }
  }

  function startPose(touch, snapshot, time) {
    const at = touch.t - STEP;
    const actor = actors.get(touch.player);
    const keeper = touch.kind === 'save' || touch.kind === 'catch';
    if (!actor || at < time - 0.3 || !(touch.kind in WEIGHT)) return;
    const playing = actor.pose;
    if (playing && (playing.at > at || (at - playing.at < REPOSE && WEIGHT[touch.kind] <= WEIGHT[playing.kind]))) return;
    const pose = { kind: touch.kind, touch, at, from: time - at, end: keeper ? KEEPER_POSE.end : POSES[touch.kind].end };
    if (touch.kind === 'kick' || touch.kind === 'throw') {
      pose.aim = aim(pose, snapshot); // the first snapshot to report the touch, if it can tell
      pose.aimed = pose.from;
    }
    if (keeper) {
      const player = snapshot.players.find(p => p.id === touch.player);
      if (!player) return;
      const dx = touch.x - player.x;
      const dy = touch.y - player.y;
      const face = actor.faceYaw; // across the way the ball came
      pose.reach = reach(-dx * Math.sin(face) + dy * Math.cos(face), touch.z, Boolean(player.dive));
    }
    actor.pose = pose;
  }

  // Which way a kick sends the ball: from the touch to where `snapshot` has it, or null
  // when the snapshot cannot tell. It must still report the touch, in play, with nobody
  // touching the ball since: a goal or the ball going out restarts play in the same
  // engine step, with the ball already placed at the restart.
  function aim(pose, snapshot) {
    const { touch } = pose;
    if (!snapshot || snapshot.t < touch.t || snapshot.phase !== 'play') return null;
    let reported = false;
    for (const other of snapshot.ball.touches ?? NONE) {
      if (other.t > touch.t) return null;
      if (other.t === touch.t && other.player === touch.player) reported = true;
    }
    const dx = snapshot.ball.x - touch.x;
    const dy = snapshot.ball.y - touch.y;
    const distance = Math.hypot(dx, dy);
    if (!reported || distance <= 0.15 || distance > FASTEST * (snapshot.t - touch.t + STEP)) return null;
    return Math.atan2(dy, dx);
  }

  function update(before, after, alpha, dt, now, latest = after) {
    if (!after) return;
    const from = before || after;
    if (previousSnapshot !== from) {
      previous.clear();
      for (const player of from.players) previous.set(player.id, player);
      previousSnapshot = from;
    }
    const reset = from !== after && !continuous(from, after);
    const blend = reset ? 1 : clamp(alpha, 0, 1);
    const time = mix(from.t, after.t, blend); // where the drawn match is on the server's clock
    const span = after.t - from.t;
    const step = clamp(dt, 0, 0.1);
    // The engine preserves its last velocities and commands at the interval/whistle.
    const stopped = after.phase === 'half_time' || after.phase === 'full_time';
    if (!stopped) {
      notice(after, time);
      if (latest !== after) notice(latest, time);
    }
    for (const actor of actors.values()) actor.group.visible = false;
    for (const player of after.players) {
      const actor = actors.get(player.id);
      if (!actor) continue;
      const old = previous.get(player.id) || player;
      const teleport = Math.hypot(player.x - old.x, player.y - old.y) > 8;
      const k = teleport ? 1 : blend;
      const { group, body, limbs } = actor;
      group.visible = true;
      group.position.set(mix(old.x, player.x, k), 0, -mix(old.y, player.y, k));
      actor.heading = angle(old.heading, player.heading, k);
      const speed = stopped ? 0 : Math.max(0, mix(old.speed, player.speed, k));
      actor.pace = Math.min(speed / 6, 1);
      actor.stride += speed * step * 2.7;
      const swing = Math.sin(actor.stride) * actor.pace * 0.7;
      const celebrating = now < actor.celebrateUntil;
      const legA = swing;
      let legB = -swing;
      let armA = -swing * 0.7;
      let armB = swing * 0.7;
      let pitch = 0;
      let lift = celebrating ? Math.abs(Math.sin(now * 7)) * 0.3 : Math.abs(Math.sin(actor.stride)) * actor.pace * 0.06;

      // A goalkeeper going for the ball faces where it comes from, whichever way the engine
      // has it running along its line, and leans across into a dive as it gathers pace.
      const bx = after.ball.x - player.x;
      const by = after.ball.y - player.y;
      if (bx * bx + by * by > 6.25) actor.faceYaw = Math.atan2(by, bx);
      const pose = stopped ? null : actor.pose;
      if (stopped) actor.pose = null;
      const guarding = !stopped && (Boolean(player.dive) || Boolean(pose?.reach));
      actor.guard = stopped ? 0 : mix(actor.guard, guarding ? 1 : 0, 1 - Math.exp(-step * (guarding ? 12 : 3)));
      actor.facing = angle(actor.heading, actor.faceYaw, actor.guard);
      let lean = 0;
      if (!stopped && player.dive && !teleport && span > 0) {
        const lateral = (-(player.x - old.x) * Math.sin(actor.facing) + (player.y - old.y) * Math.cos(actor.facing)) / span;
        lean = -Math.sign(lateral) * Math.min(1, Math.abs(lateral) / 5) * 0.9;
      }
      actor.lean = stopped ? 0 : mix(actor.lean, lean, 1 - Math.exp(-step * (player.dive ? 10 : 4)));
      let roll = actor.lean;
      const stretch = Math.abs(actor.lean) / 0.9;
      armA = mix(armA, -2.9, stretch);
      armB = mix(armB, -2.9, stretch);

      // The body meets the ball at the touch's moment of contact.
      const u = pose ? time - pose.at : 0;
      if (pose && u > pose.end) actor.pose = null;
      else if (pose) {
        const w = Math.min(clamp((u - pose.from) / 0.06, 0, 1), clamp((pose.end - u) / 0.15, 0, 1));
        if (pose.aim === null && (pose.aim = aim(pose, after) ?? aim(pose, latest)) != null) pose.aimed = u;
        // A turn starts from where the body is, even when the aim is known only late.
        const turning = track(TURN, u) * Math.min(w, clamp((u - pose.aimed) / 0.06, 0, 1));
        if (pose.aim != null) actor.facing = angle(actor.facing, pose.aim, turning);
        if (pose.reach) {
          const e = track(KEEPER_POSE.envelope, u) * w;
          roll = mix(roll, pose.reach.roll, e);
          armA = mix(armA, pose.reach.arms, e);
          armB = mix(armB, pose.reach.arms, e);
          pitch = mix(pitch, pose.reach.pitch, e);
          lift += pose.reach.lift * e;
        } else {
          const shape = POSES[pose.kind];
          if (shape.leg) legB = mix(legB, track(shape.leg, u), w);
          if (shape.arm) armA = mix(armA, track(shape.arm, u), w);
          if (shape.arms) {
            armA = mix(armA, track(shape.arms, u), w);
            armB = mix(armB, track(shape.arms, u), w);
          }
          if (shape.pitch) pitch = mix(pitch, track(shape.pitch, u), w);
          if (shape.lift) lift += track(shape.lift, u) * w;
        }
      }
      body.rotation.y = actor.facing + Math.PI / 2;
      limbs[0].rotation.x = legA;
      limbs[1].rotation.x = legB;
      limbs[2].rotation.x = armA;
      limbs[3].rotation.x = armB;
      limbs[2].rotation.z = celebrating ? -2.55 : -0.13;
      limbs[3].rotation.z = celebrating ? 2.55 : 0.13;
      body.rotation.x = pitch;
      body.rotation.z = roll;
      body.position.y = lift;
    }

    // The ball as the engine sends it, through the point of each touch at its moment.
    const oldBall = from.ball;
    const newBall = after.ball;
    const ballTeleport = Math.hypot(newBall.x - oldBall.x, newBall.y - oldBall.y) > 10;
    let start = oldBall;
    let end = newBall;
    let f = ballTeleport ? 1 : blend;
    if (!reset && !ballTeleport) {
      let startT = from.t;
      for (const touch of newBall.touches ?? NONE) {
        const contact = touch.t - STEP;
        if (contact <= startT || contact >= after.t) continue;
        if (time <= contact) {
          end = touch;
          f = (time - startT) / (contact - startT);
          break;
        }
        start = touch;
        startT = contact;
        f = (time - startT) / (after.t - startT);
      }
    }
    let x = mix(start.x, end.x, f);
    let z = -mix(start.y, end.y, f);
    const height = mix(start.z, end.z, f);
    // Carried, it is drawn at the drawn feet, nudged ahead by each touch of the stride,
    // until the moment its carrier kicks it.
    const holder = oldBall.owner != null ? actors.get(oldBall.owner) : null;
    const kicking = holder?.pose?.kind === 'kick' && time < holder.pose.at;
    const carrier = !reset && from.phase === 'play' && after.phase === 'play' && holder
      && (newBall.owner === oldBall.owner || kicking) ? holder : null;
    let carrying = false;
    if (carrier?.group.visible) {
      const feet = carrier.group.position;
      // The goal frame can stop a carried ball short of the feet: then draw it as sent.
      const sent = Math.hypot(feet.x + Math.cos(carrier.heading) * DRIBBLE - x, feet.z - Math.sin(carrier.heading) * DRIBBLE - z);
      if (sent < LOOSE) {
        const ahead = DRIBBLE + 0.14 * carrier.pace * (0.5 - 0.5 * Math.cos(carrier.stride - Math.PI / 2));
        x = feet.x + Math.cos(carrier.facing) * ahead;
        z = feet.z - Math.sin(carrier.facing) * ahead;
        carrying = true;
      }
    }
    const y = Math.max(DRAWN_RADIUS, height - BALL_RADIUS + DRAWN_RADIUS);
    // How far the path moved since last frame's.
    const moved = Math.hypot(x - (ball.position.x - applied.x), y - (ball.position.y - applied.y), z - (ball.position.z - applied.z));
    const jump = !ballReady || reset || ballTeleport || moved > 3;
    const snapped = moved > 0.3 && moved > SNAP * (time - ballTime);
    ballTime = time;
    if (jump) settle.set(0, 0, 0);
    else if (carrying !== carried || snapped) {
      settle.set(ball.position.x - x, ball.position.y - y, ball.position.z - z);
      settleAt = time;
    }
    carried = carrying;
    // The offset fades on the drawn match's clock, so a kicked ball leaves the boot along its path.
    applied.copy(settle).multiplyScalar(1 - smooth(clamp((time - settleAt) / SETTLE, 0, 1)));
    x += applied.x;
    z += applied.z;
    const drawnY = Math.max(DRAWN_RADIUS, y + applied.y);
    // It rolls without slipping on the grass and keeps its spin in the air.
    if (!jump && step > 0) {
      travel.set(x - ball.position.x, 0, z - ball.position.z);
      const distance = travel.length();
      if (stopped) spinRate = 0;
      else if (height < BALL_RADIUS + 0.05) {
        if (distance > 1e-6) spinAxis.crossVectors(up, travel).normalize();
        spinRate = distance / DRAWN_RADIUS / step;
      } else spinRate *= Math.exp(-step * 0.5);
      if (spinRate > 0) shell.quaternion.premultiply(turn.setFromAxisAngle(spinAxis, spinRate * step));
    }
    ball.position.set(x, drawnY, z);
    ballShadow.position.set(x, 0.027, z);
    const size = 0.4 + Math.min(drawnY, 10) * 0.035;
    ballShadow.scale.set(size, size, 1);
    ballShadow.material.opacity = 0.3 / (1 + drawnY * 0.18);
    ball.visible = ballShadow.visible = ballReady = true;
  }

  return {
    update,
    ballPosition: ball.position,
    getPlayerPosition(id) {
      const actor = actors.get(id);
      return actor?.group.visible ? actor.group.position : null;
    },
    handleEvent(event, now) {
      if (event.kind !== 'goal') return;
      for (const actor of actors.values()) {
        if (actor.team === event.team) actor.celebrateUntil = now + 4.2;
      }
    },
    dispose() {
      root.removeFromParent();
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      actors.clear();
      previous.clear();
      seen.clear();
    },
  };
}
