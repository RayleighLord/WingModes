#!/usr/bin/env python3
"""Recompute the shell eigenmodes and their reproducible numerical evidence."""
import argparse
import hashlib
import json
import inspect
from pathlib import Path
import time

import numpy as np
from scipy.sparse import diags, coo_matrix, kron, eye
from scipy.sparse.linalg import eigsh, norm as sparse_norm
from scipy.optimize import linear_sum_assignment

from model import MODEL, build_mesh, assemble

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT/'output'/'numerical'


def solve(mesh, gamma_factor=1.0, count=36, fixed_override=None):
    K, M, meta = assemble(mesh, gamma_factor)
    print('Assembled', json.dumps(meta), flush=True)
    fixed = ((mesh.root[:,None]*6 + np.arange(6)).ravel()
             if fixed_override is None else np.asarray(fixed_override))
    free = np.setdiff1d(np.arange(K.shape[0]), fixed)
    Ku, Mu = K[free][:,free], M[free][:,free]
    symmetry = max(float(sparse_norm(A-A.T)/sparse_norm(A)) for A in (Ku,Mu))
    assert symmetry <= 1e-12, symmetry
    assert np.all(Ku.diagonal()>0)
    D = diags(1/np.sqrt(Ku.diagonal()))
    Ks, Ms = (D@Ku@D).tocsc(), (D@Mu@D).tocsc()
    start = time.perf_counter()
    values, scaled = eigsh(Ks,k=count,M=Ms,sigma=-1.0,which='LM',tol=1e-10,
                          ncv=max(2*count+1,80),v0=np.random.default_rng(521).normal(size=len(free)))
    order = np.argsort(values); values, scaled = values[order], scaled[:,order]
    vectors = np.asarray(D@scaled)
    assert np.all(np.isfinite(values)) and np.all(values>0), values
    vectors /= np.sqrt(np.sum(vectors*(Mu@vectors),axis=0))[None,:]
    kp, mp = Ku@vectors, Mu@vectors
    residuals = np.linalg.norm(kp-mp*values,axis=0)/(np.linalg.norm(kp,axis=0)+values*np.linalg.norm(mp,axis=0))
    orthogonality = float(np.max(np.abs(vectors.T@(Mu@vectors)-np.eye(count))))
    assert np.all(residuals<=1e-6), residuals
    assert orthogonality<=1e-8, orthogonality
    phi = np.zeros((K.shape[0],count)); phi[free] = vectors
    for i in range(count):
        translations = phi[:,i].reshape(-1,6)[:,:3]
        if translations.flat[np.argmax(np.abs(translations))] < 0: phi[:,i] *= -1
    freq = np.sqrt(values)/(2*np.pi)
    meta.update(solveSeconds=time.perf_counter()-start, gammaFactor=gamma_factor,
                symmetryRelativeError=symmetry, residuals=residuals.tolist(),
                maxRelativeResidual=float(residuals.max()),massOrthogonalityError=orthogonality,
                frequenciesHz=freq.tolist(),fixedDofCount=len(fixed),rootDisplacementMax=0.0)
    print('Solved',json.dumps({'factor':mesh.factor,'gamma':gamma_factor,'frequencies':freq.tolist(),
                             'seconds':meta['solveSeconds'],'residual':max(residuals)}),flush=True)
    return phi, freq, meta, M


def checkpoint(mesh,gamma=1.0):
    OUTPUT.mkdir(parents=True,exist_ok=True)
    import pyfe3d, scipy
    identity={'modelSource':file_hash(ROOT/'numerical'/'model.py'),
              'solverSource':hashlib.sha256(inspect.getsource(solve).encode()).hexdigest(),
              'pyfe3d':pyfe3d.__version__,'numpy':np.__version__,'scipy':scipy.__version__,
              'model':MODEL,'factor':mesh.factor,'gamma':gamma,'eigenpairCount':36}
    digest=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    path=OUTPUT/f'modes-f{mesh.factor}-g{gamma:g}-{digest[:12]}.npz'
    if path.exists():
        p=np.load(path)
        metadata=json.loads(str(p['metadata']))
        print('Loaded',path,flush=True)
        return p['phi'],p['frequency'],metadata
    phi,freq,meta,_=solve(mesh,gamma)
    meta['cacheIdentity']=identity
    meta['cacheDigest']=digest
    np.savez_compressed(path,phi=phi,frequency=freq,metadata=json.dumps(meta))
    return phi,freq,meta


def prolongation(coarse,fine):
    """Bilinear material-coordinate interpolation for each conforming shell."""
    lookup={tuple(np.round(p,11)):i for i,p in enumerate(coarse.param)}
    grids=[np.unique(coarse.param[:,j]) for j in range(3)]
    rr,cc,vv=[],[],[]
    def bracket(grid,value):
        hi=min(max(1,int(np.searchsorted(grid,value))),len(grid)-1)
        lo=hi-1; t=(value-grid[lo])/(grid[hi]-grid[lo])
        return ((grid[lo],1-t),(grid[hi],t))
    for row,point in enumerate(fine.param):
        eta,q,v=point
        if v in (0.,1.) or q in (0.,1.): axes=(0,1)
        elif any(abs(q-s)<1e-10 for s in MODEL['sparChordFractions']): axes=(0,2)
        else: axes=(1,2)
        for a,wa in bracket(grids[axes[0]],point[axes[0]]):
            for b,wb in bracket(grids[axes[1]],point[axes[1]]):
                p=point.copy(); p[axes[0]]=a; p[axes[1]]=b
                if p[1] in (0.,1.): p[2]=0.
                col=lookup[tuple(np.round(p,11))]
                rr.append(row); cc.append(col); vv.append(wa*wb)
    scalar=coo_matrix((vv,(rr,cc)),shape=(len(fine.xyz),len(coarse.xyz))).tocsr()
    assert np.max(np.abs(np.asarray(scalar.sum(axis=1)).ravel()-1))<1e-12
    return kron(scalar,eye(6),format='csr')


def compare(coarse,fine,cp,fp,cf,ff,M):
    interpolated=prolongation(coarse,fine)@cp
    cross=interpolated.T@(M@fp)
    ca=np.sum(interpolated*(M@interpolated),axis=0); fa=np.sum(fp*(M@fp),axis=0)
    mac=cross**2/(ca[:,None]*fa[None,:])
    rows,cols=linear_sum_assignment(-mac)
    match=np.empty(len(rows),dtype=int); match[rows]=cols
    # Reporting by the fine (exported) ascending mode order.
    inv=np.argsort(match)
    changes=np.abs(cf[inv[:24]]-ff[:24])/ff[:24]
    individual=mac[inv[:24],np.arange(24)]
    scores=individual.copy()
    clusters=[]; start=0
    for stop in range(1,len(ff)+1):
        if stop<len(ff) and (ff[stop]-ff[stop-1])/ff[stop-1]<.01: continue
        if stop-start>1 and start<24:
            fi=np.arange(start,stop); ci=inv[fi]
            C=interpolated[:,ci]; F=fp[:,fi]
            gc=C.T@(M@C); gf=F.T@(M@F)
            ec,uc=np.linalg.eigh(gc); ef,uf=np.linalg.eigh(gf)
            wc=(uc/np.sqrt(ec))@uc.T; wf=(uf/np.sqrt(ef))@uf.T
            singular=np.linalg.svd(wc@(C.T@(M@F))@wf,compute_uv=False)
            score=float(np.min(singular)**2)
            scores[start:min(stop,24)]=score
            clusters.append({'fineIndices':(fi+1).tolist(),'coarseIndices':(ci+1).tolist(),
                             'minimumSquaredPrincipalCosine':score})
        start=stop
    report={'relativeFrequencyChanges':changes.tolist(),'massWeightedMAC':scores.tolist(),
            'individualMAC':individual.tolist(),'nearRepeatedSubspaces':clusters,
            'matchedCoarseIndices':(inv[:24]+1).tolist(),
            'maxFrequencyChangeFirst6':float(changes[:6].max()),
            'maxFrequencyChangeFirst24':float(changes.max()),'minimumMAC':float(scores.min()),
            'comparison':'Coarse modes bilinearly interpolated in shell material coordinates; full consistent fine mass metric'}
    report['passed']=bool(np.all(changes[:6]<=.01) and np.all(changes<=.02) and np.all(scores>=.95))
    return report


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--factor',type=int,help='Solve and cache one mesh refinement factor')
    parser.add_argument('--gamma',type=float,default=1.0)
    parser.add_argument('--verify-existing',action='store_true')
    args=parser.parse_args()
    if args.verify_existing:
        from test_model import verify_assets
        verify_assets(); return
    if args.factor:
        checkpoint(build_mesh(args.factor),args.gamma)
    else:
        run_complete()


def run_complete():
    from test_model import plate_benchmark, verify_assets
    benchmark=plate_benchmark()
    history=[]; previous=None
    for factor in (1,2,4,6,8,10,12,16):
        mesh=build_mesh(factor)
        phi,freq,meta=checkpoint(mesh)
        history.append(meta)
        if previous is not None:
            cm,cp,cf=previous
            K,M,_=assemble(mesh); del K
            convergence=compare(cm,mesh,cp,phi,cf,freq,M)
            convergence.update(coarseFactor=cm.factor,fineFactor=factor)
            print('Convergence',json.dumps(convergence),flush=True)
            (OUTPUT/f'convergence-{cm.factor}-{factor}.json').write_text(json.dumps(convergence,indent=2)+'\n')
            if convergence['passed']:
                gp,gf,gm=checkpoint(mesh,2.)
                sensitivity=compare(mesh,mesh,phi,gp,freq,gf,M)
                sensitivity['passed']=bool(sensitivity['maxFrequencyChangeFirst24']<=.01 and sensitivity['minimumMAC']>=.95)
                sensitivity['baselineGammaFactor']=1.
                sensitivity['comparisonGammaFactor']=2.
                sensitivity['frequencyTolerance']=.01
                print('Drilling sensitivity',json.dumps(sensitivity),flush=True)
                if sensitivity['passed']:
                    export(mesh,phi,freq,meta,history,convergence,sensitivity,benchmark,gm)
                    verify_assets()
                    return
            del M
        previous=(mesh,phi,freq)
    raise RuntimeError('Mesh schedule exhausted without meeting every acceptance gate; no data published')


def export(mesh,phi,freq,meta,history,convergence,sensitivity,benchmark,drill_metadata):
    """Write portable little-endian buffers only after all numerical gates pass."""
    used=np.unique(mesh.exterior)
    mapping=np.full(len(mesh.xyz),-1,dtype=np.int32); mapping[used]=np.arange(len(used))
    triangles=mapping[mesh.exterior]
    positions=mesh.xyz[used].astype('<f4').astype(float)
    displacement=phi.reshape(-1,6,phi.shape[1])[used,:3,:24].transpose(2,0,1).copy()
    root=np.flatnonzero(mesh.param[used,0]==0)
    displacement[:,root]=0
    displacement/=np.max(np.linalg.norm(displacement,axis=2),axis=1)[:,None,None]
    displacement=displacement.astype('<f4').astype(float)
    a=positions[triangles[:,1]]-positions[triangles[:,0]]
    b=positions[triangles[:,2]]-positions[triangles[:,0]]
    length=np.linalg.norm(a,axis=1)
    ex=a/length[:,None]
    along=np.sum(ex*b,axis=1)
    perpendicular=b-ex*along[:,None]
    height=np.linalg.norm(perpendicular,axis=1)
    areas=length*height/2
    weights=np.bincount(triangles.ravel(),weights=np.repeat(areas/3,3),minlength=len(used))
    modes=[]
    for i,u in enumerate(displacement):
        d1=(u[triangles[:,1]]-u[triangles[:,0]])/length[:,None]
        d2=(u[triangles[:,2]]-u[triangles[:,0]]-d1*along[:,None])/height[:,None]
        aa=np.sum(d1*d1,axis=1); ab=np.sum(d1*d2,axis=1); bb=np.sum(d2*d2,axis=1)
        grad=np.sqrt((aa+bb+np.sqrt((aa-bb)**2+4*ab**2))/2)
        maximum=float(grad.max())
        energy=np.sum(weights[:,None]*u*u,axis=0)
        order=np.array([2,0,1]); component=int(order[np.argmax(energy[order])])
        modes.append({'index':i+1,'frequencyHz':float(freq[i]),'colorComponent':component,
                      'colorMax':float(np.max(np.abs(u[:,component]))),
                      'displayAmplitudeM':min(.06*MODEL['semispanM'],.249/maximum),
                      'maxTriangleGradientNorm':maximum})
    arrays={'positions':np.asarray(positions,dtype='<f4'),
            'uvs':np.asarray(mesh.param[used][:,[1,0]],dtype='<f4'),
            'triangles':np.asarray(triangles,dtype='<u4'),
            'displacements':np.asarray(displacement,dtype='<f4')}
    from test_model import audit_display_geometry
    display_audit=audit_display_geometry({'vertexCount':len(used),'modes':modes},arrays)
    destination=ROOT/'public'/'data'; destination.mkdir(parents=True,exist_ok=True)
    buffers={}
    for name,array in arrays.items():
        path=destination/f'{name}.bin'; array.tofile(path)
        buffers[name]={'url':path.name,'sha256':file_hash(path),'length':int(array.size)}
    source_paths=['numerical/model.py','numerical/generate.py','numerical/test_model.py','numerical/requirements.txt']
    report={'schemaVersion':1,'passed':True,'model':MODEL,
            'formulation':{'library':'pyfe3d 0.10.0','quads':'Quad4, mixed integration, physical drilling model 0',
                           'triangles':'Tria3DSG at collapsed rib ends','mass':'Consistent; physical rotary inertia',
                           'eigensolver':'SciPy eigsh shift-invert, sigma=-1, diagonal congruence scaling',
                           'computedEigenpairs':36,'publishedModes':24},
            'acceptance':{'relativeResidual':1e-6,'massOrthogonality':1e-8,'matrixSymmetry':1e-12,
                          'frequencyChangeFirst6':.01,'frequencyChangeFirst24':.02,'MAC':.95,
                          'drillingFrequencySensitivity':.01},
            'sourceSha256':{p:file_hash(ROOT/p) for p in source_paths},'meshHistory':history,
            'finalMesh':meta,'convergence':convergence,'drillingSensitivity':sensitivity,
            'drillingSolve':drill_metadata,'benchmark':benchmark,'buffers':buffers,
            'displayGeometry':display_audit,
            'export':{'vertexCount':len(used),'triangleCount':len(triangles),
                      'axisOrder':['chordwise','spanwise','vertical'],
                      'displacementNormalization':'Per-mode maximum exterior translation vector norm equals one',
                      'amplitudeLimit':'Minimum of 6 percent of semispan and 0.25 divided by maximum surface displacement gradient',
                      'rootDisplacementMax':0.0}}
    docs=ROOT/'docs'; docs.mkdir(exist_ok=True)
    report_path=docs/'numerical-validation.json'
    report_path.write_text(json.dumps(report,indent=2)+'\n')
    results=[
        '# Numerical validation', '',
        f"The published 24 modes come from {meta['elements']:,} shell elements, "
        f"{meta['nodes']:,} nodes and {meta['degreesOfFreedom']:,} total degrees of freedom. "
        f"The modeled semispan has a structural mass of {meta['massKg']:.6f} kg.", '',
        '| Check | Observed | Acceptance |', '| --- | ---: | ---: |',
        f"| First six frequency changes | {100*convergence['maxFrequencyChangeFirst6']:.4f}% | ≤ 1% |",
        f"| All 24 frequency changes | {100*convergence['maxFrequencyChangeFirst24']:.4f}% | ≤ 2% |",
        f"| Minimum MAC or squared subspace correlation | {convergence['minimumMAC']:.6f} | ≥ 0.95 |",
        f"| Maximum relative eigenpair residual | {meta['maxRelativeResidual']:.3e} | ≤ 1e-6 |",
        f"| Mass orthogonality error | {meta['massOrthogonalityError']:.3e} | ≤ 1e-8 |",
        f"| Relative matrix symmetry error | {meta['symmetryRelativeError']:.3e} | ≤ 1e-12 |",
        f"| Factor-two drilling frequency sensitivity | {100*sensitivity['maxFrequencyChangeFirst24']:.4f}% | ≤ 1% |",
        f"| Independent plate benchmark error | {100*benchmark['maxRelativeError']:.4f}% | < 2% |",
        f"| Maximum display amplitude times gradient norm | {display_audit['maximumAmplitudeTimesGradientNorm']:.6f} | ≤ 0.25 |", '',
        'The convergence comparison interpolates coarse modes onto the fine shell mesh and uses its full consistent mass matrix. '
        'Nearly repeated modes are checked as subspaces. The export audit uses the actual float32 buffers and verifies positive '
        'triangle orientation at five phases; the gradient bound covers the entire oscillation.', '',
        '| Refinement factor | Elements | Nodes | First frequency (Hz) | Mode 24 (Hz) |',
        '| ---: | ---: | ---: | ---: | ---: |',
    ]
    for level in history:
        results.append(f"| {level['spanIntervals']//24} | {level['elements']:,} | {level['nodes']:,} | "
                       f"{level['frequenciesHz'][0]:.6f} | {level['frequenciesHz'][23]:.6f} |")
    results += ['', 'All first 24 ascending modes are retained, including local skin deformation. '
                'Earlier coarse meshes are shown to make their resolution limitations explicit.', '',
                '| Mode | Frequency (Hz) |', '| ---: | ---: |']
    results += [f'| {i+1} | {f:.6f} |' for i,f in enumerate(freq[:24])]
    results += ['', 'This is an idealized, unloaded dry structural model, not a measured aircraft or an aeroelastic flight model. '
                'Animation amplitudes are normalized visualization choices.', '',
                'See [the modeling and reproduction method](numerical-method.md) and '
                '[the machine-readable report](numerical-validation.json) for exact parameters, eigenpair diagnostics, '
                'mode matching, timings and source/buffer SHA-256 hashes.', '']
    (docs/'numerical-validation.md').write_text('\n'.join(results))
    manifest={'schemaVersion':1,'model':dict(MODEL,massKg=meta['massKg']),
              'vertexCount':len(used),'triangleCount':len(triangles),'modeCount':24,
              'rootVertices':root.tolist(),'modes':modes,'buffers':buffers,
              'generation':{'solver':'pyfe3d 0.10.0 / scipy 1.14.1',
                            'validationReportSha256':file_hash(report_path),
                            'frequencyRatiosPreserved':True},
              'validationSummary':{'passed':True,'elements':meta['elements'],
                                   'maxRelativeResidual':meta['maxRelativeResidual'],
                                   'maxFrequencyChange':convergence['maxFrequencyChangeFirst24'],
                                   'minimumMAC':convergence['minimumMAC']}}
    (destination/'wing.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Published validated assets',json.dumps(manifest['validationSummary']),flush=True)


if __name__=='__main__': main()
