import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BERLIN_ENDPOINTS, BERLIN_SAMPLE_COUNT, berlinCoordinate, createBerlinTexture } from "../wing/berlin";

describe("canonical Berlin palette", () => {
  it("uses all 256 original LUT samples and the blue-to-coral endpoint colors", () => {
    const texture = createBerlinTexture();
    const image = texture.image as { data: Uint8Array; width: number; height: number };
    expect(BERLIN_SAMPLE_COUNT).toBe(256);
    expect(image.width).toBe(256);
    expect(image.height).toBe(1);
    expect([...image.data.slice(0, 4)]).toEqual([158, 176, 255, 255]);
    expect([...image.data.slice(-4)]).toEqual([255, 173, 173, 255]);
    expect(BERLIN_ENDPOINTS.zero).toBe("#190c09");
    // Lock the entire table, not just its endpoints.
    expect(createHash("sha256").update(image.data).digest("hex")).toBe("ef7d3ef0de0b5b85188a835f1fb13c84a4de48878903198e2810d0f461032116");
    texture.dispose();
  });
  it("maps signed displacement symmetrically and clamps outliers", () => {
    expect([-2, -1, 0, 1, 2].map(berlinCoordinate)).toEqual([0, 0, 0.5, 1, 1]);
  });
  it("ships no hover-message attributes or formula-rendering dependency", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).not.toMatch(/\stitle\s*=|<svg[^>]*>[\s\S]*?<title|data-tooltip|katex/i);
  });
});
