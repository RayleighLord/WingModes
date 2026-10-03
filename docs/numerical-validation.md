# Numerical validation

The published 24 modes come from 121,584 shell elements, 118,500 nodes and 711,000 total degrees of freedom. The modeled semispan has a structural mass of 149.904763 kg.

| Check | Observed | Acceptance |
| --- | ---: | ---: |
| First six frequency changes | 0.4084% | ≤ 1% |
| All 24 frequency changes | 0.6012% | ≤ 2% |
| Minimum MAC or squared subspace correlation | 0.980035 | ≥ 0.95 |
| Maximum relative eigenpair residual | 2.027e-07 | ≤ 1e-6 |
| Mass orthogonality error | 5.478e-13 | ≤ 1e-8 |
| Relative matrix symmetry error | 5.740e-17 | ≤ 1e-12 |
| Factor-two drilling frequency sensitivity | 0.0071% | ≤ 1% |
| Independent plate benchmark error | 1.4660% | < 2% |
| Maximum stored amplitude times gradient norm | 0.249000 | ≤ 0.25 |

The convergence comparison interpolates coarse modes onto the fine shell mesh and uses its full consistent mass matrix. Nearly repeated modes are checked as subspaces. The export audit uses the actual float32 buffers and verifies positive triangle orientation at five phases; the gradient bound covers the entire oscillation.

| Refinement factor | Elements | Nodes | First frequency (Hz) | Mode 24 (Hz) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2,094 | 1,712 | 8.999340 | 133.358196 |
| 2 | 7,932 | 7,164 | 8.970243 | 77.412368 |
| 4 | 30,840 | 29,300 | 8.962850 | 71.689484 |
| 6 | 68,724 | 66,412 | 8.960980 | 70.515825 |
| 8 | 121,584 | 118,500 | 8.960369 | 70.118629 |

All first 24 ascending modes are retained, including local skin deformation. Earlier coarse meshes are shown to make their resolution limitations explicit.

| Mode | Frequency (Hz) |
| ---: | ---: |
| 1 | 8.960369 |
| 2 | 32.853498 |
| 3 | 49.741533 |
| 4 | 50.253043 |
| 5 | 51.639744 |
| 6 | 53.288290 |
| 7 | 54.735824 |
| 8 | 54.873196 |
| 9 | 55.945559 |
| 10 | 56.849243 |
| 11 | 57.328651 |
| 12 | 57.647586 |
| 13 | 59.840903 |
| 14 | 59.968847 |
| 15 | 60.304688 |
| 16 | 62.236864 |
| 17 | 62.862799 |
| 18 | 63.500615 |
| 19 | 64.127548 |
| 20 | 65.585127 |
| 21 | 66.941100 |
| 22 | 67.098111 |
| 23 | 69.120282 |
| 24 | 70.118629 |

This is an idealized, unloaded dry structural model, not a measured aircraft or an aeroelastic flight model. Animation amplitudes are normalized visualization choices.

See [the modeling and reproduction method](model.md) and [the machine-readable report](numerical-validation.json) for exact parameters, eigenpair diagnostics, mode matching, timings and source/buffer SHA-256 hashes.
