import { describe, expect, it } from "vitest";
import { createInitialControllerState, reduceControllerState } from "../ui/controller";

describe("mode and playback state", () => {
  it("starts on the first mode and respects reduced motion", () => {
    expect(createInitialControllerState().mode).toBe(1);
    expect(createInitialControllerState().isPlaying).toBe(true);
    expect(createInitialControllerState(true).isPlaying).toBe(false);
  });
  it("rejects invalid mode values without modifying accepted state", () => {
    const state = createInitialControllerState();
    for (const mode of [0, 25, 1.5, NaN, Infinity]) {
      expect(() => reduceControllerState(state, { type: "set-mode", mode })).toThrow(RangeError);
    }
    expect(state.mode).toBe(1);
    expect(Object.isFrozen(state)).toBe(true);
    expect(reduceControllerState(state, { type: "set-mode", mode: 1 })).toBe(state);
  });
  it("changes mode without changing paused playback or clean view", () => {
    let state = createInitialControllerState(true);
    state = reduceControllerState(state, { type: "toggle-ui" });
    state = reduceControllerState(state, { type: "set-mode", mode: 24 });
    expect(state).toMatchObject({ mode: 24, isPlaying: false, isUiVisible: false });
  });
  it("pauses immediately on reduced motion, allows explicit playback and does not auto-resume", () => {
    let state = reduceControllerState(createInitialControllerState(), { type: "set-reduced-motion", prefersReducedMotion: true });
    expect(state.isPlaying).toBe(false);
    state = reduceControllerState(state, { type: "set-reduced-motion", prefersReducedMotion: false });
    expect(state.isPlaying).toBe(false);
    state = reduceControllerState(state, { type: "toggle-playing" });
    expect(state.isPlaying).toBe(true);
  });
});
