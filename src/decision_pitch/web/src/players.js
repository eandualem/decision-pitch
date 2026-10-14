import * as THREE from 'three';
import { continuous } from './timeline.js';
import { createFigures, contactTime, envelope, TOUCH_PHASE } from './figures.js';

// Figures face local +z. Match headings turn anticlockwise from match +x.
const mix = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const NONE = [];
const smooth = (t) => t * t * (3 - 2 * t);
const ramp = (value, low, high) => smooth(clamp((value - low) / (high - low), 0, 1));

export const DRIBBLE = 0.6; // m ahead of a player's centre that the engine carries the ball
const BALL_RADIUS = 0.11; // the engine's ball
const DRAWN_RADIUS = BALL_RADIUS; // drawn at its real size
// s: the engine's step. A touch is where the ball was as the step that records it began,
// and the ball has moved on for the whole step by the touch's time.
const STEP = 1 / 60;
const LOOSE = 0.5; // m between a carried ball and the drawn feet beyond which it is drawn as sent
const SETTLE = 0.15; // s for the drawn ball to settle onto a new path without a jump
// m/s: faster than any kick. A path this fast is the engine pulling a ball it has just
// taken to the feet within one step, and is settled onto rather than drawn as a jump.
const SNAP = 40;
const FASTEST = 35; // m/s: no kick leaves faster (the engine's cap is 30)
const SHOT = 18; // m/s: a kick that leaves faster plays the shot, a slower one the pass
const GAIT = 0.08; // s over which the drawn velocity that drives the stride settles
// m travelled over which the direction of travel settles: by distance rather than time,
// so the jitter of a player barely moving cannot swing its steps from side to side, and
// short, so a player turning back on itself steps the new way at once (below a shuffle
// the figure ignores the travel anyway).
const TURNING = 0.04;
const FADE = 0.12; // s a pose cut short by the next one takes to fade out
// A dribbler's right foot meets the ball at its stride's touch (figures.js), just before
// it plants at 0.5: the ball runs ahead from there and the runner catches it up.
// How long a model player's latest decision colours what its figure shows, s.
const DECIDED = 2;
const DIVE_ACROSS = 1.2; // m/s across its facing at which a diving goalkeeper leaves its feet
const THROWER = 1.2; // m from the ball within which a player picks it up for a throw-in
const THROW_RELEASE = 0.4; // s the thrown ball takes to settle from the hands onto its path
const CELEBRATION = 4.2; // s a looping celebration lasts
// m: the dark spot under the ball, a little wider than it, so the white ball on its own
// shadow keeps a contrasting edge on the broadcast camera at its real size.
const BALL_SHADOW = 0.19;

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

// The engine kicks the ball wherever it is aimed, whichever way the kicker faces. The
// drawn body turns into the kick as it winds up, so the swing sends the ball where it goes.
const TURN = [[-0.14, 0], [-0.04, 1], [0.12, 1], [0.45, 0]];
// A touch interrupts a player's pose only once that pose has played this long, or if it
// matters more: two players trading the ball in a duel do not twitch with every exchange.
const REPOSE = 0.25; // s
const WEIGHT = { control: 0, tackle: 0, deflect: 0, kick: 1, throw: 1, save: 1, catch: 1 };
const CLIPS = { control: 'control', deflect: 'control', throw: 'throw_in' };
// Clips that move the whole body even at a run: the slide, the throw and the goalkeeper's.
// The others keep the stride's support leg and hips over a run.
const WHOLE = new Set(['tackle', 'throw_in', 'keeper_catch', 'keeper_catch_high']);
// Which kick a kick plays. A model player's decision says, for a moment (DECIDED); otherwise
// the ball's flight does: lifted from a wide attacking place in towards the middle, a cross;
// lifted elsewhere, a lofted pass; along the ground, the shot when it leaves fast.
const DECIDED_KICKS = { shoot: 'shot', cross: 'cross', through_ball: 'pass_lofted', clear: 'pass_lofted' };
const LOFTED = 0.3; // rad above the ground a lifted kick leaves at, at least
const WIDE = 18; // m from the middle of the pitch a cross comes from, at least
const DEEP = 22; // m from halfway
const GRAVITY = 9.81;
// A tackle at a run is the slide; one made more slowly, the standing block.
const SLIDE = 4.5; // m/s
// A clip a figure lacks plays the nearest it has.
const INSTEAD = { cross: 'pass_lofted', pass_lofted: 'pass', shot: 'pass', tackle_standing: 'tackle' };
// A sprinter knocks the ball ahead (a `knock` touch) and catches it up (its `control`):
// neither is a clip. Its stride is timed so its boot meets the ball at each, within STEER
// of its own pace, and it keeps the look of a run with the ball while it chases (CHASE s).
const CHASE = 4;
const CATCH = 0.75; // m between a chaser and the ball it knocked when it plays it again (the engine's reach)
// Neighbours (within NEAR m) running alike (velocities within ALIKE m/s) whose strides are
// within IN_STEP of a cycle of each other do not stay so: the later of the two quickens
// its stride (figures.js) for PARTING frames, which takes it about a fifth of a stride on.
const NEAR = 4;
const ALIKE = 0.8;
const IN_STEP = 0.08;
const PARTING = 70;

// What a goalkeeper does to reach the ball at `lateral` m to its left and `height` m up:
// a dive to that side if it is diving or the ball is beyond its reach, else a catch.
export function reach(lateral, height, diving) {
  if (diving || Math.abs(lateral) > 0.7) return lateral >= 0 ? 'keeper_dive_L' : 'keeper_dive_R';
  return height > 1.5 ? 'keeper_catch_high' : 'keeper_catch';
}

// The clip a touch plays: `speed` is how fast a kick sent the ball, `loft` the angle it
// left the ground at, `crossing` whether it went from a wide attacking place in towards the
// middle and `decision` the kicker's latest decision, if a model's; `running` how fast a
// tackler ran; `lateral` and `height` where a goalkeeper met the ball, and `diving` whether
// it was diving. A knock, the sprinter's touch of its stride, plays none.
export function touchClip(kind, {
  speed = 0, loft = 0, crossing = false, decision = null, running = 0, lateral = 0, height = 0, diving = false,
} = {}) {
  if (kind === 'kick') {
    if (decision && DECIDED_KICKS[decision]) return DECIDED_KICKS[decision];
    if (loft >= LOFTED) return crossing ? 'cross' : 'pass_lofted';
    return speed > SHOT ? 'shot' : 'pass';
  }
  if (kind === 'tackle') return running >= SLIDE ? 'tackle' : 'tackle_standing';
  if (kind === 'save' || kind === 'catch') return reach(lateral, height, diving);
  return CLIPS[kind] ?? null;
}

// `options` go to createFigures (figures.js).
export function createPlayers(scene, teams, figure, options = {}) {
  const root = new THREE.Group();
  scene.add(root);
  const made = createFigures(figure, options);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometry = (value) => { geometries.add(value); return value; };
  const material = (value) => { materials.add(value); return value; };
  const disc = geometry(new THREE.CircleGeometry(1, 24));
  const shadowMaterial = material(new THREE.MeshBasicMaterial({
    color: '#061b14', transparent: true, opacity: 0.2, depthWrite: false,
  }));
  const actors = new Map();
  const previous = new Map();
  let previousSnapshot = null;

  function shadow(parent, size, surface = shadowMaterial) {
    const result = new THREE.Mesh(disc, surface);
    result.position.y = 0.02;
    result.scale.set(size, size, 1);
    result.rotation.x = -Math.PI / 2;
    parent.add(result);
    return result;
  }

  teams.forEach((team, teamIndex) => {
    [...team.players, ...(team.bench || [])].forEach((player) => {
      const group = new THREE.Group();
      group.visible = false;
      root.add(group);
      shadow(group, 0.42);
      const person = made.create({
        seed: player.id, role: player.position === 'GK' ? 'keeper' : 'outfield',
        colours: team.colours, number: player.number,
      });
      group.add(person.object);
      const numberMap = new THREE.CanvasTexture(person.numberCanvas);
      numberMap.colorSpace = THREE.SRGBColorSpace;
      textures.add(numberMap);
      const badge = new THREE.Sprite(material(new THREE.SpriteMaterial({ map: numberMap, depthWrite: false })));
      badge.position.y = person.height + 0.55;
      badge.scale.set(0.88, 0.88, 1);
      group.add(badge);
      actors.set(player.id, {
        group, person, badge, team: teamIndex, heading: 0, facing: 0, faceYaw: 0, guard: 0,
        vx: 0, vy: 0, speed: 0, pace: 0, way: 0, pose: null, fading: null, dive: null, throwing: null, holding: null,
        diving: false, armed: false,
        celebrateAt: -Infinity,
        // The loop sets the figure shows (figures.js) and the model's latest decision.
        sets: { dribble: 0, jockey: 0, shield: 0, touchIn: 0, hurry: 0 }, decision: null, decidedAt: -Infinity, id: player.id,
        parting: 0, // frames it goes on quickening its stride to fall out of step
        strideAt: -Infinity, // when its boot is to meet the ball it knocked on or catches up
        chasing: false, // the ball it knocked ahead
      });
    });
  });

  // A white shell with dark pentagons, one mesh. At its real size it is a few pixels on
  // the broadcast camera, so it is lit to stay bright and its shadow is kept crisp.
  const ball = new THREE.Group();
  root.add(ball);
  const shell = new THREE.Mesh(geometry(ballGeometry(DRAWN_RADIUS)), material(new THREE.MeshLambertMaterial({
    vertexColors: true,
  })));
  shell.castShadow = true;
  ball.add(shell);
  // The ball's shadow varies independently of the players' contact shadows.
  const ballShadow = shadow(root, BALL_SHADOW, material(new THREE.MeshBasicMaterial({
    color: '#020a06', transparent: true, opacity: 0.62, depthWrite: false,
  })));
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
  let lastTouch = null; // the latest touch seen
  let taker = null; // the player picking the ball up for a throw-in
  let throwTeam = null; // the team the last throw-in was given to
  let thrower = null; // the player with a throw-in under way
  let keeping = null; // a goalkeeper holding the ball it caught
  const hands = new THREE.Vector3();
  let held = false; // in someone's hands last frame
  let thrown = false; // and that someone was taking a throw-in
  let settleFor = SETTLE;

  // Start the pose for each touch the engine reports, timed to its moment of contact. A
  // touch in a snapshot still ahead of the render time gets its wind-up.
  function notice(snapshot, time, now) {
    for (const touch of snapshot?.ball?.touches ?? NONE) {
      // The engine records at most one touch per player per step.
      const key = Math.round(touch.t * 1000) * 4096 + touch.player;
      if (seen.has(key)) continue;
      seen.set(key, touch.t);
      if (seen.size > 32) for (const [old, t] of seen) if (t < time - 2) seen.delete(old);
      const before = lastTouch;
      lastTouch = touch;
      // A sprinter's knock, and its catching up with it: the touch of its stride.
      const actor = actors.get(touch.player);
      if (actor && (touch.kind === 'knock' || (touch.kind === 'control' && before?.kind === 'knock' && before.player === touch.player))) {
        actor.strideAt = touch.t - STEP;
        continue;
      }
      startPose(touch, snapshot, time, now);
    }
  }

  function startPose(touch, snapshot, time, now) {
    const at = touch.t - STEP;
    const actor = actors.get(touch.player);
    if (!actor || at < time - 0.3 || !(touch.kind in WEIGHT)) return;
    // A throw-in held overhead is released on the touch; one not yet picked up is thrown
    // from the wind-up there is time for.
    if (touch.kind === 'throw') {
      if (!actor.throwing) actor.throwing = timed(actor, 'throw_in', time, at);
      else if (!actor.throwing.anchor) retime(actor.throwing, actor.throwing.last, at);
    }
    if (touch.kind === 'save' || touch.kind === 'catch') {
      keeperTouch(actor, touch, snapshot, at, time);
      return;
    }
    const playing = actor.pose;
    if (playing && (playing.at > at || (at - playing.at < REPOSE && WEIGHT[touch.kind] <= WEIGHT[playing.kind]))) return;
    const pose = {
      kind: touch.kind, touch, at, from: time - at, aim: null, aimed: 0, speed: 0, loft: 0, crossing: false,
      decision: actor.decision !== null && now - actor.decidedAt < DECIDED ? actor.decision : null,
      clip: null, was: null, ease: 1, cut: Infinity,
    };
    if (touch.kind === 'kick' || touch.kind === 'throw') {
      aim(pose, snapshot); // the first snapshot to report the touch, if it can tell
      pose.aimed = pose.from;
    }
    pose.clip = playable(actor, touchClip(touch.kind, { ...pose, running: actor.speed }));
    const clip = pose.clip && actor.person.clip(pose.clip);
    if (!clip) return;
    pose.end = clip.duration - clip.contact;
    replace(actor, pose, time);
  }

  // `name`, or the nearest clip to it the figure has (INSTEAD).
  function playable(actor, name) {
    while (name && !actor.person.clip(name)) name = INSTEAD[name] ?? null;
    return name;
  }

  // A pose cut short by the next fades out under it rather than vanishing.
  function replace(actor, pose, time) {
    if (actor.pose) {
      actor.fading = actor.pose;
      actor.fading.cut = time;
    }
    actor.pose = pose;
  }

  // A goalkeeper's save or catch: a dive under way has its full stretch timed to the
  // touch; otherwise it dives to a ball beyond its reach, or catches it at its height.
  function keeperTouch(actor, touch, snapshot, at, time) {
    if (actor.dive) {
      if (actor.dive.clipTime < actor.dive.contact) retime(actor.dive, actor.dive.last, at);
      return;
    }
    const player = snapshot.players.find(p => p.id === touch.player);
    if (!player) return;
    const dx = touch.x - player.x;
    const dy = touch.y - player.y;
    const face = actor.faceYaw; // across the way the ball came
    const name = touchClip(touch.kind, {
      lateral: -dx * Math.sin(face) + dy * Math.cos(face), height: touch.z, diving: Boolean(player.dive),
    });
    const clip = actor.person.clip(name);
    if (!clip) return;
    if (name.startsWith('keeper_dive')) {
      startDive(actor, name, time, at);
      return;
    }
    const playing = actor.pose;
    if (playing && playing.at > at) return;
    replace(actor, { kind: touch.kind, touch, at, from: time - at, clip: name, end: clip.duration - clip.contact, aim: null, cut: Infinity }, time);
  }

  // A dive or a throw-in plays from its start at its own pace on the drawn match's clock,
  // up to `hold` (a throw-in waits there, the ball overhead). Once its touch is known the
  // clip's contact, the dive's full stretch or the throw's release, lands on the touch.
  function timed(actor, name, time, contactAt = null, hold = Infinity) {
    const clip = actor.person.clip(name);
    const clipTime = contactAt == null ? 0 : contactTime(time - contactAt, time - contactAt, clip.contact);
    const result = { clip: name, contact: clip.contact, duration: clip.duration, start: time, last: time, clipTime, hold, anchor: null };
    if (contactAt != null) retime(result, time, contactAt);
    return result;
  }

  function startDive(actor, name, time, contactAt = null) {
    actor.dive = timed(actor, name, time, contactAt);
    actor.armed = false;
  }

  // From where the clip is at `time`, it runs at the pace that reaches its contact at
  // `contactAt`, within 0.3 to 3 times its own, then at its own pace.
  function retime(clip, time, contactAt) {
    const left = contactAt - time;
    const rate = left > 1e-3 ? clamp((clip.contact - clip.clipTime) / left, 0.3, 3) : 3;
    clip.anchor = { time, clipTime: clip.clipTime, rate, reached: time + (clip.contact - clip.clipTime) / rate };
  }

  // Plays a timed clip; returns false once it has finished. A throw-in waiting to be
  // thrown holds on the gesture layer, so a taker still stepping up does not skate.
  function playTimed(actor, clip, time, waits = false) {
    const { anchor } = clip;
    if (time > clip.last) {
      if (!anchor) clip.clipTime = Math.min(clip.hold, clip.clipTime + time - clip.last);
      else if (time < anchor.reached) clip.clipTime = anchor.clipTime + anchor.rate * (time - anchor.time);
      else clip.clipTime = clip.contact + (time - anchor.reached);
      clip.last = time;
    }
    if (clip.clipTime >= clip.duration) return false;
    const share = Math.min(clamp((time - clip.start) / 0.12, 0, 1), clamp((clip.duration - clip.clipTime) / 0.3, 0, 1));
    actor.person.act(clip.clip, clip.clipTime, share, waits && !clip.anchor ? 'gesture' : 'whole');
    return true;
  }

  // Which way a kick sends the ball and how fast, from the touch to where `snapshot` has
  // it, when the snapshot can tell: it must still report the touch, in play, with nobody
  // touching the ball since. A goal or the ball going out restarts play in the same
  // engine step, with the ball already placed at the restart. Returns whether it told.
  function aim(pose, snapshot) {
    const { touch } = pose;
    if (!snapshot || snapshot.t < touch.t || snapshot.phase !== 'play') return false;
    let reported = false;
    for (const other of snapshot.ball.touches ?? NONE) {
      if (other.t > touch.t) return false;
      if (other.t === touch.t && other.player === touch.player) reported = true;
    }
    const dx = snapshot.ball.x - touch.x;
    const dy = snapshot.ball.y - touch.y;
    const distance = Math.hypot(dx, dy);
    const elapsed = snapshot.t - touch.t + STEP;
    if (!reported || distance <= 0.15 || distance > FASTEST * elapsed) return false;
    pose.aim = Math.atan2(dy, dx);
    pose.speed = distance / elapsed;
    // The angle it left the ground at, from how high it has risen against gravity.
    const rise = snapshot.ball.z - touch.z;
    pose.loft = rise > 0.02 ? Math.atan2(rise / elapsed + GRAVITY * elapsed / 2, pose.speed) : 0;
    pose.crossing = Math.abs(touch.y) > WIDE && Math.abs(touch.x) > DEEP && Math.sin(pose.aim) * Math.sign(touch.y) < -0.3;
    return true;
  }

  // The touch's clip, timed so its moment of contact lands on the touch, and the kicker's
  // turn into the kick. A kick shows the shot or the pass by how fast the ball left.
  function playPose(actor, pose, time, after, latest, step) {
    const u = time - pose.at;
    const w = envelope(u, pose.from, pose.held ? Infinity : pose.end, 0.06, 0.2) * clamp(1 - (time - pose.cut) / FADE, 0, 1);
    if (!(w > 0)) return;
    if (pose === actor.pose && (pose.kind === 'kick' || pose.kind === 'throw')) {
      if (pose.aim === null && (aim(pose, after) || aim(pose, latest))) {
        pose.aimed = u;
        // A kick learnt late to be another eases from the one it began as into it.
        const kick = playable(actor, touchClip(pose.kind, pose));
        if (pose.kind === 'kick' && kick && kick !== pose.clip) {
          pose.was = pose.clip;
          pose.clip = kick;
          pose.ease = 0;
          const clip = actor.person.clip(kick);
          pose.end = Math.max(pose.end, clip.duration - clip.contact);
        }
      }
      pose.ease = mix(pose.ease, 1, 1 - Math.exp(-step / 0.05));
      // A turn starts from where the body is, even when the aim is known only late.
      const turning = track(TURN, u) * Math.min(w, clamp((u - pose.aimed) / 0.06, 0, 1));
      if (pose.aim !== null) actor.facing = angle(actor.facing, pose.aim, turning);
    }
    const { person } = actor;
    if (pose.kind === 'kick') {
      const kick = person.clip(pose.clip);
      if (pose.was && pose.ease < 1) person.act(pose.was, contactTime(u, pose.from, person.clip(pose.was).contact), w * (1 - pose.ease));
      person.act(pose.clip, contactTime(u, pose.from, kick.contact), w * (pose.was ? pose.ease : 1));
    } else if (pose.held) {
      // A caught ball is held at the chest at the clip's end, over the steps once it is done.
      const clip = person.clip(pose.clip);
      const at = contactTime(u, pose.from, clip.contact);
      person.act(pose.clip, Math.min(at, clip.duration), w, at < clip.duration ? 'whole' : 'gesture');
    } else if (!(pose.kind === 'throw' && actor.throwing)) {
      const clip = person.clip(pose.clip);
      person.act(pose.clip, contactTime(u, pose.from, clip.contact), w, WHOLE.has(pose.clip) ? 'whole' : 'play');
    }
  }

  // Which loop sets a player's figure shows, from the snapshot: the dribble on the ball,
  // shielding it when slow with an opponent close behind, and jockeying the opponent who
  // has it, close, facing it and not closing in. Bots send no decisions, so this is all
  // read from the play; a model player's decision to shield adds to it.
  function readSets(actor, player, carrier, players, now, time, loose) {
    const { sets } = actor;
    sets.dribble = sets.jockey = sets.shield = 0;
    // Chasing the ball it knocked ahead, it runs as it does with the ball.
    actor.chasing = loose && lastTouch?.kind === 'knock' && lastTouch.player === player.id && time - lastTouch.t < CHASE;
    if (actor.chasing) sets.dribble = 1;
    if (!carrier) return;
    const cos = Math.cos(actor.facing);
    const sin = Math.sin(actor.facing);
    if (carrier === player) {
      let nearest = Infinity;
      let behind = 0;
      for (const other of players) {
        if (actors.get(other.id)?.team === actor.team) continue;
        const dx = other.x - player.x;
        const dy = other.y - player.y;
        const d = Math.hypot(dx, dy);
        if (d < nearest) {
          nearest = d;
          behind = d > 1e-6 ? -(dx * cos + dy * sin) / d : 0;
        }
      }
      let shield = (1 - ramp(nearest, 1.6, 2.6)) * ramp(behind, 0.2, 0.6) * (1 - ramp(actor.speed, 1.6, 2.6));
      if (actor.decision === 'shield' && now - actor.decidedAt < DECIDED) shield = Math.max(shield, 1 - ramp(actor.speed, 2.6, 3.6));
      sets.shield = shield;
      sets.dribble = 1 - shield;
      return;
    }
    if (actors.get(carrier.id)?.team === actor.team) return;
    const dx = carrier.x - player.x;
    const dy = carrier.y - player.y;
    const d = Math.hypot(dx, dy);
    if (!(d > 1e-6) || d > 6) return;
    const facing = (dx * cos + dy * sin) / d;
    const closing = (actor.vx * dx + actor.vy * dy) / d;
    sets.jockey = (1 - ramp(d, 3, 6)) * ramp(facing, 0.5, 0.85) * (1 - ramp(closing, 1.5, 3.5)) * (1 - ramp(actor.speed, 3.5, 5));
  }

  // Of two neighbours running alike and in step (as drawn last frame), the later hurries.
  const running = [];
  function unstep() {
    running.length = 0;
    for (const actor of actors.values()) {
      if (actor.parting > 0) actor.parting--;
      if (actor.group.visible && actor.speed > ALIKE) running.push(actor);
      else actor.parting = 0;
    }
    for (let i = 0; i < running.length; i++) {
      const a = running[i];
      for (let j = i + 1; j < running.length; j++) {
        const b = running[j];
        const pa = a.group.position;
        const pb = b.group.position;
        if ((pa.x - pb.x) ** 2 + (pa.z - pb.z) ** 2 > NEAR * NEAR) continue;
        if ((a.vx - b.vx) ** 2 + (a.vy - b.vy) ** 2 > ALIKE * ALIKE) continue;
        const apart = Math.abs(((a.person.phase - b.person.phase) % 1 + 1.5) % 1 - 0.5);
        const later = a.id > b.id ? a : b;
        if (apart < IN_STEP && !((a.id > b.id ? b : a).parting > 0)) later.parting = PARTING;
      }
    }
    for (const actor of actors.values()) actor.sets.hurry = actor.parting > 0 ? 1 : 0;
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
    const settling = 1 - Math.exp(-step / GAIT);
    // The engine preserves its last velocities and commands at the interval/whistle.
    const stopped = after.phase === 'half_time' || after.phase === 'full_time';
    if (!stopped) {
      notice(after, time, now);
      if (latest !== after) notice(latest, time, now);
    }
    unstep();
    for (const actor of actors.values()) actor.group.visible = false;
    // At a throw-in, whoever of the team it was given to comes to the ball picks it up;
    // an opponent standing nearer, the player who put it out, say, does not. Not before
    // the drawn match reaches the throw-in, whose event says which team that is.
    taker = null;
    if (from.phase === 'throw_in' && after.phase === 'throw_in' && !reset) {
      let nearest = THROWER;
      for (const player of after.players) {
        const candidate = actors.get(player.id);
        if (!candidate || (throwTeam !== null && candidate.team !== throwTeam)) continue;
        const d = Math.hypot(player.x - after.ball.x, player.y - after.ball.y);
        if (d < nearest) {
          nearest = d;
          taker = candidate;
        }
      }
      if (taker?.throwing?.anchor) taker = null; // already thrown
    }
    thrower = null;
    keeping = null;
    let onBall = null; // the snapshot's player on the ball in open play
    if (!stopped && !reset && from.phase === 'play' && after.phase === 'play' && after.ball.owner != null) {
      for (const player of after.players) if (player.id === after.ball.owner) onBall = player;
    }
    for (const player of after.players) {
      const actor = actors.get(player.id);
      if (!actor) continue;
      const old = previous.get(player.id) || player;
      // One placed rather than moved stays put until the drawn match reaches the snapshot
      // that places it, so a restart's placing is never drawn before its moment.
      const teleport = Math.hypot(player.x - old.x, player.y - old.y) > 8;
      const k = teleport ? 0 : blend;
      const { group, person } = actor;
      group.visible = true;
      group.position.set(mix(old.x, player.x, k), 0, -mix(old.y, player.y, k));
      actor.heading = angle(old.heading, player.heading, k);
      // The drawn velocity, between the snapshots either side of the drawn time: the
      // stride follows how the figure moves on screen, not the engine's heading.
      let vx = 0;
      let vy = 0;
      if (!stopped && !reset && !teleport && span > 0) {
        vx = (player.x - old.x) / span;
        vy = (player.y - old.y) / span;
      }
      if (teleport || reset) actor.vx = actor.vy = 0;
      actor.vx = mix(actor.vx, vx, settling);
      actor.vy = mix(actor.vy, vy, settling);
      actor.speed = stopped ? 0 : Math.hypot(actor.vx, actor.vy);
      actor.pace = Math.min(actor.speed / 6, 1);

      // A goalkeeper going for the ball faces where it comes from, whichever way the engine
      // has it running along its line, and dives across that facing.
      const bx = after.ball.x - player.x;
      const by = after.ball.y - player.y;
      if (bx * bx + by * by > 6.25) actor.faceYaw = Math.atan2(by, bx);
      if (stopped) actor.pose = actor.fading = actor.dive = actor.throwing = actor.holding = null;
      const pose = actor.pose;
      const diving = !stopped && Boolean(player.dive);
      if (diving && !actor.diving) actor.armed = true; // the snapshot first marks it diving
      if (!diving) actor.armed = false;
      actor.diving = diving;
      const guarding = diving || Boolean(actor.dive) || pose?.kind === 'save' || pose?.kind === 'catch';
      actor.guard = stopped ? 0 : mix(actor.guard, guarding ? 1 : 0, 1 - Math.exp(-step * (guarding ? 12 : 3)));
      actor.facing = angle(actor.heading, actor.faceYaw, actor.guard);
      if (actor.armed && !actor.dive) {
        const lateral = -vx * Math.sin(actor.facing) + vy * Math.cos(actor.facing);
        if (Math.abs(lateral) > DIVE_ACROSS) startDive(actor, lateral > 0 ? 'keeper_dive_L' : 'keeper_dive_R', time);
      }

      // The body meets the ball at the touch's moment of contact.
      const fading = actor.fading;
      if (fading && (time - fading.cut > FADE || time < fading.cut)) actor.fading = null;
      else if (fading) playPose(actor, fading, time, after, latest, step);
      if (pose && (pose.held ? time - pose.cut > FADE : time - pose.at > pose.end)) actor.pose = null;
      else if (pose) playPose(actor, pose, time, after, latest, step);
      if (actor.dive && !playTimed(actor, actor.dive, time)) actor.dive = null;
      // The throw-in's taker holds the ball until its throw, or lets go if play moves on.
      if (!actor.throwing && actor === taker) actor.throwing = timed(actor, 'throw_in', time, null, Math.max(0, person.clip('throw_in').contact - 0.15));
      if (actor.throwing && !actor.throwing.anchor && actor !== taker) actor.throwing = null;
      if (actor.throwing && !playTimed(actor, actor.throwing, time, true)) actor.throwing = null;
      if (actor.throwing) thrower = actor;
      // A goalkeeper that catches the ball holds it at its chest, over its steps, until it
      // lets go of it or winds up to kick it.
      const owns = !stopped && after.ball.owner === player.id;
      const current = actor.pose;
      if (owns && current?.kind === 'catch' && time >= current.at && current.cut === Infinity) {
        actor.holding = current;
        current.held = true;
      }
      if (actor.holding && (!owns || current !== actor.holding)) {
        actor.holding.cut = Math.min(actor.holding.cut, time); // it lets go: the catch fades out
        actor.holding = null;
      }
      if (actor.holding) keeping = actor;
      const since = now - actor.celebrateAt;
      const celebrate = person.clip('celebrate');
      if (celebrate && since >= 0) {
        const lasts = celebrate.loop ? CELEBRATION : celebrate.duration;
        if (since < lasts) {
          const at = celebrate.loop ? since % celebrate.duration : since;
          person.act('celebrate', at, envelope(since, 0, lasts, 0.2, 0.4), 'gesture');
        }
      }
      if (actor.speed > 1e-6) {
        actor.way = angle(actor.way, Math.atan2(actor.vy, actor.vx), 1 - Math.exp(-actor.speed * step / TURNING));
      }
      readSets(actor, player, onBall, after.players, now, time, !stopped && !reset && after.phase === 'play' && after.ball.owner == null);
      // When its boot is to meet the ball: a touch seen ahead, or for a sprinter chasing its
      // knock, when it will catch the ball up, at the speeds they are going.
      let touchIn = actor.strideAt > time ? actor.strideAt - time : 0;
      if (!(touchIn > 0) && actor.chasing && span > 0) {
        const c = Math.cos(actor.way);
        const sn = Math.sin(actor.way);
        const gap = (after.ball.x - player.x) * c + (after.ball.y - player.y) * sn - CATCH;
        const rolling = ((after.ball.x - from.ball.x) * c + (after.ball.y - from.ball.y) * sn) / span;
        const closing = actor.speed - rolling;
        if (gap > 0 && closing > 0.5) touchIn = gap / closing;
      }
      actor.sets.touchIn = touchIn;
      person.object.rotation.y = actor.facing + Math.PI / 2;
      person.update(step, actor.speed, actor.way - actor.facing, actor.sets);
    }

    // The ball as the engine sends it, through the point of each touch at its moment.
    const oldBall = from.ball;
    const newBall = after.ball;
    const ballTeleport = Math.hypot(newBall.x - oldBall.x, newBall.y - oldBall.y) > 10;
    let start = oldBall;
    let end = newBall;
    let f = ballTeleport ? 0 : blend; // a placed ball too: a goal's leaves the goalmouth at the goal
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
    let y = Math.max(DRAWN_RADIUS, height - BALL_RADIUS + DRAWN_RADIUS);
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
        // The boot meets the back of the ball at the touch, at the toe's reach in the stride
        // shown, and it runs on from there.
        let ahead = carrier.person.reach() + BALL_RADIUS
          + 0.14 * carrier.pace * (0.5 - 0.5 * Math.cos(2 * Math.PI * (carrier.person.phase - carrier.person.touch(TOUCH_PHASE))));
        if (kicking) {
          // Winding up a kick, it comes back to where the engine kicks it from, which is
          // where the kick clips meet it.
          const pose = holder.pose;
          const lead = -0.6 * pose.from;
          ahead = mix(ahead, DRIBBLE, lead > 1e-3 ? smooth(clamp((time - pose.at - pose.from) / lead, 0, 1)) : 1);
        }
        x = feet.x + Math.cos(carrier.facing) * ahead;
        z = feet.z - Math.sin(carrier.facing) * ahead;
        carrying = true;
      }
    }
    // A throw-in's taker holds the ball in its hands until it lets go, and a goalkeeper
    // the ball it has caught.
    const throwing = Boolean(thrower?.group.visible && thrower.throwing.clipTime < thrower.throwing.contact);
    const inHands = throwing || Boolean(keeping?.group.visible);
    if (inHands) {
      (throwing ? thrower : keeping).person.hands(hands);
      x = hands.x;
      y = hands.y;
      z = hands.z;
      carrying = true;
    }
    // How far the path moved since last frame's.
    const moved = Math.hypot(x - (ball.position.x - applied.x), y - (ball.position.y - applied.y), z - (ball.position.z - applied.z));
    const jump = !ballReady || reset || ballTeleport || moved > 3;
    const snapped = moved > 0.3 && moved > SNAP * (time - ballTime);
    ballTime = time;
    if (jump) settle.set(0, 0, 0);
    else if (carrying !== carried || inHands !== held || snapped) {
      settle.set(ball.position.x - x, ball.position.y - y, ball.position.z - z);
      settleAt = time;
      // Thrown, it leaves the hands slowly enough for its path to rise to meet it.
      settleFor = held && thrown && !inHands ? THROW_RELEASE : SETTLE;
    }
    carried = carrying;
    held = inHands;
    thrown = throwing;
    // The offset fades on the drawn match's clock, so a kicked ball leaves the boot along its path.
    applied.copy(settle).multiplyScalar(1 - smooth(clamp((time - settleAt) / settleFor, 0, 1)));
    x += applied.x;
    z += applied.z;
    const drawnY = Math.max(DRAWN_RADIUS, y + applied.y);
    // It rolls without slipping on the grass and keeps its spin in the air.
    if (!jump && step > 0) {
      travel.set(x - ball.position.x, 0, z - ball.position.z);
      const distance = travel.length();
      if (stopped || inHands) spinRate = 0;
      else if (height < BALL_RADIUS + 0.05) {
        if (distance > 1e-6) spinAxis.crossVectors(up, travel).normalize();
        spinRate = distance / DRAWN_RADIUS / step;
      } else spinRate *= Math.exp(-step * 0.5);
      if (spinRate > 0) shell.quaternion.premultiply(turn.setFromAxisAngle(spinAxis, spinRate * step));
    }
    ball.position.set(x, drawnY, z);
    ballShadow.position.set(x, 0.022, z);
    // A crisp dark spot under a ball on the grass, larger and fainter as it rises.
    const size = BALL_SHADOW + Math.min(drawnY, 10) * 0.03;
    ballShadow.scale.set(size, size, 1);
    ballShadow.material.opacity = 0.62 / (1 + (drawnY - DRAWN_RADIUS) * 0.35);
    ball.visible = ballShadow.visible = ballReady = true;
  }

  return {
    update,
    ballPosition: ball.position,
    getPlayerPosition(id) {
      const actor = actors.get(id);
      return actor?.group.visible ? actor.group.position : null;
    },
    // Writes a drawn player's ground velocity in the scene (m/s along x and z, y 0) into
    // `out` and returns it, or returns null when the player is not drawn.
    getPlayerVelocity(id, out) {
      const actor = actors.get(id);
      return actor?.group.visible ? out.set(actor.vx, 0, -actor.vy) : null;
    },
    // Shows the numbers above the players on the wide shot only: in the close-up and the
    // cutaways they would loom over the faces and hang over the background. Called once
    // the camera has chosen this frame's shot, so a cut never shows them for a frame.
    showNumbers(wide) {
      for (const actor of actors.values()) actor.badge.visible = wide;
    },
    // The way a drawn player's figure faces, as its yaw in the scene (0 faces +z, so its
    // direction is (sin y, 0, cos y)), or null when it is not drawn.
    getPlayerFacing(id) {
      const actor = actors.get(id);
      return actor?.group.visible ? actor.person.object.rotation.y : null;
    },
    // Calls `visit(id, position)` for every player drawn this frame, with its drawn feet
    // (read-only, and reused: copy it to keep it).
    forEachPlayerPosition(visit) {
      for (const [id, actor] of actors) if (actor.group.visible) visit(id, actor.group.position);
    },
    // A model player's decision (a `decision` message), which colours what its figure shows
    // for a moment: the kick it plays, or shielding the ball. Bots send none.
    handleDecision(message, now) {
      const actor = actors.get(message.player);
      if (!actor || typeof message.action !== 'string') return;
      actor.decision = message.action;
      actor.decidedAt = now;
    },
    // An event left behind by a stall (`late`) still says who takes the next throw-in,
    // but its celebration has passed.
    handleEvent(event, now, late = false) {
      if (event.kind === 'throw_in') throwTeam = event.team ?? null;
      if (event.kind !== 'goal' || late) return;
      for (const actor of actors.values()) {
        if (actor.team === event.team) actor.celebrateAt = now;
      }
    },
    // What a player's figure shows and which way it faces, for tests and debugging.
    inspect(id) {
      const actor = actors.get(id);
      return actor && { ...actor.person.state(), facing: actor.facing, scale: actor.person.scale, visible: actor.group.visible, context: { ...actor.sets } };
    },
    dispose() {
      root.removeFromParent();
      made.dispose();
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      actors.clear();
      previous.clear();
      seen.clear();
      lastTouch = null;
    },
  };
}

// A ball of `radius` with the classic twelve dark pentagons, as vertex colours on one
// mesh: a face is dark when its centre is near one of an icosahedron's vertices.
function ballGeometry(radius) {
  const result = new THREE.IcosahedronGeometry(radius, 5);
  const position = result.attributes.position;
  const colours = new Float32Array(position.count * 3);
  const corners = new THREE.IcosahedronGeometry(1, 0).attributes.position;
  const centres = [];
  for (let i = 0; i < corners.count; i++) {
    const corner = new THREE.Vector3().fromBufferAttribute(corners, i).normalize();
    if (!centres.some(c => c.distanceTo(corner) < 1e-6)) centres.push(corner);
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  // The white is brighter than white, so the shell stays bright on its shaded side while
  // the panels stay dark (an emissive would grey them).
  const white = new THREE.Color('#fbfbf4').multiplyScalar(1.6);
  const dark = new THREE.Color('#141b24');
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    const centre = a.add(b).add(c).normalize();
    const panel = centres.some(corner => corner.dot(centre) > Math.cos(0.33));
    const shade = panel ? dark : white;
    for (let j = 0; j < 3; j++) shade.toArray(colours, (i + j) * 3);
  }
  result.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return result;
}
