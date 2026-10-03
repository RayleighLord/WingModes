# Wing Modes

Static, framework-free TypeScript/Vite/Three.js aircraft-wing mode explorer.
Keep the full-viewport presentation, Berlin palette, accessible native controls,
and relative Vite base inherited from SquarePlateModes.

## Scientific invariants

- The model is one dry, unloaded, root-clamped aluminum wing. The 24 displayed
  modes are the lowest converged finite-element eigenmodes, including local modes.
- Geometry, materials, mesh generation and solver configuration live in
  `numerical/`; committed browser assets must come from that pipeline.
- Preserve the complete three-component displacement vector and fixed root.
- One common animation time scale preserves every natural-frequency ratio.
  Display exaggeration is independent of numerical mass normalization.
- Changes to model or assets require residual, orthogonality, convergence,
  element-quality, benchmark and display-geometry checks. Never weaken their
  thresholds to make a result pass.

## Architecture and UX

- Keep lifecycle/DOM wiring, pure UI state, data validation and Three.js resources
  separate. The site runs without Python or a backend; Python regenerates data.
- Use exactly one mode-selection slider. No analytical formulas or hover
  messages, including title attributes, SVG titles and runtime tooltip text.
- Preserve keyboard access, visible labels, reduced motion, pause, clean view,
  camera controls, hidden-tab suspension and renderer recovery.
- Run unit tests, type checking, production build and browser smoke checks for
  application changes; run the browser benchmark for rendering changes.
- Serve browser checks under `/WingModes/`, inspect desktop/mobile screenshots,
  and retain accurate numerical and performance evidence in `docs/`.
