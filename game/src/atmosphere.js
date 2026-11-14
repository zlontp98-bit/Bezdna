import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED, smoothstep } from './noise.js';
import { U, mat } from './shaders.js';
import { W, SRC, SOURCES, POOLS, poolDist, heightAt, normalAt, waterAt } from './terrain.js';
import { part, merge, T } from './flora.js';

const TAU = Math.PI * 2;

// ---------- небо ----------
export function buildSky(scene) {
  const m = mat({
    side: THREE.BackSide, depthWrite: false, depthTest: true,
    vertexShader: /* glsl */ `
      varying vec3 vD;
      void main(){
        vD = position;
        vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w); // у самой дальней плоскости, но не на ней
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
  // небо рисуем после всего непрозрачного: тогда оно закрашивает только пустые пиксели
  sky.renderOrder = 1;
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

// ---------- вода ----------
// Каждый ручей — одна линия от родника в горах до шахты. Ровные участки (русло, заводи)
// рисуются лентой-гладью, а там, где вода падает с уступа, лента прерывается и начинается
// водопад-пелена (waterfall.js). У обоих один цвет и одна пена — вода везде одного стиля.
const DROP = 0.6;  // падение воды на 0.5 м пути, с которого начинается перепад
const FALL = 2.0;  // перепад ниже этого — каскад, вода остаётся лентой

export function buildStreams(scene) {
  const m = mat({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aUvs; attribute vec2 aFoam;
      varying vec3 vW; varying vec4 vU; varying float vFoam; varying float vFade;
      void main(){
        vW = position; vU = aUvs; vFoam = aFoam.x; vFade = aFoam.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec4 vU; varying float vFoam; varying float vFade;
      void main(){
        float steep = vU.z, u = vU.x, depth = vU.w;
        float spd = mix(0.9, 5.0, max(steep, vFoam * 0.6));
        float v = vU.y - uTime*spd;
        float n1 = vnoise(vec2(u*2.5, v*mix(0.35,0.22,steep)));
        float n2 = vnoise(vec2(u*7.0 + 3.0, v*mix(0.9,0.4,steep)));
        // мелко — светлая бирюза, глубоко — тёмная зелёно-синяя вода
        float dk = smoothstep(0.1, 1.4, depth) * (1.0 - steep);
        vec3 shallow = mix(vec3(0.20,0.50,0.54), vec3(0.36,0.68,0.70), n1);
        vec3 deepC = mix(vec3(0.04,0.17,0.22), vec3(0.07,0.26,0.30), n1);
        vec3 c = mix(shallow, deepC, dk);
        // нарисованная вода: переливы и блики; течёт вместе с ручьём (вдоль потока — по v)
        vec3 wt = waterTex(vW.xz, 0.06 + 0.10*steep);
        float wl = dot(wt, vec3(0.30,0.59,0.11));
        c = mix(c, c * (0.6 + 1.15*wl) + (wt - c)*0.2, 0.85 * mix(1.0, 0.5, steep));
        float foam = smoothstep(0.74, 0.9, n2) * (0.35 - dk*0.28) + steep * (0.55 + 0.45*n1);
        // под водопадом вода кипит пеной, ниже по течению пена расходится полосами
        foam += vFoam * smoothstep(0.25 + 0.5*(1.0 - vFoam), 0.9, n1*0.6 + n2*0.5);
        c = mix(c, vec3(0.94,0.98,1.0), clamp(foam, 0.0, 1.0));
        // отражение неба и солнечные блики на ряби — по ним глаз и узнаёт воду
        vec3 vd = normalize(cameraPosition - vW);
        float calm = (1.0 - steep) * (1.0 - vFoam);
        float fres = pow(1.0 - max(vd.y, 0.0), 3.0) * calm;
        c = mix(c, mix(uFogCol, uZenith, 0.35) * 1.1, fres*0.4);
        float sh = shadowAt(vW.xz);
        c = shade(c, vec3(0.0,1.0,0.0), 0.6 + 0.4*sh);
        vec3 nw = normalize(vec3((n1 - 0.5)*0.35, 1.0, (n2 - 0.5)*0.35));
        float spec = pow(max(dot(reflect(-vd, nw), uSun), 0.0), 48.0) * calm * sh;
        c += uSunCol * spec * 1.4;
        float a = mix(0.9, 1.0, max(max(steep, dk), clamp(foam, 0.0, 1.0))) * smoothstep(1.0, 0.86, abs(u)) * smoothstep(0.0, 1.2, vU.y) * vFade;
        gl_FragColor = vec4(applyFog(c, vW), a);
      }`,
  });
  const falls = [];
  for (const s of SOURCES) {
    const th = s.tw, cx = Math.cos(th), cz = Math.sin(th), px = -cz, pz = cx;
    const R = [];
    for (let r = W.SRC_R + SRC.GORGE; r > W.PIT - 6; r -= 0.5) R.push(r);
    const lvl = R.map((r) => { const w = waterAt(cx * r, cz * r); return w > -1e8 ? w : heightAt(cx * r, cz * r) + 0.2; });
    // ширина воды на ряду: насколько далеко в стороны от оси есть вода
    const halfAt = (k) => {
      const r = R[k];
      let hw = 0;
      for (const sg of [-1, 1]) {
        let l = 0.5;
        while (l < 12 && waterAt(cx * r + px * l * sg, cz * r + pz * l * sg) > -1e8) l += 0.5;
        hw = Math.max(hw, l);
      }
      return Math.max(2.5, hw + 0.4);
    };
    // разбиваем на ровные участки и водопады
    const segs = [], foamAt = new Float32Array(R.length);
    let start = 0, i = 0, open = false;
    while (i < R.length - 1) {
      if (lvl[i] - lvl[i + 1] < DROP) { i++; continue; }
      let j = i + 1;
      const calm = (k) => Math.abs(lvl[k] - lvl[k + 1]) < 0.15 && Math.abs(lvl[k + 1] - lvl[k + 2]) < 0.15 && Math.abs(lvl[k + 2] - lvl[k + 3]) < 0.15;
      while (j < R.length - 4 && !calm(j)) j++;
      open = j >= R.length - 4 || lvl[j] < -90; // в шахту: вода уходит в туман
      if (!open && lvl[i] - lvl[j] < FALL) { i++; continue; } // каскад: лента
      segs.push([start, i]);
      const f = { th, lipR: R[i], y0: lvl[i], y1: open ? -110 : lvl[j], open, half: halfAt(i) * 0.74 - 0.2, src: R[i] > W.SRC_R };
      falls.push(f);
      if (open) break;
      // пена ниже места удара струи
      for (let k = j; k < R.length; k++) foamAt[k] = Math.max(foamAt[k], smoothstep(12, 0, R[j] - R[k]) * (f.src ? 1 : 0.75));
      start = j; i = j;
    }
    if (!open) segs.push([start, R.length - 1]);
    // перед кромкой вода разгоняется и светлеет
    for (const f of falls) if (f.th === th) for (let k = 0; k < R.length; k++) {
      const d = R[k] - f.lipR;
      if (d >= 0 && d < 3) foamAt[k] = Math.max(foamAt[k], 0.35 * (1 - d / 3));
    }

    const pos = [], uvs = [], foam = [], idx = [];
    const K = 7;
    let len = 0, vi = 0;
    const n = new THREE.Vector3();
    for (let si = 0; si < segs.length; si++) {
      const [a, b] = segs[si];
      // участок кончается срывом (все, кроме последнего, и «в шахту»)
      const endsFall = si < segs.length - 1 || open;
      let prev = null;
      for (let k = a; k <= b; k++) {
        // перед срывом русло сужается воронкой: вода собирается в струю, а не обрывается
        // ровным прямоугольным краем во всю ширину ручья
        const funnel = endsFall ? 1 - 0.26 * smoothstep(7, 0, (b - k) * 0.5) : 1;
        const r = R[k], wmid = lvl[k], half = halfAt(k) * funnel;
        normalAt(cx * r, cz * r, n, 0.5);
        const wslope = k + 1 < R.length ? Math.abs(lvl[k] - lvl[k + 1]) / 0.5 : 0;
        const steep = smoothstep(0.2, 0.7, wslope);
        const row = [];
        for (let q = 0; q < K; q++) {
          const u = -1 + (2 * q) / (K - 1);
          const x = cx * r + px * half * u, z = cz * r + pz * half * u;
          // гладь ровная поперёк: где берег выше воды, он её закрывает
          row.push(x, wmid, z);
          uvs.push(u, len, steep, Math.max(0, wmid - heightAt(x, z)));
          // в чаше ленты нет: там своя гладь (waterfall.js), на её берегу они плавно сменяют друг друга —
          // две плоскости воды нигде не лежат одна на другой
          let dn = 9;
          for (const p of POOLS) dn = Math.min(dn, poolDist(p, x, z));
          foam.push(foamAt[k], smoothstep(0.8, 1.0, dn));
        }
        if (prev) len += Math.abs(r - R[k - 1]) + Math.abs(wmid - lvl[k - 1]);
        if (prev) for (let q = 0; q < K - 1; q++) idx.push(vi - K + q, vi + q, vi - K + q + 1, vi - K + q + 1, vi + q, vi + q + 1);
        pos.push(...row); vi += K; prev = row;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUvs', new THREE.Float32BufferAttribute(uvs, 4));
    g.setAttribute('aFoam', new THREE.Float32BufferAttribute(foam, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }
  return falls;
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
