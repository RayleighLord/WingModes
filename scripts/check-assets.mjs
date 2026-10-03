import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const directory = new URL("../public/data/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("wing.json", directory), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.modeCount, 24);
assert.equal(manifest.modes.length, 24);
const n = manifest.vertexCount;
const t = manifest.triangleCount;
assert.ok(Number.isSafeInteger(n) && n > 0);
assert.ok(Number.isSafeInteger(t) && t > 0);
const arrays = {};
for (const [name, length] of Object.entries({
  positions: 3 * n,
  uvs: 2 * n,
  triangles: 3 * t,
  displacements: 24 * 3 * n
})) {
  const description = manifest.buffers[name];
  assert.match(description.url, /^[a-zA-Z0-9_.-]+\.bin$/);
  assert.equal(description.length, length, `${name}: incorrect scalar count`);
  const bytes = await readFile(new URL(description.url, directory));
  assert.equal(bytes.byteLength, length * 4, `${name}: incorrect byte count`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), description.sha256,
    `${name}: checksum mismatch`);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  arrays[name] = name === "triangles" ? new Uint32Array(buffer) : new Float32Array(buffer);
  assert.ok(arrays[name].every(Number.isFinite), `${name}: non-finite data`);
}
const { positions, triangles, displacements } = arrays;
assert.ok(triangles.every(index => index < n));
assert.ok(Array.isArray(manifest.rootVertices) && manifest.rootVertices.length > 0);
for (const vertex of manifest.rootVertices) {
  assert.ok(Number.isSafeInteger(vertex) && vertex >= 0 && vertex < n);
}

function normal(a, b, c, offset, factor) {
  const ab = [0, 1, 2].map(k => positions[3 * b + k] - positions[3 * a + k]
    + factor * (displacements[offset + 3 * b + k] - displacements[offset + 3 * a + k]));
  const ac = [0, 1, 2].map(k => positions[3 * c + k] - positions[3 * a + k]
    + factor * (displacements[offset + 3 * c + k] - displacements[offset + 3 * a + k]));
  return [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
}

let previousFrequency = 0;
for (let mode = 0; mode < 24; mode += 1) {
  const metadata = manifest.modes[mode];
  assert.equal(metadata.index, mode + 1);
  assert.ok(Number.isFinite(metadata.frequencyHz) && metadata.frequencyHz > 0);
  assert.ok(metadata.frequencyHz >= previousFrequency);
  previousFrequency = metadata.frequencyHz;
  assert.ok([0, 1, 2].includes(metadata.colorComponent));
  assert.ok(Number.isFinite(metadata.colorMax) && metadata.colorMax > 0);
  assert.ok(Number.isFinite(metadata.displayAmplitudeM) && metadata.displayAmplitudeM > 0);
  const offset = mode * n * 3;
  let maximumNorm = 0;
  let maximumColor = 0;
  for (let vertex = 0; vertex < n; vertex += 1) {
    maximumNorm = Math.max(maximumNorm, Math.hypot(...displacements.subarray(offset + 3 * vertex, offset + 3 * vertex + 3)));
    maximumColor = Math.max(maximumColor, Math.abs(displacements[offset + 3 * vertex + metadata.colorComponent]));
  }
  assert.ok(Math.abs(maximumNorm - 1) < 2e-6, `Mode ${mode + 1}: invalid normalization`);
  assert.ok(Math.abs(maximumColor - metadata.colorMax) < 2e-6);
  for (const vertex of manifest.rootVertices) {
    for (let k = 0; k < 3; k += 1) assert.equal(displacements[offset + vertex * 3 + k], 0);
  }
  for (let triangle = 0; triangle < t; triangle += 1) {
    const [a, b, c] = triangles.subarray(3 * triangle, 3 * triangle + 3);
    const rest = normal(a, b, c, offset, 0);
    const restArea = rest.reduce((sum, value) => sum + value * value, 0);
    assert.ok(restArea > 0, `Degenerate triangle ${triangle}`);
    for (const phase of [-1, -0.5, 0.5, 1]) {
      const deformed = normal(a, b, c, offset, phase * metadata.displayAmplitudeM);
      const orientation = deformed.reduce((sum, value, k) => sum + value * rest[k], 0);
      assert.ok(Number.isFinite(orientation) && orientation > 0,
        `Mode ${mode + 1}: flipped triangle ${triangle}`);
    }
  }
}
console.log(`Verified ${n} vertices, ${t} triangles and all 24 modal assets: checksums, frequencies, normalization, fixed root and deformation geometry.`);
