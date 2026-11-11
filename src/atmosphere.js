import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { U, mat } from './shaders.js';
import { W, heightAt, normalAt } from './terrain.js';
import { part, merge, T } from './flora.js';

const TAU = Math.PI * 2;

// ---------- небо ----------
export function buildSky(scene) {
  const m = mat({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: /* glsl */ `
      varying vec3 vD;
      void main(){
        vD = position;
        vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vD;
      void main(){
        vec3 d = normalize(vD);
        float t = max(d.y, 0.0);
        vec3 c = mix(uFogCol, uZenith, pow(t, 0.55));
        // тёплое сияние вокруг солнца
        float s = max(dot(d, uSun), 0.0);
        c += (uSunCol*1.3 + 0.15) * (pow(s, 6.0)*0.22 + pow(s, 60.0)*0.35);
        c += vec3(1.0, 0.95, 0.85) * smoothstep(0.9990, 0.9996, s);
        // под горизонтом — туман провала
        float below = smoothstep(0.0, -0.35, d.y);
        c = mix(c, mix(uAbyssA, uAbyssB, smoothstep(-0.3, -0.9, d.y)), below);
        gl_FragColor = vec4(grade(c), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), m);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
}

// ---------- облака: пухлые низкополигональные ----------
export function buildClouds(scene) {
  const rnd = mulberry32(SEED + 3);
  const b = new THREE.IcosahedronGeometry(1, 1);
  const geo = merge([
    part(b, 0xffffff, { m: T(0, 0, 0, 1.5, 0.8, 1.2), round: new THREE.Vector3(0, -0.6, 0) }),
    part(b, 0xffffff, { m: T(1.4, -0.1, 0.2, 1.1, 0.6, 0.9), round: new THREE.Vector3(1.4, -0.6, 0) }),
    part(b, 0xffffff, { m: T(-1.5, -0.15, -0.1, 1.2, 0.6, 1.0), round: new THREE.Vector3(-1.5, -0.6, 0) }),
    part(b, 0xffffff, { m: T(0.5, 0.35, -0.3, 0.9, 0.7, 0.8), round: new THREE.Vector3(0.5, -0.4, 0) }),
    part(b, 0xffffff, { m: T(-0.6, 0.3, 0.4, 0.8, 0.6, 0.7), round: new THREE.Vector3(-0.6, -0.4, 0) }),
  ]);
  const m = mat({
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main(){
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz; vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 n = normalize(vN);
        float l = smoothstep(-0.5, 0.7, dot(n, uSun));
        vec3 c = min(uAmbHi*1.5 + uSunCol*l*0.75, vec3(1.0));
        c = mix(c, uFogCol, 0.25);
        gl_FragColor = vec4(grade(c), 1.0);
      }`,
  });
  const N = 16;
  const im = new THREE.InstancedMesh(geo, m, N);
  const d = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + rnd() * 0.3, r = 420 + rnd() * 260;
    d.position.set(Math.cos(a) * r, 190 + rnd() * 120, Math.sin(a) * r);
    d.rotation.y = rnd() * TAU;
    const s = 26 + rnd() * 34;
    d.scale.set(s, s * 0.7, s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  }
  im.frustumCulled = false;
  scene.add(im);
  return im;
}

// ---------- слои тумана в провале ----------
export function buildMist(scene) {
  const layers = [
    { y: -24, r: 84, a: 0.14 }, { y: -50, r: 66, a: 0.2 }, { y: -76, r: 48, a: 0.28 },
    { y: -101, r: 34, a: 0.5 }, { y: -122, r: 27, a: 1.0 },
  ];
  const geo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  for (const L of layers) {
    const m = mat({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uA: { value: L.a } },
      vertexShader: /* glsl */ `
        varying vec3 vW; varying vec2 vP;
        void main(){
          vP = position.xz;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uA;
        varying vec3 vW; varying vec2 vP;
        void main(){
          float r = length(vP);
          float n = vnoise(vW.xz*0.045 + uTime*0.03) * 0.6 + vnoise(vW.xz*0.13 - uTime*0.05) * 0.4;
          float a = uA * smoothstep(1.0, 0.45, r) * (0.55 + 0.6*n);
          // растворяемся, когда камера проходит сквозь слой
          a *= smoothstep(1.5, 9.0, abs(cameraPosition.y - vW.y));
          vec3 c = mix(uAbyssA, uAbyssB, smoothstep(-60.0, -125.0, vW.y)) * 1.12;
          // свечение из глубины
          c += vec3(0.25,0.5,0.6) * smoothstep(0.6, 0.0, r) * step(0.99, uA);
          gl_FragColor = vec4(grade(c), clamp(a, 0.0, 1.0));
        }`,
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.y = L.y;
    mesh.scale.set(L.r, 1, L.r);
    mesh.renderOrder = 5;
    scene.add(mesh);
  }
}

// ---------- светлячки / пыльца ----------
export function buildMotes(scene, count) {
  const rnd = mulberry32(SEED + 21);
  const S = 46;
  const pos = new Float32Array(count * 3), rn = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rnd() * S; pos[i * 3 + 1] = rnd() * 14; pos[i * 3 + 2] = rnd() * S; rn[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aR', new THREE.BufferAttribute(rn, 1));
  const m = mat({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uS: { value: S }, uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform vec3 uCenter; uniform float uS, uPx; attribute float aR;
      varying float vA; varying vec3 vC;
      void main(){
        vec3 p = position;
        p.xz = p.xz + uS * floor((uCenter.xz - p.xz)/uS + 0.5);
        p.y = uCenter.y - 3.0 + mod(position.y + uTime*0.15*(0.5+aR), 14.0);
        p.x += sin(uTime*0.5 + aR*40.0)*1.2; p.z += cos(uTime*0.4 + aR*30.0)*1.2;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float deep = smoothstep(-15.0, -50.0, p.y);
        vC = mix(vec3(1.0,0.95,0.7), vec3(0.5,1.0,0.95), deep);
        vC = mix(vC, vec3(0.85,0.6,1.0), smoothstep(-65.0,-90.0,p.y));
        float tw = 0.5 + 0.5*sin(uTime*(1.0+aR*2.0) + aR*50.0);
        vA = mix(0.22, 0.85, deep) * tw * smoothstep(uS*0.5, uS*0.3, distance(p.xz, uCenter.xz));
        gl_PointSize = uPx * (2.0 + 5.0*aR) * (1.0 + deep) * 6.0 / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying vec3 vC;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.05, d));
      }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  scene.add(pts);
  return m;
}

// ---------- ручьи-каскады ----------
// Лента воды идёт от гор через луг и падает по каждому уступу до самого колодца.
export function buildStreams(scene) {
  const m = mat({
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aUvs;
      varying vec3 vW; varying vec3 vU;
      void main(){
        vW = position; vU = aUvs;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vU;
      void main(){
        float steep = vU.z, u = vU.x;
        float spd = mix(1.6, 7.0, steep);
        float v = vU.y - uTime*spd;
        float n1 = vnoise(vec2(u*2.5, v*mix(0.55,0.22,steep)));
        float n2 = vnoise(vec2(u*7.0 + 3.0, v*mix(1.3,0.4,steep)));
        vec3 c = mix(vec3(0.16,0.56,0.70), vec3(0.42,0.80,0.88), n1);
        float foam = smoothstep(0.62, 0.82, n2) * 0.7 + steep * (0.45 + 0.4*n1);
        foam += smoothstep(0.72, 1.0, abs(u)) * 0.5;
        c = mix(c, vec3(0.96,1.0,1.0), clamp(foam, 0.0, 1.0));
        c = shade(c, vec3(0.0,1.0,0.0), 0.6 + 0.4*shadowAt(vW.xz)) ;
        float a = mix(0.78, 0.95, steep) * smoothstep(1.0, 0.86, abs(u));
        gl_FragColor = vec4(applyFog(c, vW), a);
      }`,
  });
  const n = new THREE.Vector3();
  for (const th of W.STREAMS) {
    const cx = Math.cos(th), cz = Math.sin(th), tx = -cz, tz = cx;
    const pos = [], uvs = [], idx = [];
    let len = 0, prev = null, i = 0;
    const half = 1.9;
    for (let r = 229; r > 6; r -= 0.5, i++) {
      const row = [];
      for (const side of [-1, 1]) {
        const x = cx * r + tx * half * side, z = cz * r + tz * half * side;
        normalAt(x, z, n, 0.5);
        const y = heightAt(x, z);
        row.push(x + n.x * 0.3, y + n.y * 0.3 + 0.05, z + n.z * 0.3);
      }
      normalAt(cx * r, cz * r, n, 0.5);
      const steep = 1 - Math.min(1, Math.max(0, (n.y - 0.35) / 0.5));
      if (prev) len += Math.hypot(row[0] - prev[0], row[1] - prev[1], row[2] - prev[2]);
      prev = row;
      pos.push(...row);
      uvs.push(-1, len, steep, 1, len, steep);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUvs', new THREE.Float32BufferAttribute(uvs, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, m);
    m.side = THREE.DoubleSide;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }
}
