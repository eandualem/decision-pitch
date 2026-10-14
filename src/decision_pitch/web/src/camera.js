import * as THREE from 'three';

const CLOSE = 3.8; // s on the scorer after a goal
const CUTAWAY = 2.5; // s on a manager
const FINAL = 4; // s on the managers at the final whistle
const START_WITHIN = 0.6; // s for the drawn match to reach the stoppage a shot is for
const RESTART_GAP = 25; // s at least between touchline shots at ordinary restarts
// Restarts that get a shot now and then; a throw-in is usually taken within 1.5 s.
const RESTARTS = new Set(['goal_kick', 'corner', 'free_kick']);
// Drawn dead-ball phases a shot may show in: never open play, nor a throw-in's moment.
const DEAD = new Set(['kickoff', 'goal_kick', 'corner', 'free_kick', 'penalty', 'half_time', 'full_time']);
// Stoppages still long enough for a shot that a manager's message starts mid-way.
const LONG = new Set(['kickoff', 'goal_kick', 'corner', 'half_time', 'full_time']);
// A shot asked for replaces one on screen or waiting only if it ranks higher.
const RANK = { restart: 0, manager: 1, personal: 1, period: 2, goal: 3 };
const LENS = 40; // deg: the vertical field of view of the close-ups and the manager shots
const VIEW = Math.tan(THREE.MathUtils.degToRad(LENS / 2));
// The wide shot, like a broadcast main camera: from the stand, looking down at play at a
// shallow angle through a longer lens than the close-ups', so the players are seen from the
// side and stand out as people, and the ball, at its real size, reads as a ball, while the
// frame still shows about 50 m of pitch around it. It follows most of the ball's way, and
// leads it, so the ball sits near the middle of the frame, and settles gently.
const WIDE = {
  fov: 22, // deg, vertical
  down: 22, // deg below the horizontal to the point it looks at
  distance: 72, // m from that point
  follow: [0.85, 0.55], // share of the ball's x and z the look point follows
  reach: [0.42, 0.35], // and how far it goes, as a share of the pitch's length and width
  rate: 2, // 1/s: how quickly it settles on play (twice over, see below)
};
// The frame runs ahead of the ball the way it is going, so a pass's receiver comes into view
// early and the ball stays near the middle; the shot pulls back a little for a fast ball.
const LEAD = 0.4; // s of the ball's velocity the look point runs ahead by
const LEAD_MAX = 10; // m
const PULL = { from: 12, to: 25, by: 0.3 }; // m/s of ball speed, and how much further back at the top
// However gently it follows, the look point keeps the ball this far inside the frame on the
// ground: m to either side, towards the camera and away from it. The frame narrows towards
// the camera, so the side margin shrinks by `narrow` m for each metre the ball is nearer.
const SAFE = { side: 15, narrow: 0.3, near: 12, far: 30 };
const TELEPORT = 50; // m/s: faster than any kick, so the ball was placed, not moved
// The scorer's close-up: near and a little low, through a longer lens, so the scorer stands
// about half the frame's height while it celebrates. Like a broadcast's cut to a close
// camera, it cuts in a little further out and eases in, follows the scorer, and cuts away
// when it ends.
const CLOSE_UP = {
  fov: 30, // deg, vertical
  distance: 7, // m from the scorer, over the ground
  height: 1.35, // m: a little below the scorer's eyes
  aim: 1.15, // m: the height it looks at
  from: 1.4, // starts this many times further out
  easeIn: 0.9, // s to come in to its distance
  follow: 4, // 1/s: how quickly it follows the scorer (leading its run, so it keeps its distance)
  turn: 1.5, // rad/s it may swing round the scorer when its side gets blocked, the way that is clear
  ahead: [0.4, 0.9], // s ahead it checks its side is still clear, as it moves with the scorer
  lift: 1.5, // m it rises to pass over the heads, and raised arms, of anyone who still comes too near
};
// What the close-up keeps clear of, in m: other players, the line of sight to the scorer,
// and the goal frame and net. It stays over the pitch and its surround, never behind a goal.
const CLEAR = { player: 1.2, sight: 0.5, goal: 0.6 };
const AZIMUTHS = 24; // sides tried round the scorer

// Presentation only: follow the rendered ball, never predict match outcomes.
export function createCamera(camera, pitch) {
  const wideDown = THREE.MathUtils.degToRad(WIDE.down);
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const closeup = new THREE.Vector3();
  const lastBall = new THREE.Vector3();
  const moved = new THREE.Vector3();
  const velocity = new THREE.Vector3(); // the drawn ball's, smoothed, along the ground
  const lead = new THREE.Vector3();
  const aim = new THREE.Vector3(); // the wide shot's look point, smoothed once before the camera follows it
  let pull = 0;
  let closeUntil = -Infinity;
  let scorer = null;
  let closeActors = null;
  let closeStart = 0;
  const closeFollow = new THREE.Vector3(); // the scorer, smoothed
  const lastScorer = new THREE.Vector3();
  const scorerVelocity = new THREE.Vector3();
  const scorerAhead = new THREE.Vector3();
  const closeSide = new THREE.Vector3(0, 0, 1); // from the scorer towards the camera
  const others = []; // the other players' positions this frame
  const probe = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const later = new THREE.Vector3();
  const tryDir = new THREE.Vector3();
  const tryArc = new THREE.Vector3();
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const halfLength = pitch.length / 2;
  const halfWidth = pitch.width / 2;
  const goalWidth = pitch.goalWidth ?? 7.32;
  const goalHeight = pitch.goalHeight ?? 2.44;
  const goals = [-1, 1].map(side => new THREE.Box3(
    new THREE.Vector3(side > 0 ? halfLength - CLEAR.goal : -halfLength - 2.2 - CLEAR.goal, 0, -goalWidth / 2 - CLEAR.goal),
    new THREE.Vector3(side > 0 ? halfLength + 2.2 + CLEAR.goal : -halfLength + CLEAR.goal, goalHeight + CLEAR.goal, goalWidth / 2 + CLEAR.goal),
  ));

  function gather(actors, id) {
    others.length = 0;
    actors?.forEachPlayerPosition?.((other, position) => { if (other !== id) others.push(position); });
  }

  // Whether the close-up camera, `distance` from `centre` along `dir`, is clear of the
  // stands, the goals and the other players, and sees the scorer past the goal frame.
  function clearAt(centre, dir, distance, room = CLEAR.player, velocity = null) {
    if (velocity) {
      for (const seconds of CLOSE_UP.ahead) {
        if (!clearAt(later.copy(centre).addScaledVector(velocity, seconds), dir, distance, room)) return false;
      }
    }
    probe.copy(centre).addScaledVector(dir, distance);
    probe.y = CLOSE_UP.height;
    if (Math.abs(probe.x) > halfLength + 4 || Math.abs(probe.z) > halfWidth + 1) return false;
    if (Math.abs(probe.x) > halfLength - 0.3 && Math.abs(probe.z) < goalWidth / 2 + 2) return false;
    chest.copy(centre);
    chest.y = CLOSE_UP.aim;
    const length = probe.distanceTo(chest);
    ray.set(probe, chest.clone().sub(probe).normalize());
    for (const goal of goals) {
      if (goal.containsPoint(probe)) return false;
      if (ray.intersectBox(goal, hit) && hit.distanceTo(probe) < length) return false;
    }
    for (const other of others) {
      if (Math.hypot(other.x - probe.x, other.z - probe.z) < room) return false;
    }
    return true;
  }

  // How good a side is: the broadcast camera's side of the scorer, looking out from the
  // pitch, with no one walking between the camera and the scorer.
  function sideScore(centre, dir, distance, velocity = null) {
    let score = dir.z + 0.5 * -dir.x * Math.sign(centre.x || 1);
    const ax = centre.x + dir.x * distance;
    const az = centre.z + dir.z * distance;
    for (const other of others) {
      // Room round the camera, now and where it is heading with the scorer.
      for (const seconds of [0, ...(velocity ? CLOSE_UP.ahead : [])]) {
        const d = Math.hypot(other.x - (ax + (velocity?.x ?? 0) * seconds), other.z - (az + (velocity?.z ?? 0) * seconds));
        if (d < 3) score -= (3 - d) / 3;
      }
      // Distance from the other player to the line of sight, over the ground.
      const vx = centre.x - ax;
      const vz = centre.z - az;
      const along = THREE.MathUtils.clamp(((other.x - ax) * vx + (other.z - az) * vz) / (vx * vx + vz * vz), 0.05, 0.9);
      if (Math.hypot(other.x - (ax + vx * along), other.z - (az + vz * along)) < CLEAR.sight) score -= 2;
    }
    return score;
  }

  // Whether someone stands between the camera, `distance` along `dir`, and the scorer.
  function sightBlocked(centre, dir, distance) {
    const ax = centre.x + dir.x * distance;
    const az = centre.z + dir.z * distance;
    const vx = centre.x - ax;
    const vz = centre.z - az;
    for (const other of others) {
      const along = ((other.x - ax) * vx + (other.z - az) * vz) / (vx * vx + vz * vz);
      if (along > 0.05 && along < 0.9 && Math.hypot(other.x - (ax + vx * along), other.z - (az + vz * along)) < CLEAR.sight) return true;
    }
    return false;
  }

  // Whether swinging `delta` round the scorer from the side at `from` passes clear of everyone.
  function arcClear(centre, from, delta, distance) {
    const steps = Math.ceil(Math.abs(delta) / 0.2);
    for (let i = 1; i <= steps; i++) {
      const angle = from + (delta * i) / steps;
      tryArc.set(Math.sin(angle), 0, Math.cos(angle));
      if (!clearAt(centre, tryArc, distance, CLEAR.player * 0.6)) return false;
    }
    return true;
  }

  // The clear side with the best view, `out` set to its direction; false if none is clear.
  function pickSide(centre, out, velocity = null) {
    for (const [room, ahead] of [[CLEAR.player, velocity], [CLEAR.player, null], [CLEAR.player * 0.6, null]]) {
      let best = -Infinity;
      for (let i = 0; i < AZIMUTHS; i++) {
        const angle = (i / AZIMUTHS) * Math.PI * 2;
        tryDir.set(Math.sin(angle), 0, Math.cos(angle));
        if (!clearAt(centre, tryDir, CLOSE_UP.distance, room, ahead) || !clearAt(centre, tryDir, CLOSE_UP.distance * CLOSE_UP.from, room)) continue;
        const score = sideScore(centre, tryDir, CLOSE_UP.distance, velocity);
        if (score > best) {
          best = score;
          out.copy(tryDir);
        }
      }
      if (best > -Infinity) return true;
    }
    return false;
  }

  // The wide shot stays on the match. The managers are seen in short shots while the
  // drawn ball is dead: after the scorer at a goal, at a card, a substitution, a
  // manager's message, the whistles and now and then a restart. A shot asked for waits
  // until the drawn match reaches its stoppage, and is dropped if it does not; once on,
  // it ends when the drawn play restarts. It cuts in and out.
  let request = null;
  let shot = null;
  let lastShot = -Infinity;
  let nextRestartTeam = 0;
  let drawnPhase = null;
  let shown = 'wide'; // the shot on screen: wide, close or managers
  let wasWide = false;
  let initialized = false;

  function ask(kind, now, touchline, { team = null, both = false, from = now, seconds = CUTAWAY } = {}) {
    if (!touchline || (!both && kind !== 'restart' && (team === null || team === undefined))) return;
    const busy = Math.max(shot ? RANK[shot.kind] : -1, request ? RANK[request.kind] : -1);
    if (kind !== 'goal' && (now < closeUntil || RANK[kind] <= busy)) return;
    request = { kind, team, both, from, seconds, touchline };
  }

  function start(now) {
    let team = request.team;
    if (request.kind === 'restart') {
      team = nextRestartTeam;
      nextRestartTeam = 1 - nextRestartTeam;
    }
    shot = { kind: request.kind, team, both: request.both, until: now + request.seconds, touchline: request.touchline };
    lastShot = now;
    request = null;
  }

  return {
    handleEvent(event, now, actors, touchline) {
      if (event.kind === 'goal') {
        scorer = event.player;
        closeActors = actors;
        closeup.copy(actors.getPlayerPosition(scorer) ?? actors.ballPosition);
        closeUntil = now + CLOSE;
        closeStart = now;
        closeFollow.copy(closeup);
        lastScorer.copy(closeup);
        scorerVelocity.set(0, 0, 0);
        gather(actors, scorer);
        if (!pickSide(closeFollow, closeSide)) closeSide.set(0, 0, 1);
        shot = request = null;
        ask('goal', now, touchline, { team: event.team, from: closeUntil });
      } else if (event.kind === 'yellow' || event.kind === 'red' || event.kind === 'substitution') {
        ask('personal', now, touchline, { team: event.team });
      } else if (RESTARTS.has(event.kind) && now - lastShot >= RESTART_GAP) {
        ask('restart', now, touchline);
      } else if (event.kind === 'half_time') {
        ask('period', now, touchline, { both: true });
      } else if (event.kind === 'full_time') {
        const [home, away] = event.score ?? [0, 0];
        const winner = home > away ? 0 : away > home ? 1 : null;
        ask('period', now, touchline, { team: winner, both: winner === null, seconds: FINAL });
      }
    },
    // A manager's instruction or substitution request, as it arrives.
    handleMessage(message, now, touchline) {
      if (message.type === 'manager' && LONG.has(drawnPhase)) ask('manager', now, touchline, { team: message.team });
    },
    // `drawn` is the drawn snapshot's phase, or the snapshot itself.
    update(ballPosition, dt, now, drawn) {
      const phase = typeof drawn === 'string' ? drawn : drawn?.phase;
      drawnPhase = phase;
      if (shot && (now >= shot.until || !DEAD.has(phase))) shot = null;
      if (request && now >= request.from) {
        if (DEAD.has(phase)) start(now);
        else if (phase === 'throw_in' || now > request.from + START_WITHIN) request = null;
      }
      const portrait = Math.max(1, 1 / Math.max(0.35, camera.aspect));
      // The ball's way over the ground, ignoring a ball placed for a restart.
      const step = Math.min(dt, 0.1);
      if (initialized && step > 0) {
        moved.subVectors(ballPosition, lastBall).setY(0).divideScalar(step);
        if (moved.length() > TELEPORT) velocity.set(0, 0, 0);
        else velocity.lerp(moved, 1 - Math.exp(-step * 3));
      }
      lastBall.copy(ballPosition);
      const fast = THREE.MathUtils.clamp((velocity.length() - PULL.from) / (PULL.to - PULL.from), 0, 1);
      pull += (fast - pull) * (1 - Math.exp(-step * (fast > pull ? 2 : 0.8)));
      const first = shot?.touchline.getManagerPosition(shot.both ? 0 : shot.team) ?? null;
      const second = shot?.both ? shot.touchline.getManagerPosition(1) : null;
      if (now < closeUntil) {
        const playerPosition = closeActors?.getPlayerPosition(scorer);
        if (playerPosition) closeup.copy(playerPosition);
        if (step > 0) {
          moved.subVectors(closeup, lastScorer).setY(0).divideScalar(step);
          if (moved.length() > 12) scorerVelocity.set(0, 0, 0); // placed, not run
          else scorerVelocity.lerp(moved, 1 - Math.exp(-step * CLOSE_UP.follow));
        }
        lastScorer.copy(closeup);
        // Follow where the scorer is heading over the smoothing's lag, so a running scorer
        // stays as near as a standing one.
        scorerAhead.copy(closeup).addScaledVector(scorerVelocity, 1 / CLOSE_UP.follow);
        closeFollow.lerp(scorerAhead, 1 - Math.exp(-step * CLOSE_UP.follow));
        gather(closeActors, scorer);
        const ease = THREE.MathUtils.smoothstep((now - closeStart) / CLOSE_UP.easeIn, 0, 1);
        const distance = CLOSE_UP.distance * (CLOSE_UP.from + (1 - CLOSE_UP.from) * ease);
        // Swing round the scorer, not through anyone, if its side becomes blocked now or
        // where the camera is heading, or someone walks into the line of sight.
        const blocked = !clearAt(closeFollow, closeSide, distance, CLEAR.player, scorerVelocity) || sightBlocked(closeFollow, closeSide, distance);
        if (blocked && pickSide(closeFollow, tryDir, scorerVelocity)) {
          const from = Math.atan2(closeSide.x, closeSide.z);
          let delta = Math.atan2(Math.sin(Math.atan2(tryDir.x, tryDir.z) - from), Math.cos(Math.atan2(tryDir.x, tryDir.z) - from));
          // Round the other way if the short way passes anyone.
          const long = delta - Math.sign(delta) * Math.PI * 2;
          if (!arcClear(closeFollow, from, delta, distance) && arcClear(closeFollow, from, long, distance)) delta = long;
          const angle = from + THREE.MathUtils.clamp(delta, -CLOSE_UP.turn * step, CLOSE_UP.turn * step);
          closeSide.set(Math.sin(angle), 0, Math.cos(angle));
        }
        look.copy(closeFollow);
        look.y = CLOSE_UP.aim;
        desired.copy(closeFollow).addScaledVector(closeSide, distance);
        let nearest = Infinity;
        for (const other of others) nearest = Math.min(nearest, Math.hypot(other.x - desired.x, other.z - desired.z));
        desired.y = CLOSE_UP.height + CLOSE_UP.lift * (1 - THREE.MathUtils.smoothstep(nearest, 0.6, CLEAR.player));
      } else if (first && second) {
        // Both managers, from the pitch, far enough back to frame the two areas.
        const x = (first.x + second.x) / 2;
        const distance = Math.max(9, (Math.abs(first.x - second.x) / 2 + 3) / (VIEW * camera.aspect));
        look.set(x, 1.3, first.z);
        desired.set(x, 3.8, first.z - distance);
      } else if (first) {
        // From the pitch, outside the manager, looking in across both technical areas.
        const outside = first.x < 0 ? -1 : 1;
        look.set(first.x, 1.3, first.z);
        desired.set(first.x + outside * 4.5 * portrait, 3.4, first.z - 10.5 * portrait);
      } else {
        lead.copy(velocity).multiplyScalar(LEAD);
        if (lead.length() > LEAD_MAX) lead.setLength(LEAD_MAX);
        look.set(
          THREE.MathUtils.clamp(ballPosition.x * WIDE.follow[0], -pitch.length * WIDE.reach[0], pitch.length * WIDE.reach[0]) + lead.x,
          0,
          THREE.MathUtils.clamp(ballPosition.z * WIDE.follow[1], -pitch.width * WIDE.reach[1], pitch.width * WIDE.reach[1]) + lead.z,
        );
        look.z = THREE.MathUtils.clamp(look.z, ballPosition.z - SAFE.near * portrait, ballPosition.z + SAFE.far * portrait);
        const side = SAFE.side - SAFE.narrow * Math.max(0, ballPosition.z - look.z);
        look.x = THREE.MathUtils.clamp(look.x, ballPosition.x - side, ballPosition.x + side);
        // Smoothed twice over (here and by the camera's own follow), the frame eases into a
        // pan and out of it rather than starting at full speed.
        if (!initialized || !wasWide) aim.copy(look);
        else aim.lerp(look, 1 - Math.exp(-step * WIDE.rate));
        look.copy(aim);
        const away = WIDE.distance * portrait * (1 + PULL.by * pull);
        desired.set(look.x, Math.sin(wideDown) * away, look.z + Math.cos(wideDown) * away);
      }
      const mode = now < closeUntil ? 'close' : first !== null ? 'managers' : 'wide';
      const wide = mode === 'wide';
      wasWide = wide;
      // Shots cut from one to another; the close-up, smoothed already, is followed exactly.
      const cut = !initialized || mode !== shown;
      shown = mode;
      const blend = cut || mode === 'close' ? 1 : 1 - Math.exp(-step * (mode === 'managers' ? 4 : WIDE.rate));
      camera.position.lerp(desired, blend);
      target.lerp(look, blend);
      const fov = camera.fov + ((wide ? WIDE.fov : mode === 'close' ? CLOSE_UP.fov : LENS) - camera.fov) * blend;
      if (Math.abs(fov - camera.fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.lookAt(target);
      initialized = true;
    },
    dispose() {
      // The page keeps its camera for the next match: hand it back with its own lens.
      camera.fov = LENS;
      camera.updateProjectionMatrix();
      closeActors = null;
      shot = request = null;
    },
  };
}
