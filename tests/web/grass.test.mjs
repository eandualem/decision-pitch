// Run with node --test tests/web/grass.test.mjs; no npm dependencies required.
import './three-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { LINE_RANGE, SURROUND, lineField, markings, turfTile } = await import('../../src/decision_pitch/web/src/grass.js');

const pitch = { length: 105, width: 68 };
const areas = [{ minX: -12.5, maxX: -3.5, back: 37.8 }, { minX: 3.5, maxX: 12.5, back: 37.8 }];
const field = lineField(pitch, markings(pitch, areas));

// The stored distance from the nearest painted edge at a texel, in metres, and the texel's
// centre.
function texel(x, z) {
  const i = Math.floor((x + field.halfX) / field.texel);
  const j = Math.floor((z + field.halfZ) / field.texel);
  return {
    distance: (field.data[j * field.width + i] / 255 - 0.5) * 2 * LINE_RANGE,
    x: -field.halfX + (i + 0.5) * field.texel,
    z: -field.halfZ + (j + 0.5) * field.texel,
  };
}
const distance = (x, z) => texel(x, z).distance;

test('the distance field covers the grass out to the advertising wall', () => {
  assert.equal(field.halfX, 52.5 + SURROUND);
  assert.equal(field.halfZ, 34 + SURROUND);
  assert.equal(field.data.length, field.width * field.height);
});

test('lines, arcs and spots are painted, and the grass between them is not', () => {
  for (const [x, z] of [[0, 10], [52.5, 5], [-30, -34], [9.15, 0.6], [0, 0], [41.5, 0], [-36, 7.3]]) {
    assert.ok(distance(x, z) < 0, `paint at ${x}, ${z}`);
  }
  for (const [x, z] of [[20, 10], [5, 5], [41.5, 1], [45, 0]]) {
    assert.ok(distance(x, z) >= LINE_RANGE - 0.01, `grass at ${x}, ${z}`);
  }
  // The penalty arc is drawn only outside the penalty area.
  assert.ok(distance(-52.5 + 11 - 9.15, 0.03) >= LINE_RANGE - 0.01);
  // Each technical area's front line is dashed.
  const dashes = [-12.75, -12.45, -12.15, -11.85, -11.55, -11.25].map((x) => distance(x, 35) < 0);
  assert.ok(dashes.includes(true) && dashes.includes(false));
});

test('each texel holds its distance from the nearest painted edge', () => {
  for (const z of [33.8, 33.97, 34.04, 34.2, 34.35]) {
    const at = texel(10, z);
    assert.ok(Math.abs(at.distance - (Math.abs(at.z - 34) - 0.06)) < 0.004, `beside the touchline at ${z}`);
  }
});

test('the turf tile wraps and keeps each blade height with its colour', () => {
  const tile = turfTile(64, 3);
  assert.equal(tile.colour.length, 64 * 64 * 4);
  for (let k = 0; k < 64 * 64; k++) assert.equal(tile.colour[k * 4 + 3], tile.height[k]);
  assert.ok(tile.height.some((h) => h === 0) && tile.height.some((h) => h > 200), 'thatch and tall blades');
  assert.deepEqual(turfTile(64, 3).colour, tile.colour, 'the same seed makes the same turf');
});
