import * as THREE from '../vendor/three.min.js';
import { addMeshTop } from './solids.js';
import { chunkMesh } from './chunks.js';

// Local coordinates are distance down the gallery, distance to the left, height.
// Each block has its own footprint, fracture line and offset crown.
export function pileGeometry(e, random, emit, melt) {
  const edge = 2.5, length = e.len - edge * 2;
  const count = Math.max(5, Math.round(length / 3.3));
  const step = length/count, phase=random()*6.28, sign=random()<.5?-1:1;
  const floor = s => e.fa+(e.fb-e.fa)*s/e.len;
  const trail = s => sign*e.hw*.36*Math.sin(Math.PI*(s-edge)/length)*Math.cos((s-edge)/length*4+phase);
  const world = (s,w,y) => [e.ax+e.dx*s-e.dz*w, y+floor(s), e.az+e.dz*s+e.dx*w];
  function block(s,w,l,b,top,height,shape,pitch=0, lean=0){
    const n=shape===0?7:shape===1?5:6, angle=random()*.55;
    const lower=[],belt=[],crown=[],faces=[];
    for(let i=0;i<n;i++){
      const a=(i+random()*.17)*Math.PI*2/n+angle;
      const u=l*Math.cos(a),v=b*Math.sin(a), fracture=.81+random()*.17;
      const cap=shape===2 && u>0?.63:.93;
      lower.push(world(s+u*.85,w+v*.82,top-height));
      belt.push(world(s+u,w+v,top-height*fracture*.43));
      crown.push(world(s+u*cap,w+v*cap+lean,top+u*pitch+(.5-random())*.10));
    }
    const center=world(s,w+lean,top+.05);
    for(let i=0;i<n;i++){
      const j=(i+1)%n;
      faces.push(...center,...crown[j],...crown[i]);
      if(i>0 && i<n-1)faces.push(...lower[0],...lower[i],...lower[j]);
      for(const [a,b] of [[lower,belt],[belt,crown]]) faces.push(...a[i],...b[i],...a[j],...a[j],...b[i],...b[j]);
    }
    emit(faces);
  }
  // Broad interlocking low crowns take the easy line around the fracture.
  // They overlap at walking height but keep independent sides and undersides.
  for(let j=0;j<=count;j++){
    const s=edge+j*step, w=trail(s), env=Math.sin(Math.PI*j/count);
    block(s,w,step*1.08,2.45,.13+env*(.52+.24*Math.sin(j*.72)),3.6,0,.035*Math.cos(j));
    const side=sign*(Math.cos((s-edge)/length*4+phase)>=0?-1:1);
    // Raised bank across the seam: irregular changes in height for climbing.
    const shelf=side*e.hw*.61;
    block(s,shelf,step*(.77+.42*random()),e.hw*.40,.22+env*(1.2+random()*1.65),6,j%3,(random()-.5)*.33);
    for(const flank of [-1,1]){
      const drift=Math.sin(j*.63+flank*2+phase);
      const wall=flank*(e.hw-.7+.95*drift), top=1.35+env*(2.1+1.4*drift+random()*2.4);
      block(s,wall,step*1.18,2.15,top,top+3.5,2,.18*flank);
      block(s+step*.37*drift,wall+flank*.55,step*(.78+.34*drift),2.1,top+1.8,2.8,1,-.22*flank,-flank*.55);
      for(let k=0;k<3;k++){
        const u=s+(random()-.5)*step, v=wall+flank*(random()-.45);
        block(u,v,.55+random()*.82,.52+random()*.70,top+2.15+random()*.48,1.7,k,.18*(random()-.5));
      }
    }
  }
  // Two buttresses and three overlapping capstones leave a lower passage.
  const s=edge+length*(.38+.23*random()), H=6+random()*1.4;
  for(const side of [-1,1]){
    block(s,side*e.hw*.85,4.2,e.hw*.25,H-1, H+2.4,2,.13*side);
    block(s+side*.8,side*e.hw*.57,3.8,e.hw*.39,H+1.3,2.9,0,.14*side);
  }
  block(s+.4,0,2.8,e.hw*.45,H+1.65,2.1,1,-.15);
  // Lava lies on the depression's bed; adjacent blocks mask covered areas.
  const start=edge+step,end=e.len-edge-step;
  if(end>start) {
    const half=e.hw*.84;
    const a=world(start,-half,-2.1), b=world(end,-half,-2.1);
    const c=world(end,half,-2.1),d=world(start,half,-2.1);
    melt([ ...a,...c,...b,...a,...d,...c ],{e,start,end,half});
  }
}

export function buildPiles(scene,material,sections,random){
  const hot=[],glow=new THREE.MeshBasicMaterial({color:0xff722d,side:THREE.DoubleSide});
  for(const e of sections){
    const faces=[];
    pileGeometry(e,random,block=>{
      faces.push(...block);
      addMeshTop([], .34,{full:block,slope:true,climb:true,roof:true});
    },(surface,zone)=>{
      hot.push(zone);
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(surface,3));
      const m=new THREE.Mesh(g,glow);m.userData.mine=true;scene.add(m);
    });
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(faces,3));
    g.setAttribute('aB',new THREE.Float32BufferAttribute(new Float32Array(faces.length/3*2),2));
    g.computeVertexNormals();const mesh=chunkMesh(g,material);mesh.userData.mine=true;scene.add(mesh);
  }
  return hot;
}
