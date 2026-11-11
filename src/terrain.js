import * as THREE from '../vendor/three.min.js';
import { fbm, smoothstep, clamp } from './noise.js';
import { U, mat } from './shaders.js';

const TAU = Math.PI * 2;

// Форма мира. Провал — конус со спиральными уступами-пандусами:
// по уступу можно спокойно спускаться пешком или срезать, спрыгивая вниз.
export const W = {
  R: 96,        // радиус края провала
  PITCH: 10,    // шаг уступов по радиусу
  DROP: 13,     // высота одной стены
  ARMS: 3,      // сколько спиральных пандусов
  HOLE: 20,     // радиус центрального колодца (следующий слой — потом)
  MEADOW: 205,  // где луг переходит в горы
  OUTER: 340,   // край мира
  EXT: 232,     // половина стороны квадрата, покрытого текстурами высот/теней
  STREAMS: [2.2, 5.1], // углы, под которыми текут ручьи-каскады
};

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
};

// 0..1 — насколько точка внутри русла ручья
export function streamAt(x, z) {
  const r = Math.hypot(x, z);
  if (r > 232 || r < 4) return 0;
  const th = Math.atan2(z, x);
  let c = 0;
  for (const tw of W.STREAMS) {
    const d = Math.abs(angDiff(th, tw)) * r;
    c = Math.max(c, smoothstep(3.4, 1.3, d));
  }
  return c;
}

// Аналитическая высота — источник правды, из неё строится сетка
function rawHeight(x, z) {
  const r = Math.hypot(x, z);
  let th = Math.atan2(z, x);
  if (th < 0) th += TAU;

  // луг: мягкие холмы
  let m = 1.2 + fbm(x * 0.011, z * 0.011, 3) * 5.5;
  // горы кольцом вокруг долины
  const mt = smoothstep(W.MEADOW - 30, W.OUTER - 30, r);
  const ridge = 1 - Math.abs(fbm(x * 0.009 + 40, z * 0.009, 4));
  m += mt * mt * (22 + ridge * ridge * 88) + smoothstep(W.MEADOW - 30, W.MEADOW + 20, r) * 5;

  // спираль уступов
  const wr = r + fbm(x * 0.028 + 9, z * 0.028 - 4, 2) * 4.0;
  const phi = (W.ARMS * th) / TAU;
  const u = (W.R - wr) / W.PITCH - phi;
  const k = Math.floor(u), f = u - k;
  const s = smoothstep(0.62, 0.95, f);
  let sp = -W.DROP * (k + s + phi);
  sp += fbm(x * 0.07, z * 0.07, 2) * 0.4 - (1 - s) * f * 0.5;

  // плавное объединение луга и провала, чтобы край был округлым
  const kk = 2.0;
  const hh = clamp(0.5 + (0.5 * (m - sp)) / kk, 0, 1);
  let h = m + (sp - m) * hh - kk * hh * (1 - hh);

  h -= streamAt(x, z) * 0.6;
  // центральный колодец
  h -= smoothstep(W.HOLE + 5, W.HOLE - 3, r) * 150;
  return h;
}

// ---- полярная сетка: густая на стенах, редкая в горах ----
const COLS = 256;
const radii = [];
{
  let r = 1;
  while (r < W.HOLE - 4) { radii.push(r); r += 3; }
  while (r < W.R + 8) { radii.push(r); r += 1.0; }
  while (r < W.MEADOW) { radii.push(r); r += 3; }
  while (r < W.OUTER) { radii.push(r); r += 7; }
  radii.push(W.OUTER);
}
const ROWS = radii.length;
const LUT_STEP = 0.25;
const rowLUT = new Float32Array(Math.ceil(W.OUTER / LUT_STEP) + 2);
{
  let j = 0;
  for (let i = 0; i < rowLUT.length; i++) {
    const r = i * LUT_STEP;
    while (j < ROWS - 2 && radii[j + 1] <= r) j++;
    rowLUT[i] = clamp(j + (r - radii[j]) / (radii[j + 1] - radii[j]), 0, ROWS - 1);
  }
}
const HG = new Float32Array(ROWS * COLS);

// Высота земли в любой точке. Очень дёшево: читает готовую сетку.
// Этим же пользуется физика, поэтому ноги всегда совпадают с картинкой.
export function heightAt(x, z) {
  const r = Math.sqrt(x * x + z * z);
  let th = Math.atan2(z, x);
  if (th < 0) th += TAU;
  let fr;
  if (r >= W.OUTER) fr = ROWS - 1;
  else {
    const li = r / LUT_STEP, i0 = li | 0;
    fr = rowLUT[i0] + (rowLUT[i0 + 1] - rowLUT[i0]) * (li - i0);
  }
  const fc = (th / TAU) * COLS;
  let c0 = fc | 0;
  const tc = fc - c0;
  if (c0 >= COLS) c0 -= COLS;
  const c1 = c0 + 1 >= COLS ? 0 : c0 + 1;
  const r0 = fr | 0, r1 = r0 + 1 >= ROWS ? r0 : r0 + 1, tr = fr - r0;
  const a = HG[r0 * COLS + c0], b = HG[r0 * COLS + c1];
  const c = HG[r1 * COLS + c0], d = HG[r1 * COLS + c1];
  return (a + (b - a) * tc) * (1 - tr) + (c + (d - c) * tc) * tr;
}

const _n = new THREE.Vector3();
export function normalAt(x, z, out = _n, e = 0.5) {
  out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e));
  return out.normalize();
}

// CPU-копия теней, чтобы затенять персонажа и запекать тени деревьев
const SH = 384;
const shadowData = new Uint8Array(SH * SH);
export function shadowAtCPU(x, z) {
  const u = clamp(((x / (2 * W.EXT) + 0.5) * SH) | 0, 0, SH - 1);
  const v = clamp(((z / (2 * W.EXT) + 0.5) * SH) | 0, 0, SH - 1);
  return shadowData[v * SH + u] / 255;
}

function bakeShadows(blobs) {
  const sun = U.uSun.value;
  const hl = Math.hypot(sun.x, sun.z);
  const dx = sun.x / hl, dz = sun.z / hl, tan = sun.y / hl;
  const f = new Float32Array(SH * SH).fill(1);
  const cell = (2 * W.EXT) / SH;
  for (let j = 0; j < SH; j++) {
    const z = (j + 0.5) * cell - W.EXT;
    for (let i = 0; i < SH; i++) {
      const x = (i + 0.5) * cell - W.EXT;
      const r2 = x * x + z * z;
      if (r2 > 235 * 235) continue;
      const y0 = heightAt(x, z) + 0.4;
      let occ = 1;
      // идём лучом к солнцу; чем ближе луч к скале, тем мягче тень
      for (let t = 1.6; t < 150; t *= 1.22) {
        const d = (y0 + t * tan - heightAt(x + dx * t, z + dz * t)) / t;
        if (d * 7 < occ) { occ = d * 7; if (occ <= 0) { occ = 0; break; } }
      }
      f[j * SH + i] = occ;
    }
  }
  // пятна тени под деревьями и камнями, сдвинутые от солнца
  for (const b of blobs) {
    const cx = b.x - dx * b.h * 0.8, cz = b.z - dz * b.h * 0.8;
    const rad = b.r, n = Math.ceil(rad / cell) + 1;
    const ci = ((cx + W.EXT) / cell) | 0, cj = ((cz + W.EXT) / cell) | 0;
    for (let j = cj - n; j <= cj + n; j++) {
      if (j < 0 || j >= SH) continue;
      for (let i = ci - n; i <= ci + n; i++) {
        if (i < 0 || i >= SH) continue;
        const px = (i + 0.5) * cell - W.EXT - cx, pz = (j + 0.5) * cell - W.EXT - cz;
        const q = 1 - smoothstep(0.35, 1, Math.hypot(px, pz) / rad);
        f[j * SH + i] *= 1 - 0.62 * q;
      }
    }
  }
  // лёгкое размытие
  for (let j = 0; j < SH; j++) {
    for (let i = 0; i < SH; i++) {
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) {
        const jj = j + b;
        if (jj < 0 || jj >= SH) continue;
        for (let a = -1; a <= 1; a++) {
          const ii = i + a;
          if (ii < 0 || ii >= SH) continue;
          s += f[jj * SH + ii]; n++;
        }
      }
      shadowData[j * SH + i] = Math.round(clamp(s / n, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(shadowData, SH, SH, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  U.uShadow.value = tex;
}

// Текстура высот для травы: R — высота, G — «здесь растёт трава»
function bakeHeightTexture() {
  const N = 1024;
  const data = new Uint16Array(N * N * 2);
  const cell = (2 * W.EXT) / N;
  const toHalf = THREE.DataUtils.toHalfFloat;
  const n = new THREE.Vector3();
  for (let j = 0; j < N; j++) {
    const z = (j + 0.5) * cell - W.EXT;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * cell - W.EXT;
      const h = heightAt(x, z);
      const r = Math.hypot(x, z);
      let m = 0;
      if (r > W.HOLE + 2 && r < 236) {
        normalAt(x, z, n, 0.6);
        m = smoothstep(0.84, 0.94, n.y) * (1 - streamAt(x, z)) * smoothstep(236, 222, r);
      }
      data[(j * N + i) * 2] = toHalf(h);
      data[(j * N + i) * 2 + 1] = toHalf(m);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  U.uHmap.value = tex;
}

const terrainMat = () => mat({
  vertexShader: /* glsl */ `
    varying vec3 vW; varying vec3 vN;
    void main(){
      vW = position; vN = normal;
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      float d = -vW.y;
      // слоистая порода: полосы идут по высоте и слегка «гуляют»
      float wob = vnoise(vW.xz*0.045)*5.0 + vnoise(vW.xz*0.21)*0.9;
      float y = vW.y + wob;
      // вдали полосы гасим, чтобы не рябило
      float lf = smoothstep(300.0, 70.0, distance(vW, cameraPosition));
      float band = mix(0.5, smoothstep(0.35, 0.65, fract(y*0.21)), 0.25 + 0.75*lf);
      float thin = smoothstep(0.86, 0.93, fract(y*0.55)) * lf * (1.0 - smoothstep(8.0, 26.0, vW.y));
      vec3 rock = mix(vec3(0.66,0.55,0.44), vec3(0.50,0.41,0.36), band);
      rock = mix(rock, vec3(0.80,0.71,0.58), thin*0.55);
      vec3 rockDeep = mix(vec3(0.42,0.44,0.60), vec3(0.30,0.31,0.50), band);
      rockDeep = mix(rockDeep, vec3(0.56,0.66,0.84), thin*0.5);
      rock = mix(rock, rockDeep, smoothstep(22.0, 80.0, d));
      // горы: серый камень и снежные шапки
      vec3 mtn = mix(vec3(0.60,0.57,0.56), vec3(0.52,0.50,0.53), band);
      rock = mix(rock, mtn, smoothstep(18.0, 50.0, vW.y));
      float snow = smoothstep(62.0, 80.0, vW.y + wob*2.0) * smoothstep(0.45, 0.75, n.y);

      vec3 grass = grassCol(vW);
      // в горах трава редеет и желтеет
      grass = mix(grass, vec3(0.56,0.62,0.34), smoothstep(14.0, 60.0, vW.y));
      float gm = smoothstep(0.70, 0.86, n.y + (vnoise(vW.xz*0.9)-0.5)*0.08);
      gm *= 1.0 - smoothstep(40.0, 70.0, vW.y)*0.9;
      vec3 alb = mix(rock, grass, gm);
      alb = mix(alb, vec3(0.94,0.96,1.0), snow);

      vec3 c = shade(alb, n, shadowAt(vW.xz));
      gl_FragColor = vec4(applyFog(c, vW), 1.0);
    }`,
});

export function buildTerrain(scene) {
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      HG[ri * COLS + c] = rawHeight(Math.cos(th) * r, Math.sin(th) * r);
    }
  }

  const material = terrainMat();
  const SECT = 8, per = COLS / SECT;
  const n = new THREE.Vector3();
  for (let s = 0; s < SECT; s++) {
    const pos = new Float32Array(ROWS * (per + 1) * 3);
    const nor = new Float32Array(ROWS * (per + 1) * 3);
    const idx = [];
    let p = 0;
    for (let ri = 0; ri < ROWS; ri++) {
      const r = radii[ri];
      for (let ci = 0; ci <= per; ci++) {
        const c = (s * per + ci) % COLS;
        const th = (c / COLS) * TAU;
        const x = Math.cos(th) * r, z = Math.sin(th) * r;
        pos[p] = x; pos[p + 1] = HG[ri * COLS + c]; pos[p + 2] = z;
        normalAt(x, z, n, r < W.R + 10 ? 0.45 : 1.5);
        nor[p] = n.x; nor[p + 1] = n.y; nor[p + 2] = n.z;
        p += 3;
      }
    }
    for (let ri = 0; ri < ROWS - 1; ri++) {
      for (let ci = 0; ci < per; ci++) {
        const a = ri * (per + 1) + ci, b = a + 1, c = a + per + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }
  bakeHeightTexture();
}

export { bakeShadows };
