import * as THREE from 'three';

// Each team's manager in its technical area. Presentation only: it reacts to the
// messages and events the page already receives and never changes the match.
export function createTouchline(scene, teams, pitch) {
  const root = new THREE.Group();
  root.name = 'touchline';
  scene.add(root);
  return {
    update(ballPosition, dt, now, actors) {},
    handleEvent(event, now) {},
    handleMessage(message, now) {},
    dispose() { root.removeFromParent(); },
  };
}
