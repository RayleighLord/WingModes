# Wing model and numerical method

The fixed model represents one cantilevered semispan of an idealized aluminum
aircraft wing. All quantities in the numerical pipeline use metres, kilograms and
seconds. There are no fuel, engine, aerodynamic, prestress or damping terms.

| Quantity | Value |
| --- | --- |
| Semispan | 6 m |
| Root / tip chord | 2.4 / 1.0 m, linear taper |
| Leading-edge sweep | 20° |
| Dihedral | 4° |
| Airfoil | NACA 2412, closed trailing edge |
| Geometric twist | 0° |
| Young's modulus | 70 GPa |
| Poisson's ratio | 0.33 |
| Density | 2700 kg/m³ |
| Skin thickness | 2.5 mm at root to 1.5 mm at tip |
| Spar positions | 15% and 65% chord |
| Spar web thickness | 3.5 mm at root to 2.0 mm at tip |
| Rib spacing / thickness | 0.5 m / 2 mm |
| Root condition | All six shell degrees of freedom fixed |

## Reproduce the modes

Use Python 3.12. A normal website build uses the committed data and does not need
the numerical environment.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r numerical/requirements.txt
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python numerical/generate.py
.venv/bin/python numerical/generate.py --verify-existing
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python -m unittest discover -s numerical -p 'test_*.py'
```

Generation assembles and solves the refinement meshes, runs numerical acceptance
checks and exports the browser buffers only after validation. Checkpoints and
intermediate results live in the ignored `output/numerical/` directory. Their
identity includes the model, solver source and dependency versions.

`--factor N` computes one refinement level and `--gamma FACTOR` changes the
drilling regularization for sensitivity studies. The default command produces
the complete validated publication dataset. The committed report is
[numerical-validation.json](numerical-validation.json).

## Discretization

The generator creates connected shell meshes with common node IDs along skin,
spar and rib intersections. Four-node quadrilateral shell elements describe skin,
spar webs and rib interiors; triangular elements close rib ends without collapsed
quadrilaterals. Consistent mass includes the structure's distributed inertia.

The pinned solver is pyfe3d 0.10.0, using its default physical drilling formulation.
The numerical implementation follows the project's
[shell assembly example](https://github.com/saullocastro/pyfe3d/blob/0.10.0/tests/test_quad4_natural_freq.py)
and [element documentation](https://saullocastro.github.io/pyfe3d/quad4.html).
SciPy's sparse generalized eigensolver computes at least 32 eigenpairs after root
constraints are eliminated. Raw eigenvalues must be finite and positive. The first
24 modes are exported in frequency order, including local deformation modes.

## Required numerical evidence

The generator starts with 24/48/96 span divisions and nominal chord divisions,
adding chord stations at both spars and the camber join, with 2/4/8 divisions
through web depth. Physical rib spacing remains fixed. Further
refinement is required whenever the final two meshes fail the acceptance gates:

- Relative matrix-symmetry errors at most 1e-12.
- Relative modal equilibrium residuals at most 1e-6.
- Mass-orthogonality error at most 1e-8.
- Matched frequency changes at most 1% for the first six modes and 2% for all 24.
- Mass-weighted modal correlation of at least 0.95, with subspace comparisons for
  nearly repeated modes.
- An independent structural benchmark and a factor-of-two drilling sensitivity
  check, with matched wing-frequency changes at most 1%.

The report also records connected mesh topology, positive element areas, physical
mass, exact root constraints, solver versions and generation provenance. It is
evidence for this discretized idealization; the model has not been calibrated to
a manufactured aircraft.

The published dataset passed using the 144-to-192 span-division comparison. Its
final mesh has 121,584 shell elements and 711,000 degrees of freedom. See the
[numerical validation](numerical-validation.md) for measured results and the
coarser meshes that failed the acceptance criteria.

## Browser representation

The solver keeps mass-normalized full eigenvectors for verification. Exported
surface translations retain all three components and are separately normalized
to a maximum vector magnitude of one, with a deterministic sign convention.
Coordinates use chordwise x, spanwise y and vertical z.

Each stored display amplitude targets 6% of semispan and is limited by the maximum
triangle displacement gradient to keep its norm at most 0.25. Float32 exported
geometry is checked across the oscillation cycle for finite coordinates and
positive triangle orientation. This exaggeration is not a physical response
amplitude. The viewer applies a further 1.2× magnification for clearer motion.
Camera framing uses that same magnification, and `npm run check:assets` verifies
positive triangle orientation and upper/lower skin separation over the entire
oscillation cycle at the rendered amplitude. The computed eigenvectors and
frequencies are unchanged.

Berlin colors encode the signed model-coordinate component with the greatest
area-weighted squared displacement. The accessible description identifies it; color
normalization is independent of display exaggeration and camera orientation.

One common slowdown preserves all frequency ratios. The fundamental takes at
least 10 display seconds, with extra common slowdown if necessary to keep the
highest mode at or below 1.5 displayed cycles per second.

The versioned manifest contains modal metadata, SI units, root vertex indices,
buffer lengths and SHA-256 checksums. Little-endian Float32 arrays contain
positions, UV coordinates and mode-major displacement vectors; a UInt32 array
contains triangle indices. The website verifies these assets before rendering.
