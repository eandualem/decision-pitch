import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../../src/decision_pitch/web/vendor/three/three.module.js';

const source = readFileSync(new URL('../../src/decision_pitch/web/src/players.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export function', 'function');

function setup() {
  const document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  const context = { THREE, document };
  vm.createContext(context);
  vm.runInContext(source, context);
  const scene = new THREE.Scene();
  const actors = context.createPlayers(scene, [{
    colours: { shirt: '#123456', shorts: '#ffffff', keeper: '#ffcc00' },
    players: [{ id: 1, number: 1, position: 'GK' }],
  }]);
  const body = scene.children[0].children[0].children[1];
  const limbs = body.children.filter(child => child.isGroup);
  return {
    actors, body, limbs,
    frame(phase, now, action = 'move') {
      const snapshot = {
        phase, t: 1, period: 1,
        players: [{ id: 1, x: 0, y: 0, heading: 0, speed: 6, action }],
        ball: { x: 0, y: 0, z: 0.11 },
      };
      actors.update(snapshot, snapshot, 1, 0.1, now);
    },
  };
}

for (const phase of ['half_time', 'full_time']) {
  test(`${phase} suppresses retained locomotion and preserves stride for resumed play`, () => {
    const player = setup();
    const reference = setup();
    try {
      player.frame('play', 1);
      reference.frame('play', 1);
      assert.ok(Math.abs(player.limbs[0].rotation.x) > 0.1, 'running before whistle');
      for (const now of [1.1, 1.2, 1.3, 1.4]) {
        player.frame(phase, now);
        for (const limb of player.limbs) assert.ok(limb.rotation.x === 0, 'no running swing');
        assert.equal(player.body.position.y, 0, 'no running bounce');
      }
      player.frame('play', 2);
      reference.frame('play', 2);
      assert.equal(player.limbs[0].rotation.x, reference.limbs[0].rotation.x, 'stride did not advance while stopped');
      assert.equal(player.body.position.y, reference.body.position.y);
      assert.ok(Math.abs(player.limbs[0].rotation.x) > 0.01, 'running resumes');
    } finally {
      player.actors.dispose();
      reference.actors.dispose();
    }
  });

  test(`${phase} retains intentional celebration but suppresses stale kick commands`, () => {
    const player = setup();
    try {
      player.frame('play', 1, 'kick');
      player.frame(phase, 1.1, 'kick');
      assert.ok(player.limbs[1].rotation.x === 0, 'in-progress kick stops at whistle');
      player.actors.handleEvent({ kind: 'goal', team: 0 }, 1.1);
      player.frame(phase, 1.2, 'kick');
      assert.ok(player.body.position.y > 0, 'goal bounce remains intentional');
      assert.ok(Math.abs(player.limbs[2].rotation.z) > 2, 'celebration arms raised');
      for (const limb of player.limbs) assert.ok(limb.rotation.x === 0);
      player.frame(phase, 6, 'kick');
      assert.equal(player.body.position.y, 0, 'celebration expires to a standing pose');
    } finally {
      player.actors.dispose();
    }
  });
}
