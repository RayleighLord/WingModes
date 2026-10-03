import { MODE_COUNT, type ControllerState } from "../types";

export type ControllerAction =
  | { readonly type: "set-mode"; readonly mode: number }
  | { readonly type: "toggle-playing" }
  | { readonly type: "toggle-ui" }
  | { readonly type: "set-reduced-motion"; readonly prefersReducedMotion: boolean };

export function createInitialControllerState(prefersReducedMotion = false): Readonly<ControllerState> {
  return Object.freeze({ mode: 1, isPlaying: !prefersReducedMotion, isUiVisible: true, prefersReducedMotion });
}

export function reduceControllerState(state: Readonly<ControllerState>, action: ControllerAction): Readonly<ControllerState> {
  switch (action.type) {
    case "set-mode":
      if (!Number.isInteger(action.mode) || action.mode < 1 || action.mode > MODE_COUNT) {
        throw new RangeError(`Mode must be an integer from 1 to ${MODE_COUNT}.`);
      }
      return action.mode === state.mode ? state : Object.freeze({ ...state, mode: action.mode });
    case "toggle-playing":
      return Object.freeze({ ...state, isPlaying: !state.isPlaying });
    case "toggle-ui":
      return Object.freeze({ ...state, isUiVisible: !state.isUiVisible });
    case "set-reduced-motion":
      return action.prefersReducedMotion === state.prefersReducedMotion ? state : Object.freeze({
        ...state,
        prefersReducedMotion: action.prefersReducedMotion,
        isPlaying: action.prefersReducedMotion ? false : state.isPlaying
      });
  }
}
