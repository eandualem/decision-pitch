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
const VIEW = Math.tan(THREE.MathUtils.degToRad(20)); // half the camera's vertical field of view
// The wide shot, like a broadcast main camera: from the stand, looking down at play at a
// shallow angle through a longer lens than the close-ups', so the players are seen from the
// side and stand out as people, and the ball, at its real size, reads as a ball, while the
// frame still shows a stretch of pitch around it. It follows part of the ball's way and
// settles gently, so the ball moves within the frame rather than the frame rushing after it.
const WIDE = {
  fov: 20, // deg, vertical
  down: 22, // deg below the horizontal to the point it looks at
  distance: 72, // m from that point
  follow: [0.75, 0.5], // share of the ball's x and z the look point follows
  reach: [0.42, 0.35], // and how far it goes, as a share of the pitch's length and width
  rate: 2.4, // 1/s: how quickly it settles on play (twice over, see below)
};
// A fast ball (a long pass, a switch of play) is led a little along its way, so the receiver
// comes into view early, and the shot pulls back a little while it travels.
const LEAD = 0.15; // s of the ball's velocity the look point runs ahead by
const LEAD_MAX = 6; // m
const PULL = { from: 12, to: 25, by: 0.3 }; // m/s of ball speed, and how much further back at the top
// However gently it follows, the look point keeps the ball this far inside the frame on the
// ground: m to either side, towards the camera and away from it. The frame narrows towards
// the camera, so the side margin shrinks by `narrow` m for each metre the ball is nearer.
const SAFE = { side: 15, narrow: 0.3, near: 12, far: 30 };
const TELEPORT = 50; // m/s: faster than any kick, so the ball was placed, not moved

// Presentation only: follow the rendered ball, never predict match outcomes.
export function createCamera(camera, pitch) {
  const baseFov = camera.fov; // the close-ups' and cutaways' field of view
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
  let cutting = false;
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
      // The ball's way over the ground, ignoring a ball placed for a restart. A slow frame
      // still moves the camera its full way, so it keeps up with play at a low frame rate.
      const step = Math.min(dt, 0.5);
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
        look.copy(closeup);
        look.y = 1;
        desired.set(closeup.x + 10 * portrait, 12 * portrait, closeup.z + 20 * portrait);
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
          THREE.MathUtils.clamp((ballPosition.x + lead.x) * WIDE.follow[0], -pitch.length * WIDE.reach[0], pitch.length * WIDE.reach[0]),
          0,
          THREE.MathUtils.clamp((ballPosition.z + lead.z) * WIDE.follow[1], -pitch.width * WIDE.reach[1], pitch.width * WIDE.reach[1]),
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
      const wide = now >= closeUntil && first === null;
      wasWide = wide;
      const onManagers = now >= closeUntil && first !== null;
      const cut = !initialized || cutting !== onManagers;
      cutting = onManagers;
      const blend = cut ? 1 : 1 - Math.exp(-step * (cutting ? 4 : WIDE.rate));
      camera.position.lerp(desired, blend);
      target.lerp(look, blend);
      const fov = camera.fov + ((wide ? WIDE.fov : baseFov) - camera.fov) * blend;
      if (Math.abs(fov - camera.fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.lookAt(target);
      initialized = true;
    },
    dispose() {
      closeActors = null;
      shot = request = null;
    },
  };
}
