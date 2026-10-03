import { MODE_COUNT, type WingDataset, type WingManifest } from "../types";

const BUFFER_NAMES = ["positions", "uvs", "triangles", "displacements"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validate untrusted metadata before allocating or using any GPU resources. */
export function validateManifest(value: unknown): WingManifest {
  const fail = (): never => { throw new Error("The wing dataset metadata is invalid or unsupported."); };
  if (!record(value) || value.schemaVersion !== 1 || value.modeCount !== MODE_COUNT) return fail();
  const { vertexCount, triangleCount, model, modes, rootVertices, buffers } = value;
  if (!positive(vertexCount) || !Number.isInteger(vertexCount) || vertexCount > 2_000_000 ||
      !positive(triangleCount) || !Number.isInteger(triangleCount) || triangleCount > 4_000_000 ||
      !record(model) || typeof model.name !== "string" || !positive(model.semispanM) ||
      !Array.isArray(modes) || modes.length !== MODE_COUNT ||
      !Array.isArray(rootVertices) || rootVertices.length < 3 || !record(buffers)) return fail();
  let previousFrequency = 0;
  for (const [index, mode] of modes.entries()) {
    if (!record(mode) || mode.index !== index + 1 || !positive(mode.frequencyHz) ||
        mode.frequencyHz < previousFrequency || ![0, 1, 2].includes(mode.colorComponent as number) ||
        !positive(mode.colorMax) || !positive(mode.displayAmplitudeM)) return fail();
    previousFrequency = mode.frequencyHz;
  }
  if (new Set(rootVertices).size !== rootVertices.length || rootVertices.some((index) =>
    !Number.isInteger(index) || index < 0 || index >= vertexCount)) return fail();
  const lengths = { positions: vertexCount * 3, uvs: vertexCount * 2,
    triangles: triangleCount * 3, displacements: MODE_COUNT * vertexCount * 3 };
  for (const key of BUFFER_NAMES) {
    const buffer = buffers[key];
    if (!record(buffer) || typeof buffer.url !== "string" || !/^[a-zA-Z0-9_.-]+\.bin$/.test(buffer.url) ||
        typeof buffer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(buffer.sha256) ||
        buffer.length !== lengths[key]) return fail();
  }
  return value as unknown as WingManifest;
}

export function validateDataset(data: WingDataset): void {
  for (const key of ["positions", "uvs", "displacements"] as const) {
    if (data[key].length !== data.manifest.buffers[key].length || data[key].some((value) => !Number.isFinite(value))) {
      throw new Error(`The wing ${key} buffer contains invalid values.`);
    }
  }
  if (data.triangles.length !== data.manifest.triangleCount * 3 ||
      data.triangles.some((index) => index >= data.manifest.vertexCount)) {
    throw new Error("The wing surface connectivity is invalid.");
  }
  const stride = data.manifest.vertexCount * 3;
  for (let mode = 0; mode < MODE_COUNT; mode += 1) {
    for (const root of data.manifest.rootVertices) {
      const offset = mode * stride + root * 3;
      if (data.displacements[offset] !== 0 || data.displacements[offset + 1] !== 0 || data.displacements[offset + 2] !== 0) {
        throw new Error("The wing dataset does not satisfy the fixed-root condition.");
      }
    }
  }
}

export async function loadWingDataset(url: string, signal?: AbortSignal): Promise<WingDataset> {
  const options = signal ? { signal } : {};
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Could not load the wing model (${response.status}). Check your connection and retry.`);
  let metadata: unknown;
  try {
    metadata = await response.json();
  } catch {
    throw new Error("The wing model metadata could not be read. Retry to download a complete copy.");
  }
  const manifest = validateManifest(metadata);
  if (!globalThis.crypto?.subtle) throw new Error("Dataset verification requires HTTPS or a local development server.");
  const base = new URL(url, document.baseURI);
  const arrays = await Promise.all(BUFFER_NAMES.map(async (name) => {
    const descriptor = manifest.buffers[name];
    const binaryResponse = await fetch(new URL(descriptor.url, base), options);
    if (!binaryResponse.ok) throw new Error(`Could not load the wing ${name} (${binaryResponse.status}). Retry to download the complete model.`);
    const buffer = await binaryResponse.arrayBuffer();
    if (buffer.byteLength !== descriptor.length * 4) throw new Error(`The wing ${name} download is incomplete.`);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (checksum !== descriptor.sha256) throw new Error(`The wing ${name} checksum does not match. Retry to download a verified copy.`);
    return buffer;
  }));
  const data: WingDataset = { manifest, positions: new Float32Array(arrays[0]!), uvs: new Float32Array(arrays[1]!),
    triangles: new Uint32Array(arrays[2]!), displacements: new Float32Array(arrays[3]!) };
  validateDataset(data);
  return data;
}
