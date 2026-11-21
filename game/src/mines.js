import * as THREE from '../vendor/three.min.js';
import { TUNNELS, tunLocal, tunC, tunHW, tunH, tunFloor, rockMat, setMineSpace } from './terrain.js';
import { chunkMesh } from './chunks.js';
import { mulberry32, SEED, smoothstep } from './noise.js';
import { part, merge, T as M4, propMaterial } from './flora.js';
import { addBox } from './solids.js';

// Шахты под озером: старые выработки (−195…−215), глыбовый лабиринт (−228…−252), глубинные жилы (−256…−320)
// и огромная Красная пропасть с красным туманом на дне (упал в туман — смерть, возврат на последний уступ).
// План — /mnt/project-files/mines-plan (вариант 1). Ходы начинаются от концов двух туннелей (tunnels.js).
//
// Как устроено. Шахта — набор «пустот» в толще скалы: ходы (отрезки с полом и сводом), залы, узкие ямы
// и пропасть. Для физики каждая пустота в точке (x, z) даёт отрезок высот [пол, свод]; их объединение —
// воздух, всё остальное — скала (terrain.js terrainAt → mineSpace). Стены рисуем по той же форме:
// поле «насколько точка в воздухе» (+ шум скалы) считается на сетке, поверхность строится методом
// surface nets по кускам 30 м — куски вне кадра не рисуются.

const TAU = Math.PI * 2;
export const CHASM = { x: 205, z: -40, rx: 66, rz: 58, floor: -345, fog: -322, death: -316, roof: -174 };
const chE = (x, z) => Math.hypot((x - CHASM.x) / CHASM.rx, (z - CHASM.z) / CHASM.rz);
const chAt = (th, s = 1) => [CHASM.x + Math.cos(th) * CHASM.rx * s, CHASM.z + Math.sin(th) * CHASM.rz * s];

// ---- план: узлы [x, z, пол] ----
const N = {
  a2: [100, -130, -201], L: [120, -152, -204], a3: [148, -138, -208], O1: [168, -96, -211],
  s1: [64, -184, -205], s2: [56, -204, -207], NEST: [50, -228, -209],
  T1: [170, -182, -211],
  b2: [-135, -22, -197], JB: [-125, -70, -202], T2: [-175, -95, -203], b3: [-95, -120, -207], b4: [-50, -152, -212], b5: [0, -168, -217], b6: [50, -165, -222], b7: [95, -157, -227],
  H2: [113, -159, -231], c1: [156, -168, -234], c2: [178, -132, -238], O3: [186, -104, -240], c3: [150, -112, -237], cp1: [120, -108, -236], c4: [118, -72, -241], T3: [80, -62, -239], c5: [126, -44, -245],
  O2: [140, -30, -248], O2b: [150, 4, -251],
  d1: [140, 44, -255], P3: [136, 58, -257], d2: [136, 58, -281], H3: [96, 96, -286], T4: [52, 116, -288], d3: [150, 74, -296], O4: [172, 40, -303], d4: [118, 128, -306], EXIT: [105, 160, -312],
};
// ходы: [откуда, куда, вид]. main — штрек с рельсами и крепью, side — боковой, narrow — узкий лаз
const E = [
  ['A1', 'a2', 'main'], ['a2', 'L', 'main'], ['L', 'a3', 'main'], ['a3', 'O1', 'main'],
  ['a2', 's1', 'side'], ['s1', 's2', 'narrow'], ['s2', 'NEST', 'side'], ['a3', 'T1', 'narrow'],
  ['B1', 'b2', 'main'], ['b2', 'JB', 'main'], ['JB', 'T2', 'side'], ['JB', 'b3', 'main'], ['b3', 'b4', 'main'], ['b4', 'b5', 'main'], ['b5', 'b6', 'main'], ['b6', 'b7', 'main'], ['b7', 'H2', 'main'],
  ['H2', 'c1', 'rough'], ['c1', 'c2', 'rough'], ['c2', 'O3', 'rough'], ['c2', 'c3', 'narrow'], ['c3', 'cp1', 'narrow'], ['H2', 'cp1', 'rough'], ['cp1', 'c4', 'rough'], ['c4', 'T3', 'side'], ['c4', 'c5', 'rough'], ['c5', 'O2', 'side'],
  ['O2b', 'd1', 'side'], ['d1', 'P3', 'side'], ['d2', 'H3', 'main'], ['H3', 'T4', 'side'], ['H3', 'd4', 'main'], ['d4', 'EXIT', 'main'], ['d2', 'd3', 'narrow'], ['d3', 'O4', 'narrow'],
];
const KIND = { main: { hw: 4.0, H: 6.2, amp: 0.9 }, side: { hw: 2.7, H: 4.8, amp: 0.8 }, rough: { hw: 3.2, H: 6.5, amp: 1.0 }, narrow: { hw: 1.45, H: 3.5, amp: 0.4 } };
// залы: [узел, радиус, высота свода]
const HALLS = [['L', 13, 10], ['NEST', 15, 12], ['H2', 11, 9], ['H3', 14, 12], ['JB', 8, 7.5], ['b5', 7, 7], ['c2', 7, 8]];
// узкие ямы вниз: [верх, низ, радиус]; низ стоит ровно под верхом
const PITS = [['L', 'H2', 2.8], ['P3', 'd2', 2.6]];
// выходы к пропасти: узел сдвигается от предыдущего узла хода до самого края пропасти
const EDGE = [['O1', 'a3'], ['O3', 'c2'], ['O2', 'c5'], ['O4', 'd3']];
// тупики-завалы: на конце хода груда камней
const RUBBLE = ['T3', 'EXIT'];

export const MINE_LIGHTS = [];
export const MINE_NODES = N;   // для проверок
const EL = [];          // все пустоты
let GRID = null;        // сетка 16 м → пустоты (для физики и поля)
const GC = 16;

// ---- шум скалы: значение в узлах решётки, гладко между ними ----
function h3(i, j, k) {
  let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vn3(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  let fx = x - i, fy = y - j, fz = z - k;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = h3(i, j, k), b = h3(i + 1, j, k), c = h3(i, j + 1, k), d = h3(i + 1, j + 1, k);
  const e = h3(i, j, k + 1), f = h3(i + 1, j, k + 1), g = h3(i, j + 1, k + 1), h = h3(i + 1, j + 1, k + 1);
  const x0 = a + (b - a) * fx, x1 = c + (d - c) * fx, x2 = e + (f - e) * fx, x3 = g + (h - g) * fx;
  const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
  return (y0 + (y1 - y0) * fz) * 2 - 1;
}
const rockN = (x, y, z) => 0.62 * vn3(x * 0.19, y * 0.23, z * 0.19) + 0.38 * vn3(x * 0.47 + 7.1, y * 0.5, z * 0.47 - 3.3);

// ---- пустоты ----
// пол хода в точке t (0..1): ровный уклон; у «глыбовых» ходов — уступы, на которые надо запрыгивать
function segFloor(e, t) {
  let f = e.fa + (e.fb - e.fa) * t;
  if (e.rough) {
    const s = t * e.len, env = smoothstep(4, 9, s) * smoothstep(4, 9, e.len - s);
    const q = Math.sin(s * 0.23 + e.seed) + 0.7 * Math.sin(s * 0.51 + e.seed * 2.3);
    f += Math.round(q * 1.3) * 0.55 * env;   // ступени по 0.55 м: запрыгнуть можно, перешагнуть — нет
  }
  return f;
}
function addSeg(a, b, kind, extra = {}) {
  const K = KIND[kind] || kind;
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
  const e = { type: 0, kind: extra.kind || kind, ax: a[0], az: a[1], fa: a[2], bx: b[0], bz: b[1], fb: b[2], dx: dx / len, dz: dz / len, len,
    hw: K.hw, H: K.H, amp: K.amp, rough: kind === 'rough', seed: EL.length * 1.7, ...extra };
  e.box = [Math.min(a[0], b[0]) - e.hw, Math.max(a[0], b[0]) + e.hw, Math.min(a[1], b[1]) - e.hw, Math.max(a[1], b[1]) + e.hw, Math.min(a[2], b[2]) - 2, Math.max(a[2], b[2]) + e.H + 2];
  EL.push(e);
  return e;
}
function addHall(c, R, H) {
  EL.push({ type: 1, x: c[0], z: c[1], f: c[2], R, H, amp: 1.0, box: [c[0] - R, c[0] + R, c[1] - R, c[1] + R, c[2] - 2, c[2] + H + 2] });
}
function addPit(top, bot, r, topH) {
  EL.push({ type: 2, x: top[0], z: top[1], fb: bot[2], top: top[2] + topH, r, amp: 0.45, box: [top[0] - r, top[0] + r, top[1] - r, top[1] + r, bot[2] - 2, top[2] + topH + 2] });
}
function chasmRoof(e) { return CHASM.roof + 16 * Math.max(0, 1 - e * e); }

// поле: > 0 — воздух, < 0 — скала (примерно расстояние до стены, м)
function segD(e, x, y, z) {
  let t = ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const u = Math.hypot(x - (e.ax + e.dx * e.len * t), z - (e.az + e.dz * e.len * t));
  const v = y - segFloor(e, t);
  if (v < 0 && u < e.hw) return v;
  const q = Math.pow(u / e.hw, 4) + Math.pow(Math.max(0, v) / e.H, 4);
  return Math.min(v, (1 - Math.sqrt(Math.sqrt(q))) * Math.min(e.hw, e.H));
}
function hallD(e, x, y, z) {
  const r = Math.hypot(x - e.x, z - e.z), v = y - e.f;
  const q = Math.pow(r / e.R, 4) + Math.pow(Math.max(0, v) / e.H, 2);
  return Math.min(v, (1 - Math.sqrt(Math.sqrt(q))) * Math.min(e.R, e.H));
}
function pitD(e, x, y, z) {
  return Math.min(e.r - Math.hypot(x - e.x, z - e.z), y - e.fb, e.top - y);
}
function chasmD(x, y, z) {
  const e = chE(x, z);
  return Math.min((1 - e) * Math.min(CHASM.rx, CHASM.rz), y - CHASM.floor, chasmRoof(e) - y);
}
const baseD = (e, x, y, z) => e.type === 0 ? segD(e, x, y, z) : e.type === 1 ? hallD(e, x, y, z) : e.type === 2 ? pitD(e, x, y, z) : chasmD(x, y, z);

// карниз вдоль стены пропасти (между выходами O2 и O2b): там стена ровнее и чуть отступает
let LEDGE = null;
function ledgeCalm(x, y, z) {
  if (!LEDGE) return 0;
  let a = Math.atan2((z - CHASM.z) / CHASM.rz, (x - CHASM.x) / CHASM.rx);
  const m = (LEDGE.a0 + LEDGE.a1) / 2, hw = Math.abs(LEDGE.a1 - LEDGE.a0) / 2 + 0.06;
  let d = a - m; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
  return (1 - smoothstep(hw - 0.05, hw + 0.04, Math.abs(d))) * smoothstep(LEDGE.y - 4, LEDGE.y - 1, y) * (1 - smoothstep(LEDGE.y + 5, LEDGE.y + 9, y));
}
function field(x, y, z, list) {
  let best = -1e9, n = null;
  for (const e of list) {
    let d = baseD(e, x, y, z);
    if (d < (e.type === 3 ? -11 : -4)) { if (d > best) best = d; continue; }
    if (e.type === 3) {
      // стены пропасти: крупные выступы, слои-карнизы и мелкий скол
      const calm = ledgeCalm(x, y, z);
      // стена только отступает в скалу (не выпирает внутрь): край пустоты для физики — ровный эллипс, и
      // у выходов к пропасти под ногами никогда не оказывается «камень, которого нет»
      const big = vn3(x * 0.045, y * 0.06, z * 0.045) * 3.4 + vn3(x * 0.11 + 3, y * 0.14, z * 0.11) * 1.5 + Math.sin(y * 0.42 + vn3(x * 0.03, 0, z * 0.03) * 4) * 0.9;
      d += Math.max(0, 2.0 + big) * (1 - calm * 0.85) + calm * 1.6;
    } else {
      if (n === null) n = rockN(x, y, z);
      const v = e.type === 0 ? y - segFloor(e, 0.5) : e.type === 1 ? y - e.f : 9;
      d += n * e.amp * (e.type === 2 ? 1 : smoothstep(0.3, 1.6, d < 0 ? 9 : Math.min(v + 0.5, 9)));
    }
    if (d > best) best = d;
  }
  return best;
}

function cellsOf(box) {
  const out = [];
  for (let i = Math.floor(box[0] / GC); i <= Math.floor(box[1] / GC); i++)
    for (let j = Math.floor(box[2] / GC); j <= Math.floor(box[3] / GC); j++) out.push(i + ',' + j);
  return out;
}
function indexAll() {
  GRID = new Map();
  for (const e of EL) for (const k of cellsOf(e.box)) (GRID.get(k) || GRID.set(k, []).get(k)).push(e);
}

// ---- физика: пол под ногами на высоте y (или null — скала / вне шахт) ----
const PAD = 0.55;
const _iv = [];
function mineSpace(x, z, y) {
  const list = GRID.get(Math.floor(x / GC) + ',' + Math.floor(z / GC));
  if (!list) return null;
  _iv.length = 0;
  for (const e of list) {
    if (x < e.box[0] || x > e.box[1] || z < e.box[2] || z > e.box[3]) continue;
    if (e.type === 0) {
      let t = ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.len;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const u = Math.hypot(x - (e.ax + e.dx * e.len * t), z - (e.az + e.dz * e.len * t));
      const hw = e.hw - PAD * (e.hw < 2 ? 0.6 : 1);
      if (u > hw) continue;
      const f = segFloor(e, t);
      _iv.push(f, f + e.H * Math.pow(Math.max(0, 1 - Math.pow(u / e.hw, 4)), 0.25) - 0.3);
    } else if (e.type === 1) {
      const r = Math.hypot(x - e.x, z - e.z);
      if (r > e.R - PAD * 1.4) continue;
      _iv.push(e.f, e.f + e.H * Math.sqrt(Math.max(0, 1 - Math.pow(r / e.R, 4))) - 0.3);
    } else if (e.type === 2) {
      if (Math.hypot(x - e.x, z - e.z) > e.r - 0.3) continue;
      _iv.push(e.fb, e.top);
    } else {
      const c = chE(x, z);
      if (c > 1 - 0.45 / CHASM.rz) continue;
      _iv.push(CHASM.floor, chasmRoof(c));
    }
  }
  if (!_iv.length) return null;
  // объединяем отрезки: снизу вверх; ищем тот, где стоят ноги (или чуть ниже его пола — ступенька)
  const n = _iv.length / 2, ord = [];
  for (let i = 0; i < n; i++) ord.push(i);
  ord.sort((a, b) => _iv[a * 2] - _iv[b * 2]);
  let lo = _iv[ord[0] * 2], hi = _iv[ord[0] * 2 + 1];
  for (let k = 1; k <= n; k++) {
    const i = ord[k];
    if (k < n && _iv[i * 2] <= hi + 0.05) { hi = Math.max(hi, _iv[i * 2 + 1]); continue; }
    if (y >= lo - 0.6 && y < hi) return lo;
    if (k < n) { lo = _iv[i * 2]; hi = _iv[i * 2 + 1]; }
  }
  return null;
}

// ---- поверхность: surface nets по кускам ----
const CS = 1.5, CN = 20;   // клетка 1.5 м, кусок 20 клеток = 30 м
function buildRock(scene, skip) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const e of EL) { x0 = Math.min(x0, e.box[0]); x1 = Math.max(x1, e.box[1]); z0 = Math.min(z0, e.box[2]); z1 = Math.max(z1, e.box[3]); y0 = Math.min(y0, e.box[4]); y1 = Math.max(y1, e.box[5]); }
  const S = CS * CN, M = 7;   // M — запас: шум сдвигает стену до ~7 м
  const meshes = [];
  let evals = 0, tris = 0;
  const P = CN + 2, val = new Float32Array(P * P * P), vid = new Int32Array((CN + 1) ** 3);
  for (let cx = Math.floor((x0 - M) / S); cx <= Math.floor((x1 + M) / S); cx++)
  for (let cz = Math.floor((z0 - M) / S); cz <= Math.floor((z1 + M) / S); cz++)
  for (let cy = Math.floor((y0 - M) / S); cy <= Math.floor((y1 + M) / S); cy++) {
    const ox = cx * S, oy = cy * S, oz = cz * S;
    const bx = [ox - M, ox + S + M, oz - M, oz + S + M, oy - M, oy + S + M];
    const list = EL.filter((e) => e.box[0] < bx[1] + 6 && e.box[1] > bx[0] - 6 && e.box[2] < bx[3] + 6 && e.box[3] > bx[2] - 6 && e.box[4] < bx[5] + 6 && e.box[5] > bx[4] - 6);
    if (!list.length) continue;
    // весь кусок заведомо в воздухе или в скале — пропускаем
    const mx = ox + S / 2, my = oy + S / 2, mz = oz + S / 2, half = S * 0.87 + M;
    let dc = -1e9;
    for (const e of list) dc = Math.max(dc, baseD(e, mx, my, mz));
    if (dc > half || dc < -half - 6) continue;
    // значения поля в узлах: от −1 до CN (+1 слой с каждой стороны)
    for (let k = 0; k < P; k++) for (let j = 0; j < P; j++) for (let i = 0; i < P; i++)
      val[(k * P + j) * P + i] = field(ox + (i - 1) * CS, oy + (j - 1) * CS, oz + (k - 1) * CS, list);
    evals += P * P * P;
    const V = (i, j, k) => val[(k * P + j) * P + i];
    // вершина в каждой клетке со сменой знака (клетки 0..CN по узлам 0..CN+1)
    const pos = [], idx = [];
    const C1 = CN + 1;
    vid.fill(-1);
    for (let k = 0; k < C1; k++) for (let j = 0; j < C1; j++) for (let i = 0; i < C1; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) if (V(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2)) < 0) neg++;
      if (neg === 0 || neg === 8) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (let a = 0; a < 12; a++) {
        // 12 рёбер клетки
        const ax = a < 4 ? 0 : a < 8 ? 1 : 2;
        const o1 = (a & 3) & 1, o2 = ((a & 3) >> 1) & 1;
        let p0, p1;
        if (ax === 0) { p0 = [i, j + o1, k + o2]; p1 = [i + 1, j + o1, k + o2]; }
        else if (ax === 1) { p0 = [i + o1, j, k + o2]; p1 = [i + o1, j + 1, k + o2]; }
        else { p0 = [i + o1, j + o2, k]; p1 = [i + o1, j + o2, k + 1]; }
        const v0 = V(p0[0], p0[1], p0[2]), v1 = V(p1[0], p1[1], p1[2]);
        if ((v0 < 0) === (v1 < 0)) continue;
        const f = v0 / (v0 - v1);
        sx += p0[0] + (p1[0] - p0[0]) * f; sy += p0[1] + (p1[1] - p0[1]) * f; sz += p0[2] + (p1[2] - p0[2]) * f; cnt++;
      }
      vid[(k * C1 + j) * C1 + i] = pos.length / 3;
      pos.push(ox + (sx / cnt - 1) * CS, oy + (sy / cnt - 1) * CS, oz + (sz / cnt - 1) * CS);
    }
    const VI = (i, j, k) => vid[(k * C1 + j) * C1 + i];
    // грани: по рёбрам, что начинаются в узлах куска 1..CN (каждое ребро — ровно в одном куске)
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      // ход туннеля рисует tunnels.js — тут его не дублируем
      const qx = (pos[a * 3] + pos[c * 3]) / 2, qy = (pos[a * 3 + 1] + pos[c * 3 + 1]) / 2, qz = (pos[a * 3 + 2] + pos[c * 3 + 2]) / 2;
      if (skip(qx, qy, qz)) return;
      if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
    };
    for (let k = 1; k <= CN; k++) for (let j = 1; j <= CN; j++) for (let i = 1; i <= CN; i++) {
      const v0 = V(i, j, k);
      if (i < CN + 1) { const v1 = V(i + 1, j, k); if ((v0 < 0) !== (v1 < 0)) quad(VI(i, j - 1, k - 1), VI(i, j, k - 1), VI(i, j, k), VI(i, j - 1, k), v0 > 0); }
      if (j < CN + 1) { const v1 = V(i, j + 1, k); if ((v0 < 0) !== (v1 < 0)) quad(VI(i - 1, j, k - 1), VI(i - 1, j, k), VI(i, j, k), VI(i, j, k - 1), v0 > 0); }
      if (k < CN + 1) { const v1 = V(i, j, k + 1); if ((v0 < 0) !== (v1 < 0)) quad(VI(i - 1, j - 1, k), VI(i, j - 1, k), VI(i, j, k), VI(i - 1, j, k), v0 > 0); }
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ng = g.toNonIndexed();
    ng.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
    const m = chunkMesh(ng, rockMat);
    m.userData.mine = true;
    scene.add(m); meshes.push(m);
    tris += idx.length / 3;
  }
  return { meshes, evals, tris };
}

// ---- сборка ----
export function buildMines(scene) {
  const t0 = performance.now();
  const rnd = mulberry32(SEED + 9091);
  // начало: концы двух туннелей
  const ends = TUNNELS.map((T) => {
    const pt = (t) => { const c = tunC(T, t); return [T.x + T.dx * t + T.nx * c, T.z + T.dz * t + T.nz * c, tunFloor(T, t, c)]; };
    return { T, at: pt, end: pt(T.L) };
  });
  N.A1 = ends[0].end; N.B1 = ends[1].end;
  // выходы к пропасти — до самого края
  for (const [o, from] of EDGE) {
    const a = N[from], b = N[o];
    let x = b[0], z = b[1];
    const dx = CHASM.x - x, dz = CHASM.z - z, l = Math.hypot(dx, dz), sg = chE(x, z) > 1 ? 1 : -1;
    for (let k = 0; k < 400 && (chE(x, z) > 1) === (sg > 0); k++) { x += sg * dx / l * 0.25; z += sg * dz / l * 0.25; }
    N[o] = [x + dx / l * 1.5, z + dz / l * 1.5, b[2]];   // ход кончается в 1.5 м за краем — дальше пустота
  }
  // карниз: O2 и O2b — на краю пропасти; между ними дорожка из досок вдоль стены
  const ang = (p) => Math.atan2((p[1] - CHASM.z) / CHASM.rz, (p[0] - CHASM.x) / CHASM.rx);
  const aO2 = ang(N.O2);
  {
    let a1 = ang(N.O2b);
    const [x, z] = chAt(a1, 0.995);
    N.O2b = [x, z, N.O2b[2]];
    LEDGE = { a0: aO2, a1, y: N.O2[2] };
  }
  // пустоты
  // заход из туннеля: последние метры туннеля продолжаем такой же ширины, чтобы шов был в глубине его стен
  const stubs = [];
  for (const q of ends) {
    const T = q.T, a = q.at(T.L - 9), b = q.at(T.L + 2.5);
    stubs.push(addSeg(a, [b[0], b[1], q.end[2]], { hw: tunHW(T, T.L) * 0.9, H: tunH(T, T.L) * 0.85, amp: 0.8 }, { kind: 'stub' }));
  }
  const segs = [];
  for (const [a, b, k] of E) segs.push(addSeg(N[a], N[b], k, { from: a, to: b }));
  for (const [n, R, H] of HALLS) addHall(N[n], R, H);
  // пересечение: паучий ход над нижним штреком — в полу дыра (можно спрыгнуть)
  const X = segX(N.a2, N.s1, N.b6, N.b7);
  if (X) {
    const up = segs.find((e) => e.from === 'a2' && e.to === 's1'), dn = segs.find((e) => e.from === 'b6' && e.to === 'b7');
    const tu = ((X[0] - up.ax) * up.dx + (X[1] - up.az) * up.dz) / up.len, td = ((X[0] - dn.ax) * dn.dx + (X[1] - dn.az) * dn.dz) / dn.len;
    // дыра у стены паучьего хода (сбоку остаётся проход), над осью нижнего штрека
    const hx = X[0] - up.dz * 1.6, hz = X[1] + up.dx * 1.6;
    addPit([hx, hz, segFloor(up, tu)], [hx, hz, segFloor(dn, td)], 1.5, 2);
    N.X = [hx, hz, segFloor(up, tu)];
  }
  for (const [a, b, r] of PITS) { const top = N[a], bot = N[b]; addPit([bot[0], bot[1], top[2]], bot, r, 3); }
  // пропасть
  EL.push({ type: 3, amp: 0, box: [CHASM.x - CHASM.rx - 8, CHASM.x + CHASM.rx + 8, CHASM.z - CHASM.rz - 8, CHASM.z + CHASM.rz + 8, CHASM.floor - 4, CHASM.roof + 22] });
  // ходы на той стороне пропасти: видно, дойти нельзя
  const FAR = [[-0.75, -226], [-0.08, -262], [0.45, -238], [-1.15, -284], [0.95, -292], [-0.35, -300], [0.2, -212]];
  const farMouths = [];
  for (const [a, y] of FAR) {
    const [x, z] = chAt(a, 0.97), [x2, z2] = chAt(a, 1.32);
    farMouths.push({ a, y, e: addSeg([x, z, y], [x2, z2, y - 1], 'side') });
  }
  indexAll();
  setMineSpace(mineSpace);
  // в первых метрах туннелей стены рисует tunnels.js
  const skip = (x, y, z) => {
    for (const q of ends) {
      const T = q.T, [t, w] = tunLocal(T, x, z);
      if (t < T.L - 2.5 && t > T.L - 14 && Math.abs(w - tunC(T, t)) < tunHW(T, t) + 4 && y < q.end[2] + T.H * 2.2) return true;
    }
    return false;
  };
  const rock = buildRock(scene, skip);
  const props = buildProps(scene, rnd, { segs, farMouths, stubs });
  buildMines.stats = { ms: Math.round(performance.now() - t0), chunks: rock.meshes.length, tris: rock.tris, evals: rock.evals, props: props.tris, lights: MINE_LIGHTS.length };
  return buildMines.stats;
}
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}
// смерть в красном тумане: ноги ниже этой высоты над дном пропасти
export function inDeadlyFog(p) { return p.y < CHASM.death && chE(p.x, p.z) < 1.1; }
// пол хода (для расстановки)
export const mineFloor = (x, z, y) => mineSpace(x, z, y);

// ================= обстановка =================
const WOOD = [0x6e4729, 0x5f3d24, 0x7a5232, 0x664229], IRON = 0x3a3638, STONE = 0x5a5550, GLASS = 0xffc070, WEB = 0xb8acc8;
const rotY = (dx, dz) => Math.atan2(-dz, dx);   // поворот, при котором своя ось x смотрит вдоль (dx, dz)
function buildProps(scene, rnd, ctx) {
  const B = new Map();
  const put = (x, z, p) => { const k = Math.floor(x / 40) + ',' + Math.floor(z / 40); (B.get(k) || B.set(k, []).get(k)).push(p); };
  const box = (x, y, z, sx, sy, sz, col, ry = 0, rz = 0, glow = 0) => put(x, z, part(new THREE.BoxGeometry(1, 1, 1), col, { glow, m: M4(x, y, z, sx, sy, sz, ry, rz) }));
  const geo = (g, x, y, z, col, m, glow = 0) => put(x, z, part(g, col, { glow, m }));
  const wood = () => WOOD[Math.floor(rnd() * WOOD.length)];
  const light = (x, y, z, r, k, col) => MINE_LIGHTS.push({ x, y, z, r, k, col });

  // фонарь: железный колпак, стекло со светом, донце; висит на цепи длиной ch
  function lantern(x, y, z, ch = 0.5, s = 1.4, lit = true) {
    if (ch > 0) box(x, y - ch / 2, z, 0.04, ch, 0.04, IRON);
    const ly = y - ch - 0.25 * s;
    geo(new THREE.CylinderGeometry(0.04, 0.22, 0.16, 6), x, ly + 0.25 * s, z, IRON, M4(x, ly + 0.25 * s, z, s));
    geo(new THREE.CylinderGeometry(0.14, 0.14, 0.32, 6), x, ly, z, GLASS, M4(x, ly, z, s), 1);
    geo(new THREE.CylinderGeometry(0.17, 0.11, 0.07, 6), x, ly - 0.18 * s, z, IRON, M4(x, ly - 0.18 * s, z, s));
    for (let j = 0; j < 3; j++) { const b = j * TAU / 3 + 0.5; box(x + Math.cos(b) * 0.145 * s, ly, z + Math.sin(b) * 0.145 * s, 0.03 * s, 0.34 * s, 0.03 * s, IRON); }
    if (lit) light(x, ly, z, 9, 1.0, [1.0, 0.58, 0.26]);
  }
  // рама крепи поперёк хода: стойки на каменных башмаках, верхняк, подкосы, железные хомуты
  function frame(x, y, z, dx, dz, hw, h, lamp) {
    const ry = rotY(-dz, dx), nx = -dz, nz = dx, w = hw - 0.45;
    for (const sd of [-1, 1]) {
      const px = x + nx * w * sd, pz = z + nz * w * sd;
      box(px, y + 0.17, pz, 0.55, 0.34, 0.55, STONE, ry);
      box(px, y + h / 2, pz, 0.32, h, 0.32, wood(), ry, (rnd() - 0.5) * 0.04);
      box(px, y + h * 0.35, pz, 0.36, 0.09, 0.36, IRON, ry); box(px, y + h * 0.8, pz, 0.36, 0.09, 0.36, IRON, ry);
      // подкос: от стойки к верхняку, под 45°
      box(px - nx * sd * 0.55, y + h - 0.6, pz - nz * sd * 0.55, 1.3, 0.2, 0.22, wood(), ry, sd * Math.PI / 4);
    }
    box(x, y + h + 0.17, z, w * 2 + 0.7, 0.36, 0.4, wood(), ry);
    box(x + nx * (w - 0.2), y + h + 0.17, z + nz * (w - 0.2), 0.42, 0.42, 0.44, IRON, ry);
    box(x - nx * (w - 0.2), y + h + 0.17, z - nz * (w - 0.2), 0.42, 0.42, 0.44, IRON, ry);
    if (lamp) lantern(x + nx * (w - 1.0) * (rnd() < 0.5 ? -1 : 1), y + h, z + nz * (w - 1.0), 0.55);
  }
  // рельсы: две полосы и шпалы, по прямой от a до b (пол хода — ровный уклон)
  function rails(a, b, f0, f1) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 1) return;
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux, ry = rotY(ux, uz), pitch = Math.atan2(f1 - f0, len);
    for (let s = 0.4; s < len; s += 0.75) {
      const x = a[0] + ux * s, z = a[1] + uz * s, y = f0 + (f1 - f0) * (s / len);
      box(x, y + 0.06, z, 0.24, 0.1, 1.5, wood(), ry);
    }
    for (let s0 = 0; s0 < len; s0 += 6) {
      const l = Math.min(6, len - s0), sm = s0 + l / 2, x = a[0] + ux * sm, z = a[1] + uz * sm, y = f0 + (f1 - f0) * (sm / len);
      for (const sd of [-0.52, 0.52]) box(x + nx * sd, y + 0.17, z + nz * sd, l + 0.02, 0.12, 0.08, 0x6c6a72, ry, pitch);
    }
  }
  // вагонетка: кузов из досок, железные углы, колёса; иногда с рудой
  function cart(x, y, z, dx, dz, ore) {
    const ry = rotY(dx, dz), nx = -dz, nz = dx;
    box(x, y + 0.5, z, 1.5, 0.1, 0.95, 0x4a3020, ry);
    for (const sd of [-1, 1]) {
      box(x + nx * 0.47 * sd, y + 0.8, z + nz * 0.47 * sd, 1.5, 0.6, 0.08, wood(), ry);
      box(x + dx * 0.74 * sd, y + 0.8, z + dz * 0.74 * sd, 0.08, 0.6, 0.95, wood(), ry);
      for (const sd2 of [-1, 1]) {
        box(x + dx * 0.72 * sd + nx * 0.45 * sd2, y + 0.8, z + dz * 0.72 * sd + nz * 0.45 * sd2, 0.12, 0.66, 0.12, IRON, ry);
        const wx = x + dx * 0.48 * sd + nx * 0.52 * sd2, wz = z + dz * 0.48 * sd + nz * 0.52 * sd2;
        geo(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 8), wx, y + 0.24, wz, IRON, new THREE.Matrix4().compose(new THREE.Vector3(wx, y + 0.24, wz), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, ry, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
      }
    }
    if (ore) for (let k = 0; k < 6; k++) geo(new THREE.IcosahedronGeometry(0.24 + rnd() * 0.12, 0), x, y, z, ore === 2 ? 0x6fb8ff : 0x6a6560, M4(x + (rnd() - 0.5) * 0.9, y + 1.08, z + (rnd() - 0.5) * 0.5, 1, 0.8, 1, rnd() * TAU), ore === 2 ? 0.8 : 0);
  }
  const crate = (x, y, z, s = 0.9, ry = 0) => { box(x, y + s / 2, z, s, s, s, 0x7a5434, ry); box(x, y + s / 2, z, s + 0.04, 0.12, s + 0.04, 0x4c3220, ry); box(x, y + s / 2, z, 0.12, s + 0.04, s + 0.04, 0x4c3220, ry); };
  const barrel = (x, y, z) => { geo(new THREE.CylinderGeometry(0.36, 0.32, 0.95, 9), x, y, z, 0x6e4a2c, M4(x, y + 0.48, z)); for (const h of [0.2, 0.76]) geo(new THREE.CylinderGeometry(0.375, 0.375, 0.07, 9), x, y, z, IRON, M4(x, y + h, z)); };
  // кристаллы: голубой холодный свет
  function crystals(x, y, z, n, s0 = 0.6, col = 0x4aa6ff) {
    for (let j = 0; j < n; j++) {
      const s = s0 * (0.6 + rnd() * 0.9), a = rnd() * TAU, r = rnd() * 0.7;
      geo(new THREE.CylinderGeometry(0.22, 0.38, 1, 5), x, y, z, col, M4(x + Math.cos(a) * r, y + s * 0.4, z + Math.sin(a) * r, s * 0.4, s * 1.5, s * 0.4, rnd() * TAU, (rnd() - 0.5) * 0.8), 1);
    }
    light(x, y + 0.8, z, 8, 0.9, [0.35, 0.65, 1.0]);
  }
  // паутина: лучи и кольца из тонких нитей в плоскости (центр, нормаль n, радиус R)
  function web(x, y, z, nx, ny, nz, R) {
    const n = new THREE.Vector3(nx, ny, nz).normalize();
    const a = new THREE.Vector3(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize(), b = n.clone().cross(a);
    const K = 7 + Math.floor(rnd() * 3), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const strand = (p0, p1, th = 0.025) => {
      const d = p1.clone().sub(p0), l = d.length();
      q.setFromUnitVectors(up, d.normalize());
      const m = new THREE.Matrix4().compose(p0.clone().add(p1).multiplyScalar(0.5), q, new THREE.Vector3(th, l, th));
      put(x, z, part(new THREE.BoxGeometry(1, 1, 1), WEB, { glow: 0.12, m }));
    };
    const c = new THREE.Vector3(x, y, z), pt = (ang, r) => c.clone().addScaledVector(a, Math.cos(ang) * r).addScaledVector(b, Math.sin(ang) * r);
    const ra = Array.from({ length: K }, (_, i) => (i / K) * TAU + rnd() * 0.3), rl = ra.map(() => R * (0.75 + rnd() * 0.35));
    ra.forEach((g, i) => strand(c, pt(g, rl[i])));
    for (let ring = 1; ring <= 4; ring++) for (let i = 0; i < K; i++) {
      const j = (i + 1) % K, f = ring / 4.6;
      strand(pt(ra[i], rl[i] * f), pt(ra[j] + (j === 0 ? TAU : 0), rl[j] * f), 0.018);
    }
  }
  const cocoon = (x, y, z, s = 1) => geo(new THREE.IcosahedronGeometry(0.45 * s, 1), x, y, z, 0xe2d8ea, M4(x, y, z, 1, 1.9, 1, rnd() * TAU, (rnd() - 0.5) * 0.3), 0.3);
  // паук: брюшко, голова, 8 лап из двух колен, красные глаза
  function spider(x, y, z, s = 1, ry = 0, hang = 0) {
    if (hang > 0) box(x, y + hang / 2 + 0.3 * s, z, 0.02, hang, 0.02, WEB, 0, 0, 0.12);
    const c = Math.cos(ry), sn = Math.sin(ry);
    const P = (fx, fy, fz) => [x + (fx * c + fz * sn) * s, y + fy * s, z + (-fx * sn + fz * c) * s];
    let p = P(-0.45, 0.35, 0); geo(new THREE.IcosahedronGeometry(0.5 * s, 1), p[0], p[1], p[2], 0x1d1618, M4(p[0], p[1], p[2], 1, 0.85, 0.95, ry));
    p = P(0.2, 0.3, 0); geo(new THREE.IcosahedronGeometry(0.28 * s, 1), p[0], p[1], p[2], 0x241b1e, M4(p[0], p[1], p[2], 1, 0.8, 1, ry));
    for (const sd of [-1, 1]) {
      const e = P(0.44, 0.38, 0.09 * sd); geo(new THREE.IcosahedronGeometry(0.055 * s, 0), e[0], e[1], e[2], 0xff2a1a, M4(e[0], e[1], e[2]), 1);
      for (let l = 0; l < 4; l++) {
        const ax = 0.25 - l * 0.17, k = P(ax + 0.1 - l * 0.06, 0.75, sd * 0.62), f = P(ax + 0.25 - l * 0.2, 0.0, sd * 1.15), r = P(ax, 0.32, sd * 0.15);
        for (const [p0, p1] of [[r, k], [k, f]]) {
          const v0 = new THREE.Vector3(...p0), v1 = new THREE.Vector3(...p1), d = v1.clone().sub(v0), len = d.length();
          const m = new THREE.Matrix4().compose(v0.clone().add(v1).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(0.07 * s, len, 0.07 * s));
          put(x, z, part(new THREE.BoxGeometry(1, 1, 1), 0x1a1315, { m }));
        }
      }
    }
  }
  const rockLump = (x, y, z, s) => geo(new THREE.IcosahedronGeometry(s, 1), x, y, z, 0x4e4a48, M4(x, y + s * 0.4, z, 1 + rnd() * 0.4, 0.6 + rnd() * 0.3, 1 + rnd() * 0.4, rnd() * TAU));

  // --- по ходам ---
  const halls = HALLS.map(([n, R]) => ({ x: N[n][0], z: N[n][1], R }));
  const inHall = (x, z, m = 1) => halls.some((h) => Math.hypot(x - h.x, z - h.z) < h.R + m);
  for (const e of ctx.segs) {
    const tier1 = e.fa > -226;
    // крепь: в штреках через 5 м, в боковых через 7 м, в лазах — изредка одна стойка
    if (e.kind === 'main' || e.kind === 'side' || e.kind === 'rough') {
      const step = e.kind === 'main' ? 5 : e.kind === 'side' ? 7 : 9;
      let n = 0;
      for (let s = 3; s < e.len - 2; s += step) {
        const x = e.ax + e.dx * s, z = e.az + e.dz * s;
        if (inHall(x, z, 1.5) || chE(x, z) < 1.12) continue;
        const t = s / e.len, y = segFloor(e, t), y2 = segFloor(e, Math.min(1, t + 0.6 / e.len)), y1 = segFloor(e, Math.max(0, t - 0.6 / e.len));
        if (Math.abs(y2 - y1) > 0.2) continue;   // на уступе раму не ставим
        frame(x, y, z, e.dx, e.dz, e.hw, Math.min(e.H * 0.72, 4.6), (n++ % (e.kind === 'main' ? 3 : 2)) === 1);
        // кое-где у стены — ящик, бочка или доски
        if (rnd() < 0.22) { const sd = rnd() < 0.5 ? -1 : 1, w = e.hw - 1.1; (rnd() < 0.5 ? crate : barrel)(x - e.dz * w * sd + e.dx * 1.6, y, z + e.dx * w * sd + e.dz * 1.6); }
      }
    }
    if (e.kind === 'main') {
      // рельсы до края пропасти
      let l = e.len;
      for (let s = 0; s < e.len; s += 0.5) if (chE(e.ax + e.dx * s, e.az + e.dz * s) < 1.04) { l = s - 1; break; }
      rails([e.ax, e.az], [e.ax + e.dx * l, e.az + e.dz * l], e.fa, segFloor(e, l / e.len));
      if (rnd() < 0.5 && e.len > 25) { const s = e.len * (0.3 + rnd() * 0.4); cart(e.ax + e.dx * s, segFloor(e, s / e.len) + 0.12, e.az + e.dz * s, e.dx, e.dz, 1 + (rnd() < 0.3 ? 1 : 0)); }
    }
    if (e.kind === 'narrow') {
      // в лазах — только редкие фонари на стене
      for (let s = 6; s < e.len - 3; s += 14) { const x = e.ax + e.dx * s, z = e.az + e.dz * s; lantern(x - e.dz * (e.hw - 0.4), segFloor(e, s / e.len) + 2.6, z + e.dx * (e.hw - 0.4), 0.15, 1.1); }
    }
    // кристаллы — на глубине и в глыбовых ходах
    if (!tier1 || e.kind === 'rough') for (let s = 5 + rnd() * 6; s < e.len - 3; s += 9 + rnd() * 10) {
      const sd = rnd() < 0.5 ? -1 : 1, w = e.hw - 0.7, x = e.ax + e.dx * s - e.dz * w * sd, z = e.az + e.dz * s + e.dx * w * sd;
      if (chE(x, z) < 1.1) continue;
      crystals(x, segFloor(e, s / e.len), z, 3 + Math.floor(rnd() * 3), e.fa < -270 ? 0.9 : 0.6);
    }
  }
  // --- лагерь шахтёров ---
  {
    const [x, z, y] = N.L;
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + 0.3, r = 10.5; box(x + Math.cos(a) * r, y + 3, z + Math.sin(a) * r, 0.36, 6, 0.36, wood()); lantern(x + Math.cos(a) * (r - 0.4), y + 4.2, z + Math.sin(a) * (r - 0.4), 0.3); }
    cart(x - 6, y + 0.12, z + 5, 0.6, 0.8, 1); cart(x - 3.5, y + 0.12, z + 7, 0.6, 0.8, 2); cart(x + 2, y + 0.12, z - 8, 1, 0, 0);
    for (let k = 0; k < 7; k++) { const a = 4.5 + k * 0.2, r = 10 + rnd() * 1.4; (k % 3 ? crate : barrel)(x + Math.cos(a) * r, y, z + Math.sin(a) * r); }   // у стены, подальше от ямы
    crate(x + 7, y + 0.9, z + 5, 0.8); crate(x + 7.8, y, z + 4.4); crate(x + 6.6, y, z + 5.4);
    // стол
    box(x + 3, y + 0.85, z + 5, 2.2, 0.12, 1.1, wood()); for (const [ox, oz] of [[-1, -0.45], [1, -0.45], [-1, 0.45], [1, 0.45]]) box(x + 3 + ox, y + 0.42, z + 5 + oz, 0.1, 0.84, 0.1, wood());
    lantern(x + 3, y + 1.33, z + 5, 0, 1.2);
    // копёр над ямой: две стойки, перекладина, цепь вниз
    const pit = PITS[0], [px, pz] = [N[pit[1]][0], N[pit[1]][1]];
    for (const sd of [-1, 1]) box(px + sd * 3.4, y + 2.6, pz, 0.34, 5.2, 0.34, wood());
    box(px, y + 5.3, pz, 7.4, 0.36, 0.4, wood()); box(px, y + 2.6, pz, 0.05, 5.2, 0.05, IRON);
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; if (k === 2) continue; box(px + Math.cos(a) * 3.4, y + 0.5, pz + Math.sin(a) * 3.4, 0.14, 1.0, 0.14, wood()); box(px + Math.cos(a + 0.31) * 3.3, y + 0.95, pz + Math.sin(a + 0.31) * 3.3, 2.1, 0.1, 0.1, wood(), -(a + 0.31) - Math.PI / 2); }
    lantern(px, y + 5.1, pz + 0.3, 0.4, 1.6);
  }
  // --- паучье гнездо и ход к нему ---
  {
    const [x, z, y] = N.NEST;
    for (let k = 0; k < 16; k++) {
      const a = rnd() * TAU, r = 6 + rnd() * 7, h = 3 + rnd() * 8;
      web(x + Math.cos(a) * r, y + h, z + Math.sin(a) * r, Math.cos(a), (rnd() - 0.5) * 0.8, Math.sin(a), 2.2 + rnd() * 2.2);
    }
    for (let k = 0; k < 6; k++) web(x + (rnd() - 0.5) * 12, y + 9 + rnd() * 2, z + (rnd() - 0.5) * 12, 0, 1, 0, 3 + rnd() * 2);
    for (let k = 0; k < 9; k++) { const a = rnd() * TAU, r = 7 + rnd() * 6; cocoon(x + Math.cos(a) * r, y + 1 + rnd() * 6, z + Math.sin(a) * r, 0.8 + rnd() * 0.8); }
    spider(x + 3, y, z - 4, 2.2, 1.2); spider(x - 6, y, z + 3, 1.8, -0.6);
    for (let k = 0; k < 4; k++) spider(x + (rnd() - 0.5) * 14, y + 4 + rnd() * 4, z + (rnd() - 0.5) * 14, 0.8, rnd() * TAU, 3 + rnd() * 3);
    crystals(x - 9, y, z - 6, 4, 0.7); crystals(x + 8, y, z + 7, 3, 0.6);
    // у входа в гнездо — пара старых фонарей: светят тускло, дальше темно
    for (const [ox, oz] of [[9, 6], [11, 1]]) { box(x + ox, y + 1.6, z + oz, 0.2, 3.2, 0.2, wood(), 0, 0.15); lantern(x + ox + 0.4, y + 3.0, z + oz, 0.3); }
    for (let k = 0; k < 3; k++) cocoon(x + (rnd() - 0.5) * 4, y + 0.6, z + (rnd() - 0.5) * 4, 1.4);
    // по дороге к гнезду — паутина гуще и гуще
    for (const e of ctx.segs) if (e.from === 's1' || e.from === 's2') for (let s = 4; s < e.len; s += 4 + rnd() * 3) {
      const t = s / e.len, x2 = e.ax + e.dx * s, z2 = e.az + e.dz * s, f = segFloor(e, t), sd = rnd() < 0.5 ? -1 : 1;
      web(x2 - e.dz * (e.hw - 0.3) * sd, f + e.H * (0.45 + rnd() * 0.35), z2 + e.dx * (e.hw - 0.3) * sd, -e.dz * sd, -0.3, e.dx * sd, 1.0 + rnd() * 0.8 * (e.from === 's2' ? 1.6 : 1));
      if (e.from === 's2' && rnd() < 0.5) cocoon(x2, f + e.H - 1.2, z2, 0.7);
    }
  }
  // --- залы глубже ---
  { const [x, z, y] = N.H2; for (let k = 0; k < 5; k++) { const a = rnd() * TAU; crystals(x + Math.cos(a) * 8.5, y, z + Math.sin(a) * 8.5, 3, 0.7); } crate(x + 4, y, z - 6); barrel(x + 5, y, z - 4.8); lantern(x - 7, y + 4.2, z + 4, 0.3); }
  { const [x, z, y] = N.H3; for (let k = 0; k < 10; k++) { const a = k / 10 * TAU + rnd() * 0.3, r = 9 + rnd() * 3.5; crystals(x + Math.cos(a) * r, y + (rnd() < 0.3 ? 1.5 + rnd() * 3 : 0), z + Math.sin(a) * r, 4 + Math.floor(rnd() * 4), 1.1 + rnd() * 0.8, rnd() < 0.25 ? 0x7d8cff : 0x4aa6ff); } crystals(x, y, z, 5, 1.6); }
  { const [x, z, y] = N.JB; lantern(x + 4, y + 4.5, z, 0.4); cart(x - 3, y + 0.12, z + 3, 0.2, 1, 0); }
  // завалы
  for (const n of RUBBLE) { const [x, z, y] = N[n]; for (let k = 0; k < 9; k++) rockLump(x + (rnd() - 0.5) * 5, y + rnd() * 1.5, z + (rnd() - 0.5) * 5, 0.8 + rnd() * 1.3); box(x, y + 1.6, z, 0.3, 3.2, 0.3, wood(), 0, 0.5); }
  // таблички-указатели у развилок (пустые доски на стойке)
  for (const n of ['JB', 'a2', 'H2']) { const [x, z, y] = N[n]; box(x + 2, y + 1.1, z + 2, 0.12, 2.2, 0.12, wood()); box(x + 2, y + 2.0, z + 2, 1.2, 0.3, 0.06, 0x7a5232, rnd() * TAU); }

  // --- у пропасти ---
  // обрыв со сломанным мостиком (O1): 9 м досок над пустотой, дальше — обломки
  const dirIn = (n) => { const [x, z] = N[n], dx = CHASM.x - x, dz = CHASM.z - z, l = Math.hypot(dx, dz); return [dx / l, dz / l]; };
  function planks(x0, z0, ux, uz, len, y, w, solid = true, broken = 0) {
    const ry = rotY(ux, uz), nx = -uz, nz = ux;
    for (let s = 0.3; s < len; s += 0.5) {
      if (broken && s > len - broken && rnd() < 0.45) continue;
      const x = x0 + ux * s, z = z0 + uz * s;
      box(x, y - 0.05 + (rnd() - 0.5) * 0.03, z, 0.46, 0.09, w * (0.9 + rnd() * 0.12), wood(), ry);
    }
    for (const sd of [-1, 1]) box(x0 + ux * len / 2 + nx * (w / 2 - 0.1) * sd, y - 0.22, z0 + uz * len / 2 + nz * (w / 2 - 0.1) * sd, len, 0.22, 0.2, 0x4c3220, ry);
    if (solid) for (let s = 0; s < len - 0.1; s += 2) { const l = Math.min(2, len - s), x = x0 + ux * (s + l / 2), z = z0 + uz * (s + l / 2); addBox(x, z, l / 2 + 0.05, w / 2, ry, y, y - 0.3); }
  }
  function rail(x0, z0, ux, uz, len, y, off) {
    const nx = -uz, nz = ux, ry = rotY(ux, uz);
    for (let s = 0; s <= len; s += 1.6) box(x0 + ux * s + nx * off, y + 0.55, z0 + uz * s + nz * off, 0.12, 1.1, 0.12, wood());
    box(x0 + ux * len / 2 + nx * off, y + 1.08, z0 + uz * len / 2 + nz * off, len, 0.1, 0.1, wood(), ry);
  }
  {
    const [x, z, y] = N.O1, [ux, uz] = dirIn('O1');
    planks(x - ux * 2, z - uz * 2, ux, uz, 11, y, 2.4, true, 3);
    rail(x - ux * 2, z - uz * 2, ux, uz, 8, y, 1.1);
    for (const sd of [-1, 1]) box(x + ux * 1 - uz * 1.2 * sd, y - 2.5, z + uz * 1 + ux * 1.2 * sd, 0.3, 5, 0.3, wood(), 0, sd * 0.25);
    // обломки висят ниже на верёвках
    for (let k = 0; k < 3; k++) { const s = 12 + k * 1.1; box(x + ux * s, y - 1.5 - k * 0.8, z + uz * s, 0.46, 0.09, 2.2, wood(), rotY(ux, uz), 0.9 + k * 0.2); }
    lantern(x - ux * 1.5 - uz * 1.1, y + 1.4, z - uz * 1.5 + ux * 1.1, 0, 1.3);
    box(x - ux * 1.5 - uz * 1.1, y + 0.7, z - uz * 1.5 + ux * 1.1, 0.12, 1.4, 0.12, wood());
  }
  // балкон над пропастью (O3)
  {
    const [x, z, y] = N.O3, [ux, uz] = dirIn('O3');
    planks(x - ux * 1.5, z - uz * 1.5, ux, uz, 5.5, y, 4.6, true);
    rail(x - ux * 1.5, z - uz * 1.5, ux, uz, 5.5, y, 2.2); rail(x - ux * 1.5, z - uz * 1.5, ux, uz, 5.5, y, -2.2);
    box(x + ux * 4, y + 0.55, z + uz * 4, 0.12, 1.1, 0.12, wood()); box(x + ux * 4, y + 1.08, z + uz * 4, 4.4, 0.1, 0.1, wood(), rotY(-uz, ux));
    for (const sd of [-1, 1]) box(x + ux * 3 - uz * 2 * sd, y - 3, z + uz * 3 + ux * 2 * sd, 0.3, 6, 0.3, wood(), rotY(ux, uz), 0.5);
    lantern(x + ux * 3.8 - uz * 2.2, y + 1.5, z + uz * 3.8 + ux * 2.2, 0.3);
  }
  // карниз вдоль стены (O2 → O2b): доски на кронштейнах, кое-где перила
  {
    // доски начинаются и кончаются на 2.5 м дальше выходов — заходят в сами ходы, без щели
    const y = LEDGE.y, ex = Math.sign(LEDGE.a1 - LEDGE.a0) * 2.5 / 62, A0 = LEDGE.a0 - ex, A1 = LEDGE.a1 + ex;
    const n = Math.max(4, Math.ceil(Math.abs(A1 - A0) * 60 / 2.2));
    for (let k = 0; k < n; k++) {
      const a0 = A0 + (A1 - A0) * (k / n), a1 = A0 + (A1 - A0) * ((k + 1) / n);
      const [x0, z0] = chAt(a0, 0.968), [x1, z1] = chAt(a1, 0.968), dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
      const yy = y + (N.O2b[2] - y) * (k / n);
      planks(x0, z0, dx / l, dz / l, l + 0.2, yy, 3.0, true);
      const [wx, wz] = chAt(a0, 0.99), [ix, iz] = chAt(a0, 0.93);
      box((wx + ix) / 2, yy - 0.9, (wz + iz) / 2, 0.16, 1.8, 0.16, wood(), 0, 0.6);
      if (k % 3 !== 1) rail(x0, z0, dx / l, dz / l, l, yy, -1.15 * Math.sign(LEDGE.a1 - LEDGE.a0) * -1);
      if (k % 4 === 0) lantern(wx * 0.97 + ix * 0.03, yy + 2.6, wz * 0.97 + iz * 0.03, 0.4);
    }
  }
  // уступ у самого тумана (O4): маленькая площадка
  { const [x, z, y] = N.O4, [ux, uz] = dirIn('O4'); planks(x - ux * 1, z - uz * 1, ux, uz, 3.5, y, 3, true); lantern(x - uz * 1.4, y + 1.6, z + ux * 1.4, 0.2); }
  // на той стороне: устья ходов с фонарями и площадками, мосты, цепи
  for (const m of ctx.farMouths) {
    const [x, z] = chAt(m.a, 0.975), ux = Math.cos(m.a), uz = Math.sin(m.a);
    planks(x + ux * 1.2, z + uz * 1.2, -ux, -uz, 4.5, m.y, 3.2, false);
    frame(x + ux * 2.5, m.y, z + uz * 2.5, -ux, -uz, 2.7, 3.6, false);
    lantern(x + uz * 1.6, m.y + 3, z - ux * 1.6, 0.3, 2.2, false); lantern(x - uz * 1.6, m.y + 3, z + ux * 1.6, 0.3, 2.2, false);
    for (let k = 0; k < 3; k++) box(x - ux * 3, m.y - 4 - k * 4, z - uz * 3, 0.3, 4, 0.3, wood());
  }
  // каменный мост и дощатый мост на той стороне (без коллизий: туда не дойти)
  const span = (a0, a1, y, stone) => {
    const [x0, z0] = chAt(a0, 0.985), [x1, z1] = chAt(a1, 0.985), dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l, ry = rotY(ux, uz);
    if (stone) {
      for (let s = 0; s < l; s += 2.2) { const x = x0 + ux * s, z = z0 + uz * s, sag = Math.sin(s / l * Math.PI); box(x, y - 0.5, z, 2.3, 1.0 + (1 - sag) * 0.8, 3.6, 0x4b4440, ry); box(x - uz * 1.7, y + 0.35, z + ux * 1.7, 2.1, 0.7, 0.35, 0x57504a, ry); box(x + uz * 1.7, y + 0.35, z - ux * 1.7, 2.1, 0.7, 0.35, 0x57504a, ry); }
      for (let k = 1; k < 4; k++) { const s = l * k / 4, x = x0 + ux * s, z = z0 + uz * s; box(x, y - 14, z, 3, 26, 3, 0x433c39, ry); lantern(x, y + 2.2, z, 0.5, 2.4, false); }
    } else {
      for (let s = 0.3; s < l; s += 0.55) { const x = x0 + ux * s, z = z0 + uz * s, sag = Math.sin(s / l * Math.PI) * 2.2; box(x, y - sag, z, 0.45, 0.09, 2.2, wood(), ry); }
      for (const sd of [-1.1, 1.1]) for (let s = 0; s < l; s += 2.4) { const x = x0 + ux * (s + 1.2) - uz * sd, z = z0 + uz * (s + 1.2) + ux * sd, sag = Math.sin((s + 1.2) / l * Math.PI) * 2.2; box(x, y - sag + 1.0, z, 2.4, 0.06, 0.06, 0x3a2a1c, ry); }
      lantern(x0 + ux * l / 2, y - 2.2 + 0.9, z0 + uz * l / 2, 0.2, 2.0, false);
    }
  };
  span(-0.85, 0.6, -236, true); span(0.2, 1.05, -266, false); span(-1.3, -0.3, -282, false);
  // цепи и подвесные клети в пропасти
  for (let k = 0; k < 7; k++) {
    const a = rnd() * TAU, [x, z] = chAt(a, 0.35 + rnd() * 0.5), y = CHASM.roof + 6, L = 25 + rnd() * 55;
    box(x, y - L / 2, z, 0.08, L, 0.08, IRON);
    if (rnd() < 0.6) { box(x, y - L - 0.9, z, 1.4, 1.8, 1.4, 0x2a2426); lantern(x, y - L - 2, z, 0.3, 1.6, false); }
  }
  // --- склеиваем по кускам 40 м ---
  let tris = 0;
  const mat = propMaterial();
  for (const parts of B.values()) {
    const g = merge(parts);
    tris += g.attributes.position.count / 3;
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false; m.userData.mine = true;
    scene.add(m);
  }
  return { tris };
}
