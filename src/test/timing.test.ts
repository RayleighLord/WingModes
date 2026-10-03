import { describe, expect, it } from "vitest";
import { animationCycleSeconds } from "../math/timing";
import type { WingMode } from "../types";

function modes(frequencies: number[]): WingMode[] {
  return frequencies.map((frequencyHz, index) => ({ index: index + 1, frequencyHz, colorComponent: 2, colorMax: 1, displayAmplitudeM: 0.1 }));
}

describe("common modal slowdown", () => {
  it("gives the fundamental ten seconds when the spectrum allows it", () => {
    expect(animationCycleSeconds(modes([3, 6, 12]), 1)).toBe(10);
    expect(animationCycleSeconds(modes([3, 6, 12]), 3)).toBe(2.5);
  });
  it("slows the complete spectrum together to cap the highest mode at 1.5 Hz", () => {
    const spectrum = modes([2, 11, 45, 90]);
    const cycles = spectrum.map((_, index) => animationCycleSeconds(spectrum, index + 1));
    expect(cycles[0]).toBe(30);
    expect(1 / cycles[3]!).toBeCloseTo(1.5);
    spectrum.forEach((mode, index) => expect(cycles[index]! * mode.frequencyHz).toBeCloseTo(60));
  });
  it("rejects indices outside the spectrum", () => {
    for (const index of [0, 2, 1.2, NaN]) expect(() => animationCycleSeconds(modes([1]), index)).toThrow(RangeError);
  });
});
