import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat, U } from './shaders.js';
import { W, SRC, SOURCES, POOLS, LAKE, poolDist, heightAt, waterAt } from './terrain.js';
// озеро на дне шахты рисуется той же гладью, что и чаши под водопадами
const lakePool = { x: LAKE.x, z: LAKE.z, level: LAKE.level, rad: LAKE.r + 1.2, src: false };
import { smoothstep } from './noise.js';
import { groundAt, solidAt } from './solids.js';

// Вода ручьёв: гладь, водопады и сток по дну шахты — одна лента на ручей; у подножия — брызги и водяная пыль.
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

// ================== ручей целиком: одна лента от родника до озера ==================
// Раньше гладь ручья, каждый водопад и сток по дну были отдельными сетками со своими шейдерами — на стыках
// были видны «куски». Теперь у каждого ручья одна непрерывная полоса: ряды идут по воде от родника,
// через кромку, вниз по стене и по дну шахты до озера. Координата q — метры пути воды: рисунок течёт
// с одной скоростью везде, а вид (гладь или завеса) плавно зависит от крутизны ряда.
const DROP = 0.6;  // падение воды на 0.5 м пути, с которого начинается перепад
const FALL = 2.0;  // перепад ниже этого — каскад, вода остаётся гладью
const COLS = 9;    // точек поперёк ленты
export const STREAMS = [];

// Путь всех ручьёв считается до расстановки растений: деревья и грибы не ставим туда, где течёт вода.
export function planWater() {
  if (STREAMS.length) return STREAMS;
  for (const s of SOURCES) STREAMS.push(planStream(s.tw));
  // точки воды (падение и сток по дну) в сетке 4 м — для waterNear
  for (const st of STREAMS) for (const r of st.rows) {
    if (r.kind === 'flat') continue;
    for (let u = -1; u <= 1.001; u += 0.5) {
      const x = r.c[0] + r.sd[0] * u * r.half, z = r.c[2] + r.sd[1] * u * r.half;
      const key = Math.floor(x / 4) + ',' + Math.floor(z / 4);
      (NEAR.get(key) || NEAR.set(key, []).get(key)).push([x, r.c[1], z]);
    }
  }
  return STREAMS;
}
const NEAR = new Map();
// Течёт ли вода рядом с предметом (x, y, z), у которого ширина rad и высота h: кроны над водопадом не нужны.
export function waterNear(x, y, z, rad, h) {
  const R = rad + 0.8;
  for (let gx = Math.floor((x - R) / 4); gx <= Math.floor((x + R) / 4); gx++)
    for (let gz = Math.floor((z - R) / 4); gz <= Math.floor((z + R) / 4); gz++) {
      const l = NEAR.get(gx + ',' + gz);
      if (l) for (const p of l) if (p[1] > y - 1.5 && p[1] < y + h + 1 && Math.hypot(p[0] - x, p[2] - z) < R) return true;
    }
  return false;
}

function planStream(th) {
  const cx = Math.cos(th), cz = Math.sin(th), px = -cz, pz = cx;
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
  // ровные участки и водопады
  const segs = [], falls = [], foamAt = new Float32Array(R.length);
  let start = 0, i = 0, open = false;
  while (i < R.length - 1) {
    if (lvl[i] - lvl[i + 1] < DROP) { i++; continue; }
    let j = i + 1;
    const calm = (k) => Math.abs(lvl[k] - lvl[k + 1]) < 0.15 && Math.abs(lvl[k + 1] - lvl[k + 2]) < 0.15 && Math.abs(lvl[k + 2] - lvl[k + 3]) < 0.15;
    while (j < R.length - 4 && !calm(j)) j++;
    open = j >= R.length - 4 || lvl[j] < -90; // в шахту: вода падает до самого озера
    if (!open && lvl[i] - lvl[j] < FALL) { i++; continue; } // каскад: гладь
    segs.push([start, i]);
    const f = { th, lipR: R[i], y0: lvl[i], y1: open ? LAKE.level : lvl[j], open, half: halfAt(i), src: R[i] > W.SRC_R, j };
    falls.push(f);
    if (open) break;
    for (let k = j; k < R.length; k++) foamAt[k] = Math.max(foamAt[k], smoothstep(12, 0, R[j] - R[k]) * (f.src ? 1 : 0.75));
    start = j; i = j;
  }
  if (!open) segs.push([start, R.length - 1]);
  // перед кромкой вода разгоняется и светлеет
  for (const f of falls) for (let k = 0; k < R.length; k++) {
    const d = R[k] - f.lipR;
    if (d >= 0 && d < 3) foamAt[k] = Math.max(foamAt[k], 0.35 * (1 - d / 3));
  }
  // ---- ряды: гладь, водопад, гладь, ... ----
  const rows = [];
  for (let si = 0; si < segs.length; si++) {
    const [a, b] = segs[si];
    // после водопада гладь продолжается ниже места удара (вода не течёт назад к стене)
    const after = si > 0 ? rows[rows.length - 1] : null;
    const rStop = after ? Math.hypot(after.c[0], after.c[2]) - 0.6 : 1e9;
    for (let k = a; k <= b; k++) {
      if (R[k] > rStop) continue;
      const slope = Math.abs(lvl[Math.max(a, k - 3)] - lvl[Math.min(b, k + 3)]) / (0.5 * (Math.min(b, k + 3) - Math.max(a, k - 3)) || 1); // по 3 м: ступеньки сетки не мигают
      rows.push({ kind: 'flat', c: [cx * R[k], lvl[k], cz * R[k]], sd: [px, pz], half: halfAt(k), steep: 0.6 * smoothstep(0.25, 0.8, slope), foam: foamAt[k], hb: 99 });
    }
    const f = falls[si];
    if (!f) continue;
    f.i0 = rows.length; // первый ряд водопада
    const fr = f.open ? shaftRows(f, cx, cz, px, pz) : dropRows(f, cx, cz, px, pz);
    for (const r of fr) rows.push(r);
    f.i1 = rows.length - 1;
  }
  finishRows(rows, cx, cz);
  return { th, rows, falls };
}

// Обычный водопад (в чашу или на уступ): парабола с кромки, пелена не уходит в скалу.
function dropRows(f, cx, cz, px, pz) {
  const H = f.y0 - f.y1, T = Math.sqrt((2 * H) / G), VH = f.src ? SRC.VH : 1.6;
  const P = (o, l) => [cx * (f.lipR - o) + px * l, cz * (f.lipR - o) + pz * l];
  const halfAt = (d) => f.half + Math.min(1.0, H * 0.03) * d;
  const clear = (o, y, hw) => {
    for (let u = -1; u <= 1.001; u += 0.25) { const [x, z] = P(o, u * hw); if (heightAt(x, z) > y - 0.4) return false; }
    return true;
  };
  const N = Math.min(56, Math.max(18, Math.round(H * 1.1)));
  const rows = [];
  let oPrev = 0;
  for (let i = 1; i < N; i++) {
    const tt = (i / (N - 1)) * T, y = f.y0 - 0.5 * G * tt * tt, d = (f.y0 - y) / H;
    let o = Math.max(VH * tt, oPrev);
    if (y > f.y1 + 2.5) for (let k = 0; k < 50 && !clear(o, y, halfAt(d)); k++) o += 0.2;
    oPrev = o;
    const [x, z] = P(o, 0);
    rows.push({ kind: 'fall', c: [x, y, z], sd: [px, pz], half: halfAt(d), hb: y - f.y1, drop: f.y0 - y });
  }
  // последний ряд уходит под гладь: линия входа в воду ровная, без щели
  const b = rows[rows.length - 1];
  rows.push({ ...b, c: [b.c[0], f.y1 - 0.4, b.c[2]], hb: -0.4 });
  f.land = [b.c[0], f.y1, b.c[2]];
  return rows;
}

// Водопад в шахту. Вода переливается через кромку и одной ровной завесой стекает вдоль отвесной стены
// до самого дна — без изгибов. Глыбы игрока у стены стоят перед водой: где завеса уходит за камень, она мягко
// тает, а на верху камня — пена и брызги (см. buildWater). На дне вода ручейком бежит к озеру, огибая камни.
function shaftRows(f, cx, cz, px, pz) {
  const H = f.y0 - LAKE.level, VH = 1.6, GAP = 0.7;
  const halfAt = (d) => f.half + Math.min(1.2, H * 0.02) * d;
  const at = (r, l) => [cx * r + px * l, cz * r + pz * l];
  // радиус стены на высоте y (ближайший к центру по всей ширине завесы)
  const wallR = (y, hw) => {
    let rw = 1e9;
    for (let u = -1; u <= 1.001; u += 0.5) {
      let r = Math.max(LAKE.r, f.lipR - 30);
      while (r < f.lipR + 2) { const [x, z] = at(r, u * hw); if (heightAt(x, z) > y) break; r += 0.25; }
      rw = Math.min(rw, r);
    }
    return rw;
  };
  const DY = 0.5, Y = [], RR = [], HW = [];
  let land = null;
  for (let y = f.y0 - DY; y > LAKE.level - 0.3; y -= DY) {
    const d = (f.y0 - y) / H, hw = halfAt(d);
    const tt = Math.sqrt((2 * (f.y0 - y)) / G);
    let r = Math.min(f.lipR - VH * tt, wallR(y, hw) - GAP);
    // у дна «стеной» становится сам пол: не даём завесе прыгать к центру
    if (RR.length && f.y0 - y > 4) r = Math.max(r, RR[RR.length - 1] - 0.4);
    const [gx, gz] = at(r, 0);
    if (heightAt(gx, gz) > y - 0.15 || Math.hypot(gx, gz) < LAKE.r - 1) { land = y; break; }
    Y.push(y); RR.push(r); HW.push(hw);
  }
  // стена неровная: сглаживаем, чтобы завеса шла ровно
  for (let pass = 0; pass < 4; pass++) {
    const t = RR.slice();
    for (let i = 1; i < RR.length - 1; i++) RR[i] = Math.min(t[i], (t[i - 1] + 2 * t[i] + t[i + 1]) / 4);
  }
  // Глыбу у стены (до 10 м от неё) вода обтекает спереди: завеса перекатывается через верх камня,
  // идёт перед ним и ниже плавно прижимается к стене — так её видно. Глыба побольше стоит перед водой.
  const MAXP = 10, free = (r, y, hw) => {
    for (let u = -1; u <= 1.001; u += 0.25) { const [x, z] = at(r, u * hw); if (solidAt(x, y, z, 0.35) || solidAt(x, y - 0.5, z, 0.35)) return false; }
    return true;
  };
  const OQ = RR.map((r, i) => {
    if (free(r, Y[i], HW[i])) return 0;
    for (let o = 0.4; o <= MAXP; o += 0.4) if (free(r - o, Y[i], HW[i])) return o;
    return 0;
  });
  const OS = new Float32Array(RR.length);
  for (let j = 0; j < OQ.length; j++) {
    if (!OQ[j]) continue;
    // над глыбой вода выгибается быстро (перекатывается через верх), под ней — долго и плавно прижимается обратно
    const Ru = 1.5 + OQ[j] * 0.5, Rd = 4 + OQ[j] * 2.2;
    for (let i = Math.max(0, j - 80); i < Math.min(OQ.length, j + 80); i++) {
      const dy = Y[i] - Y[j], x = dy > 0 ? dy / Ru : -dy / Rd;
      if (x < 1) OS[i] = Math.max(OS[i], OQ[j] * (1 - x * x) * (1 - x * x));
    }
  }
  for (let i = 0; i < RR.length; i++) RR[i] -= Math.max(OS[i], OQ[i]);
  // после выгиба завеса могла уйти в пол раньше — обрываем её на полу
  let n = Y.length;
  for (let i = 1; i < n; i++) { const [x, z] = at(RR[i], 0); if (heightAt(x, z) > Y[i] - 0.1) { n = i + 1; break; } }
  const rows = [];
  for (let i = 1; i < n; i++) {
    if (i % 2 && i !== n - 1) continue; // ряд через метр
    const [x, z] = at(RR[i], 0);
    rows.push({ kind: 'fall', c: [x, Y[i], z], sd: [px, pz], half: HW[i], hb: 99, shaft: 1, drop: f.y0 - Y[i] });
  }
  if (!rows.length) return rows;
  // ---- по дну: вода растекается и бежит к озеру, огибая камни ----
  const last = rows[rows.length - 1];
  const x0 = last.c[0], z0 = last.c[2], y0 = heightAt(x0, z0);
  for (const r of rows) r.hb = r.c[1] - y0;
  f.land = [x0, y0, z0];
  const hw0 = last.half;
  const pts = floorPath(x0, z0);
  for (const p of pts) {
    const k = smoothstep(0, 4, p[3]);
    rows.push({ kind: 'run', c: [p[0], p[1] + 0.1, p[2]], half: hw0 * (1 - 0.3 * k), hb: 99, foam: 0.9 * smoothstep(16, 2, p[3]) });
  }
  // в озеро: последний ряд под гладью
  const e = rows[rows.length - 1];
  rows.push({ ...e, kind: 'run', c: [e.c[0], LAKE.level - 0.3, e.c[2]], foam: e.foam });
  f.lake = [e.c[0], e.c[2], e.half];
  return rows;
}

// Путь по дну шахты от места удара до озера: кратчайший обход камней по сетке 0.5 м (Дейкстра).
// Подъём дорого стоит — вода выбирает низины. Возвращает точки [x, y, z, метры пути].
function floorPath(x0, z0) {
  const C = 0.5, ext = Math.hypot(x0 - LAKE.x, z0 - LAKE.z) + 6;
  const minX = Math.min(x0, LAKE.x) - ext * 0.5, minZ = Math.min(z0, LAKE.z) - ext * 0.5;
  const NX = Math.ceil((Math.max(x0, LAKE.x) + ext * 0.5 - minX) / C), NZ = Math.ceil((Math.max(z0, LAKE.z) + ext * 0.5 - minZ) / C);
  const N = NX * NZ, hh = new Float32Array(N), ok = new Uint8Array(N), dist = new Float32Array(N).fill(1e9), from = new Int32Array(N).fill(-1);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = minX + (i + 0.5) * C, z = minZ + (j + 0.5) * C, h = heightAt(x, z), k = j * NX + i;
    hh[k] = h;
    ok[k] = h < -160 && !solidAt(x, h + 0.6, z, 0.5) ? 1 : 0;
  }
  const idx = (x, z) => Math.max(0, Math.min(NZ - 1, Math.floor((z - minZ) / C))) * NX + Math.max(0, Math.min(NX - 1, Math.floor((x - minX) / C)));
  const s0 = idx(x0, z0);
  const heap = [[0, s0]];
  dist[s0] = 0; ok[s0] = 1;
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], e = heap.pop(); if (heap.length) { heap[0] = e; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  let goal = -1;
  while (heap.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const i = k % NX, j = (k / NX) | 0, x = minX + (i + 0.5) * C, z = minZ + (j + 0.5) * C;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r - 1.5) { goal = k; break; }
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) continue;
      const kk = jj * NX + ii;
      // сквозь камень — только если иначе никак (место удара может быть за глыбой у стены)
      const nd = d + C * Math.hypot(di, dj) * (ok[kk] ? 1 : 12) + 4 * Math.max(0, hh[kk] - hh[k]);
      if (nd < dist[kk]) { dist[kk] = nd; from[kk] = k; push([nd, kk]); }
    }
  }
  const cells = [];
  if (goal < 0) { console.warn('waterfall: по дну не дойти до озера'); goal = idx(LAKE.x + (x0 - LAKE.x) * 0.5, LAKE.z + (z0 - LAKE.z) * 0.5); cells.push(goal); }
  else for (let k = goal; k >= 0; k = from[k]) cells.push(k);
  cells.reverse();
  // сгладить и разложить через ~1 м
  let P = cells.map((k) => [minX + ((k % NX) + 0.5) * C, minZ + (((k / NX) | 0) + 0.5) * C]);
  P.unshift([x0, z0]);
  for (let pass = 0; pass < 6; pass++) P = P.map((p, i) => (i === 0 || i === P.length - 1 ? p : [(P[i - 1][0] + 2 * p[0] + P[i + 1][0]) / 4, (P[i - 1][1] + 2 * p[1] + P[i + 1][1]) / 4]));
  const out = [];
  let run = 0, lx = x0, lz = z0;
  for (const [x, z] of P) {
    const d = Math.hypot(x - lx, z - lz);
    if (d < 0.9 && out.length) continue;
    run += d; lx = x; lz = z;
    // низкие плоские камни на дне вода переливает поверху (высокие она обходит — см. ok)
    const h = heightAt(x, z), g = groundAt(x, z, h + 0.7);
    out.push([x, Math.max(g - h < 0.7 ? g : h, LAKE.level), z, run]);
  }
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i < out.length - 1; i++) out[i][1] = (out[i - 1][1] + 2 * out[i][1] + out[i + 1][1]) / 4;
  return out;
}

// Касательные, поперечные векторы, нормали, метры пути, крутизна и кромки — одинаково для всех рядов
function finishRows(rows, cx, cz) {
  let q = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], a = rows[Math.max(0, i - 1)].c, b = rows[Math.min(rows.length - 1, i + 1)].c;
    if (i) q += Math.hypot(r.c[0] - rows[i - 1].c[0], r.c[1] - rows[i - 1].c[1], r.c[2] - rows[i - 1].c[2]);
    r.q = q;
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1, th = Math.hypot(tx, tz);
    tx /= tl; ty /= tl; tz /= tl;
    r.t = [tx, ty, tz];
    // по дну поперёк — по горизонтали к ходу воды; у ручья и завесы — поперёк ручья
    if (r.kind === 'run') {
      let sd = th > 1e-3 ? [-(b[2] - a[2]) / th, (b[0] - a[0]) / th] : rows[i - 1].sd;
      const ps = rows[i - 1].sd;
      if (sd[0] * ps[0] + sd[1] * ps[1] < 0) sd = [-sd[0], -sd[1]]; // без перекрута ленты
      // у подножия поперечник поворачивается плавно: от завесы к ручейку
      let k = 0; while (k < 6 && rows[i - 1 - k]?.kind === 'run') k++;
      if (k < 6) { const t = (k + 1) / 7; sd = [ps[0] * (1 - t) + sd[0] * t, ps[1] * (1 - t) + sd[1] * t]; const l = Math.hypot(sd[0], sd[1]) || 1; sd = [sd[0] / l, sd[1] / l]; }
      r.sd = sd;
    }
    // нормаль: sd × t, смотрит вверх и от стены (к центру шахты)
    const sx = r.sd[0], sz = r.sd[1];
    let nx = -sz * ty, ny = sz * tx - sx * tz, nz = sx * ty;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (ny + 0.5 * (nx * -cx + nz * -cz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    r.n = [nx, ny, nz];
    r.fall = Math.max(r.steep || 0, smoothstep(0.35, 0.8, -ty), smoothstep(1.0, 3.0, r.drop || 0));
    if (r.kind === 'run') r.fall = Math.min(r.fall, 0.25);
  }
  // ширину тоже: на стыке водопада и глади нет ступеньки
  for (let pass = 0; pass < 6; pass++) {
    const h = rows.map((r) => r.half);
    for (let i = 1; i < rows.length - 1; i++) rows[i].half = (h[i - 1] + 2 * h[i] + h[i + 1]) / 4;
  }
  // крутизну сглаживаем по пути: вид воды меняется плавно, а не рывком на одном ряду
  for (let pass = 0; pass < 2; pass++) {
    const f = rows.map((r) => r.fall);
    for (let i = 1; i < rows.length - 1; i++) rows[i].fall = (f[i - 1] + 2 * f[i] + f[i + 1]) / 4;
  }
}

export function buildWater(scene) {
  planWater();
  const waterMat = mat({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aUv; attribute vec4 aEx; attribute vec3 aN;
      varying vec3 vW; varying vec4 vUv; varying vec4 vEx; varying vec3 vN;
      void main(){
        vW = position; vUv = aUv; vEx = aEx; vN = aN;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    // Одна вода: u — поперёк (-1..1), q — метры пути от родника, fall — крутизна (0 гладь, 1 завеса).
    // Рисунок — шум, сильно вытянутый вдоль течения, и сдвигается он с одной скоростью по всему пути:
    // на глади — редкие пенные струйки и блики неба, на перегибе — светлая кромка, в падении — бело-голубые
    // струи, у подножия — белые зубцы пены.
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec4 vUv; varying vec4 vEx; varying vec3 vN;
      void main(){
        float u = vUv.x, q = vUv.y, fall = vUv.z, depth = vUv.w;
        float fade = vEx.x, foamA = vEx.y, hb = vEx.z, lip = vEx.w;
        float qt = q - uTime * 2.4;                      // м/с вдоль пути — одинаково везде
        float s1 = vnoise(vec2(u * 4.0 + 1.7, qt * 0.07));
        float s2 = vnoise(vec2(u * 10.0 + 5.0, qt * 0.19));
        float s3 = vnoise(vec2(u * 24.0 + 2.0, qt * 0.5));
        float streak = s1 * 0.5 + s2 * 0.33 + s3 * 0.17;
        float dk = smoothstep(0.1, 1.4, depth) * (1.0 - fall);
        vec3 shallow = vec3(0.28, 0.59, 0.62), deepC = vec3(0.05, 0.20, 0.25), sheet = vec3(0.55, 0.80, 0.88);
        vec3 white = vec3(0.93, 0.97, 1.0);
        vec3 c = mix(shallow, deepC, dk);
        // на глади — та же нарисованная вода, что в чашах и озере (течёт к центру со скоростью ленты)
        if (fall < 0.98) {
          vec3 wt = waterTex(vW.xz, 0.18);
          float wl = dot(wt, vec3(0.30, 0.59, 0.11));
          c = mix(c, c * (0.6 + 1.15 * wl) + (wt - c) * 0.2, 0.85 * (1.0 - fall));
        }
        c = mix(c, sheet, fall);
        // струи: на глади редкие и тонкие, в падении — мягкие широкие
        c = mix(c, white, mix(smoothstep(0.6, 0.82, streak) * 0.3, smoothstep(0.42, 0.78, streak) * 0.82, fall));
        // пена: на каскадах и ниже водопадов (бежит вместе с водой), светлая кромка, зубцы у подножия
        float fo = foamA * smoothstep(0.25 + 0.5 * (1.0 - foamA), 0.9, s2 * 0.6 + s3 * 0.5);
        fo = max(fo, smoothstep(0.7, 1.0, foamA) * (0.45 + 0.3 * s3)); // вода бьёт о камень
        fo = max(fo, lip * (0.4 + 0.25 * s3));
        float teeth = 0.6 + 2.2 * vnoise(vec2(u * 8.0 + 3.0, uTime * 0.35));
        float foamB = smoothstep(teeth + 1.2, teeth, hb);
        fo = clamp(max(fo, foamB * 0.92), 0.0, 1.0);
        c = mix(c, white, fo);
        float sh = shadowAt(vW.xz);
        c = shade(c, normalize(vN + vec3(0.0, 0.35 * fall, 0.0)), mix(0.6 + 0.4 * sh, 0.88 + 0.12 * sh, fall));
        // на глади — отражение неба и солнечные блики
        vec3 vd = normalize(cameraPosition - vW);
        float calm = (1.0 - fall) * (1.0 - fo);
        c = mix(c, mix(uFogCol, uZenith, 0.35) * 1.1, pow(1.0 - max(vd.y, 0.0), 3.0) * calm * 0.4);
        vec3 nw = normalize(vec3((s2 - 0.5) * 0.35, 1.0, (s3 - 0.5) * 0.35));
        c += uSunCol * pow(max(dot(reflect(-vd, nw), uSun), 0.0), 48.0) * calm * sh * 1.4;
        // края: на глади их прячет берег, у завесы — мягкие и чуть рваные
        float rag = vnoise(vec2(qt * 0.5, u < 0.0 ? 3.0 : 11.0));
        float edge = abs(u) + (rag - 0.5) * 0.22 * fall;
        float a = smoothstep(1.0, 0.86, edge);
        a *= mix(mix(0.9, 1.0, max(dk, fo)), mix(0.78, 0.95, smoothstep(0.3, 0.7, streak)), fall);
        a = max(a, foamB * smoothstep(1.0, 0.9, edge) * 0.95);
        a *= smoothstep(-0.35, 0.1, hb) * fade * smoothstep(0.0, 1.2, q);
        gl_FragColor = vec4(applyFog(c, vW), clamp(a, 0.0, 0.97));
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

  const rnd = mulberry32(SEED + 131);
  const MP = [], MS = [], MD = [], SP = [], SS = [];
  const fog = (x, y, z, size, alpha, dx, dz) => { MP.push(x, y, z); MS.push(size, alpha, rnd(), rnd()); MD.push(dx, dz); };
  const spl = (x, y, z, hw, n, k) => {
    for (let i = 0; i < n; i++) { SP.push(x + (rnd() - 0.5) * hw, y + 0.1, z + (rnd() - 0.5) * hw); SS.push(rnd(), rnd() * k, 0.12 + rnd() * 0.16, rnd() * Math.PI * 2); }
  };
  for (const st of STREAMS) {
    const rows = st.rows;
    // светлая кромка: ±1.5 м пути вокруг каждой кромки
    const lipQ = st.falls.map((f) => rows[f.i0 - 1]?.q ?? rows[f.i0].q);
    const pos = [], uv = [], ex = [], nn = [], idx = [], hitsAt = [];
    for (const r of rows) {
      const { c, sd, n, half, fall, q } = r;
      let lip = 0;
      for (const lq of lipQ) lip = Math.max(lip, Math.exp(-(((q - lq - 0.6) / 1.3) ** 2)));
      const bul = r.kind === 'flat' || r.kind === 'run' ? 0 : (r.shaft ? 0.5 : Math.min(0.5, half * 0.12)) * fall;
      for (let j = 0; j < COLS; j++) {
        const u = -1 + (2 * j) / (COLS - 1), oo = (1 - u * u) * bul;
        const x = c[0] + sd[0] * u * half + n[0] * oo, z = c[2] + sd[1] * u * half + n[2] * oo;
        let y = c[1] + n[1] * oo;
        // ручеёк по дну: бугорки и плоские камни под краями ленты вода покрывает, а не обтекает дырой
        if (r.kind === 'run') { const h = heightAt(x, z), g = groundAt(x, z, h + 0.7); const top = g - h < 0.7 ? g : h; if (top + 0.06 > y && top < y + 0.8) y = top + 0.06; }
        pos.push(x, y, z);
        // глубина (цвет глади) и пруды: в чаше ленты нет, там своя гладь — плавная смена у берега
        let depth = 1, fade = 1;
        if (r.kind === 'flat') {
          depth = Math.max(0, y - heightAt(x, z));
          let dn = 9;
          for (const p of POOLS) dn = Math.min(dn, poolDist(p, x, z));
          fade = smoothstep(0.8, 1.0, dn);
        } else if (r.kind === 'run') depth = 0.7;
        // завеса за глыбой игрока: внутри камня тает, на верху камня — пена (вода бьёт о камень), под ним — светлее
        let fv = r.foam || 0;
        if (r.shaft) {
          if (solidAt(x, y, z, 0.15)) fv = 1; // внутри камня завесу и так не видно, а у его верха — пена
          else if (solidAt(x, y - 1.1, z, 0.1)) { fv = 1; if (j % 3 === 1 && rnd() < 0.5) hitsAt.push([x, y - 0.6, z]); }
          else if (solidAt(x, y + 1.1, z, 0.1)) fv = Math.max(fv, 0.5);
        }
        uv.push(u, q, fall, depth);
        ex.push(fade, fv, r.hb, lip);
        // свет на завесе — по горизонтали от стены: где завеса выгибается, она не темнеет и не светлеет полосой
        if (fall > 0.5) { const hl = Math.hypot(n[0], n[2]) || 1; nn.push(n[0] / hl, 0, n[2] / hl); } else nn.push(n[0], n[1], n[2]);
      }
    }
    for (let i = 0; i < rows.length - 1; i++)
      for (let j = 0; j < COLS - 1; j++) {
        const v = i * COLS + j;
        idx.push(v, v + COLS, v + 1, v + 1, v + COLS, v + COLS + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 4));
    g.setAttribute('aEx', new THREE.Float32BufferAttribute(ex, 4));
    g.setAttribute('aN', new THREE.Float32BufferAttribute(nn, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, waterMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.userData.water = st;
    scene.add(mesh);

    // брызги там, где завеса бьёт о верх камня
    for (const h of hitsAt) { spl(h[0], h[1], h[2], 1.5, 4, 0.5); if (rnd() < 0.3) fog(h[0], h[1] + 0.5, h[2], 2 + rnd() * 2, 0.06, 0, 0); }
    for (const f of st.falls) {
      const fr = rows.slice(f.i0, f.i1 + 1).filter((r) => r.kind === 'fall');
      if (!fr.length || !f.land) continue;
      const H = f.y0 - f.land[1], end = fr[fr.length - 1], hw = end.half;
      // куда бьёт струя: чаша под ней рисует кипящую пену и расходящиеся круги
      for (const p of [...POOLS, lakePool]) if (poolDist(p, f.land[0], f.land[2]) < 1) (p.splashes ||= []).push({ x: f.land[0], z: f.land[2], rad: hw * 0.6 + Math.min(1.5, H * 0.025) });
      if (f.lake) (lakePool.splashes ||= []).push({ x: f.lake[0], z: f.lake[1], rad: f.lake[2] * 0.7 });
      // ---- водяная пыль у подножия: чем выше водопад, тем её больше ----
      const big = Math.min(1, H / 45), N = Math.round(10 + 22 * big);
      const eo = Math.hypot(end.n[0], end.n[2]) || 1, ex2 = end.n[0] / eo, ez2 = end.n[2] / eo;
      for (let i = 0; i < N; i++) {
        const a = (rnd() - 0.5) * 2.5, l = (rnd() - 0.5) * 2 * hw, sp = (rnd() - 0.5) * 1.6;
        fog(f.land[0] + ex2 * a + end.sd[0] * l, f.land[1] + 0.3 + rnd() * 1.5 * big, f.land[2] + ez2 * a + end.sd[1] * l,
          (2 + rnd() * 3) * (0.6 + 1.4 * big), 0.1 + rnd() * 0.14, ex2 * 0.8 - ez2 * sp, ez2 * 0.8 + ex2 * sp);
      }
      // лёгкая дымка вдоль струи: редкие большие клубы, почти прозрачные
      for (let i = 4; i < fr.length - 2; i += 7) {
        const r = fr[i], l = (rnd() - 0.5) * 2 * r.half;
        fog(r.c[0] + r.sd[0] * l + r.n[0] * 1.2, r.c[1] - 1, r.c[2] + r.sd[1] * l + r.n[2] * 1.2, 3 + rnd() * 3, 0.05 + rnd() * 0.04, r.n[0] * 0.3, r.n[2] * 0.3);
      }
      spl(f.land[0], f.land[1], f.land[2], hw, Math.round(14 + 20 * big), 1);
      // мокрые скалы вокруг струи; у кромки камень не темним
      for (const r of fr) if (r.c[1] < f.y0 - 2) wetDisc(r.c[0], r.c[2], r.half + 1.0, r.c[1] - 2.5, Math.min(r.c[1] + 1.5, f.y0 - 1.5));
    }
    // течение под водой (fallPush): в падении и по дну шахты
    for (const r of rows) if (r.kind !== 'flat') FLOW.push({ x: r.c[0], y: r.c[1], z: r.c[2], hw: r.half, sd: r.sd, tx: r.t[0], ty: r.t[1], tz: r.t[2], air: r.fall > 0.5 ? 1 : 0 });
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
