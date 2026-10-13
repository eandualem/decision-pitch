import * as THREE from 'three';

// Bodies face local +z. Match headings turn anticlockwise from match +x.
const mix = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

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
      actors.set(player.id, {
        group, body, limbs, team: teamIndex, stride: index * 0.8,
        celebrateUntil: -Infinity, kickAt: -Infinity, kicking: false,
      });
    });
  });

  // Faceted white shell and dark pentagonal panels use only procedural geometry.
  const ball = new THREE.Group();
  root.add(ball);
  const shell = mesh(geometry(new THREE.IcosahedronGeometry(0.3, 2)), paint('#fff9df'), ball, 0, 0, 0);
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

  function update(before, after, alpha, dt, now) {
    if (!after) return;
    const from = before || after;
    if (previousSnapshot !== from) {
      previous.clear();
      for (const player of from.players) previous.set(player.id, player);
      previousSnapshot = from;
    }
    const reset = from.period !== after.period || from.phase !== after.phase || after.t < from.t;
    const blend = reset ? 1 : THREE.MathUtils.clamp(alpha, 0, 1);
    const step = THREE.MathUtils.clamp(dt, 0, 0.1);
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
      body.rotation.y = angle(old.heading, player.heading, k) + Math.PI / 2;
      const speed = Math.max(0, mix(old.speed, player.speed, k));
      actor.stride += speed * step * 2.7;
      const swing = Math.sin(actor.stride) * Math.min(speed / 6, 1) * 0.7;
      const celebrating = now < actor.celebrateUntil;
      const kicking = player.action === 'kick' && Math.hypot(player.x - after.ball.x, player.y - after.ball.y) < 2.5;
      if (kicking && !actor.kicking) actor.kickAt = now;
      actor.kicking = kicking;
      const kickAge = now - actor.kickAt;
      const kick = kickAge >= 0 && kickAge < 0.4 ? Math.sin(kickAge / 0.4 * Math.PI) * 1.3 : 0;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing - kick;
      limbs[2].rotation.x = -swing * 0.7;
      limbs[3].rotation.x = swing * 0.7;
      limbs[2].rotation.z = celebrating ? -2.55 : -0.13;
      limbs[3].rotation.z = celebrating ? 2.55 : 0.13;
      body.position.y = celebrating ? Math.abs(Math.sin(now * 7)) * 0.3 : Math.abs(Math.sin(actor.stride)) * Math.min(speed / 6, 1) * 0.06;
    }
    const oldBall = from.ball;
    const newBall = after.ball;
    const ballTeleport = Math.hypot(newBall.x - oldBall.x, newBall.y - oldBall.y) > 10;
    const k = ballTeleport ? 1 : blend;
    const x = mix(oldBall.x, newBall.x, k);
    const y = Math.max(0.3, mix(oldBall.z, newBall.z, k));
    const z = -mix(oldBall.y, newBall.y, k);
    if (ballReady && !reset && !ballTeleport) {
      shell.rotation.z -= (x - ball.position.x) / 0.3;
      shell.rotation.x += (z - ball.position.z) / 0.3;
    }
    ball.position.set(x, y, z);
    ballShadow.position.set(x, 0.027, z);
    const size = 0.4 + Math.min(y, 10) * 0.035;
    ballShadow.scale.set(size, size, 1);
    ballShadow.material.opacity = 0.3 / (1 + y * 0.18);
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
    },
  };
}
