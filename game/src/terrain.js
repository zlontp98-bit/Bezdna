import * as THREE from '../vendor/three.min.js';
import { fbm, smoothstep, clamp } from './noise.js';
import { U, mat } from './shaders.js';

const TAU = Math.PI * 2;

// Форма мира. Сейчас это луг, три пандуса вниз и первое кольцо-терраса,
// за которым обрыв в туман. Следующие кольца добавим позже.
export const W = {
  R: 96,        // радиус края провала
  PITCH: 10,    // шаг уступов по радиусу
  DROP: 13,     // высота одной стены
  ARMS: 3,      // сколько спиральных пандусов
  HOLE: 70,     // край первого кольца: отсюда гигантская стена вниз
  LOW: 48,      // глубина нижнего уступа под стеной
  PIT: 50,      // радиус шахты, уходящей в бездну
  SHELF: [4.55, 1.68], // карниз-спуск по стене: начальный угол и длина дуги (рад)
  MEADOW: 205,  // где луг переходит в горы
  OUTER: 340,   // край мира
  EXT: 232,     // половина стороны квадрата, покрытого текстурами высот/теней
  STREAMS: [2.155, 4.25], // углы, под которыми текут ручьи (сразу за началом пандусов)
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

// то же, но шире: участок стены, который делаем отвесным под водопад
function streamWide(x, z) {
  const r = Math.hypot(x, z);
  if (r > 110 || r < 60) return 0;
  const th = Math.atan2(z, x);
  let c = 0;
  for (const tw of W.STREAMS) c = Math.max(c, smoothstep(6.5, 3.2, Math.abs(angDiff(th, tw)) * r));
  return c;
}

// Чаши под водопадами: { x, z, level } — заполняются перед постройкой сетки
export const POOLS = [];
const warpR = (x, z) => Math.hypot(x, z) + fbm(x * 0.028 + 9, z * 0.028 - 4, 2) * 4.0;

// старая дорога: от лугов к краю, где стоит подъёмник
export const ROAD = [Math.cos(5.80) * 118, Math.sin(5.80) * 118, Math.cos(5.93) * 96.5, Math.sin(5.93) * 96.5];
function segDist(x, z, ax, az, bx, bz) {
  const t = clamp(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2), 0, 1);
  return Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t));
}

// 0..1 — тропинка: от лагеря к пандусу, по пандусам вниз и вокруг по кольцу
export function pathAt(x, z) {
  const r = Math.hypot(x, z);
  if (r < 66 || r > 124) return 0;
  // кусок старой мощёной дороги к подъёмнику на краю
  const road = segDist(x, z, ROAD[0], ROAD[1], ROAD[2], ROAD[3]);
  if (r > 116) return smoothstep(2.3, 1.6, road) * (1 - streamAt(x, z));
  const wr = warpR(x, z);
  let th = Math.atan2(z, x);
  if (th < 0) th += TAU;
  const phi = (W.ARMS * th) / TAU, pf = phi - Math.floor(phi);
  const lv = (W.R - wr) / W.PITCH;
  const wob = fbm(x * 0.15, z * 0.15, 2) * 0.035;
  let m = smoothstep(0.17, 0.09, Math.abs(lv - (pf + 0.31)) + wob) * smoothstep(0.97, 0.86, pf);
  if (lv > pf + 1.0) m = Math.max(m, smoothstep(1.5, 0.8, Math.abs(wr - 74.5) + wob * 10));
  // от лагеря до начала пандуса
  const ax = 113, az = 4, bx = 93, bz = 1.2;
  const t = clamp(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2), 0, 1);
  const d = Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t));
  m = Math.max(m, smoothstep(1.7, 0.9, d + wob * 10));
  m = Math.max(m, smoothstep(2.3, 1.6, road + wob * 6));
  return m * (1 - streamAt(x, z));
}

// контрфорсы: край стены гуляет по углу, получаются колонны и ниши
const edgeR = (x, z) => W.HOLE + 0.6 + fbm(x * 0.11 + 7, z * 0.11 - 3, 3) * 3.2;
const pitR = (x, z) => W.PIT + fbm(x * 0.09 - 11, z * 0.09 + 5, 3) * 4.0;
// высота карниза на угле th (или null — карниза нет)
export function shelfAt(th) {
  let t = th - W.SHELF[0];
  if (t < -0.04) t += TAU;
  t /= W.SHELF[1];
  if (t < -0.03 || t > 1.15) return null;
  return -W.DROP - (W.LOW - W.DROP) * clamp(t, 0, 1);
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
  if (mt > 0) {
    // острые хребты и отдельные пики
    const ridge = 1 - Math.abs(fbm(x * 0.009 + 40, z * 0.009, 4));
    const crag = 1 - Math.abs(fbm(x * 0.03 - 7, z * 0.03 + 2, 3));
    m += mt * mt * (16 + ridge * ridge * ridge * 105 + crag * crag * 22 * mt);
  }
  m += smoothstep(W.MEADOW - 30, W.MEADOW + 20, r) * 5;

  // спираль уступов
  const wr = warpR(x, z);
  const st = streamAt(x, z);
  const phi = (W.ARMS * th) / TAU;
  const u = (W.R - wr) / W.PITCH - phi;
  const k = Math.floor(u), f = u - k;
  // у ручья стена отвесная — там падает водопад
  const sw = streamWide(x, z);
  const s = smoothstep(0.62 + 0.2 * sw, 0.95 - 0.04 * sw, f);
  // пока есть только первое кольцо: ниже него спираль не продолжается
  let sp = Math.max(-W.DROP * (k + s + phi), -W.DROP);
  sp += fbm(x * 0.07, z * 0.07, 2) * 0.4 - (1 - s) * f * 0.5;

  // плавное объединение луга и провала, чтобы край был округлым
  const kk = 2.0;
  const hh = clamp(0.5 + (0.5 * (m - sp)) / kk, 0, 1);
  let h = m + (sp - m) * hh - kk * hh * (1 - hh);

  // гигантская стена от первого кольца вниз до нижнего уступа
  if (r < W.HOLE + 8) {
    const er = edgeR(x, z);
    const wall = smoothstep(er + 0.7, er - 0.7, r);
    if (wall > 0) {
      let low = -W.LOW + fbm(x * 0.06, z * 0.06, 2) * 1.6 + fbm(x * 0.3, z * 0.3, 1) * 0.25;
      // карниз: узкая полка вдоль стены, спускается по дуге
      const hs = shelfAt(th);
      if (hs !== null) {
        const band = smoothstep(er - 5.0, er - 4.3, r);
        low += (Math.max(low, hs + fbm(x * 0.4, z * 0.4, 1) * 0.15) - low) * band;
      }
      // шахта в бездну
      low -= smoothstep(pitR(x, z) + 1.0, pitR(x, z) - 1.5, r) * 140;
      h += (low - h) * wall;
    }
  }
  h -= st * 0.6;
  for (const p of POOLS) h -= 1.5 * smoothstep(5.2, 2.0, Math.hypot(x - p.x, z - p.z)); // чаша под водопадом
  return h;
}

// ---- полярная сетка: густая на стенах, редкая в горах ----
const COLS = 256;
const radii = [];
{
  let r = 1;
  while (r < W.PIT - 7) { radii.push(r); r += 3; }
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
  const data = new Uint16Array(N * N * 4);
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
      if (r > W.PIT + 2 && r < 236) {
        normalAt(x, z, n, 0.6);
        m = smoothstep(0.84, 0.94, n.y) * (1 - streamAt(x, z)) * smoothstep(236, 222, r);
      }
      const pth = pathAt(x, z);
      for (const p of POOLS) m *= smoothstep(4.6, 5.6, Math.hypot(x - p.x, z - p.z));
      const o = (j * N + i) * 4;
      data[o] = toHalf(h);
      data[o + 1] = toHalf(m * (1 - pth));
      data[o + 2] = toHalf(pth);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
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
    uniform sampler2D uHmap;
    varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = normalize(vN);
      float camD = distance(vW, cameraPosition);
      float lf = smoothstep(190.0, 50.0, camD);
      float wall = 1.0 - smoothstep(0.5, 0.82, n.y);
      // координата вдоль стены — по ней идут колонны и трещины
      vec2 tg = normalize(vec2(-n.z, n.x) + 1e-4);
      float u = dot(vW.xz, tg);
      float wob = vnoise(vW.xz*0.045)*5.0 + vnoise(vW.xz*0.21)*0.9;
      float y = vW.y + wob;

      // колонны: грани стены повёрнуты чуть по-разному, свет ложится плоскостями
      float col = vnoise(vec2(u*0.16, vW.y*0.018));
      float col2 = vnoise(vec2(u*0.45 + 7.0, vW.y*0.05));
      vec3 nn = n;
      nn.xz += tg * ((col - 0.5)*1.3 + (col2 - 0.5)*0.5) * wall;
      nn.y += (col2 - 0.5) * 0.25 * wall;
      nn = normalize(nn);

      // трещины: тонкие тёмные линии, вытянутые вниз
      float cr = vnoise(vec2(u*0.5, vW.y*0.055 + vnoise(vec2(u*0.2, vW.y*0.1))*0.6));
      float crack = smoothstep(0.05, 0.0, abs(cr - 0.5)) * wall * lf;
      // слои породы
      float band = mix(0.5, smoothstep(0.3, 0.7, fract(y*0.16)), 0.35 + 0.65*lf);
      float ledge = smoothstep(0.88, 0.95, fract(y*0.33)) * lf;

      // палитра камня: тёплая охра наверху, холодный сланец в глубине
      float tone = vnoise(vec2(u*0.04, vW.y*0.03) + vW.xz*0.01);
      vec3 rock = mix(vec3(0.52,0.43,0.35), vec3(0.40,0.34,0.30), band);
      rock = mix(rock, vec3(0.52,0.45,0.36), tone*0.6);
      vec3 deepR = mix(vec3(0.36,0.38,0.44), vec3(0.26,0.28,0.35), band);
      deepR = mix(deepR, vec3(0.36,0.40,0.46), tone*0.5);
      rock = mix(rock, deepR, smoothstep(10.0, 60.0, -vW.y));
      rock = mix(rock, rock*1.25 + 0.03, ledge*(1.0-crack));
      rock *= 0.82 + 0.3*col;
      rock *= 1.0 - crack*0.6;
      // мох и подтёки зелени на стенах: гуще под уступами и в сырых местах
      float moss = smoothstep(0.55, 0.8, vnoise(vec2(u*0.12, vW.y*0.09)) + ledge*0.4 - (1.0-wall)*0.2) * wall;
      vec3 mossC = mix(vec3(0.20,0.30,0.16), vec3(0.14,0.27,0.24), smoothstep(10.0, 45.0, -vW.y));
      rock = mix(rock, mossC, moss*0.75*lf);
      // горы: светлее и холоднее, наверху редкий снег
      vec3 mtn = mix(vec3(0.48,0.46,0.48), vec3(0.36,0.35,0.40), band) * (0.85 + 0.3*col);
      rock = mix(rock, mtn, smoothstep(20.0, 55.0, vW.y));
      float snow = smoothstep(95.0, 115.0, vW.y + wob*2.0) * smoothstep(0.5, 0.8, n.y);

      vec3 grass = grassCol(vW);
      grass = mix(grass, vec3(0.42,0.46,0.28), smoothstep(14.0, 60.0, vW.y));
      float gm = smoothstep(0.72, 0.86, n.y + (vnoise(vW.xz*0.9)-0.5)*0.08);
      gm *= 1.0 - smoothstep(30.0, 60.0, vW.y)*0.95;
      vec3 alb = mix(rock, grass, gm);
      // край обрыва: голая земля и камень перед кромкой
      float pth = texture2D(uHmap, vW.xz/(2.0*uExt)+0.5).b;
      pth = smoothstep(0.35, 0.65, pth + (vnoise(vW.xz*1.3)-0.5)*0.3);
      vec3 dirt = mix(vec3(0.52,0.43,0.32), vec3(0.42,0.35,0.27), vnoise(vW.xz*0.8));
      alb = mix(alb, dirt, pth * gm);
      alb = mix(alb, vec3(0.86,0.88,0.94), snow);

      // в щелях и у подножия стен темнее
      float ao = mix(1.0, 0.8 + 0.2*col2, wall);
      vec3 c = shade(alb, mix(n, nn, 0.9), shadowAt(vW.xz)) * ao;
      gl_FragColor = vec4(applyFog(c, vW), 1.0);
    }`,
});

export function buildTerrain(scene) {
  // место чаш: идём вдоль ручья от края внутрь до подножия стены
  for (const th of W.STREAMS) {
    const cx = Math.cos(th), cz = Math.sin(th);
    let r = W.R + 2;
    while (r > W.HOLE + 8 && rawHeight(cx * r, cz * r) > -11.5) r -= 0.25;
    const pr = r - 3.4;
    POOLS.push({ x: cx * pr, z: cz * pr, level: 0, dx: -cx, dz: -cz, rTop: r + 5.5 });
  }
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      HG[ri * COLS + c] = rawHeight(Math.cos(th) * r, Math.sin(th) * r);
    }
  }

  // уровень воды в чаше — чуть ниже самого низкого берега
  for (const p of POOLS) {
    let lo = 1e9;
    for (let a = 0; a < 16; a++) {
      const x = p.x + Math.cos(a * 0.3927) * 5.3, z = p.z + Math.sin(a * 0.3927) * 5.3;
      if (streamAt(x, z) < 0.2 && Math.hypot(x, z) < Math.hypot(p.x, p.z) + 2) lo = Math.min(lo, heightAt(x, z));
    }
    p.level = lo - 0.12;
  }

  const material = rockMat = terrainMat();
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
// материал скал — им же покрыты островки-столпы
export let rockMat;
