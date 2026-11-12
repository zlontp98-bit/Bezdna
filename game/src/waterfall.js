import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat } from './shaders.js';
import { W, SOURCES, POOLS, gorgeBed } from './terrain.js';

// Водопады-истоки: пелена воды с кромки скалы в пруд и водяная пыль у подножия.
const G = 9.8, VH = 1.4; // ускорение падения и скорость, с которой вода уходит с кромки

const at = (s, a, l) => {
  const r = W.SRC_R + a, th = s.tw + l / r;
  return [Math.cos(th) * r, Math.sin(th) * r];
};

export function buildWaterfalls(scene) {
  const sheetMat = mat({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aUv; attribute vec2 aOut;
      varying vec3 vW; varying vec4 vUv; varying float vLit;
      void main(){
        vW = position; vUv = aUv;
        // пелена обращена от скалы: на солнечной стороне светлее
        vLit = 0.82 + 0.3 * max(dot(normalize(vec3(aOut.x, 0.35, aOut.y)), uSun), 0.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec4 vUv; varying float vLit;
      void main(){
        float u = vUv.x, q = vUv.y, L = vUv.z, d = vUv.w;
        // q растёт как корень из пройденной высоты: при равномерной прокрутке струи ускоряются
        float f = q * 3.2 - uTime * (1.5 + L * 0.35);
        float n1 = vnoise(vec2(u * 5.0 + L * 11.0, f));
        float n2 = vnoise(vec2(u * 14.0 + L * 3.0, f * 2.3 + 1.7));
        float streak = n1 * 0.65 + n2 * 0.35;
        // у кромки вода ещё прозрачная зеленоватая, ниже — белая от пены
        float aer = smoothstep(0.0, 0.22, d);
        vec3 c = mix(vec3(0.27, 0.47, 0.48), mix(vec3(0.70, 0.76, 0.79), vec3(0.95, 0.97, 0.98), smoothstep(0.38, 0.75, streak)), aer);
        c *= vLit * mix(0.8, 1.0, L);
        // внизу тонет в водяной пыли
        c = mix(c, vec3(0.86, 0.90, 0.92), smoothstep(0.65, 1.0, d) * 0.45);
        float edge = abs(u) + (n2 - 0.5) * 0.5 * (0.25 + d);
        float a = smoothstep(1.0, 0.7, edge);
        // разрывы в пелене, через них видна мокрая скала
        a *= mix(0.95, 0.35 + 0.7 * smoothstep(0.28, 0.7, streak), aer);
        a *= mix(1.0, 0.7, L) * smoothstep(1.0, 0.86, d);
        gl_FragColor = vec4(applyFog(c, vW), clamp(a, 0.0, 1.0));
      }`,
  });

  const mistMat = mat({
    transparent: true, depthWrite: false,
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aS; attribute vec2 aDir;
      varying float vA; varying float vSeed;
      void main(){
        // клуб пыли: поднимается, расползается от струи и тает
        float t = fract(uTime * (0.07 + aS.w * 0.05) + aS.z);
        vec3 p = position + vec3(aDir.x, 0.0, aDir.y) * t * (2.5 + aS.w * 3.0);
        p.y += t * (3.5 + aS.w * 5.0);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.5);
        float size = aS.x * (0.55 + t * 0.9);
        vA = sin(t * 3.1416) * aS.y * smoothstep(1.5, 7.0, dist);
        vSeed = aS.z * 17.0;
        gl_PointSize = min(uPx * 583.0 * size / dist, 900.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying float vSeed;
      void main(){
        vec2 pc = gl_PointCoord - 0.5;
        float r = length(pc);
        float n = vnoise(pc * 3.0 + vSeed);
        float a = vA * smoothstep(0.5, 0.05, r + (n - 0.5) * 0.18);
        gl_FragColor = vec4(grade(mix(uFogCol, vec3(0.96, 0.98, 1.0), 0.65)), a);
      }`,
  });

  const rnd = mulberry32(SEED + 131);
  for (const s of SOURCES) {
    const pool = POOLS.find((p) => p.s === s);
    const y0 = gorgeBed(s, s.lipA) + 0.3, y1 = pool.level;
    const T = Math.sqrt((2 * (y0 - y1)) / G);
    const outX = -Math.cos(s.tw), outZ = -Math.sin(s.tw); // от скалы к пруду

    // ---- пелена: два слоя, задний гуще и ближе к скале ----
    const ROWS = 40, COLSN = 11, pos = [], uv = [], dir = [], idx = [];
    for (const L of [0, 1]) {
      const base = pos.length / 3;
      for (let i = 0; i < ROWS; i++) {
        // первые ряды — гладь на кромке, дальше — падение по параболе
        const k = i / (ROWS - 1);
        const lead = 0.12;
        let a, y, d;
        if (k < lead) {
          const e = k / lead;
          a = s.lipA + 0.9 * (1 - e); y = y0; d = 0;
        } else {
          const tt = ((k - lead) / (1 - lead)) * T;
          a = s.lipA - VH * tt * (L ? 1.12 : 0.92); y = y0 - 0.5 * G * tt * tt; d = (y0 - y) / (y0 - y1);
        }
        const half = 2.6 + 1.8 * d + L * 0.3;
        for (let j = 0; j < COLSN; j++) {
          const u = -1 + (2 * j) / (COLSN - 1);
          // посередине струя выгнута вперёд
          const aa = a - (1 - u * u) * (0.35 + 0.5 * d) * (L ? 1 : 0.6);
          const [x, z] = at(s, aa, u * half);
          pos.push(x, y, z);
          uv.push(u, Math.sqrt(y0 - y + 0.3), L, d);
          dir.push(outX, outZ);
        }
      }
      for (let i = 0; i < ROWS - 1; i++)
        for (let j = 0; j < COLSN - 1; j++) {
          const v = base + i * COLSN + j;
          idx.push(v, v + COLSN, v + 1, v + 1, v + COLSN, v + COLSN + 1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 4));
    g.setAttribute('aOut', new THREE.Float32BufferAttribute(dir, 2));
    g.setIndex(idx);
    const sheet = new THREE.Mesh(g, sheetMat);
    sheet.frustumCulled = false;
    sheet.renderOrder = 4;
    scene.add(sheet);

    // ---- водяная пыль у подножия ----
    const N = 26, mp = new Float32Array(N * 3), aS = new Float32Array(N * 4), md = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const l = (rnd() - 0.5) * 8, a = s.hitA + (rnd() - 0.4) * 2.5;
      const [x, z] = at(s, a, l);
      mp[i * 3] = x; mp[i * 3 + 1] = y1 + 0.3 + rnd() * 1.5; mp[i * 3 + 2] = z;
      aS[i * 4] = 4 + rnd() * 6; aS[i * 4 + 1] = 0.12 + rnd() * 0.14; aS[i * 4 + 2] = rnd(); aS[i * 4 + 3] = rnd();
      // в основном от скалы, немного в стороны
      const sp = (rnd() - 0.5) * 1.6;
      md[i * 2] = outX * 0.8 - outZ * sp; md[i * 2 + 1] = outZ * 0.8 + outX * sp;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aS', new THREE.BufferAttribute(aS, 4));
    mg.setAttribute('aDir', new THREE.BufferAttribute(md, 2));
    const mist = new THREE.Points(mg, mistMat);
    mist.frustumCulled = false;
    mist.renderOrder = 9;
    scene.add(mist);
  }
  return mistMat;
}
