import * as THREE from 'three';

const CLOSE = 3.8; // s on the scorer after a goal
const CUTAWAY = 2.5; // s on a manager, only while the ball is dead
const RESTART_GAP = 45; // s at least between touchline shots at ordinary restarts
// Restarts long enough for a reaction shot; a throw-in is usually taken within 1.5 s.
const RESTARTS = new Set(['goal_kick', 'corner', 'free_kick']);

// Presentation only: follow the rendered ball, never predict match outcomes.
export function createCamera(camera, pitch) {
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const closeup = new THREE.Vector3();
  let closeUntil = -Infinity;
  let scorer = null;
  let closeActors = null;
  // The wide shot stays on the match; managers are seen in short reaction shots while
  // the ball is dead: after the scorer at a goal, at a card or a substitution, and now
  // and then at a restart. One at a time; it cuts in and out, and play restarting ends it.
  let cutTeam = null;
  let cutFrom = Infinity;
  let cutUntil = -Infinity;
  let cutTouchline = null;
  let cutting = false;
  let lastCut = -Infinity;
  let nextRestartTeam = 0;
  let initialized = false;

  function cutaway(team, from, touchline) {
    if (!touchline || team === null || team === undefined) return;
    cutTeam = team;
    cutFrom = from;
    cutUntil = from + CUTAWAY;
    cutTouchline = touchline;
  }

  return {
    handleEvent(event, now, actors, touchline) {
      if (event.kind === 'goal') {
        scorer = event.player;
        closeActors = actors;
        closeup.copy(actors.getPlayerPosition(scorer) ?? actors.ballPosition);
        closeUntil = now + CLOSE;
        cutaway(event.team, closeUntil, touchline);
      } else if (now < closeUntil || now < cutUntil) {
        // A shot is already on or due.
      } else if (event.kind === 'yellow' || event.kind === 'red' || event.kind === 'substitution') {
        cutaway(event.team, now, touchline);
      } else if (RESTARTS.has(event.kind) && now - lastCut >= RESTART_GAP && touchline) {
        cutaway(nextRestartTeam, now, touchline);
        nextRestartTeam = 1 - nextRestartTeam;
      }
    },
    update(ballPosition, dt, now, phase) {
      const portrait = Math.max(1, 1 / Math.max(0.35, camera.aspect));
      // Play restarting ends a reaction shot, or skips one due after it restarted.
      if (now >= cutFrom && now < cutUntil && (!phase || phase === 'play')) cutUntil = -Infinity;
      const manager = now >= cutFrom && now < cutUntil ? cutTouchline.getManagerPosition(cutTeam) : null;
      if (now < closeUntil) {
        const playerPosition = closeActors?.getPlayerPosition(scorer);
        if (playerPosition) closeup.copy(playerPosition);
        look.copy(closeup);
        look.y = 1;
        desired.set(closeup.x + 10 * portrait, 12 * portrait, closeup.z + 20 * portrait);
      } else if (manager) {
        // From the pitch, outside the manager, looking in across both technical areas.
        const outside = manager.x < 0 ? -1 : 1;
        look.set(manager.x, 1.3, manager.z);
        desired.set(manager.x + outside * 4.5 * portrait, 3.4, manager.z - 10.5 * portrait);
      } else {
        look.set(THREE.MathUtils.clamp(ballPosition.x * 0.65, -pitch.length * 0.32, pitch.length * 0.32), 0,
          THREE.MathUtils.clamp(ballPosition.z * 0.34, -pitch.width * 0.2, pitch.width * 0.2));
        desired.set(look.x, 53 * portrait, look.z + 64 * portrait);
      }
      const cut = !initialized || cutting !== (manager !== null);
      if (manager && !cutting) lastCut = now;
      cutting = manager !== null;
      const blend = cut ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * (cutting ? 4 : 2.4));
      camera.position.lerp(desired, blend);
      target.lerp(look, blend);
      camera.lookAt(target);
      initialized = true;
    },
    dispose() {
      closeActors = cutTouchline = null;
    },
  };
}
