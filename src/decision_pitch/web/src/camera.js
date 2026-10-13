import * as THREE from 'three';

// Presentation only: follow the rendered ball, never predict match outcomes.
export function createCamera(camera, pitch) {
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const closeup = new THREE.Vector3();
  let closeUntil = -Infinity;
  let scorer = null;
  let closeActors = null;
  let initialized = false;
  return {
    handleEvent(event, now, actors) {
      if (event.kind !== 'goal') return;
      scorer = event.player;
      closeActors = actors;
      closeup.copy(actors.getPlayerPosition(scorer) ?? actors.ballPosition);
      closeUntil = now + 3.8;
    },
    update(ballPosition, dt, now) {
      const portrait = Math.max(1, 1 / Math.max(0.35, camera.aspect));
      if (now < closeUntil) {
        const playerPosition = closeActors?.getPlayerPosition(scorer);
        if (playerPosition) closeup.copy(playerPosition);
        look.copy(closeup);
        look.y = 1;
        desired.set(closeup.x + 10 * portrait, 12 * portrait, closeup.z + 20 * portrait);
      } else {
        look.set(THREE.MathUtils.clamp(ballPosition.x * 0.65, -pitch.length * 0.32, pitch.length * 0.32), 0,
          THREE.MathUtils.clamp(ballPosition.z * 0.34, -pitch.width * 0.2, pitch.width * 0.2));
        desired.set(look.x, 53 * portrait, look.z + 64 * portrait);
      }
      const blend = initialized ? 1 - Math.exp(-Math.min(dt, 0.1) * 2.4) : 1;
      camera.position.lerp(desired, blend);
      target.lerp(look, blend);
      camera.lookAt(target);
      initialized = true;
    },
    dispose() {},
  };
}
