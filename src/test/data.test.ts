import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import { loadWingDataset, validateDataset, validateManifest } from "../data/wing";
import type { WingDataset, WingManifest } from "../types";

function fixture(): WingDataset {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 1, 0.5]);
  const uvs = new Float32Array(8);
  const triangles = new Uint32Array([0, 1, 3, 1, 2, 3]);
  const displacements = new Float32Array(24 * 12);
  for (let i = 0; i < 24; i += 1) displacements[i * 12 + 11] = 1;
  const arrays = { positions, uvs, triangles, displacements };
  const buffers = Object.fromEntries(Object.entries(arrays).map(([name, values]) => [name, {
    url: `${name}.bin`, length: values.length, sha256: createHash("sha256").update(new Uint8Array(values.buffer)).digest("hex")
  }])) as WingManifest["buffers"];
  const manifest: WingManifest = {
    schemaVersion: 1, vertexCount: 4, triangleCount: 2, modeCount: 24,
    model: { name: "Test wing", semispanM: 6 }, rootVertices: [0, 1, 2], buffers,
    modes: Array.from({ length: 24 }, (_, i) => ({ index: i + 1, frequencyHz: i + 2, colorComponent: 2, colorMax: 1, displayAmplitudeM: 0.1 }))
  };
  return { manifest, ...arrays };
}

afterEach(() => vi.unstubAllGlobals());

describe("versioned numerical dataset", () => {
  it("accepts a complete finite dataset with a stationary root", () => {
    const data = fixture();
    expect(validateManifest(data.manifest)).toBe(data.manifest);
    expect(() => validateDataset(data)).not.toThrow();
  });
  it("rejects bad versions, unordered frequencies, invalid counts and off-origin paths", () => {
    const data = fixture();
    for (const patch of [
      { schemaVersion: 2 }, { modeCount: 23 }, { vertexCount: 0 }, { rootVertices: [0, 0, 1] },
      { modes: [...data.manifest.modes].reverse() },
      { buffers: { ...data.manifest.buffers, positions: { ...data.manifest.buffers.positions, url: "https://example.com/private.bin" } } }
    ]) expect(() => validateManifest({ ...data.manifest, ...patch })).toThrow(/metadata/);
  });
  it("rejects nonfinite states, out-of-range connectivity and moving roots", () => {
    const nonfinite = fixture();
    nonfinite.displacements[11] = NaN;
    expect(() => validateDataset(nonfinite)).toThrow(/invalid values/);
    const connectivity = fixture();
    connectivity.triangles[0] = 4;
    expect(() => validateDataset(connectivity)).toThrow(/connectivity/);
    const root = fixture();
    root.displacements[0] = 1e-9;
    expect(() => validateDataset(root)).toThrow(/fixed-root/);
  });
  it("fetches each buffer relative to the manifest and verifies its checksum", async () => {
    const data = fixture();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("document", { baseURI: "https://example.org/WingModes/" });
    const fetcher = vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith("wing.json")) return new Response(JSON.stringify(data.manifest));
      const key = text.split("/").at(-1)!.replace(".bin", "") as keyof Pick<WingDataset, "positions" | "uvs" | "triangles" | "displacements">;
      return new Response(data[key].buffer.slice(0) as ArrayBuffer);
    });
    vi.stubGlobal("fetch", fetcher);
    const loaded = await loadWingDataset("./data/wing.json");
    expect(loaded.displacements).toEqual(data.displacements);
    expect(fetcher.mock.calls).toHaveLength(5);
    expect(fetcher.mock.calls.slice(1).every(([url]) => String(url).startsWith("https://example.org/WingModes/data/"))).toBe(true);
  });
  it("rejects corrupted downloads even when their byte length is correct", async () => {
    const data = fixture();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("document", { baseURI: "https://example.org/WingModes/" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith("wing.json")) return new Response(JSON.stringify(data.manifest));
      const key = text.split("/").at(-1)!.replace(".bin", "") as keyof WingManifest["buffers"];
      return new Response(new Uint8Array(data.manifest.buffers[key].length * 4));
    }));
    await expect(loadWingDataset("./data/wing.json")).rejects.toThrow(/checksum/);
  });
});
