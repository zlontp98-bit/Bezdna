import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { U, mat } from './shaders.js';
import { W, heightAt, normalAt, waterAt, POOLS } from './terrain.js';
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
        vec3 c = mix(vec3(0.70,0.73,0.80), vec3(1.0,0.88,0.74), l);
        c = mix(c, uFogCol, 0.45);
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
    // дымка над нижним уступом и море тумана в шахте
    { y: -40, r: 74, a: 0.22 }, { y: -58, r: 62, a: 0.45 }, { y: -68, r: 62, a: 0.75 }, { y: -82, r: 62, a: 1.0 },
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
          float a = uA * smoothstep(1.0, 0.8, r) * (0.55 + 0.6*n);
          // растворяемся, когда камера проходит сквозь слой
          a *= smoothstep(1.5, 9.0, abs(cameraPosition.y - vW.y));
          vec3 c = uAbyssA * 1.15;
          // свечение из глубины
          c = mix(c, uAbyssB*1.6, smoothstep(-45.0, -85.0, vW.y));
          c += vec3(0.10,0.18,0.22) * smoothstep(0.5, 0.0, r) * step(0.99, uA);
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
      attribute vec4 aUvs;
      varying vec3 vW; varying vec4 vU;
      void main(){
        vW = position; vU = aUvs;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec4 vU;
      void main(){
        float steep = vU.z, u = vU.x, depth = vU.w;
        float spd = mix(0.9, 7.0, steep);
        float v = vU.y - uTime*spd;
        float n1 = vnoise(vec2(u*2.5, v*mix(0.35,0.22,steep)));
        float n2 = vnoise(vec2(u*7.0 + 3.0, v*mix(0.9,0.4,steep)));
        // мелко — светлая бирюза, глубоко — тёмная зелёно-синяя вода
        float dk = smoothstep(0.1, 1.4, depth) * (1.0 - steep);
        vec3 shallow = mix(vec3(0.20,0.50,0.54), vec3(0.36,0.68,0.70), n1);
        vec3 deepC = mix(vec3(0.04,0.17,0.22), vec3(0.07,0.26,0.30), n1);
        vec3 c = mix(shallow, deepC, dk);
        float foam = smoothstep(0.74, 0.9, n2) * (0.35 - dk*0.28) + steep * (0.55 + 0.45*n1);
        foam += smoothstep(0.84, 1.0, abs(u)) * 0.35 * (1.0 - steep*0.5);
        c = mix(c, vec3(0.94,0.98,1.0), clamp(foam, 0.0, 1.0));
        // блики неба на спокойной воде
        vec3 vd = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(vd.y, 0.0), 3.0) * (1.0 - steep);
        c = mix(c, uFogCol*1.05, fres*0.55);
        c = shade(c, vec3(0.0,1.0,0.0), 0.6 + 0.4*shadowAt(vW.xz));
        float a = mix(0.9, 1.0, max(steep, dk)) * smoothstep(1.0, 0.86, abs(u));
        gl_FragColor = vec4(applyFog(c, vW), a);
      }`,
  });
  const n = new THREE.Vector3();
  for (const th of W.STREAMS) {
    const cx = Math.cos(th), cz = Math.sin(th), tx = -cz, tz = cx;
    const pos = [], uvs = [], idx = [];
    let len = 0, prev = null, i = 0;
    const half = 3.5, K = 5; // пять точек поперёк: середина глубокая, края мелкие
    for (let r = 229; r > W.PIT - 6; r -= 0.5, i++) {
      const row = [];
      normalAt(cx * r, cz * r, n, 0.5);
      const steep = 1 - Math.min(1, Math.max(0, (n.y - 0.35) / 0.5));
      const wmid = waterAt(cx * r, cz * r);
      for (let k = 0; k < K; k++) {
        const u = -1 + (2 * k) / (K - 1);
        const x = cx * r + tx * half * u, z = cz * r + tz * half * u;
        const y = heightAt(x, z);
        normalAt(x, z, n, 0.5);
        // на крутом участке вода лежит на камне, на пологом — ровной гладью
        let wy = wmid > -1e8 ? wmid : y + 0.3;
        wy = Math.max(wy, y + n.y * 0.3 + 0.04 - steep * 0.1);
        row.push(x, wy, z);
        uvs.push(u, len, steep, Math.max(0, wy - y));
      }
      if (prev) len += Math.hypot(row[6] - prev[6], row[7] - prev[7], row[8] - prev[8]);
      prev = row;
      pos.push(...row);
      if (i > 0) {
        const a = (i - 1) * K, b = i * K;
        for (let k = 0; k < K - 1; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUvs', new THREE.Float32BufferAttribute(uvs, 4));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, m);
    m.side = THREE.DoubleSide;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }
}

// ---------- чаши под водопадами: гладь воды, пена и брызги ----------
export function buildPools(scene) {
  const water = mat({
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec2 vP;
      void main(){ vP = position.xz; vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uHit;
      varying vec3 vW; varying vec2 vP;
      void main(){
        float r = length(vP);
        float dh = length(vP - uHit);
        // круги от падающей воды
        float ring = sin(dh*22.0 - uTime*6.0) * 0.5 + 0.5;
        float n = vnoise(vW.xz*1.6 + uTime*0.25);
        vec3 c = mix(vec3(0.06,0.26,0.34), vec3(0.22,0.58,0.66), n*0.6 + ring*0.25*smoothstep(0.75,0.1,dh));
        c = mix(c, vec3(0.30,0.66,0.72), smoothstep(0.7, 1.0, r)*0.6);
        float foam = smoothstep(0.42, 0.05, dh) + smoothstep(0.6, 0.85, vnoise(vW.xz*3.0 - uTime*0.4)) * 0.35
                   + smoothstep(0.86, 1.0, r) * 0.6;
        c = mix(c, vec3(0.97,1.0,1.0), clamp(foam, 0.0, 1.0));
        c = shade(c, vec3(0.0,1.0,0.0), 0.6 + 0.4*shadowAt(vW.xz));
        gl_FragColor = vec4(applyFog(c, vW), 0.95 * smoothstep(1.0, 0.94, r));
      }`,
    uniforms: { uHit: { value: new THREE.Vector2() } },
  });
  const spray = mat({
    transparent: true, depthWrite: false,
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aS; varying float vA;
      void main(){
        float t = fract(uTime*(0.35 + aS.w*0.3) + aS.z);
        vec3 p = position + vec3(aS.x, 0.0, aS.y) * (0.4 + t*1.6);
        p.y += t*(2.6 + aS.w*1.5) - t*t*2.2;
        vA = (1.0 - t) * 0.5 * smoothstep(0.0, 0.12, t);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = uPx * (70.0 + 80.0*t) / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(grade(mix(uFogCol, vec3(1.0), 0.75)), vA * smoothstep(0.5, 0.1, d)); }`,
  });
  const disc = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  for (const p of POOLS) {
    const m = water.clone();
    m.uniforms = { ...water.uniforms, uHit: { value: new THREE.Vector2(-p.dx * 0.55, -p.dz * 0.55) } };
    const mesh = new THREE.Mesh(disc, m);
    mesh.position.set(p.x, p.level, p.z);
    mesh.scale.set(5.4, 1, 5.4);
    mesh.renderOrder = 3;
    scene.add(mesh);
    // брызги у подножия
    const N = 26, pos = new Float32Array(N * 3), aS = new Float32Array(N * 4);
    const hx = p.x - p.dx * 3.0, hz = p.z - p.dz * 3.0;
    for (let i = 0; i < N; i++) {
      pos[i * 3] = hx + (Math.random() - 0.5) * 3.2 * Math.abs(p.dz) + (Math.random() - 0.5) * 0.6;
      pos[i * 3 + 1] = p.level + 0.1;
      pos[i * 3 + 2] = hz + (Math.random() - 0.5) * 3.2 * Math.abs(p.dx) + (Math.random() - 0.5) * 0.6;
      aS[i * 4] = Math.random() - 0.5 + p.dx * 0.6; aS[i * 4 + 1] = Math.random() - 0.5 + p.dz * 0.6;
      aS[i * 4 + 2] = Math.random(); aS[i * 4 + 3] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 4));
    const pts = new THREE.Points(g, spray);
    pts.frustumCulled = false; pts.renderOrder = 7;
    scene.add(pts);
  }
  return spray;
}

// ---------- лучи света, падающие в провал ----------
// Каждый луч — полоска, которая всегда развёрнута к камере вокруг оси луча.
export function buildShafts(scene) {
  const rnd = mulberry32(SEED + 77);
  const N = 7;
  const pos = [], A = [], B = [], idx = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * TAU, r = 8 + rnd() * 40;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = -20 - rnd() * 25;
    const w = 3 + rnd() * 7, h = 60 + rnd() * 40, ph = rnd() * 10;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      pos.push(sx, sy, 0); A.push(cx, cy, cz, ph); B.push(w, h);
    }
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 2));
  g.setIndex(idx);
  const m = mat({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aA; attribute vec2 aB;
      varying vec2 vUv; varying float vPh; varying vec3 vW;
      void main(){
        vec3 axis = normalize(uSun);
        vec3 toCam = cameraPosition - aA.xyz;
        vec3 right = normalize(cross(axis, toCam));
        vec3 p = aA.xyz + right * position.x * aB.x + axis * position.y * aB.y * 0.5;
        vUv = position.xy; vPh = aA.w; vW = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying float vPh; varying vec3 vW;
      void main(){
        float edge = smoothstep(1.0, 0.15, abs(vUv.x));
        float len = smoothstep(-1.0, -0.2, vUv.y) * smoothstep(1.0, 0.3, vUv.y);
        float flick = 0.65 + 0.35*sin(uTime*0.35 + vPh) * vnoise(vec2(vUv.x*2.0 + vPh, uTime*0.1));
        float near = smoothstep(4.0, 30.0, distance(vW, cameraPosition));
        float a = edge * len * flick * near * 0.085;
        gl_FragColor = vec4(grade(uSunCol*1.1 + vec3(0.05,0.06,0.08)) * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  scene.add(mesh);
}
