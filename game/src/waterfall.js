import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat, U } from './shaders.js';
import { SRC, POOLS, LAKE, poolDist, heightAt } from './terrain.js';
// озеро на дне шахты рисуется той же гладью, что и чаши под водопадами
const lakePool = { x: LAKE.x, z: LAKE.z, level: LAKE.level, rad: LAKE.r + 1.2, src: false };
import { smoothstep } from './noise.js';
import { groundAt } from './solids.js';

// Водопады: пелена воды с кромки по параболе, у подножия — брызги и водяная пыль.
// Список перепадов строит buildStreams; здесь только картинка.
const G = 9.8;

// ---- мокрые скалы: карта сверху 512×512 на весь мир (как карта теней), r — сила, g/b — полоса высот ----
const WN = 512;
let wetData = null;
function wetDisc(x, z, rad, y0, y1) {
  const ext = U.uExt.value, k = WN / (2 * ext);
  if (!wetData) { wetData = new Uint8Array(WN * WN * 4); for (let i = 0; i < WN * WN; i++) { wetData[i * 4 + 1] = 255; wetData[i * 4 + 2] = 0; } }
  const cx = (x + ext) * k, cz = (z + ext) * k, rr = rad * k;
  const enc = (y) => Math.max(0, Math.min(255, Math.round(((y + 220) / 320) * 255)));
  for (let j = Math.max(0, Math.floor(cz - rr)); j <= Math.min(WN - 1, Math.ceil(cz + rr)); j++)
    for (let i = Math.max(0, Math.floor(cx - rr)); i <= Math.min(WN - 1, Math.ceil(cx + rr)); i++) {
      const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / rr;
      if (d > 1) continue;
      const o = (j * WN + i) * 4, w = Math.round(255 * Math.min(1, (1 - d) * 1.6));
      wetData[o] = Math.max(wetData[o], w);
      wetData[o + 1] = Math.min(wetData[o + 1], enc(y0));
      wetData[o + 2] = Math.max(wetData[o + 2], enc(y1));
    }
}
function finishWet() {
  if (!wetData) return;
  const t = new THREE.DataTexture(wetData, WN, WN, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; // высоты нельзя смешивать с соседями
  t.needsUpdate = true;
  U.uWet.value = t;
}

// ---- течение под струёй: ряды всех водопадов в сетке 4 м ----
const FLOW = [], FGRID = new Map(), FC = 4;
function buildFlowGrid() {
  for (const r of FLOW) {
    const R = r.hw + 1;
    for (let gx = Math.floor((r.x - R) / FC); gx <= Math.floor((r.x + R) / FC); gx++)
      for (let gz = Math.floor((r.z - R) / FC); gz <= Math.floor((r.z + R) / FC); gz++) {
        const key = gx + ',' + gz;
        if (!FGRID.has(key)) FGRID.set(key, []);
        FGRID.get(key).push(r);
      }
  }
}
// Сила воды в точке (x, y, z) — у груди героя. out.x/out.z — куда сносит (м/с), out.down — давит вниз (0..1).
export function fallPush(x, y, z, out) {
  out.x = 0; out.z = 0; out.down = 0;
  const list = FGRID.get(Math.floor(x / FC) + ',' + Math.floor(z / FC));
  if (!list) return out;
  let best = 0;
  for (const r of list) {
    const dy = y - r.y;
    if (dy < -1.6 || dy > 1.6) continue;
    const ox = x - r.x, oz = z - r.z;
    const across = Math.abs(ox * r.sd[0] + oz * r.sd[1]);
    if (across > r.hw * 0.9) continue;
    const th = Math.hypot(r.tx, r.tz), hx = th > 1e-3 ? r.tx / th : 0, hz = th > 1e-3 ? r.tz / th : 0;
    if (Math.abs(ox * hx + oz * hz) > 1.3) continue;
    const k = (1 - across / (r.hw * 0.9)) * (1 - Math.abs(dy) / 1.6);
    if (k <= best) continue;
    best = k;
    const sp = r.air ? 1.6 : 2.6; // по камню вода тащит вдоль, в падении — больше давит вниз
    out.x = hx * sp * Math.min(1, k * 2); out.z = hz * sp * Math.min(1, k * 2);
    out.down = Math.min(1, k * 2) * (r.air ? 1 : 0.3);
  }
  return out;
}

export function buildWaterfalls(scene, falls) {
  const sheetMat = mat({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uLip: { value: 2.0 } }, // q (метры пути) на кромке: подход по глади — 2 м
    vertexShader: /* glsl */ `
      attribute vec4 aUv; attribute vec3 aOut; attribute vec2 aEx;
      varying vec3 vW; varying vec4 vUv; varying vec3 vN; varying float vHb; varying vec2 vEx;
      void main(){
        vW = position; vUv = aUv; vHb = aOut.z; vEx = aEx;
        vN = normalize(vec3(aOut.x, 0.35, aOut.y));
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    // Завеса как в стилизованных играх: одна полоса с координатой вдоль пути воды (q — метры пути), шумы бегут вниз
    // с одной скоростью. У кромки — цвет ручья и ровный край во всю его ширину, ниже — мягкие бело-голубые струи,
    // у воды — белые зубцы пены.
    fragmentShader: /* glsl */ `
      uniform float uLip;
      varying vec3 vW; varying vec4 vUv; varying vec3 vN; varying float vHb; varying vec2 vEx;
      void main(){
        float u = vUv.x, q = vUv.y, L = vUv.z, d = vUv.w, flt = vEx.y;
        float t = uTime * 1.6;                                   // м/с вдоль пути, одинаково везде
        // мягкие вертикальные струи: шум сильно растянут вдоль пути воды, три масштаба
        float s1 = vnoise(vec2(u * 5.0 + L * 9.0, q * 0.06 - t * 0.06));
        float s2 = vnoise(vec2(u * 13.0 + 5.0, q * 0.16 - t * 0.16));
        float s3 = vnoise(vec2(u * 31.0 + 2.0, q * 0.45 - t * 0.45));
        float streak = s1 * 0.5 + s2 * 0.33 + s3 * 0.17;
        // на глади вода как в ручье; через пару метров падения — светлая бело-голубая завеса
        float fall = smoothstep(uLip, uLip + 3.5, q) * (1.0 - flt);
        vec3 river = vec3(0.30, 0.62, 0.66), blue = vec3(0.58, 0.82, 0.90), white = vec3(0.93, 0.97, 1.0);
        vec3 c = mix(river, blue, fall);
        c = mix(c, white, smoothstep(0.42, 0.78, streak) * mix(0.35, 0.85, fall));
        // гладкий светлый перегиб через край — прямая чистая кромка
        float lip = smoothstep(1.0, 0.0, abs(q - uLip - 0.35)) * (1.0 - flt);
        c = mix(c, white, lip * 0.45);
        // внизу — белые «зубцы» пены, где завеса врезается в воду
        float teeth = 0.6 + 2.2 * vnoise(vec2(u * 8.0 + L * 3.0, t * 0.35));
        float foamB = smoothstep(teeth + 1.2, teeth, vHb);
        c = mix(c, white, foamB * 0.92);
        c = shade(c, vN, 0.88 + 0.12 * shadowAt(vW.xz));
        // края: у кромки ровные, ниже чуть рваные
        float rag = vnoise(vec2(q * 0.5 - t * 0.5, u < 0.0 ? 3.0 : 11.0));
        float edge = abs(u) + (rag - 0.5) * 0.28 * fall;
        float a = smoothstep(1.0, 0.9, edge);
        a *= L < 0.25 ? 0.3 : mix(0.88, mix(0.72, 0.95, smoothstep(0.3, 0.7, streak)), fall);
        a = max(a, foamB * smoothstep(1.0, 0.9, edge) * 0.95);
        a *= smoothstep(-0.35, 0.1, vHb) * vEx.x;
        gl_FragColor = vec4(applyFog(c, vW), clamp(a, 0.0, 0.95));
      }`,
  });

  const mistMat = mat({
    transparent: true, depthWrite: false, defines: { NO_WET: 1 },
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aS; attribute vec2 aDir;
      varying float vA; varying float vSeed;
      void main(){
        // клуб пыли: поднимается, расползается от струи и тает
        float t = fract(uTime * (0.07 + aS.w * 0.05) + aS.z);
        vec3 p = position + vec3(aDir.x, 0.0, aDir.y) * t * (2.5 + aS.w * 3.0);
        p.y += t * (2.0 + aS.w * 4.0) * aS.x * 0.15;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.5);
        float size = aS.x * (0.55 + t * 0.9);
        vA = sin(t * 3.1416) * aS.y * smoothstep(3.0, 12.0, dist); // вплотную клубы не рисуем: на телефоне это дорого
        vSeed = aS.z * 17.0;
        gl_PointSize = min(uPx * 583.0 * size / dist, 260.0);
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
  const MP = [], MS = [], MD = [], SP = [], SS = [];
  // капли: каждая летит по своей дуге от места удара и пропадает, потом всё сначала
  const sprayMat = mat({
    transparent: true, depthWrite: false, defines: { NO_WET: 1 },
    uniforms: { uPx: mistMat.uniforms.uPx },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aS;
      varying float vA;
      void main(){
        float t = fract(uTime * (0.8 + aS.x * 0.7) + aS.x * 7.13);
        float sp = 1.2 + aS.y * 2.6;
        vec3 p = position + vec3(cos(aS.w), 0.0, sin(aS.w)) * sp * t;
        p.y += (2.0 + aS.y * 3.5) * t - 4.9 * t * t;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.3);
        vA = (1.0 - t) * smoothstep(0.0, 0.08, t) * 0.85 * smoothstep(60.0, 20.0, dist);
        gl_PointSize = clamp(uPx * 583.0 * aS.z / dist, 1.0, 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main(){
        float r = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(grade(vec3(0.92, 0.97, 1.0)), vA * smoothstep(0.5, 0.2, r));
      }`,
  });
  for (const f of falls) {
    const cx = Math.cos(f.th), cz = Math.sin(f.th), px = -cz, pz = cx;
    const outX = -cx, outZ = -cz; // от стены к центру провала
    const H = f.y0 - f.y1, T = Math.sqrt((2 * H) / G), VH = f.open ? 4.2 : f.src ? SRC.VH : 1.6;
    // точка на пелене: o — насколько вода отошла от кромки к центру, l — поперёк
    const P = (o, l) => [cx * (f.lipR - o) + px * l, cz * (f.lipR - o) + pz * l];
    const halfAt = (d) => f.half + Math.min(2.5, H * 0.06) * d;
    // пелена не должна уходить в скалу: если стена выпирает, отодвигаем её ряд вперёд
    const clear = (o, y, hw) => {
      for (let u = -1; u <= 1.001; u += 0.25) {
        const [x, z] = P(o, u * hw);
        if (heightAt(x, z) > y - 0.4) return false;
      }
      return true;
    };
    const COLSN = 11;
    // ряд пелены: центр c, вектор поперёк струи sd (по горизонтали), нормаль nr, доля пути d, высота над гладью hb
    let rows;
    if (f.open) rows = flowPath(f, cx, cz, H, VH);
    else {
      const ROWS = Math.min(56, Math.max(18, Math.round(H * 1.1)));
      rows = [];
      let oPrev = 0;
      for (let i = 0; i < ROWS; i++) {
        const tt = (i / (ROWS - 1)) * T, y = f.y0 - 0.5 * G * tt * tt, d = (f.y0 - y) / H;
        let o = Math.max(VH * tt, oPrev);
        // у самой воды берега не в счёт: струя падает в чашу, а не обходит её края
        if (i > 0 && y > f.y1 + 2.5) for (let k = 0; k < 50 && !clear(o, y, halfAt(d)); k++) o += 0.2;
        oPrev = o;
        const [x, z] = P(o, 0);
        rows.push({ c: [x, y, z], air: 1, tx: 0, ty: -1, tz: 0, sd: [px, pz], nr: [outX, 0, outZ], d, q: Math.sqrt(f.y0 - y + 0.3), hb: y - f.y1 });
      }
      // последний ряд уходит под гладь чаши: линия входа в воду ровная, без щели
      const b = rows[rows.length - 1];
      rows.push({ ...b, c: [b.c[0], f.y1 - 0.4, b.c[2]], d: 1, q: Math.sqrt(f.y0 - f.y1 + 0.7), hb: -0.4 });
    }
    // Подход: пелена начинается на глади ручья за метр до кромки и проявляется, а лента ручья там же тает.
    // q — метры пути от начала подхода: одна и та же скорость течения на глади, на перегибе и в падении.
    {
      const pre = [];
      for (let r = 0.9; r > 0.05; r -= 0.3) {
        pre.push({ c: [cx * (f.lipR + r), f.y0 + 0.03, cz * (f.lipR + r)], air: 0, flat: 1, fade: smoothstep(0.9, 0.2, r), wk: 1, pre: 1,
          tx: outX, ty: 0, tz: outZ, sd: [px, pz], nr: [0, 1, 0], d: 0, q: 2 - r, hb: f.y0 - f.y1 });
      }
      let len = 2;
      for (let i = 0; i < rows.length; i++) {
        if (i) len += Math.hypot(rows[i].c[0] - rows[i - 1].c[0], rows[i].c[1] - rows[i - 1].c[1], rows[i].c[2] - rows[i - 1].c[2]);
        rows[i].q = len;
      }
      rows = pre.concat(rows);
    }
    const NR = rows.length, end = rows[NR - 1];
    const pos = [], uv = [], dir = [], idx = [], exA = [];
    // три слоя: задний (шире, ближе к скале), средний, передний (уже, выгнут вперёд)
    // Слои: 0 — поперечная пелена (вдоль нормали: сбоку струя не превращается в «линию»), 0.5 — тело, 1 — пена спереди.
    // По камню струя растекается шире.
    for (const [L, wAdd, off, bulge] of [[0, 0, 0, 0], [0.5, 0.15, 0, 0.45]]) { // два слоя: меньше перерисовки на телефоне
      const base = pos.length / 3;
      for (const { c, sd, nr, d, q, hb, air, flat = air === 0 ? 1 : 0, fade = 1, wk } of rows) {
        // у кромки пелена ровно той же ширины, что и ручей; по камню ниже струя растекается шире
        const half = (halfAt(d) + (wk ? 0 : wAdd)) * (wk ?? (air === 0 ? 1.35 : 1));
        const nl = Math.hypot(nr[0], nr[2]) || 1;
        for (let j = 0; j < COLSN; j++) {
          const u = -1 + (2 * j) / (COLSN - 1);
          if (L === 0) { // поперёк: ширина вдоль нормали, треть ширины струи
            const w = half * 0.35 * u;
            pos.push(c[0] + nr[0] * w, c[1] + nr[1] * w, c[2] + nr[2] * w);
            uv.push(u, q, L, d); dir.push(sd[0], sd[1], hb); exA.push(fade * (1 - flat), flat);
            continue;
          }
          // на глади и на камне слои лежат вплотную (иначе передний слой висит над водой «плитой»)
          const oo = ((1 - u * u) * bulge * (0.6 + 0.6 * d) + off) * (1 - flat);
          pos.push(c[0] + sd[0] * u * half + nr[0] * oo, c[1] + nr[1] * oo, c[2] + sd[1] * u * half + nr[2] * oo);
          uv.push(u, q, L, d);
          dir.push(nr[0] / nl, nr[2] / nl, hb);
          exA.push(fade, flat);
        }
      }
      for (let i = 0; i < NR - 1; i++)
        for (let j = 0; j < COLSN - 1; j++) {
          const v = base + i * COLSN + j;
          idx.push(v, v + COLSN, v + 1, v + 1, v + COLSN, v + COLSN + 1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 4));
    g.setAttribute('aOut', new THREE.Float32BufferAttribute(dir, 3));
    g.setAttribute('aEx', new THREE.Float32BufferAttribute(exA, 2));
    g.setIndex(idx);
    const sheet = new THREE.Mesh(g, sheetMat);
    sheet.frustumCulled = false;
    sheet.renderOrder = 4;
    scene.add(sheet);
    // куда бьёт струя: чаша под ней рисует здесь кипящую пену и расходящиеся круги
    {
      const hx = end.c[0], hz = end.c[2];
      for (const p of [...POOLS, lakePool]) if (poolDist(p, hx, hz) < 1) (p.splashes ||= []).push({ x: hx, z: hz, rad: halfAt(1) * 0.6 + Math.min(1.5, H * 0.025) });
    }

    // ---- водяная пыль у подножия: чем выше водопад, тем её больше ----
    const big = Math.min(1, H / 45), N = Math.round(10 + 22 * big), hw = halfAt(1);
    const eo = Math.hypot(end.nr[0], end.nr[2]) || 1, ex = end.nr[0] / eo, ez = end.nr[2] / eo;
    const fog = (x, y, z, size, alpha, dx, dz) => { MP.push(x, y, z); MS.push(size, alpha, rnd(), rnd()); MD.push(dx, dz); };
    for (let i = 0; i < N; i++) {
      const a = (rnd() - 0.5) * 2.5, l = (rnd() - 0.5) * 2 * hw, sp = (rnd() - 0.5) * 1.6;
      fog(end.c[0] + ex * a + end.sd[0] * l, f.y1 + 0.3 + rnd() * 1.5 * big, end.c[2] + ez * a + end.sd[1] * l,
        (2 + rnd() * 3) * (0.6 + 1.4 * big), 0.1 + rnd() * 0.14, ex * 0.8 - ez * sp, ez * 0.8 + ex * sp);
    }
    // лёгкая дымка вдоль всей струи: редкие большие клубы, почти прозрачные
    for (let i = 4; i < NR - 2; i += 7) {
      const r = rows[i], hwr = halfAt(r.d), l = (rnd() - 0.5) * 2 * hwr;
      fog(r.c[0] + r.sd[0] * l + r.nr[0] * 1.2, r.c[1] - 1, r.c[2] + r.sd[1] * l + r.nr[2] * 1.2,
        3 + rnd() * 3, 0.05 + rnd() * 0.04, r.nr[0] * 0.3, r.nr[2] * 0.3);
    }
    // ---- брызги: немного капель у места падения и там, где струя бьёт о камень ----
    const spl = (x, y, z, n, k) => {
      for (let i = 0; i < n; i++) { SP.push(x + (rnd() - 0.5) * hw, y + 0.1, z + (rnd() - 0.5) * hw); SS.push(rnd(), rnd() * k, 0.12 + rnd() * 0.16, rnd() * Math.PI * 2); }
    };
    spl(end.c[0], Math.max(f.y1, end.c[1]), end.c[2], Math.round(14 + 20 * big), 1);
    for (const h of rows.hits || []) {
      spl(h[0], h[1], h[2], Math.round(6 + 10 * h[3]), 0.4 + 0.6 * h[3]);
      fog(h[0], h[1] + 0.5, h[2], 2.5 + rnd() * 2, 0.08, 0, 0);
    }
    // ---- мокрые скалы вокруг струи (карта uWet) и течение под струёй ----
    // у кромки камень не темним: иначе вокруг истока грязное пятно; мокро только ниже, где летят брызги
    for (const r of rows) {
      if (!r.pre && r.c[1] < f.y0 - 2) wetDisc(r.c[0], r.c[2], halfAt(r.d) + (r.air ? 1.0 : 1.2), r.c[1] - 2.5, Math.min(r.c[1] + 1.5, f.y0 - 1.5));
      FLOW.push({ x: r.c[0], y: r.c[1], z: r.c[2], hw: halfAt(r.d), sd: r.sd, tx: r.tx, ty: r.ty, tz: r.tz, air: r.air });
    }
  }
  // все клубы и все брызги — по одному вызову отрисовки
  {
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(MP, 3));
    mg.setAttribute('aS', new THREE.Float32BufferAttribute(MS, 4));
    mg.setAttribute('aDir', new THREE.Float32BufferAttribute(MD, 2));
    const mist = new THREE.Points(mg, mistMat);
    mist.frustumCulled = false;
    mist.renderOrder = 9;
    scene.add(mist);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(SP, 3));
    sg.setAttribute('aS', new THREE.Float32BufferAttribute(SS, 4));
    const spray = new THREE.Points(sg, sprayMat);
    spray.frustumCulled = false;
    spray.renderOrder = 8;
    scene.add(spray);
  }
  finishWet();
  buildFlowGrid();
  buildPools(scene);
  return mistMat;
}

// ---- чаши под водопадами: отдельная водная гладь по форме бассейна ----
// Лента ручья внутри чаши гаснет (atmosphere.js), так что вода тут — одна поверхность:
// глубина по дну, пена и круги от места удара струи, тонкая кромка пены у берега.
function buildPools(scene) {
  const m = mat({
    transparent: true, depthWrite: false, defines: { NO_WET: 1 },
    vertexShader: /* glsl */ `
      attribute vec4 aP;
      varying vec3 vW; varying vec4 vP;
      void main(){
        vW = position; vP = aP;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHits[4]; // места ударов струй: x, z, радиус пены (0 — нет)
      varying vec3 vW; varying vec4 vP;
      void main(){
        // ближайшее место удара струи; vP: z — глубина, w — прозрачность у берега
        float r = 1e4, F = 0.0; vec2 dv = vec2(1.0, 0.0);
        for (int i = 0; i < 4; i++) {
          if (uHits[i].z <= 0.0) continue;
          vec2 o = vW.xz - uHits[i].xy; float l = length(o);
          if (l / uHits[i].z < r / max(F, 0.01)) { r = l; F = uHits[i].z; dv = o; }
        }
        float depth = vP.z;
        vec2 dirv = dv / max(r, 0.01);
        float n1 = vnoise(vW.xz * 0.45 + vec2(uTime * 0.13, -uTime * 0.10));
        float n2 = vnoise(vW.xz * 1.5 - vec2(uTime * 0.22, uTime * 0.17) + 7.0);
        float dk = smoothstep(0.1, 1.6, depth);
        vec3 shallow = mix(vec3(0.20, 0.50, 0.54), vec3(0.36, 0.68, 0.70), n1);
        vec3 deepC = mix(vec3(0.04, 0.17, 0.22), vec3(0.07, 0.26, 0.30), n1);
        vec3 c = mix(shallow, deepC, dk);
        // нарисованная вода: переливы и солнечные блики, чуть дрейфуют; вдали усредняются сами
        vec3 wt = waterTex(vW.xz, 0.06);   // та же вода и то же течение, что у ручья: стык не виден
        float wl = dot(wt, vec3(0.30,0.59,0.11));
        c = mix(c, c * (0.6 + 1.15*wl) + (wt - c)*0.2, 0.85);
        // под струёй вода кипит, дальше пена расходится рваными кольцами
        float boil = smoothstep(F * 1.25, F * 0.45, r);
        float ring = vnoise(dirv * 3.0 + vec2(r * 0.8 - uTime * 1.5) + n1 * 1.5);
        float rings = smoothstep(0.52, 0.85, ring) * smoothstep(F * 3.2, F * 0.9, r);
        // круги от удара: расходящиеся кольца, рвутся шумом и тают с расстоянием
        float circ = sin(r * 1.5 - uTime * 2.4 + n1 * 1.2) * 0.5 + 0.5;
        rings += smoothstep(0.86, 0.97, circ) * smoothstep(F * 5.5, F * 1.1, r) * smoothstep(0.25, 0.6, n2) * 0.8;
        float shore = smoothstep(0.30, 0.04, depth) * smoothstep(0.35, 0.75, n2);
        float foam = step(0.01, F) * (boil * (0.65 + 0.5 * n2) + rings * 0.6) + shore * 0.55 + smoothstep(0.8, 0.93, n2) * 0.10 * (1.0 - dk * 0.7);
        foam = clamp(foam, 0.0, 1.0);
        c = mix(c, vec3(0.94, 0.98, 1.0), foam);
        vec3 vd = normalize(cameraPosition - vW);
        float calm = 1.0 - foam;
        float fres = pow(1.0 - max(vd.y, 0.0), 3.0) * calm;
        c = mix(c, mix(uFogCol, uZenith, 0.35) * 1.1, fres * 0.4);
        float sh = shadowAt(vW.xz);
        c = shade(c, vec3(0.0, 1.0, 0.0), 0.6 + 0.4 * sh);
        // рябь: круги от струи качают блик
        float wv = sin(r * 2.4 - uTime * 3.2) * smoothstep(F * 4.0, F, r) * step(0.01, F);
        vec3 nw = normalize(vec3((n1 - 0.5) * 0.35 + dirv.x * wv * 0.12, 1.0, (n2 - 0.5) * 0.35 + dirv.y * wv * 0.12));
        float spec = pow(max(dot(reflect(-vd, nw), uSun), 0.0), 48.0) * calm * sh;
        c += uSunCol * spec * 1.4;
        float a = mix(0.9, 1.0, max(dk, foam)) * vP.w;
        gl_FragColor = vec4(applyFog(c, vW), a);
      }`,
  });
  const NRG = 12, SEG = 48;
  for (const p of [...POOLS, lakePool]) {
    // точка чаши: t — доля радиуса, ph — угол; у истока чаша вытянута вниз по течению
    const pt = (t, ph) => {
      const c = Math.cos(ph), s = Math.sin(ph);
      if (!p.src) return [p.x + c * t * p.rad, p.z + s * t * p.rad];
      // оси чаши: dx,dz — вниз по течению
      const al = -c * t * SRC.POOL / (c > 0 ? 0.55 : 1.3), l = s * t * SRC.POOL;
      return [p.x - p.dx * al - p.dz * l, p.z - p.dz * al + p.dx * l];
    };
    const pos = [], aP = [], idx = [];
    for (let i = 0; i <= NRG; i++) {
      const t = (i / NRG) ** 0.8;
      for (let j = 0; j < SEG; j++) {
        const [x, z] = i === 0 ? [pt(0, 0)[0], pt(0, 0)[1]] : pt(t, (j / SEG) * Math.PI * 2);
        pos.push(x, p.level, z);
        aP.push(0, 0, Math.max(0, p.level - heightAt(x, z)), smoothstep(1.0, 0.8, poolDist(p, x, z)));
      }
    }
    for (let i = 0; i < NRG; i++)
      for (let j = 0; j < SEG; j++) {
        const a = i * SEG + j, b = i * SEG + (j + 1) % SEG, c = a + SEG, d = b + SEG;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aP', new THREE.Float32BufferAttribute(aP, 4));
    g.setIndex(idx);
    const pm = m.clone();
    Object.assign(pm.uniforms, m.uniforms); // общие uTime, свет и туман — те же объекты
    const hs = (p.splashes || []).slice(0, 4);
    pm.uniforms.uHits = { value: [0, 1, 2, 3].map((i) => hs[i] ? new THREE.Vector3(hs[i].x, hs[i].z, hs[i].rad) : new THREE.Vector3()) };
    pm.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, pm);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }
}

// ---- водопад в шахту: путь воды с кромки до озера ----
// Вода падает по параболе; встретив глыбу или уступ, растекается по её верху, стекает вниз по склону
// (к озеру), срывается с края и падает дальше — так до самой глади. Упёрлась в стену — скользит по ней вниз.
export function flowPath(f, cx, cz, H, VH) {
  const DT = 0.025, WALL = 0.8, LIFT = 0.25;
  // начинаем на кромке, на уровне воды ручья (подход по глади строится отдельно, см. buildWaterfalls)
  let x = cx * f.lipR, z = cz * f.lipR, y = f.y0;
  let hx = -cx, hz = -cz, hs = 1.6, vy = 0, air = true; // направление и скорость по горизонтали
  const pts = [[x, y, z, 1]], hits = [];
  let arc = 0, lastX = x, lastY = y, lastZ = z;
  const sup = (px, pz, py) => groundAt(px, pz, py);
  const toLake = (px, pz) => { const l = Math.hypot(px - LAKE.x, pz - LAKE.z) || 1; return [(LAKE.x - px) / l, (LAKE.z - pz) / l]; };
  const inLake = (px, pz) => Math.hypot(px - LAKE.x, pz - LAKE.z) < LAKE.r - 1;
  let noHug = 0, lowY = y, stuck = 0;
  for (let it = 0; it < 40000 && y > LAKE.level; it++) {
    // застряли (долго не опускаемся): на время отключаем прилипание к стене
    if (y < lowY - 0.5) { lowY = y; stuck = 0; } else if (++stuck > 300) { noHug = 200; stuck = 0; }
    noHug--;
    if (air) {
      vy -= G * DT;
      let nx = x + hx * hs * DT, nz = z + hz * hs * DT, ny = y + vy * DT;
      let g = sup(nx, nz, ny);
      if (g - ny > WALL) { // стена или бок глыбы: горизонтальная скорость гаснет, вода скользит вниз
        hs *= 0.3; nx = x; nz = z; g = sup(nx, nz, ny);
        if (g - ny > WALL) { // и на месте внутри камня (под нависающей глыбой): отходим к озеру, вверх не прыгаем
          const [lx, lz] = toLake(x, z);
          x += lx * 0.3; z += lz * 0.3; hx = lx; hz = lz; hs = 1; noHug = 120;
          continue;
        }
      }
      x = nx; z = nz; y = ny;
      // вода липнет к стене: если позади (откуда летит) скала ближе 3 м — прижимаемся к ней и стекаем по ней
      for (let dd = 0.3; dd < 3; dd += 0.3) {
        if (sup(x - hx * dd, z - hz * dd, y) - y > WALL) {
          if (dd > 1.0 && noHug <= 0) {
            // прижимаемся, только если там ещё воздух: иначе вода «возвращалась» на уступ, с которого сорвалась
            const k = (dd - 1.0) * Math.min(1, DT * 3), qx = x - hx * k, qz = z - hz * k;
            if (sup(qx, qz, y) < y - 0.4) { x = qx; z = qz; }
          }
          hs = Math.min(hs, 1.2);
          break;
        }
      }
      g = sup(x, z, y);
      if (g - y > WALL) { const [lx, lz] = toLake(x, z); x += lx * 0.3; z += lz * 0.3; noHug = 120; }
      else if (g >= y - 0.05 && !(inLake(x, z) && g < LAKE.level)) { if (vy < -6) hits.push([x, g, z, Math.min(1, -vy / 25)]); y = g; air = false; vy = 0; hs = Math.max(hs, 1.5); }
    } else {
      // по верху: выбираем направление, где ниже и ближе к озеру, без резких поворотов
      const [lx, lz] = toLake(x, z);
      let best = null;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), st = 0.45;
        const g = sup(x + dx * st, z + dz * st, y + 0.3);
        if (g > y + 0.3) continue; // в гору или в стену
        const sc = (y - g) * 1.2 + 0.35 * (dx * lx + dz * lz) + 0.5 * (dx * hx + dz * hz);
        if (!best || sc > best.sc) best = { sc, dx, dz, g };
      }
      if (!best) { hx = lx; hz = lz; hs = 1.5; air = true; y += 0.3; continue; } // в ямке: перелить через край
      hx = best.dx; hz = best.dz;
      // шаг — ровно на проверенное расстояние: дальше мог оказаться бок соседней глыбы (раньше вода «взлетала» на её верх)
      const step = 0.45;
      const nx = x + hx * step, nz = z + hz * step, g = sup(nx, nz, y + 0.3);
      if (g > y + 0.3) { hx = -hx; hz = -hz; continue; }
      x = nx; z = nz;
      if (g < y - 0.6 || (inLake(x, z) && g < LAKE.level)) { air = true; vy = 0; hs = 1.4; } // край: срывается вниз
      else y = g;
    }
    const dd = Math.hypot(x - lastX, y - lastY, z - lastZ);
    if (dd > 0.9) { arc += dd; pts.push([x, y, z, air ? 1 : 0]); lastX = x; lastY = y; lastZ = z; }
  }
  if (y > LAKE.level) console.warn('waterfall: путь не дошёл до озера', x, y, z);
  pts.push([x, Math.min(y, LAKE.level) - 0.4, z, 1]);
  // сгладить ломаную (на воздухе она и так плавная, на камнях — ступеньки сетки)
  for (let pass = 0; pass < 2; pass++)
    for (let i = 1; i < pts.length - 1; i++)
      for (let c = 0; c < 3; c++) pts[i][c] = pts[i][c] * 0.5 + (pts[i - 1][c] + pts[i + 1][c]) * 0.25;
  // ряды пелены
  const rows = [];
  let sx = -cz, sz = cx, len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], c = pts[i];
    if (i) len += Math.hypot(c[0] - pts[i - 1][0], c[1] - pts[i - 1][1], c[2] - pts[i - 1][2]);
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const th = Math.hypot(tx, tz), tl = Math.hypot(tx, ty, tz) || 1;
    if (th > 0.15 * tl) { sx = -tz / th; sz = tx / th; } // поперёк — по горизонтали к ходу струи
    tx /= tl; ty /= tl; tz /= tl;
    // нормаль пелены: sd × t, где sd = (sx, 0, sz)
    const nx = -sz * ty, ny = sz * tx - sx * tz, nz = sx * ty;
    const nl = Math.hypot(nx, ny, nz) || 1;
    // пусть нормаль смотрит от скалы: вверх, если струя лежит на камне, и к озеру, если падает
    let sgn = ny < -0.01 ? -1 : 1;
    if (Math.abs(ny) < 0.3) { const [lx, lz] = toLake(c[0], c[2]); sgn = nx * lx + nz * lz < 0 ? -1 : 1; }
    rows.push({ c: [c[0], c[1], c[2]], air: c[3], tx, ty, tz, sd: [sx, sz], nr: [nx / nl * sgn, ny / nl * sgn, nz / nl * sgn], d: Math.min(1, (f.y0 - c[1]) / H), q: Math.sqrt(len + 0.3), hb: c[1] - LAKE.level });
  }
  rows.hits = hits;
  return rows;
}
