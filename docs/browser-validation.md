# Browser validation

Verified on 2026-10-03 using the production build served under `/WingModes/`.
All 16 application unit tests, TypeScript checks, the production build, the modal
asset audit and the complete browser smoke suite pass. The independent numerical
suite has four passing tests; its results are in [numerical validation](numerical-validation.md).

## Performance

Chrome 154.0.8037.97 used an NVIDIA GeForce RTX 4090 through ANGLE/OpenGL 4.5.
Each of the 24 modes was measured for two seconds after warmup in each viewport,
followed by three complete slider sweeps (72 measured switches per viewport).
Numbers below are the worst per-mode means and percentiles, not averages hiding
a slower mode.

| Measurement | Desktop 1440 × 900 | Mobile viewport 390 × 844 | Acceptance |
| --- | ---: | ---: | ---: |
| Worst mean frame interval | 16.671 ms | 16.669 ms | ≤ 20 ms |
| Worst per-mode frame p95 | 17.0 ms | 17.1 ms | ≤ 33.4 ms |
| Largest individual frame interval | 20.5 ms | 28.6 ms | ≤ 100 ms |
| Mode-switch p95 | 16.8 ms | 16.9 ms | ≤ 100 ms |
| First ready, local server | 386 ms | 586 ms | Recorded |

Every performance gate passed. Both cases retained 3 geometries, 1 texture and
3 shader programs across repeated mode changes, with zero browser errors.

Mobile measurements use a touch-enabled viewport at device pixel ratio 2 on the
same RTX 4090 machine. First-ready timings include loading the 24.75 MiB dataset
from a local server; internet download time depends on the connection.

The complete per-mode timings, hardware details and resource counts are in
[browser-validation.json](browser-validation.json). Reproduce with `npm run benchmark`;
fresh measurements are written to `output/performance.json`.

## Interaction and visual checks

The browser suite covers all 24 modes, their ordering and common slowdown,
native pointer and keyboard selection, playback and paused-frame stability,
orbit/zoom/reset, clean view, reduced motion, page suspension, graphics context
loss/restoration and failed-download retry. It checks the absence of tooltip
attributes and hover messages before and after interactions.

Desktop and mobile layouts were inspected from 320 to 1440 CSS pixels wide,
with no horizontal overflow and control targets of at least 44 pixels. Positive,
near-zero and negative displacement phases were inspected. The default underside
view exposes the lower-skin modes; manual orbit remains available for every side.

The README screenshot is generated with:

```sh
UPDATE_README_SCREENSHOT=1 npm run test:browser
```

Screenshots and phase-capture metadata are kept in the ignored
`output/playwright/` directory during verification.
