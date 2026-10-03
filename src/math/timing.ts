import type { WingMode } from "../types";

/** A single slowdown preserves every computed frequency ratio. */
export function animationCycleSeconds(modes: readonly WingMode[], index: number): number {
  if (!Number.isInteger(index) || index < 1 || index > modes.length || !modes.length) {
    throw new RangeError("The mode is outside the available dataset.");
  }
  const fundamental = modes[0]!.frequencyHz;
  const highest = modes[modes.length - 1]!.frequencyHz;
  const fundamentalPeriod = Math.max(10, (2 / 3) * highest / fundamental);
  return fundamentalPeriod * fundamental / modes[index - 1]!.frequencyHz;
}
