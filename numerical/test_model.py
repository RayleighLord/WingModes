"""Fast independent benchmark and audits of the published numerical artifacts.

Run: .venv/bin/python -m unittest discover -s numerical -p 'test_*.py'
"""
import hashlib
import json
from pathlib import Path
import unittest

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from model import MODEL, Mesh, build_mesh, assemble
from scipy.sparse.linalg import norm as sparse_norm
from generate import ROOT, solve


def plate_benchmark(nx=24, ny=18, count=6):
    """Simply supported isotropic thin plate, independent closed-form test."""
    a,b=1.,.7
    xyz=np.array([[x,y,0.] for y in np.linspace(0,b,ny+1) for x in np.linspace(0,a,nx+1)])
    elements=[]
    for j in range(ny):
        for i in range(nx):
            n=j*(nx+1)+i
            elements.append(((n,n+1,n+nx+2,n+nx+1),'rib',0.))
    boundary=np.flatnonzero(np.isclose(xyz[:,0],0)|np.isclose(xyz[:,0],a)|
                            np.isclose(xyz[:,1],0)|np.isclose(xyz[:,1],b))
    fixed=(boundary[:,None]*6+np.array([0,1,2])).ravel()
    mesh=Mesh(xyz,np.zeros_like(xyz),elements,np.empty((0,3),int),boundary,0,nx,ny,0)
    _,freq,meta,_=solve(mesh,count=count,fixed_override=fixed)
    E,nu,rho,h=MODEL['youngModulusPa'],MODEL['poissonRatio'],MODEL['densityKgM3'],MODEL['ribThicknessM']
    bending=E*h**3/(12*(1-nu**2))
    exact=np.sort([np.pi/2*np.sqrt(bending/(rho*h))*(m*m/a**2+n*n/b**2)
                   for m in range(1,8) for n in range(1,8)])[:count]
    errors=np.abs(freq-exact)/exact
    assert np.max(errors)<.02,(freq,exact,errors)
    return {'name':'Simply supported isotropic thin rectangular plate',
            'dimensionsM':[a,b,h],'elements':nx*ny,'computedFrequenciesHz':freq.tolist(),
            'referenceFrequenciesHz':exact.tolist(),'relativeErrors':errors.tolist(),
            'maxRelativeError':float(errors.max()),'tolerance':.02,'passed':True,
            'maxEigenpairResidual':meta['maxRelativeResidual']}


def verify_assets():
    data=ROOT/'public'/'data'
    manifest=json.loads((data/'wing.json').read_text())
    report_path=ROOT/'docs'/'numerical-validation.json'
    report=json.loads(report_path.read_text())
    assert manifest['schemaVersion']==1 and manifest['modeCount']==24
    assert hashlib.sha256(report_path.read_bytes()).hexdigest()==manifest['generation']['validationReportSha256']
    for path,checksum in report['sourceSha256'].items():
        assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==checksum, f'Stale numerical source: {path}'
    arrays={}
    for name,definition in manifest['buffers'].items():
        path=data/definition['url']; content=path.read_bytes()
        assert len(content)==definition['length']*4
        assert hashlib.sha256(content).hexdigest()==definition['sha256']
        arrays[name]=np.frombuffer(content,dtype='<u4' if name=='triangles' else '<f4')
        assert np.all(np.isfinite(arrays[name]))
    n=manifest['vertexCount']; triangles=arrays['triangles'].reshape(-1,3)
    assert len(triangles)==manifest['triangleCount'] and triangles.max()<n
    assert arrays['positions'].size==3*n and arrays['uvs'].size==2*n
    displacements=arrays['displacements'].reshape(24,n,3)
    positions=arrays['positions'].reshape(n,3)
    assert np.array_equal(np.asarray(manifest['rootVertices']),np.flatnonzero(positions[:,1]==0))
    assert np.all(displacements[:,manifest['rootVertices']]==0)
    assert np.allclose(np.max(np.linalg.norm(displacements,axis=2),axis=1),1.,atol=2e-7)
    frequencies=np.array([m['frequencyHz'] for m in manifest['modes']])
    assert np.all(np.isfinite(frequencies)) and np.all(frequencies>0) and np.all(np.diff(frequencies)>=0)
    assert np.array_equal(frequencies,np.asarray(report['finalMesh']['frequenciesHz'][:24]))
    assert all(manifest['model'][key]==value for key,value in report['model'].items())
    assert [m['index'] for m in manifest['modes']]==list(range(1,25))
    assert report['passed'] and report['convergence']['passed'] and report['drillingSensitivity']['passed']
    assert report['benchmark']['passed']
    audit_display_geometry(manifest,arrays)
    print(f'Validated {n} exterior vertices, {len(triangles)} triangles, and all 24 mode buffers.')


def audit_display_geometry(manifest,arrays):
    """Check actual quantized render geometry, including every phase's bound."""
    n=manifest['vertexCount']
    xyz=np.asarray(arrays['positions'],dtype=float).reshape(n,3)
    tri=np.asarray(arrays['triangles']).reshape(-1,3)
    u=np.asarray(arrays['displacements'],dtype=float).reshape(24,n,3)
    a=xyz[tri[:,1]]-xyz[tri[:,0]]; b=xyz[tri[:,2]]-xyz[tri[:,0]]
    normals=np.cross(a,b); areas2=np.linalg.norm(normals,axis=1)
    assert np.all(np.isfinite(areas2)) and np.all(areas2>0)
    length=np.linalg.norm(a,axis=1); unit=a/length[:,None]
    along=np.sum(unit*b,axis=1)
    height=np.linalg.norm(b-along[:,None]*unit,axis=1)
    bound=0.; orientation=1.
    for i,mode in enumerate(manifest['modes']):
        amp=mode['displayAmplitudeM']; color=mode['colorComponent']
        assert np.isfinite(amp) and 0<amp<=.06*MODEL['semispanM']
        assert color in (0,1,2)
        assert np.isclose(mode['colorMax'],np.max(np.abs(u[i,:,color])),rtol=2e-6)
        da=u[i,tri[:,1]]-u[i,tri[:,0]]; db=u[i,tri[:,2]]-u[i,tri[:,0]]
        d1=da/length[:,None]; d2=(db-along[:,None]*d1)/height[:,None]
        aa=np.sum(d1*d1,axis=1); ab=np.sum(d1*d2,axis=1); bb=np.sum(d2*d2,axis=1)
        maximum=np.sqrt((aa+bb+np.sqrt((aa-bb)**2+4*ab**2))/2).max()
        bound=max(bound,float(amp*maximum))
        assert amp*maximum<=.25*(1+1e-7),(i,amp*maximum)
        # The norm bound covers every phase; samples additionally audit indices
        # and the direct geometric deformation used by the browser.
        for phase in (-1.,-.5,0.,.5,1.):
            deformed=np.cross(a+phase*amp*da,b+phase*amp*db)
            dots=np.sum(deformed*normals,axis=1)/(areas2*areas2)
            assert np.all(dots>0),(i,phase,float(dots.min()))
            orientation=min(orientation,float(dots.min()))
    return {'passed':True,'maximumAmplitudeTimesGradientNorm':bound,
            'minimumSignedAreaRatioAtSampledPhases':orientation,
            'sampledPhases':[-1.,-.5,0.,.5,1.],
            'minimumUndeformedTriangleAreaM2':float(areas2.min()/2),
            'allPhaseGuarantee':'Surface displacement-gradient operator norm is below 0.25 for every mode'}


class NumericalTests(unittest.TestCase):
    def test_independent_plate_benchmark(self):
        plate_benchmark()

    def test_mesh_connectivity_and_root(self):
        mesh=build_mesh(1)
        touched=set(n for e,_,_ in mesh.elements for n in e)
        self.assertEqual(len(touched),len(mesh.xyz))
        pairs=np.array([(a,b) for ids,_,_ in mesh.elements for a in ids for b in ids])
        graph=coo_matrix((np.ones(len(pairs)),(pairs[:,0],pairs[:,1])),shape=(len(mesh.xyz),len(mesh.xyz)))
        self.assertEqual(connected_components(graph,directed=False,return_labels=False),1)
        self.assertTrue(np.all(mesh.xyz[mesh.root,1]==0))
        edges={}
        for tri in mesh.exterior:
            for a,b in zip(tri,np.roll(tri,-1)):
                key=tuple(sorted((int(a),int(b))))
                edges[key]=edges.get(key,0)+1
        for (a,b),count in edges.items():
            self.assertTrue(count==2 or (count==1 and mesh.xyz[a,1]==mesh.xyz[b,1]==0))

    def test_rigid_body_invariance_and_total_mass(self):
        mesh=build_mesh(1); K,M,metadata=assemble(mesh)
        scale=sparse_norm(K)
        for axis in np.eye(3):
            translation=np.tile(np.r_[axis,[0.,0.,0.]],len(mesh.xyz))
            rotation=np.column_stack((np.cross(np.tile(axis,(len(mesh.xyz),1)),mesh.xyz),
                                       np.tile(axis,(len(mesh.xyz),1)))).ravel()
            for motion in (translation,rotation):
                residual=np.linalg.norm(K@motion)/(scale*np.linalg.norm(motion))
                self.assertLess(residual,1e-12)
            self.assertAlmostEqual(float(translation@(M@translation))/metadata['massKg'],1.,places=11)

    def test_published_assets(self):
        verify_assets()


if __name__=='__main__': unittest.main()
