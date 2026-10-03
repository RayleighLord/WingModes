import { loadWingDataset } from "./data/wing";
import { animationCycleSeconds } from "./math/timing";
import type { WingDataset } from "./types";
import { createInitialControllerState, reduceControllerState, type ControllerAction } from "./ui/controller";
import { WingRenderer } from "./wing/renderer";

const COMPONENTS = ["Chordwise", "Spanwise", "Vertical"] as const;

export function startApp(): void {
  const shell = element("app-shell");
  const stage = element("wing-stage");
  const loading = element("wing-loading");
  const fallback = element("wing-fallback");
  const slider = element<HTMLInputElement>("mode-slider");
  const animation = element<HTMLButtonElement>("animation-toggle");
  const visibility = element<HTMLButtonElement>("ui-visibility-toggle");
  const retry = element<HTMLButtonElement>("retry-renderer");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new AbortController();
  const listenerOptions = { signal: listeners.signal };
  let state = createInitialControllerState(reducedMotion.matches);
  let renderer: WingRenderer | null = null;
  let data: WingDataset | null = null;
  let loadController: AbortController | null = null;
  let generation = 0;
  let destroyed = false;

  function announce(message: string): void {
    element("interaction-status").textContent = message;
  }

  function showFailure(message: string, contextLost = false): void {
    loading.hidden = true;
    fallback.hidden = false;
    element("wing-fallback-message").textContent = message;
    stage.dataset.status = contextLost ? "context-lost" : "error";
    stage.setAttribute("aria-busy", "false");
    slider.disabled = !data;
    animation.disabled = !data;
  }

  async function initializeRenderer(): Promise<void> {
    const current = ++generation;
    loadController?.abort();
    loadController = new AbortController();
    renderer?.destroy();
    renderer = null;
    loading.hidden = false;
    fallback.hidden = true;
    retry.disabled = true;
    slider.disabled = true;
    animation.disabled = true;
    stage.dataset.status = "loading";
    stage.setAttribute("aria-busy", "true");
    try {
      data ??= await loadWingDataset(`${import.meta.env.BASE_URL}data/wing.json`, loadController.signal);
      if (destroyed || current !== generation) return;
      renderer = new WingRenderer(stage, data, {
        onContextLost: () => showFailure("The graphics context was lost. The view will resume when graphics are available, or select Retry.", true),
        onContextRestored: () => {
          fallback.hidden = true;
          stage.setAttribute("aria-busy", "false");
          renderer?.setPlaying(state.isPlaying);
          renderer?.setPageVisible(!document.hidden);
          announce("The three-dimensional wing view was restored.");
        }
      });
      renderer.setMode(state.mode);
      renderer.setPageVisible(!document.hidden);
      renderer.setPlaying(state.isPlaying);
      renderMode();
      loading.hidden = true;
      slider.disabled = false;
      animation.disabled = false;
      stage.setAttribute("aria-busy", "false");
      announce("Wing ready. Use the mode slider to explore 24 computed normal modes.");
    } catch (error) {
      if (destroyed || current !== generation || (error instanceof DOMException && error.name === "AbortError")) return;
      renderer?.destroy();
      renderer = null;
      showFailure(error instanceof Error ? error.message : "This browser could not load the three-dimensional wing view.");
    } finally {
      if (!destroyed && current === generation) retry.disabled = false;
    }
  }

  function renderMode(): void {
    slider.value = `${state.mode}`;
    slider.style.setProperty("--mode-progress", `${(state.mode - 1) / 23 * 100}%`);
    element("mode-value").innerHTML = `${String(state.mode).padStart(2, "0")} <span>/ 24</span>`;
    if (!data) return;
    const mode = data.manifest.modes[state.mode - 1]!;
    const frequency = mode.frequencyHz.toFixed(mode.frequencyHz < 10 ? 3 : 2);
    const component = COMPONENTS[mode.colorComponent];
    element("frequency-value").innerHTML = `${frequency} <span>Hz</span>`;
    element("color-component").textContent = `${component} displacement`;
    slider.setAttribute("aria-valuetext", `Mode ${state.mode} of 24, ${frequency} hertz`);
    element("wing-description").textContent = `Aircraft-wing mode ${state.mode}, natural frequency ${frequency} hertz. ` +
      `The Berlin blue-to-coral palette shows signed ${component.toLowerCase()} displacement. ` +
      `All three displacement components are animated; the root stays fixed. Motion is exaggerated and slowed, ` +
      `with a ${animationCycleSeconds(data.manifest.modes, state.mode).toFixed(2)} second visual cycle. ` +
      "All modes share the same slowdown, preserving their relative frequencies.";
  }

  function dispatch(action: ControllerAction): void {
    if (destroyed) return;
    const previous = state;
    state = reduceControllerState(state, action);
    if (state === previous) return;
    if (state.mode !== previous.mode) {
      renderer?.setMode(state.mode);
      renderMode();
    }
    if (state.isPlaying !== previous.isPlaying) renderer?.setPlaying(state.isPlaying);
    renderState();
  }

  function renderState(): void {
    animation.setAttribute("aria-pressed", `${state.isPlaying}`);
    animation.setAttribute("aria-label", state.isPlaying ? "Pause vibration" : "Play vibration");
    animation.querySelector("[data-animation-toggle-label]")!.textContent = state.isPlaying ? "Pause" : "Play";
    shell.dataset.uiHidden = `${!state.isUiVisible}`;
    visibility.setAttribute("aria-expanded", `${state.isUiVisible}`);
    visibility.setAttribute("aria-pressed", `${!state.isUiVisible}`);
    visibility.setAttribute("aria-label", state.isUiVisible ? "Hide UI" : "Show UI");
    visibility.querySelector("[data-ui-toggle-label]")!.textContent = state.isUiVisible ? "Hide UI" : "Show UI";
    // Move focus out of hidden controls when the keyboard shortcut hides them.
    if (!state.isUiVisible && document.activeElement?.closest(".ui-chrome")) visibility.focus({ preventScroll: true });
  }

  slider.addEventListener("input", () => dispatch({ type: "set-mode", mode: Number(slider.value) }), listenerOptions);
  slider.addEventListener("change", () => announce(slider.getAttribute("aria-valuetext") ?? `Mode ${state.mode}`), listenerOptions);
  animation.addEventListener("click", () => dispatch({ type: "toggle-playing" }), listenerOptions);
  visibility.addEventListener("click", () => dispatch({ type: "toggle-ui" }), listenerOptions);
  retry.addEventListener("click", () => { void initializeRenderer(); }, listenerOptions);
  element("reset-camera").addEventListener("click", () => {
    renderer?.resetView();
    stage.focus({ preventScroll: true });
    announce("Wing camera reset.");
  }, listenerOptions);
  stage.addEventListener("pointerdown", () => stage.focus({ preventScroll: true }), listenerOptions);
  stage.addEventListener("keydown", (event) => renderer?.handleKeyboard(event), listenerOptions);
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isEditing(event.target)) return;
    if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      dispatch({ type: "toggle-ui" });
    } else if (event.code === "Space" && !(event.target instanceof HTMLElement && event.target.closest("button,a"))) {
      event.preventDefault();
      dispatch({ type: "toggle-playing" });
    }
  }, listenerOptions);
  reducedMotion.addEventListener("change", () => dispatch({ type: "set-reduced-motion", prefersReducedMotion: reducedMotion.matches }), listenerOptions);
  document.addEventListener("visibilitychange", () => renderer?.setPageVisible(!document.hidden), listenerOptions);
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) renderer?.setPageVisible(false);
    else {
      destroyed = true;
      generation += 1;
      loadController?.abort();
      listeners.abort();
      renderer?.destroy();
      renderer = null;
      data = null;
    }
  }, listenerOptions);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !destroyed) {
      renderer?.setPageVisible(!document.hidden);
      renderer?.resize();
    }
  }, listenerOptions);
  renderState();
  renderMode();
  void initializeRenderer();
}

function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing required element #${id}.`);
  return result as T;
}
