# Wing Modes

A scientific, interactive explorer of the first 24 finite-element vibration modes
of a generic aircraft wing. One slider selects a mode; the airfoil surface animates
its full three-dimensional displacement with the Berlin scientific color map.

![Wing Modes explorer](docs/wing-modes-explorer.png)

The presentation and project organization follow
[SquarePlateModes](https://github.com/RayleighLord/SquarePlateModes).
The application is a static website: its computed modes ship with the repository,
and visitors need only a browser with WebGL 2.
The complete modal dataset is 24.75 MiB and loads once before interaction.

## Run locally

Use Node.js 22.12 or newer (22 or 24 LTS).

```sh
npm ci
npm run dev
```

Drag to orbit; scroll or pinch to zoom. The mode slider is keyboard accessible.
Pause, Reset view and Hide UI are available without hover tooltips. Reduced-motion
preferences start the application paused. The initial view looks at the lower
skin so its local vibration modes are visible; orbit to inspect any other side.

## Structural model

One root-clamped, 6 m semispan aluminum wing has NACA 2412 sections, a chord taper
from 2.4 to 1.0 m, 20° leading-edge sweep and 4° dihedral. Its shell model includes
skin, two spar webs and ribs every 0.5 m. The model is dry and unloaded and uses
linear elastic, undamped vibration. It represents a documented generic structure,
not measured properties of a particular aircraft.

The displayed frequencies are numerical natural frequencies in Hz. Animation uses
one common slowdown factor, preserving frequency ratios across all modes. Shapes
are normalized and exaggerated within a distortion bound. Colors show the signed
displacement component named on screen; they do not indicate stress.

See [the model and numerical method](docs/model.md) for dimensions, materials and
reproduction instructions, and [the numerical validation](docs/numerical-validation.md)
for all 24 frequencies and the measured convergence results.

## Verification

```sh
npm test
npm run typecheck
npm run check:assets
npm run test:browser
npm run benchmark
```

Browser tests use the production build at `/WingModes/`, collect desktop/mobile
screenshots and exercise all 24 modes. The benchmark records the actual browser
and WebGL renderer together with frame timing and mode-switch latency. Artifacts
are written to `output/`; checked-in reports live in `docs/`.
See [browser validation](docs/browser-validation.md) for the measured frame times,
hardware and interaction coverage.

## Publish with GitHub Pages

Push the repository to GitHub and select **GitHub Actions** as the Pages source.
The single CI workflow tests and builds pull requests, and deploys successful
`main` pushes. Vite's relative asset paths support repository subpaths. The Python
solver is used for reproducibility and numerical checks; it is not deployed.

## Organization and attribution

Application lifecycle, UI state, modal data and Three.js rendering are separate
modules under `src/`. Offline finite-element generation lives in `numerical/`;
ready-to-serve data lives in `public/data/`. Browser checks live in `scripts/`.

The Berlin color map is Fabio Crameri's Scientific Colour Maps v8.0.1; its license
is preserved in the source and [third-party notices](public/THIRD_PARTY_NOTICES.txt).
The offline solver uses [pyfe3d](https://github.com/saullocastro/pyfe3d) and SciPy.
