import * as THREE from 'three';

// The pitch's grass and painted lines (docs/decisions.md, section 6, "Real grass and the
// stands behind the goals"). All dimensions are metres; the pitch lies in the scene's x
// (length) and z (width), with y up.
export const SURROUND = 8; // m of grass beyond the lines, out to the advertising wall
export const LINE_TEXEL = 0.05; // m per texel of the markings' distance field
export const LINE_RANGE = 0.5; // m of distance it holds either side of a painted edge
const LINE = 0.06; // m: half the width of a line
const AREA_LINE = 0.05; // m: half the width of a technical area's dashes
const SPOT = 0.11; // m: the radius of the centre and penalty marks
const TILE = 512; // texels across the one-metre turf tile
const STRIPES = 20; // mowing bands across the pitch
const STRIPE_SHADE = 0.17; // how much lighter or darker a band looks along its lean
// The turf's depth near the camera: how deep it is, the steps a view ray is traced down it
// in, and the distances from the camera over which the depth fades out.
export const DEPTH = { depth: 0.03, steps: 8, fade: [4, 10] };
const PAINT = 0xf2f4ec;
const WORN = 0x6c6943;

// The painted markings as segments [x1, z1, x2, z2, half width], arcs [x, z, radius, start
// angle, end angle, half width] and spots [x, z, radius]: the pitch's own and a dashed box
// round each technical area, from a metre off the touchline to `back`.
export function markings(pitch, areas = []) {
  const hl = pitch.length / 2;
  const hw = pitch.width / 2;
  const segments = [];
  const arcs = [];
  const spots = [[0, 0, SPOT]];
  const segment = (x1, z1, x2, z2, half = LINE) => segments.push([x1, z1, x2, z2, half]);
  segment(-hl, -hw, hl, -hw);
  segment(hl, -hw, hl, hw);
  segment(hl, hw, -hl, hw);
  segment(-hl, hw, -hl, -hw);
  segment(0, -hw, 0, hw);
  arcs.push([0, 0, 9.15, 0, Math.PI * 2, LINE]);
  const penaltyArc = Math.acos(5.5 / 9.15);
  for (const side of [-1, 1]) {
    for (const [depth, halfWidth] of [[16.5, 20.16], [5.5, 9.16]]) {
      const x = side * (hl - depth);
      segment(side * hl, -halfWidth, x, -halfWidth);
      segment(x, -halfWidth, x, halfWidth);
      segment(x, halfWidth, side * hl, halfWidth);
    }
    const spotX = side * (hl - 11);
    spots.push([spotX, 0, SPOT]);
    const angle = side === -1 ? 0 : Math.PI;
    arcs.push([spotX, 0, 9.15, angle - penaltyArc, angle + penaltyArc, LINE]);
    for (const end of [-1, 1]) {
      const start = side === -1 ? (end === -1 ? 0 : -Math.PI / 2)
        : (end === -1 ? Math.PI / 2 : Math.PI);
      arcs.push([side * hl, end * hw, 1, start, start + Math.PI / 2, LINE]);
    }
  }
  for (const { minX, maxX, back } of areas) {
    const front = hw + 1;
    const left = minX - 0.5;
    const right = maxX + 0.5;
    for (let x = left; x < right; x += 0.85) segment(x, front, Math.min(x + 0.5, right), front, AREA_LINE);
    for (const x of [left, right]) {
      for (let z = front; z < back; z += 0.85) segment(x, z, x, Math.min(z + 0.5, back), AREA_LINE);
    }
  }
  return { segments, arcs, spots };
}

// Math.hypot is several times slower than this, and these run for every texel near a line.
const length = (x, z) => Math.sqrt(x * x + z * z);

// The distance from a segment's or an arc's painted edge. Their arrays are read by index,
// not destructured, for the same reason.
function segmentDistance(x, z, s) {
  const dx = s[2] - s[0];
  const dz = s[3] - s[1];
  const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / (dx * dx + dz * dz || 1)));
  return length(x - s[0] - dx * t, z - s[1] - dz * t) - s[4];
}

function arcDistance(x, z, a) {
  const turn = Math.PI * 2;
  const along = ((Math.atan2(z - a[1], x - a[0]) - a[3]) % turn + turn) % turn;
  if (along <= a[4] - a[3]) return Math.abs(length(x - a[0], z - a[1]) - a[2]) - a[5];
  return Math.min(
    length(x - a[0] - a[2] * Math.cos(a[3]), z - a[1] - a[2] * Math.sin(a[3])),
    length(x - a[0] - a[2] * Math.cos(a[4]), z - a[1] - a[2] * Math.sin(a[4])),
  ) - a[5];
}

// The markings as a distance field over the grass: for each texel, its signed distance from
// the nearest painted edge (negative on paint), clamped to ±LINE_RANGE and stored in a byte,
// 0 at -LINE_RANGE and 255 at +LINE_RANGE. Row j, column i is the texel centred at
// x = -halfX + (i + 0.5) * texel, z = -halfZ + (j + 0.5) * texel.
export function lineField(pitch, marks, texel = LINE_TEXEL) {
  const halfX = pitch.length / 2 + SURROUND;
  const halfZ = pitch.width / 2 + SURROUND;
  const width = Math.ceil(2 * halfX / texel);
  const height = Math.ceil(2 * halfZ / texel);
  const data = new Uint8Array(width * height).fill(255);
  const reach = LINE_RANGE;
  // Each texel of rows minZ to maxZ, within reach, from minX to maxX, or within `spans(z)`
  // ([from, to] x ranges) where it is given.
  function put(minX, minZ, maxX, maxZ, distance, spans = () => [[minX, maxX]]) {
    const j0 = Math.max(0, Math.floor((minZ - reach + halfZ) / texel));
    const j1 = Math.min(height - 1, Math.ceil((maxZ + reach + halfZ) / texel));
    for (let j = j0; j <= j1; j++) {
      const z = -halfZ + (j + 0.5) * texel;
      for (const [from, to] of spans(z)) {
        const i0 = Math.max(0, Math.floor((from - reach + halfX) / texel));
        const i1 = Math.min(width - 1, Math.ceil((to + reach + halfX) / texel));
        for (let i = i0; i <= i1; i++) {
          const d = distance(-halfX + (i + 0.5) * texel, z);
          if (d >= reach) continue;
          const value = Math.round((Math.max(d, -reach) / reach * 0.5 + 0.5) * 255);
          const k = j * width + i;
          if (value < data[k]) data[k] = value;
        }
      }
    }
  }
  for (const s of marks.segments) {
    put(Math.min(s[0], s[2]) - s[4], Math.min(s[1], s[3]) - s[4],
      Math.max(s[0], s[2]) + s[4], Math.max(s[1], s[3]) + s[4], (x, z) => segmentDistance(x, z, s));
  }
  // An arc only near its circle: on each row, the two runs of the ring within reach of it.
  for (const a of marks.arcs) {
    const [cx, cz, radius, , , half] = a;
    const outer = radius + half + reach;
    const inner = Math.max(0, radius - half - reach);
    const ring = (z) => {
      const dz = Math.abs(z - cz);
      if (dz >= outer) return [];
      const far = Math.sqrt(outer * outer - dz * dz);
      const near = dz < inner ? Math.sqrt(inner * inner - dz * dz) : 0;
      return [[cx - far + reach, cx - near - reach], [cx + near + reach, cx + far - reach]];
    };
    put(cx - outer, cz - outer, cx + outer, cz + outer, (x, z) => arcDistance(x, z, a), ring);
  }
  for (const [cx, cz, radius] of marks.spots) {
    put(cx - radius, cz - radius, cx + radius, cz + radius, (x, z) => length(x - cx, z - cz) - radius);
  }
  return { data, width, height, halfX, halfZ, texel };
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth value noise over a `size` square that wraps at its edges, from `cells` random values
// across: a function of texel coordinates, from 0 to 1.
function wrappingNoise(size, cells, rand) {
  const values = Array.from({ length: cells * cells }, rand);
  const at = (i, j) => values[((j + cells) % cells) * cells + (i + cells) % cells];
  const ease = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const u = x / size * cells;
    const v = y / size * cells;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = ease(u - i);
    const fv = ease(v - j);
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fu;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fu;
    return top + (bottom - top) * fv;
  };
}

// A square metre of turf seen from above, which tiles: short blades in many shades of green
// over darker thatch, in clumps of slightly different colour and height. `colour` is RGBA
// (sRGB colour, the height of the turf in alpha, 0 to 1 of its depth) and `normal` its
// slopes, x in red and z in green, up in blue.
export function turfTile(size = TILE, seed = 11) {
  const rand = random(seed);
  const clump = wrappingNoise(size, 8, rand);
  const tone = wrappingNoise(size, 3, rand);
  const colour = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const shade = 0.75 + 0.5 * rand();
    colour[k * 4] = 40 * shade;
    colour[k * 4 + 1] = 47 * shade;
    colour[k * 4 + 2] = 25 * shade;
  }
  const blades = Math.round(size * size / 3);
  for (let n = 0; n < blades; n++) {
    const x0 = rand() * size;
    const y0 = rand() * size;
    const c = clump(x0, y0);
    const t = tone(x0, y0);
    const tall = (0.5 + 0.5 * rand()) * (0.7 + 0.3 * c);
    const reach = 2 + rand() * 5; // texels from root to tip, seen from above
    const angle = rand() * Math.PI * 2;
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach;
    const green = 78 + 50 * rand();
    const red = green * (0.46 + 0.12 * t + 0.08 * rand());
    const blue = green * (0.3 + 0.12 * rand());
    const steps = Math.ceil(reach);
    for (let s = 0; s <= steps; s++) {
      const along = s / steps;
      const x = ((Math.round(x0 + dx * along) % size) + size) % size;
      const y = ((Math.round(y0 + dy * along) % size) + size) % size;
      const k = y * size + x;
      const h = tall * (0.6 + 0.4 * along); // the root is lower than the tip
      if (h <= heights[k]) continue;
      heights[k] = h;
      const light = 0.62 + 0.38 * along;
      colour[k * 4] = Math.min(255, red * light);
      colour[k * 4 + 1] = Math.min(255, green * light);
      colour[k * 4 + 2] = Math.min(255, blue * light);
    }
  }
  const normal = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size);
  const h = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
  const steep = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      height[k] = colour[k * 4 + 3] = Math.round(heights[k] * 255);
      const nx = -(h(x + 1, y) - h(x - 1, y)) * steep;
      const nz = -(h(x, y + 1) - h(x, y - 1)) * steep;
      const norm = Math.sqrt(nx * nx + nz * nz + 1);
      normal[k * 4] = Math.round((nx / norm * 0.5 + 0.5) * 255);
      normal[k * 4 + 1] = Math.round((nz / norm * 0.5 + 0.5) * 255);
      normal[k * 4 + 2] = Math.round((1 / norm * 0.5 + 0.5) * 255);
      normal[k * 4 + 3] = 255;
    }
  }
  return { colour, height, normal, size };
}

// Low-frequency variation for the turf's colour over tens of metres, which tiles.
export function variation(size = 128, seed = 5) {
  const rand = random(seed);
  const broad = wrappingNoise(size, 4, rand);
  const fine = wrappingNoise(size, 13, rand);
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[y * size + x] = Math.round((0.65 * broad(x, y) + 0.35 * fine(x, y)) * 255);
  }
  return { data, size };
}

const GLSL = /* glsl */ `
uniform sampler2D grassTile;
uniform sampler2D grassHeight; // the tile's heights alone, for tracing the turf's depth
uniform sampler2D grassNormal;
uniform sampler2D grassVariation;
uniform sampler2D grassLines;
uniform vec4 grassLinesRect; // x and z of the field's corner, and 1 / its size in each
uniform vec4 grassStripes; // x of the first band's edge, band width, shade, normal tilt
uniform vec2 grassHalf; // half the pitch's length and width
uniform vec3 grassPaint;
uniform vec3 grassWorn;
uniform vec2 grassFade; // the distances from the camera over which the turf's depth fades
varying vec3 vGrass;
// +1 where the band's blades lean towards +z, -1 towards -z, eased across a band's edge.
float grassLean(float x) {
  float w = fract((x - grassStripes.x) / (2.0 * grassStripes.y));
  float edge = 0.15 / (2.0 * grassStripes.y);
  return 2.0 * (smoothstep(0.0, edge, w) - smoothstep(0.5, 0.5 + edge, w)) - 1.0;
}
`;

const SURFACE = /* glsl */ `
vec2 gp = vGrass.xz;
vec2 gDx = dFdx(gp);
vec2 gDy = dFdy(gp);
float gLean = grassLean(gp.x);
// Near the camera, the view ray is traced down through the blades' heights to the first one
// it meets (parallax occlusion): blades hide those behind them, the bands' blades lean, and
// deeper in the turf is in shade. The depth fades out with distance.
float gNear = 1.0 - smoothstep(grassFade.x, grassFade.y, length(vGrass - cameraPosition));
vec2 gShift = vec2(0.0);
float gSink = 0.0; // how far down the turf the ray meets a blade: 0 at the tips, 1 at the roots
if (gNear > 0.0) {
  vec3 gRay = normalize(vGrass - cameraPosition);
  vec2 gRun = gRay.xz / max(-gRay.y, 0.1) * ${DEPTH.depth.toFixed(3)} * gNear;
  vec2 gTip = vec2(0.0, gLean * 0.008 * gNear); // the tips lean with the band
  // One level of detail for the whole trace, from the pixel's footprint on the tile.
  float gLod = log2(max(max(length(gDx), length(gDy)) * ${TILE.toFixed(1)}, 1.0));
  float gAbove = 1.0; // how far the ray was above the blades at the step before
  gSink = 1.0;
  gShift = gRun;
  for (int i = 1; i <= ${DEPTH.steps}; i++) {
    float level = float(i) / ${DEPTH.steps.toFixed(1)};
    vec2 q = gRun * level + gTip * (1.0 - level);
    float above = (1.0 - level) - textureLod(grassHeight, gp + q, gLod).r;
    if (above <= 0.0) {
      // Between the two steps, where the ray crosses the blades.
      float back = above / (above - gAbove) / ${DEPTH.steps.toFixed(1)};
      gSink = level - back;
      gShift = gRun * gSink + gTip * (1.0 - gSink);
      break;
    }
    gAbove = above;
  }
}
vec4 gA = textureGrad(grassTile, gp + gShift, gDx, gDy);
vec4 gB = texture2D(grassTile, mat2(0.8, 0.6, -0.6, 0.8) * gp * 0.37 + 0.31);
float gBroad = texture2D(grassVariation, gp / 41.0).r;
float gPatch = texture2D(grassVariation, gp / 9.3 + 0.17).r;
vec3 gAlbedo = mix(gA.rgb, gB.rgb, 0.3) * (0.86 + 0.28 * gBroad);
gAlbedo *= mix(vec3(1.0), vec3(1.07, 1.02, 0.85), smoothstep(0.45, 0.8, gPatch));
// Light wear in the goalmouths, on the penalty marks and the centre spot.
float gWear = 0.4 * exp(-dot(gp, gp) / 2.0);
for (int s = 0; s < 2; s++) {
  float side = float(s) * 2.0 - 1.0;
  vec2 g = (gp - vec2(side * (grassHalf.x - 3.0), 0.0)) / vec2(3.2, 5.0);
  vec2 k = (gp - vec2(side * (grassHalf.x - 0.7), 0.0)) / vec2(0.9, 3.4);
  vec2 m = (gp - vec2(side * (grassHalf.x - 11.0), 0.0)) / 1.1;
  gWear += exp(-dot(g, g)) + 0.7 * exp(-dot(k, k)) + 0.6 * exp(-dot(m, m));
}
gWear = clamp(gWear * smoothstep(0.35, 0.85, 0.6 * gPatch + 0.5 * gB.a), 0.0, 1.0) * 0.32;
gAlbedo = mix(gAlbedo, grassWorn * (0.75 + 0.5 * gB.a), gWear);
// Mowing stripes: lighter looking the way a band's blades lean, darker looking into them.
vec3 gView = normalize(vGrass - cameraPosition);
gAlbedo *= 1.0 + grassStripes.z * gLean * gView.z;
// Paint, from the distance field: the share of the pixel's footprint across a line that the
// line covers, so a far line thins and fades instead of breaking up; mottled by the blades.
// The footprint is measured along the field's gradient: a distance's own screen derivatives
// vanish where two pixels straddle a line's centre. The field has no mipmaps, so it is read
// at its full size.
vec2 gLuv = (gp - grassLinesRect.xy) * grassLinesRect.zw;
float gRaw = textureLod(grassLines, gLuv, 0.0).r;
float gDist = (gRaw - 0.5) * 2.0 * ${LINE_RANGE.toFixed(2)};
float gPaint = 0.0;
if (gDist < ${(LINE_RANGE - 0.02).toFixed(2)}) {
  vec2 gTexel = 1.0 / vec2(textureSize(grassLines, 0));
  vec2 gGrad = vec2(textureLod(grassLines, gLuv + vec2(gTexel.x, 0.0), 0.0).r,
    textureLod(grassLines, gLuv + vec2(0.0, gTexel.y), 0.0).r) - gRaw;
  float gFoot = dot(gGrad, gGrad) > 1e-10
    ? abs(dot(normalize(gGrad), gDx)) + abs(dot(normalize(gGrad), gDy)) : max(length(gDx), length(gDy));
  gFoot = max(gFoot, 0.002);
  float gCentre = max(gDist + ${LINE.toFixed(2)}, 0.0);
  gPaint = clamp((min(gCentre + gFoot * 0.5, ${LINE.toFixed(2)}) - max(gCentre - gFoot * 0.5, -${LINE.toFixed(2)})) / gFoot, 0.0, 1.0);
}
gAlbedo = mix(gAlbedo, grassPaint * (0.8 + 0.2 * gA.a), gPaint * 0.94);
vec3 gN = textureGrad(grassNormal, gp + gShift, gDx, gDy).xzy * 2.0 - 1.0;
gN = normalize(mix(gN, vec3(0.0, 1.0, 0.0), 0.35 + 0.4 * gPaint) + vec3(0.0, 0.0, grassStripes.w * gLean));
gAlbedo *= 1.0 - 0.5 * gSink * gNear;
diffuseColor.rgb = gAlbedo;
`;

function grassMaterial(uniforms) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGrass = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      .replace('#include <map_fragment>', SURFACE)
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);');
  };
  material.customProgramCacheKey = () => 'grass';
  return material;
}

// Generated once and kept for the next match: the turf, its variation and each pitch's lines.
let tile;
let broad;
const fields = new Map();

// A distance field is sampled without mipmaps: averaged, its distances no longer hold.
function texture(data, width, height, format, { srgb = false, wrap = true, anisotropy = 1, mipmaps = true } = {}) {
  const value = new THREE.DataTexture(data, width, height, format, THREE.UnsignedByteType);
  value.wrapS = value.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  value.magFilter = THREE.LinearFilter;
  value.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  value.generateMipmaps = mipmaps;
  value.unpackAlignment = 1;
  value.anisotropy = anisotropy;
  if (srgb) value.colorSpace = THREE.SRGBColorSpace;
  value.needsUpdate = true;
  return value;
}

// The grass and its lines, added to `root`. `areas` are the technical areas' dashed boxes
// (see `markings`).
export function createGrass(root, renderer, pitch, areas) {
  tile ??= turfTile();
  broad ??= variation();
  const key = `${pitch.length}x${pitch.width}`;
  if (!fields.has(key)) fields.set(key, lineField(pitch, markings(pitch, areas)));
  const field = fields.get(key);
  const anisotropy = Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
  const textures = [
    texture(tile.colour, tile.size, tile.size, THREE.RGBAFormat, { srgb: true, anisotropy }),
    texture(tile.normal, tile.size, tile.size, THREE.RGBAFormat, { anisotropy }),
    texture(broad.data, broad.size, broad.size, THREE.RedFormat),
    texture(field.data, field.width, field.height, THREE.RedFormat, { wrap: false, mipmaps: false }),
    texture(tile.height, tile.size, tile.size, THREE.RedFormat),
  ];
  const material = grassMaterial({
    grassTile: { value: textures[0] },
    grassNormal: { value: textures[1] },
    grassVariation: { value: textures[2] },
    grassLines: { value: textures[3] },
    grassHeight: { value: textures[4] },
    grassLinesRect: { value: new THREE.Vector4(-field.halfX, -field.halfZ,
      1 / (field.width * field.texel), 1 / (field.height * field.texel)) },
    grassStripes: { value: new THREE.Vector4(-pitch.length / 2, pitch.length / STRIPES, STRIPE_SHADE, 0.06) },
    grassHalf: { value: new THREE.Vector2(pitch.length / 2, pitch.width / 2) },
    grassPaint: { value: new THREE.Color(PAINT) },
    grassWorn: { value: new THREE.Color(WORN) },
    grassFade: { value: new THREE.Vector2(...DEPTH.fade) },
  });
  const plane = new THREE.PlaneGeometry(2 * field.halfX, 2 * field.halfZ);
  plane.rotateX(-Math.PI / 2);
  const turf = new THREE.Mesh(plane, material);
  turf.name = 'turf';
  turf.receiveShadow = true;
  root.add(turf);
  return {
    dispose() {
      root.remove(turf);
      plane.dispose();
      material.dispose();
      textures.forEach((value) => value.dispose());
    },
  };
}
