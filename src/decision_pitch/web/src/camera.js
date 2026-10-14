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

// Presentation only: follow the rendered ball, never predict match outcomes.
export function createCamera(camera, pitch) {
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const closeup = new THREE.Vector3();
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
        look.set(THREE.MathUtils.clamp(ballPosition.x * 0.65, -pitch.length * 0.32, pitch.length * 0.32), 0,
          THREE.MathUtils.clamp(ballPosition.z * 0.34, -pitch.width * 0.2, pitch.width * 0.2));
        desired.set(look.x, 53 * portrait, look.z + 64 * portrait);
      }
      const onManagers = now >= closeUntil && first !== null;
      const cut = !initialized || cutting !== onManagers;
      cutting = onManagers;
      const blend = cut ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * (cutting ? 4 : 2.4));
      camera.position.lerp(desired, blend);
      target.lerp(look, blend);
      camera.lookAt(target);
      initialized = true;
    },
    dispose() {
      closeActors = null;
      shot = request = null;
    },
  };
}
