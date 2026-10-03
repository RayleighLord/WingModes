"""Deterministic conforming shell mesh of an idealized aluminum aircraft wing.

Coordinates are chordwise x, spanwise y, and vertical z, in SI units.
This module builds actual skin, spar and rib elements, with shared joints.
"""
from dataclasses import dataclass
import time

import numpy as np
from scipy.sparse import coo_matrix
from pyfe3d import (Quad4, Quad4Data, Quad4Probe, Tria3DSG,
                   Tria3DSGData, Tria3DSGProbe, INT, DOUBLE)
from pyfe3d.shellprop_utils import isotropic_plate

MODEL = {
    "name": "Swept aluminum wing", "semispanM": 6.0,
    "rootChordM": 2.4, "tipChordM": 1.0,
    "leadingEdgeSweepDeg": 20.0, "dihedralDeg": 4.0,
    "airfoil": "NACA 2412, closed trailing edge", "twistDeg": 0.0,
    "youngModulusPa": 70e9, "poissonRatio": 0.33, "densityKgM3": 2700.0,
    "skinThicknessRootM": 0.0025, "skinThicknessTipM": 0.0015,
    "sparThicknessRootM": 0.0035, "sparThicknessTipM": 0.002,
    "ribThicknessM": 0.002, "sparChordFractions": [0.15, 0.65],
    "ribSpacingM": 0.5, "boundary": "All six degrees of freedom clamped at the root",
    "assumptions": "Linear elastic, unloaded dry structure; no fuel, engine, aerodynamic loading or damping",
}


@dataclass
class Mesh:
    xyz: np.ndarray
    param: np.ndarray
    elements: list
    exterior: np.ndarray
    root: np.ndarray
    factor: int
    span_intervals: int
    chord_intervals: int
    depth_intervals: int


def airfoil(q):
    """Upper and lower NACA 2412 coordinates, normalized by chord."""
    m, p, t = 0.02, 0.4, 0.12
    if q < p:
        camber = m / p**2 * (2 * p * q - q*q)
        slope = 2*m / p**2 * (p - q)
    else:
        camber = m / (1-p)**2 * ((1-2*p) + 2*p*q - q*q)
        slope = 2*m / (1-p)**2 * (p - q)
    thick = 5*t*(0.2969*np.sqrt(q) - 0.1260*q - 0.3516*q*q
                 + 0.2843*q**3 - 0.1036*q**4)
    angle = np.arctan(slope)
    return (np.array([q - thick*np.sin(angle), camber + thick*np.cos(angle)]),
            np.array([q + thick*np.sin(angle), camber - thick*np.cos(angle)]))


def build_mesh(factor=1):
    ns, nd = 24*factor, 2*factor
    qvals = np.unique(np.round(np.r_[
        0.5*(1-np.cos(np.linspace(0, np.pi, 24*factor+1))),
        MODEL['sparChordFractions'], 0.4], 13))
    nq = len(qvals)-1
    coords, params, nodes, elements, exterior = [], [], {}, [], []

    def node(i, j, k):
        if j in (0, nq):
            k = 0  # Upper/lower skins meet; no duplicated or degenerate edge.
        key = (i, j, k)
        if key not in nodes:
            eta, q, v = i/ns, qvals[j], k/nd
            upper, lower = airfoil(q)
            section = lower + v*(upper-lower)
            chord = (1-eta)*MODEL['rootChordM'] + eta*MODEL['tipChordM']
            span = eta*MODEL['semispanM']
            xyz = [span*np.tan(np.deg2rad(MODEL['leadingEdgeSweepDeg'])) + chord*section[0],
                   span,
                   span*np.tan(np.deg2rad(MODEL['dihedralDeg'])) + chord*section[1]]
            nodes[key] = len(coords)
            coords.append(xyz)
            params.append([eta, q, v])
        return nodes[key]

    def panel(ids, kind, eta, visible=False):
        # Rib end cells collapse to a proper three-node DSG triangle.
        ids = tuple(dict.fromkeys(ids))
        assert len(ids) in (3, 4)
        elements.append((ids, kind, eta))
        if visible:
            exterior.append(ids[:3])
            if len(ids) == 4:
                exterior.append((ids[0], ids[2], ids[3]))

    for i in range(ns):
        eta = (i+0.5)/ns
        for j in range(nq):
            # Outward orientation on both external skins.
            panel([node(i,j,nd),node(i,j+1,nd),node(i+1,j+1,nd),node(i+1,j,nd)],
                  'skin', eta, True)
            panel([node(i,j,0),node(i+1,j,0),node(i+1,j+1,0),node(i,j+1,0)],
                  'skin', eta, True)
    for q in MODEL['sparChordFractions']:
        j = int(np.flatnonzero(np.isclose(qvals, q, atol=1e-12))[0])
        for i in range(ns):
            for k in range(nd):
                panel([node(i,j,k),node(i+1,j,k),node(i+1,j,k+1),node(i,j,k+1)],
                      'spar', (i+0.5)/ns)
    for i in range(0, ns+1, ns//12):
        for j in range(nq):
            for k in range(nd):
                panel([node(i,j,k),node(i,j,k+1),node(i,j+1,k+1),node(i,j+1,k)],
                      'rib', i/ns, i == ns)
    xyz, param = np.asarray(coords), np.asarray(params)
    root = np.flatnonzero(param[:,0] == 0)
    return Mesh(xyz, param, elements, np.asarray(exterior, dtype=np.int32),
                root, factor, ns, nq, nd)


def shell_thickness(kind, eta):
    if kind == 'skin':
        return (1-eta)*MODEL['skinThicknessRootM'] + eta*MODEL['skinThicknessTipM']
    if kind == 'spar':
        return (1-eta)*MODEL['sparThicknessRootM'] + eta*MODEL['sparThicknessTipM']
    return MODEL['ribThicknessM']


def assemble(mesh, gamma_factor=1.0):
    start = time.perf_counter()
    ndof = len(mesh.xyz)*6
    flat = mesh.xyz.ravel().astype(DOUBLE)
    qdata, tdata = Quad4Data(), Tria3DSGData()
    qprobe, tprobe = Quad4Probe(), Tria3DSGProbe()
    nk = sum(qdata.KC0_SPARSE_SIZE if len(e[0]) == 4 else tdata.KC0_SPARSE_SIZE
             for e in mesh.elements)
    nm = sum(qdata.M_SPARSE_SIZE if len(e[0]) == 4 else tdata.M_SPARSE_SIZE
             for e in mesh.elements)
    kr, kc, kv = np.zeros(nk, dtype=INT), np.zeros(nk, dtype=INT), np.zeros(nk, dtype=DOUBLE)
    mr, mc, mv = np.zeros(nm, dtype=INT), np.zeros(nm, dtype=INT), np.zeros(nm, dtype=DOUBLE)
    props, ik, im, mass, min_area, min_jacobian = {}, 0, 0, 0., np.inf, np.inf
    for ids, kind, eta in mesh.elements:
        thickness = shell_thickness(kind, eta)
        if thickness not in props:
            props[thickness] = isotropic_plate(thickness, MODEL['youngModulusPa'],
                                             MODEL['poissonRatio'], rho=MODEL['densityKgM3'])
        prop = props[thickness]
        data = qdata if len(ids) == 4 else tdata
        element = Quad4(qprobe) if len(ids) == 4 else Tria3DSG(tprobe)
        element.drilling_model = 0
        if gamma_factor != 1:
            element.gamma_rz = gamma_factor*prop.A66
        for j, nid in enumerate(ids, 1):
            setattr(element, 'n'+str(j), nid+1)
            setattr(element, 'c'+str(j), 6*nid)
        element.init_k_KC0, element.init_k_M = ik, im
        element.update_rotation_matrix(flat)
        element.update_probe_xe(flat)
        element.update_KC0(kr, kc, kv, prop)
        element.update_M(mr, mc, mv, prop, mtype=0)
        area = element.area
        if not np.isfinite(area) or area <= 0:
            raise RuntimeError(f'Invalid {kind} element area {area}')
        # Check signed Jacobians in the element's own tangent plane.
        pts = mesh.xyz[list(ids)]
        e1 = pts[1]-pts[0]; e1 /= np.linalg.norm(e1)
        normal = np.cross(pts[1]-pts[0],pts[-1]-pts[0]); normal /= np.linalg.norm(normal)
        e2 = np.cross(normal,e1)
        xy = np.column_stack((pts@e1,pts@e2))
        if len(ids) == 4:
            for xi in (-1/np.sqrt(3),1/np.sqrt(3)):
                for zeta in (-1/np.sqrt(3),1/np.sqrt(3)):
                    ds = np.array([[-(1-zeta),1-zeta,1+zeta,-(1+zeta)],
                                   [-(1-xi),-(1+xi),1+xi,1-xi]])/4
                    jac = np.linalg.det(ds@xy)
                    if jac <= 0: raise RuntimeError('Nonpositive quadrilateral Jacobian')
                    min_jacobian = min(min_jacobian,jac)
        mass += area*thickness*MODEL['densityKgM3']
        min_area = min(min_area,area)
        ik += data.KC0_SPARSE_SIZE; im += data.M_SPARSE_SIZE
    K = coo_matrix((kv,(kr,kc)),shape=(ndof,ndof)).tocsr()
    M = coo_matrix((mv,(mr,mc)),shape=(ndof,ndof)).tocsr()
    K.eliminate_zeros(); M.eliminate_zeros()
    metadata = {"nodes":len(mesh.xyz), "elements":len(mesh.elements), "degreesOfFreedom":ndof,
                "quads":sum(len(e[0])==4 for e in mesh.elements),
                "triangles":sum(len(e[0])==3 for e in mesh.elements),
                "spanIntervals":mesh.span_intervals,"chordIntervalsPerSide":mesh.chord_intervals,
                "depthIntervals":mesh.depth_intervals,"massKg":mass,
                "minimumElementAreaM2":min_area,"minimumQuadJacobianM2":min_jacobian,
                "assemblySeconds":time.perf_counter()-start}
    return K, M, metadata
