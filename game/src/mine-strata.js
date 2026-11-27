import * as THREE from '../vendor/three.min.js';
import { mulberry32 } from './noise.js';
import { addMeshTop } from './solids.js';
import { chunkMesh } from './chunks.js';

// Coordinates along a passage: s follows its centreline, w points left.
// Each piece has a clipped footprint and two bevels around its fractured midsection.
function stone(target, section, s, w, length, width, top, thickness, tilt, lean, rng) {
  const corners = [[-1,-.54],[-.65,-1],[.54,-1],[1,-.65],[1,.48],[.61,1],[-.64,1],[-1,.57]];
  const outline = corners.map(([u,v]) => [u * length * (.89 + rng() * .11), v * width * (.9 + rng() * .1)]);
  const shear = (rng() - .5) * .38;
  function ring(scale, height, shift) {
    return outline.map(([u,v]) => {
      const along = s + scale * (u + shear * v);
      const across = w + scale * v + shift;
      return [section.ax + section.dx * along - section.dz * across,
        section.fa + along * (section.fb - section.fa) / section.len + height + tilt * u,
        section.az + section.dz * along + section.dx * across];
    });
  }
  const low = ring(.77, top - thickness, 0);
  const rim = ring(1, top - thickness * .34, lean * .55);
  const high = ring(.83, top, lean);
  const faces = [];
  // Counterclockwise in the horizontal s,w plane points down in world space.
  for (let i = 1; i < high.length - 1; i++) faces.push(...high[0], ...high[i+1], ...high[i], ...low[0], ...low[i], ...low[i+1]);
  for (const [a,b] of [[low,rim],[rim,high]]) {
    for (let i=0; i<a.length; i++) {
      const j=(i+1)%a.length;
      faces.push(...a[i], ...b[i], ...a[j], ...a[j], ...b[i], ...b[j]);
    }
  }
  addMeshTop([], .28, {full:faces, climb:true, slope:true, roof:top-thickness>1.8});
  target.push(...faces);
}

export function buildMineStrata(scene, material, sections, halls, openings, seed) {
  const rng=mulberry32(seed), batches=new Map();
  let stones=0;
  function group(e,s,w) {
    const x=e.ax+s*e.dx-w*e.dz, z=e.az+s*e.dz+w*e.dx;
    const key=Math.floor(x/32)+','+Math.floor(z/32);
    if (!batches.has(key)) batches.set(key,[]);
    return batches.get(key);
  }
  for (const e of sections) {
    if ((!e.from && !e.branch) || e.field || !['main','rough','side'].includes(e.kind) || e.len<(e.branch ? 9 : 14)) continue;
    // Truncate before junctions and around cross-shaft openings.
    const rail=e.kind==='main';
    let side=rng()<.5?-1:1;
    for (let s=e.branch ? Math.min(e.len*.53,8) : 7+rng()*3; s<e.len-3; s+=10+rng()*9) {
      if (rng()<.60) side=-side;
      const x=e.ax+e.dx*s, z=e.az+e.dz*s;
      if (openings.some(p=>Math.hypot(x-p[0],z-p[1])<10 && Math.abs(e.fa-p[2])<30)) continue;
      const target=group(e,s,0);
      // Keep a continuous rail lane on its original -2.6 m offset. On other
      // corridors leave space on the far side for walking around each cluster.
      const root=side*(e.hw-.25);
      const lane=rail && e.hw>6 ? -2.6 : 0;
      const reach=Math.min(e.hw*1.07,Math.abs(root-lane)-1.35);
      const span=Math.min(5.6, s-1, e.len-s-1)*( .70+rng()*.30);
      const type=Math.floor(rng()*4), sign=rng()<.5?-1:1;
      const slab=(ds,dw,l,b,y,h,pitch,lean=0)=>{
        stone(target,e,s+ds,root+side*dw,l,b,y,h,pitch,side*lean,rng); stones++;
      };
      if (type===0) { // Interlocking terraces with two different approaches.
        slab(0,-.1,span,reach,2.2+rng()*1.1,4.7,sign*.22);
        slab(span*.64,-reach*.32,span*.54,reach*.54,1.05,2.7,-sign*.13);
      } else if (type===1) { // Broad cantilever over a walkable lower band.
        const underside=3.9+Math.abs(e.fb-e.fa)/e.len*span;
        slab(0,0,span,reach,underside+1.6,1.6,sign*.10);
        slab(-span*.86,-reach*.10,span*.39,reach*.61,2.0,3.7,.24);
      } else if (type===2) { // A narrow vertical rib and a smaller overlapping foot.
        slab(0,.15,span*.65,reach*.42,e.H*.61,e.H*.61+1,.13,-reach*.35);
        slab(span*.41,-.3,span*.72,reach*.70,1.4,3,sign*.23);
      } else { // A tilted wall shelf and its lower landing.
        slab(-span*.2,-.1,span*.9,reach*.79,2.55,3.9,sign*.46);
        slab(sign*span*.83,-reach*.15,span*.43,reach*.60,1.1,2.5,sign*.12);
      }
    }
  }
  // Off-centre rock groups leave irregular loops in wide chambers. Keep all
  // passage mouths, shafts and the centre of each chamber clear.
  for (const {x,z,y,r,exits} of halls) {
    const angle=rng()*2*Math.PI;
    for (let n=0;n<12;n++) {
      const a=angle+n*Math.PI/6, dx=Math.cos(a),dz=Math.sin(a);
      const cx=x+dx*r*.60,cz=z+dz*r*.60;
      if(exits.some(p=>Math.hypot(cx-p[0],cz-p[1])<r*.59) ||
         openings.some(p=>Math.hypot(cx-p[0],cz-p[1])<7 && Math.abs(y-p[2])<30)) continue;
      const e={ax:cx,az:cz,fa:y,fb:y,len:1,dx:-dz,dz:dx};
      const target=group(e,0,0);
      stone(target,e,0,0,r*.23,r*.15,3+rng()*1.6,6,.22,0,rng);
      stone(target,e,r*.19,r*.045,r*.16,r*.12,1.2,2.6,-.18,0,rng);
      stones+=2;
      break;
    }
  }
  for (const faces of batches.values()) {
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(faces,3));
    g.setAttribute('aB',new THREE.Float32BufferAttribute(new Float32Array(faces.length/3*2),2));
    g.computeVertexNormals();
    const mesh=chunkMesh(g,material);
    mesh.name='Mine strata';
    scene.add(mesh);
  }
  return stones;
}

// Seven cross-sections taper each span into a bowed rock rib. Use the exact
// triangles for walking on the crown, gripping the sides and passing underneath.
export function buildRibs(scene,material,ribs) {
  for (const {a,b,bend,rise,width,gap} of ribs) {
    const len=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const nx=-(b[1]-a[1])/len, nz=(b[0]-a[0])/len;
    const faces=[], rings=[];
    const cuts=gap?[0,.125,.25,.375,.489,.502,.625,.75,.875,1]:[0,.125,.25,.375,.5,.625,.75,.875,1];
    for(let j=0;j<cuts.length;j++){
      const t=cuts[j], bow=Math.sin(t*Math.PI), shoulder=(1-bow)**2;
      const w=width*(.86+1.16*shoulder+.12*Math.sin(j*2.1));
      const thick=2.6+6*shoulder+rise*.3;
      const x=a[0]+(b[0]-a[0])*t+nx*bend*bow,z=a[1]+(b[1]-a[1])*t+nz*bend*bow;
      const y=a[2]+(b[2]-a[2])*t+rise*bow;
      rings.push([[-.78,.0],[.74,0],[1,-.30],[.68,-.83],[-.18,-1],[-1,-.46]]
        .map(([side,h])=>[x+side*w*nx,y+h*thick,z+side*w*nz]));
    }
    for(let j=1;j<rings.length;j++){
      if(gap && j===5) continue;
      const p=rings[j-1],q=rings[j];
      for(let i=0;i<p.length;i++){
        const k=(i+1)%p.length;
        faces.push(...p[i],...q[k],...q[i],...p[i],...p[k],...q[k]);
      }
    }
    for(const [index,invert] of [[0,false],[rings.length-1,true],...(gap?[[4,true],[5,false]]:[])]){
      const ring=rings[index];
      for(let i=1;i<ring.length-1;i++)faces.push(...ring[0],...ring[invert?i:i+1],...ring[invert?i+1:i]);
    }
    addMeshTop([], .38, {full:faces,slope:true,roof:true,climb:true});
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(faces,3));
    g.setAttribute('aB',new THREE.Float32BufferAttribute(new Float32Array(faces.length/3*2),2));
    g.computeVertexNormals();
    const mesh=chunkMesh(g,material);mesh.name='Rock span';mesh.userData.mine=true;scene.add(mesh);
  }
}
