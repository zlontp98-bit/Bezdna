import * as THREE from '../vendor/three.min.js';
import { TUNNELS, tunLocal, tunC, tunHW, tunH, tunFloor, rockMat, setMineSpace } from './terrain.js';
import { chunkMesh } from './chunks.js';
import { mulberry32, SEED, smoothstep } from './noise.js';
import { part, merge, T as M4, propMaterial } from './flora.js';
import { LAVA_POOLS, mat } from './shaders.js';
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
export const CHASM = { x: 150, z: -25, rx: 52, rz: 46, floor: -345, fog: -322, death: -316, roof: -204 };
const chE = (x, z) => Math.hypot((x - CHASM.x) / CHASM.rx, (z - CHASM.z) / CHASM.rz);
const chAt = (th, s = 1) => [CHASM.x + Math.cos(th) * CHASM.rx * s, CHASM.z + Math.sin(th) * CHASM.rz * s];

// ---- план: узлы [x, z, пол] ----
// Вариант 3 (после теста): карта первого варианта, ходы вдвое шире, Красная пропасть ближе к центру — на неё
// смотрят со всех сторон; между ходами — лавовые поля с большими камнями (паркур из хода в ход),
// обвалы-осыпи и лестницы по стене пропасти между ярусами. План: /mnt/project-files/mines-plan/5-variant3-lava.png
const N = {
  a2: [100, -130, -203], L: [120, -152, -206], a3: [148, -138, -209], O1: [150, -100, -211],
  s1: [64, -184, -203], s2: [56, -204, -207], NEST: [50, -228, -209],
  T1: [172, -186, -211], F1: [192, -170, -223], G1: [198, -146, -229],
  K0: [-135.5, 22, -198], b2: [-135, -22, -202], JB: [-125, -70, -205], T2: [-178, -98, -206],
  b3: [-95, -120, -209], b4: [-47.5, -144, -213], b5: [0, -168, -217], b6: [50, -165, -222], b7: [95, -157, -227],
  ST: [-12, -208, -215],
  H2: [113, -159, -231], c1: [156, -168, -234], c2: [178, -132, -238], O3: [192, -62, -240], c3: [150, -112, -237], cp1: [120, -108, -236], c4: [118, -72, -241], T3: [80, -62, -239], c5: [80, -34, -245],
  O2: [96, -22, -248], O2b: [110, 12, -251],
  d1: [140, 44, -255], P3: [136, 58, -257], d2: [136, 58, -281], H3: [96, 96, -286], T4: [52, 116, -288], d3: [150, 74, -296], O4: [158, 40, -303], d4: [118, 128, -306], EXIT: [105, 160, -312],
};
// ходы: [откуда, куда, вид]. main — штрек с рельсами и крепью, side — боковой, narrow — узкий лаз, entry — как туннель,
// scree — обвал-осыпь: пол уступами по 0.8 м (вниз — просто идёшь, вверх — запрыгиваешь)
const E = [
  ['A1', 'a2', 'entry'], ['a2', 'L', 'main'], ['L', 'a3', 'main'], ['a3', 'O1', 'main'],
  ['a2', 's1', 'side'], ['s1', 's2', 'narrow'], ['s2', 'NEST', 'side'], ['a3', 'T1', 'narrow'],
  ['B1', 'K0', 'entry'], ['K0', 'b2', 'main'], ['b2', 'JB', 'main'], ['JB', 'T2', 'side'], ['JB', 'b3', 'main'], ['b3', 'b4', 'main'], ['b4', 'b5', 'main'], ['b5', 'b6', 'main'], ['b6', 'b7', 'main'], ['b7', 'H2', 'main'],
  ['b5', 'ST', 'side'],
  ['H2', 'c1', 'rough'], ['c1', 'c2', 'rough'], ['c2', 'O3', 'rough'], ['c2', 'c3', 'narrow'], ['c3', 'cp1', 'narrow'], ['H2', 'cp1', 'rough'], ['cp1', 'c4', 'rough'], ['c4', 'T3', 'side'], ['c4', 'c5', 'rough'], ['c5', 'O2', 'side'],
  ['O2b', 'd1', 'side'], ['d1', 'P3', 'side'], ['d2', 'H3', 'main'], ['H3', 'T4', 'side'], ['H3', 'd4', 'main'], ['d4', 'EXIT', 'main'], ['d2', 'd3', 'narrow'], ['d3', 'O4', 'narrow'],
  // обвалы между ярусами
  ['T1', 'F1', 'scree'], ['F1', 'G1', 'scree'], ['G1', 'c2', 'scree'], ['T3', 'c5', 'scree'], ['d4', 'T4', 'scree'],
];
const KIND = {
  main: { hw: 8.0, H: 14, amp: 1.2 }, side: { hw: 4.5, H: 8, amp: 1.0 }, rough: { hw: 6.0, H: 12, amp: 1.2 }, narrow: { hw: 1.5, H: 3.4, amp: 0.4 },
  entry: { hw: 6.5, H: 10, amp: 0.9, kind: 'main' }, scree: { hw: 5.0, H: 9, amp: 1.1 },
};
// залы и комнаты: [узел, радиус, высота свода]
const HALLS = [['L', 22, 16], ['NEST', 20, 15], ['H2', 15, 13], ['H3', 24, 20], ['JB', 13, 12], ['b5', 12, 11], ['c2', 11, 12], ['a2', 10, 11],
  ['K0', 12, 10], ['T1', 12, 10], ['F1', 7, 9], ['G1', 8, 10], ['T2', 11, 10], ['ST', 12, 10]];
// узкие ямы вниз: [верх, низ, радиус]; низ стоит ровно под верхом
const PITS = [['L', 'H2', 2.8], ['P3', 'd2', 2.6]];
// выходы к пропасти: узел сдвигается от предыдущего узла хода до самого края пропасти
const EDGE = [['O1', 'a3'], ['O3', 'c2'], ['O2', 'c5'], ['O4', 'd3']];
// тупики-завалы: на конце хода груда камней
const RUBBLE = ['EXIT'];

// ---- лавовые поля ----
// Низкая лава в гроте между ходами, из неё торчат большие глыбы разной формы — по ним прыгают из хода в ход.
// Вход в поле: короткий ход от узла до края грота, в конце — «берег» (большая глыба на уровне пола хода).
// Между берегами — цепочка глыб с щелями 1.2–2 м (прыжок) и ступенями не выше 0.9 м; вокруг — ещё глыбы.
// entries: [узел, пол у края]
const FIELDS = [
  { ...LAVA_POOLS[0], roofE: -199, roofT: -193, entries: [['b5', -217.5], ['a2', -210]] },
  { ...LAVA_POOLS[1], roofE: -223, roofT: -216, entries: [['H2', -234], ['c2', -236]] },
  { ...LAVA_POOLS[2], roofE: -279, roofT: -272, entries: [['H3', -290], ['d3', -294]], via: [[0.35, 0.45]] },
  { ...LAVA_POOLS[3], roofE: -194, roofT: -189, entries: [['b2', -204], ['T2', -206]] },
];
// лестницы по стене пропасти между ярусами: [от узла, до узла, обход по углу (рад), промежуточные точки [угол, высота]]
// via — точка поворота: лестница уходит дальше по стене и возвращается ниже (зигзаг, не так круто)
const WALLPATHS = [
  { from: 'O2', to: 'O2b', via: [] },
  { from: 'O1', to: 'O3', via: [[-0.35, -231]] },
  { from: 'O2b', to: 'O4', via: [[0.75, -279]] },
];
const PATH_S = 0.968, PATH_W = 3.2, RISE = 0.45;

export const MINE_LIGHTS = [];
export const MINE_NODES = N;   // для проверок
export const MINE_ROUTES = [], MINE_PATHS = [], MINE_FIELDS = [];
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
  } else if (e.scree) {
    // осыпь: ровные площадки, между ними уступы ≤ 0.8 м
    // у нижнего конца — ровный заход (там стык с широким ходом: его пол не «съедает» первую ступень)
    const n = e.steps, u = Math.min(1, Math.max(0, (t * e.len - e.la) / (e.len - e.la - e.lb)));
    f = e.fa + (e.fb - e.fa) * Math.min(n, Math.max(0, Math.round(u * (n + 1) - 0.5))) / n;
  }
  return f;
}
function addSeg(a, b, kind, extra = {}) {
  const K = KIND[kind] || kind;
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
  const e = { type: 0, kind: extra.kind || K.kind || kind, ax: a[0], az: a[1], fa: a[2], bx: b[0], bz: b[1], fb: b[2], dx: dx / len, dz: dz / len, len,
    hw: K.hw, H: K.H, amp: K.amp, rough: kind === 'rough', scree: kind === 'scree', seed: EL.length * 1.7, ...extra };
  e.steps = Math.max(1, Math.ceil(Math.abs(b[2] - a[2]) / 0.8));
  if (e.scree) {
    e.la = a[2] < b[2] ? 9 : 5; e.lb = b[2] < a[2] ? 9 : 5;
    const k = Math.min(1, Math.max(0, len - e.steps * 1.0) / (e.la + e.lb)); e.la *= k; e.lb *= k;
  }
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

const segT = (e, x, z) => { const t = ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.len; return t < 0 ? 0 : t > 1 ? 1 : t; };
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
// лавовая пещера: эллипс со сводом-куполом, дно под лавой; столбы и карниз — скала внутри неё
const lvE = (e, x, z) => { const rx = x - e.x, rz = z - e.z; return Math.hypot((rx * e.ux + rz * e.uz) / e.a, (-rx * e.uz + rz * e.ux) / e.b); };
const lvRoof = (e, k) => e.roofE + (e.roofT - e.roofE) * Math.max(0, 1 - k * k * k * k);
function capT(c, x, z) { let t = ((x - c.ax) * c.dx + (z - c.az) * c.dz) / c.len; return t < 0 ? 0 : t > 1 ? 1 : t; }
// глыба: эллипс (полуоси rx × rz, повёрнут), ровный верх top
const bK = (p, x, z) => { const dx = x - p.x, dz = z - p.z; return Math.hypot((dx * p.cu + dz * p.su) / p.rx, (-dx * p.su + dz * p.cu) / p.rz); };
function lavaD(e, x, y, z, noisy) {
  const k = lvE(e, x, z);
  let d = Math.min((1 - k) * e.b, y - e.floor, lvRoof(e, k) - y);
  if (noisy) {
    const big = vn3(x * 0.05, y * 0.07, z * 0.05) * 3.2 + vn3(x * 0.12 + 3, y * 0.16, z * 0.12) * 1.4;
    d += Math.max(0, 1.6 + big);
  }
  // столбы: сверху плоская площадка; у верха край чуть отступает внутрь (стоять можно до самого края видимой скалы),
  // ниже — глыбы торчат в обе стороны
  const side = (y2, top) => {
    if (!noisy) return 0;
    const n = vn3(x * 0.3, y2 * 0.11, z * 0.3) * 0.65 + vn3(x * 0.8, y2 * 0.35, z * 0.8) * 0.35;
    const lo = smoothstep(top - 1.2, top - 4, y2);
    return Math.max(0, n) * 0.55 * (1 - lo) + n * 2.2 * lo;
  };
  for (const p of e.pil) {
    if (Math.abs(x - p.x) > p.R + 6 || Math.abs(z - p.z) > p.R + 6) continue;
    // ниже верха глыба шире (основание расползается к лаве)
    const wid = noisy ? Math.min(1.6, Math.max(0, p.top - 1.0 - y) * 0.18) : 0;
    d = Math.min(d, Math.max((bK(p, x, z) - 1) * p.m - wid + side(y, p.top), y - p.top));
  }
  for (const c of e.caps) {
    const t = capT(c, x, z), top = c.ta + (c.tb - c.ta) * t;
    const r = Math.hypot(x - (c.ax + c.dx * c.len * t), z - (c.az + c.dz * c.len * t));
    if (r > c.r + 12) continue;
    d = Math.min(d, Math.max(r - c.r + side(y, top), y - top));
  }
  // сталактиты со свода (только вид)
  if (noisy) for (const st of e.stal) {
    const r = Math.hypot(x - st.x, z - st.z);
    if (r > st.R) continue;
    d = Math.min(d, (y - (st.y - st.L * (1 - r / st.R))) * -0.35);
  }
  return d;
}
const baseD = (e, x, y, z) => e.type === 0 ? segD(e, x, y, z) : e.type === 1 ? hallD(e, x, y, z) : e.type === 2 ? pitD(e, x, y, z) : e.type === 4 ? lavaD(e, x, y, z, false) : chasmD(x, y, z);

// тропы вдоль стены пропасти (карниз O2→O2b и лестницы между ярусами): там стена ровнее
// CALM — участки [угол0, высота0, угол1, высота1]
const CALM = [];
const wrapA = (d) => { while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
function ledgeCalm(x, y, z) {
  if (!CALM.length) return 0;
  const a = Math.atan2((z - CHASM.z) / CHASM.rz, (x - CHASM.x) / CHASM.rx);
  let best = 0;
  for (const c of CALM) {
    const span = wrapA(c[2] - c[0]), d = wrapA(a - c[0]);
    if (Math.abs(span) < 1e-4) continue;
    let f = d / span;
    const out = Math.max(0, -f, f - 1) * Math.abs(span);
    if (out > 0.12) continue;
    f = Math.min(1, Math.max(0, f));
    const yy = c[1] + (c[3] - c[1]) * f;
    const w = (1 - smoothstep(0.03, 0.1, out)) * smoothstep(yy - 4, yy - 1, y) * (1 - smoothstep(yy + 5, yy + 9, y));
    if (w > best) best = w;
  }
  return best;
}
function field(x, y, z, list) {
  let best = -1e9, n = null;
  for (const e of list) {
    let d = baseD(e, x, y, z);
    if (d < (e.type >= 3 ? -11 : -4)) { if (d > best) best = d; continue; }
    if (e.type === 4) d = lavaD(e, x, y, z, true);
    else if (e.type === 3) {
      // стены пропасти: крупные выступы, слои-карнизы и мелкий скол
      const calm = ledgeCalm(x, y, z);
      // стена только отступает в скалу (не выпирает внутрь): край пустоты для физики — ровный эллипс, и
      // у выходов к пропасти под ногами никогда не оказывается «камень, которого нет»
      const big = vn3(x * 0.045, y * 0.06, z * 0.045) * 3.4 + vn3(x * 0.11 + 3, y * 0.14, z * 0.11) * 1.5 + Math.sin(y * 0.42 + vn3(x * 0.03, 0, z * 0.03) * 4) * 0.9;
      d += Math.max(0, 2.0 + big) * (1 - calm * 0.85) + calm * 0.3;
    } else {
      if (n === null) n = rockN(x, y, z);
      const v = e.type === 0 ? y - segFloor(e, segT(e, x, z)) : e.type === 1 ? y - e.f : 9;
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
    } else if (e.type === 4) {
      const k = lvE(e, x, z);
      if (k > 1 - 0.45 / e.b) continue;
      let f = e.floor;
      for (const p of e.pil) if (p.top > f && bK(p, x, z) < 1 - 0.15 / p.m) f = p.top;
      for (const c of e.caps) {
        const t = capT(c, x, z), top = c.ta + (c.tb - c.ta) * t;
        if (top > f && Math.hypot(x - (c.ax + c.dx * c.len * t), z - (c.az + c.dz * c.len * t)) < c.r - 0.15) f = top;
      }
      _iv.push(f, lvRoof(e, k));
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
    const near = (x, z, m) => x > bx[0] - m && x < bx[1] + m && z > bx[2] - m && z < bx[3] + m;
    const list = EL.filter((e) => e.box[0] < bx[1] + 6 && e.box[1] > bx[0] - 6 && e.box[2] < bx[3] + 6 && e.box[3] > bx[2] - 6 && e.box[4] < bx[5] + 6 && e.box[5] > bx[4] - 6)
      // у лавовой пещеры берём только столбы и сталактиты рядом с куском
      .map((e) => e.type !== 4 ? e : { ...e, pil: e.pil.filter((p) => near(p.x, p.z, p.R + 11)), stal: e.stal.filter((st) => near(st.x, st.z, st.R + 1) && st.y - st.L < bx[5] + 1 && st.y > bx[4] - 1) });
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
  // тропы вдоль стены: O2b — прямо на краю пропасти; у каждого выхода — площадка, дальше ступени
  const ang = (p) => Math.atan2((p[1] - CHASM.z) / CHASM.rz, (p[0] - CHASM.x) / CHASM.rx);
  { const [x, z] = chAt(ang(N.O2b), 0.995); N.O2b = [x, z, N.O2b[2]]; }
  CALM.length = 0;
  const perM = 1 / ((CHASM.rx + CHASM.rz) / 2 * PATH_S);   // радиан на метр вдоль стены
  const paths = WALLPATHS.map((W) => {
    const A = [ang(N[W.from]), N[W.from][2]], B = [ang(N[W.to]), N[W.to][2]];
    const pts = [A, ...W.via, B];
    const d0 = Math.sign(wrapA(pts[1][0] - A[0])), d1 = Math.sign(wrapA(B[0] - pts[pts.length - 2][0]));
    // заход 2.5 м в ход, площадка 4 м у выхода
    // точки [угол, высота, доля радиуса]; после разворота лестница идёт обратно внешней полосой
    // (рядом с верхней, а не под ней) и прижимается к стене, когда верхняя уже высоко
    const SW = PATH_S, SI = PATH_S - PATH_W * 1.02 / ((CHASM.rx + CHASM.rz) / 2);
    const Bl = [B[0] - d1 * 4 * perM, B[1]];
    const full = [[A[0] - d0 * 2.5 * perM, A[1], SW], [A[0] + d0 * 4 * perM, A[1], SW]];
    for (const v of W.via) {
      full.push([v[0], v[1], SW], [v[0], v[1], SI]);
      const sp = wrapA(Bl[0] - v[0]);
      for (const [f, sl] of [[0.35, SI], [0.8, SW]]) full.push([v[0] + sp * f, v[1] + (Bl[1] - v[1]) * f, sl]);
    }
    full.push([Bl[0], Bl[1], SW], [B[0] + d1 * 2.5 * perM, B[1], SW]);
    for (let i = 0; i + 1 < full.length; i++) if (full[i][2] === SW && full[i + 1][2] === SW) CALM.push([full[i][0], full[i][1], full[i + 1][0], full[i + 1][1]]);
    return { ...W, pts: full };
  });
  // пустоты
  // заход из туннеля: последние метры туннеля продолжаем такой же ширины, чтобы шов был в глубине его стен
  const stubs = [];
  for (const q of ends) {
    const T = q.T, a = q.at(T.L - 9), b = q.at(T.L + 2.5);
    stubs.push(addSeg(a, [b[0], b[1], q.end[2]], { hw: tunHW(T, T.L) * 0.9, H: tunH(T, T.L) * 0.85, amp: 0.8 }, { kind: 'stub' }));
  }
  // лавовые поля: берега у входов, цепочка глыб между ними, ещё глыбы вокруг, сталактиты
  const fieldStubs = [];
  const lavas = FIELDS.map((L, li) => {
    const e = { type: 4, li, x: L.x, z: L.z, a: L.a, b: L.b, ux: L.ux, uz: L.uz, y: L.y, floor: L.y - 4, roofE: L.roofE, roofT: L.roofT, amp: 0, pil: [], caps: [], stal: [], src: L, route: [] };
    const sr = mulberry32(SEED + 4040 + li * 17);
    const loc = (x, z) => [(x - L.x) * L.ux + (z - L.z) * L.uz, -(x - L.x) * L.uz + (z - L.z) * L.ux];
    const wld = (s2, q) => [L.x + L.ux * s2 - L.uz * q, L.z + L.uz * s2 + L.ux * q];
    const boulder = (x, z, rx, rz, ang, top, tag) => {
      const p = { x, z, rx, rz, cu: Math.cos(ang), su: Math.sin(ang), top, m: Math.min(rx, rz), R: Math.max(rx, rz) + 2.5, tag };
      e.pil.push(p);
      if (tag) N[tag] = [x, z, top];
      return p;
    };
    const SH = 5.5;   // радиус берега
    const shores = L.entries.map(([n, fl], j) => {
      const P = N[n], [s2, q] = loc(P[0], P[1]), k = Math.hypot(s2 / L.a, q / L.b);
      const [rx0, rz0] = wld(s2 / k, q / k);                         // точка на краю грота
      const nx = (L.x - rx0), nz = (L.z - rz0), nl = Math.hypot(nx, nz);
      const end = [rx0 + nx / nl * 1.5, rz0 + nz / nl * 1.5, fl];     // ход кончается чуть за краем
      fieldStubs.push([n, end, 'F' + li + '_' + j]);
      const tag = 'S' + li + '_' + j;
      boulder(rx0 + nx / nl * 1.0, rz0 + nz / nl * 1.0, SH, SH, 0, fl, tag);
      return { x: rx0 + nx / nl * 1.0, z: rz0 + nz / nl * 1.0, top: fl, tag, node: n };
    });
    // цепочка: глыбы поперёк пути, щели 1.2–2 м, ступени не выше 0.9 м
    for (let j = 0; j + 1 < shores.length; j++) {
      const A = shores[j], B = shores[j + 1];
      // путь: от берега к берегу, через точки via (доли полуосей), если берега близко
      const P = [[A.x, A.z], ...(L.via || []).map(([fs, fq]) => wld(fs * L.a, fq * L.b)), [B.x, B.z]];
      const segL = []; let D = 0;
      for (let i = 0; i + 1 < P.length; i++) { const l = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); segL.push(l); D += l; }
      const at = (s2) => { let i = 0; while (i < segL.length - 1 && s2 > segL[i]) { s2 -= segL[i]; i++; } const ux = (P[i + 1][0] - P[i][0]) / segL[i], uz = (P[i + 1][1] - P[i][1]) / segL[i]; return [P[i][0] + ux * s2, P[i][1] + uz * s2, ux, uz]; };
      const Li = D - 2 * SH, dh = B.top - A.top;
      let n = Math.max(1, Math.round((Li - 1.6) / 10), Math.ceil(Math.abs(dh) / 0.85) - 1);
      let g = 1.6, r = (Li - (n + 1) * g) / (2 * n);
      if (r > 5.5) { n++; r = (Li - (n + 1) * g) / (2 * n); }
      if (r < 2.4) { g = 1.15; r = (Li - (n + 1) * g) / (2 * n); }
      const lat = P.length > 2 ? 0 : (sr() - 0.5) * 0.25 * D;
      e.route.push(A.tag);
      let prev = A.top;
      for (let i = 0; i < n; i++) {
        const sAl = SH + g + r + i * (2 * r + g), t = sAl / D;
        let off = lat * Math.sin(Math.PI * t);
        const [cx, cz, ux, uz] = at(sAl);
        let x = cx - uz * off, z = cz + ux * off;
        const [ls, lq] = loc(x, z);
        if (Math.hypot(ls / L.a, lq / L.b) > 0.8) { off *= 0.3; x = cx - uz * off; z = cz + ux * off; }
        let top = A.top + dh * (i + 1) / (n + 1) + (sr() - 0.5) * 0.35;
        top = Math.max(prev - 0.9, Math.min(prev + 0.9, top), L.y + 0.9);
        prev = top;
        const tag = 'C' + li + '_' + j + '_' + i;
        boulder(x, z, r * (1.25 + sr() * 0.6), r, Math.atan2(-ux, uz) + (sr() - 0.5) * 0.5, top, tag);   // длинная ось — поперёк пути
        e.route.push(tag);
      }
      e.route.push(B.tag);
    }
    // ещё глыбы вокруг: пониже, разной формы, на некоторые можно запрыгнуть
    const nExtra = Math.round(L.a * L.b / 55);
    for (let k = 0, tries = 0; k < nExtra && tries < 300; tries++) {
      const a = sr() * TAU, rr = Math.sqrt(sr()) * 0.85, [x, z] = wld(Math.cos(a) * L.a * rr, Math.sin(a) * L.b * rr);
      const rx = 2.2 + sr() * 5, rz = 1.8 + sr() * 3.5, R = Math.max(rx, rz);
      if (e.pil.some((p) => Math.hypot(p.x - x, p.z - z) < R + p.R - 1.0)) continue;
      boulder(x, z, rx, rz, sr() * TAU, L.y + (sr() < 0.12 ? 7 + sr() * 6 : 0.6 + sr() * 4.5));
      k++;
    }
    for (let k = 0; k < Math.round(L.a * L.b / 35); k++) {
      const a = sr() * TAU, rr = Math.sqrt(sr()) * 0.9, [x, z] = wld(Math.cos(a) * L.a * rr, Math.sin(a) * L.b * rr);
      e.stal.push({ x, z, y: lvRoof(e, rr) + 3, R: 1.2 + sr() * 2.4, L: 3 + sr() * 9 });
    }
    const ext = Math.max(L.a, L.b) + 10;
    e.box = [L.x - ext, L.x + ext, L.z - ext, L.z + ext, e.floor - 4, L.roofT + 8];
    EL.push(e);
    return e;
  });
  MINE_ROUTES.length = 0; for (const e of lavas) MINE_ROUTES.push(e.route);
  MINE_FIELDS.length = 0; MINE_FIELDS.push(...lavas);
  MINE_PATHS.length = 0; MINE_PATHS.push(...paths);
  const segs = [];
  // ход от зала начинаем у края зала (пол зала ровный, без канавы от уклона хода), если уклон не выйдет круче
  const HR = Object.fromEntries(HALLS.map(([n, R]) => [n, R]));
  const trim = (a, b, na, nb, k) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz), dh = Math.abs(b[2] - a[2]);
    const need = k === 'scree' ? Math.ceil(dh / 0.8) * 1.1 : dh / 0.5;
    let ra = HR[na] ? HR[na] * 0.85 : 0, rb = HR[nb] ? HR[nb] * 0.85 : 0;
    const room = len - need - 2;
    if (ra + rb > 0 && ra + rb > room) { const f = Math.max(0, room) / (ra + rb); ra *= f; rb *= f; }
    return [[a[0] + dx / len * ra, a[1] + dz / len * ra, a[2]], [b[0] - dx / len * rb, b[1] - dz / len * rb, b[2]]];
  };
  for (const [a, b, k] of E) { const [A, B] = k === 'scree' ? [N[a], N[b]] : trim(N[a], N[b], a, b, k); segs.push(addSeg(A, B, k, { from: a, to: b })); }
  for (const [n, end, tag] of fieldStubs) { N[tag] = end; const [A, B] = trim(N[n], end, n, tag, 'side'); segs.push(addSeg(A, B, 'side', { from: n, to: tag, field: true })); }
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
  const FAR = [[-0.1, -226], [0.2, -262], [0.45, -238], [0.6, -290], [3.4, -262], [3.8, -275], [4.2, -290], [4.4, -300]];
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
  const props = buildProps(scene, rnd, { segs, farMouths, stubs, lavas, paths });
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
// смерть в красном тумане (ноги ниже этой высоты над дном пропасти) или в лаве
export function inDeadlyFog(p) {
  return (p.y < CHASM.death && chE(p.x, p.z) < 1.1) || inLava(p);
}
export function inLava(p) {
  for (const L of LAVA_POOLS) {
    if (p.y > L.y + 0.4) continue;
    const rx = p.x - L.x, rz = p.z - L.z;
    if (Math.hypot((rx * L.ux + rz * L.uz) / L.a, (-rx * L.uz + rz * L.ux) / L.b) < 1.05) return true;
  }
  return false;
}
// лава: светящиеся потоки под тёмной коркой, медленно ползут
let _lavaMat = null;
function lavaMaterial() {
  if (_lavaMat) return _lavaMat;
  _lavaMat = mat({
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW;
      void main(){
        vec2 p = vW.xz; float t = uTime;
        float n1 = vnoise(p * 0.07 + vec2(t * 0.025, t * 0.018));
        float n2 = vnoise(p * 0.19 - vec2(t * 0.04, -t * 0.03) + n1 * 2.2);
        float n3 = vnoise(p * 0.6 + n2 * 3.0 + t * 0.08);
        float crust = smoothstep(0.45, 0.66, n2 * 0.7 + n3 * 0.3);
        vec3 hot = mix(vec3(1.0, 0.30, 0.03), vec3(1.0, 0.80, 0.28), smoothstep(0.22, 0.0, abs(n2 - 0.38)));
        vec3 em = mix(hot * 1.2, vec3(0.14, 0.035, 0.015), crust);
        em *= 0.85 + 0.2 * sin(t * 1.5 + n1 * 9.0);
        float d = distance(vW, cameraPosition);
        vec3 c = applyFog(vec3(0.05, 0.015, 0.01), vW) + em * exp(-d * 0.003);
        float mx = max(max(c.r, c.g), c.b); if (mx > 1.0) c /= mx;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return _lavaMat;
}
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
    if (lit) light(x, ly, z, 9 * Math.max(1, s / 1.4), 1.0, [1.0, 0.58, 0.26]);
  }
  // рама крепи поперёк хода: стойки на каменных башмаках, верхняк, подкосы, железные хомуты
  function frame(x, y, z, dx, dz, hw, h, lamp) {
    const ry = rotY(-dz, dx), nx = -dz, nz = dx, w = hw - 0.45, k = Math.min(2.2, Math.max(1, hw / 4));   // k — толщина брёвен в больших штреках
    for (const sd of [-1, 1]) {
      const px = x + nx * w * sd, pz = z + nz * w * sd;
      box(px, y + 0.17 * k, pz, 0.55 * k, 0.34 * k, 0.55 * k, STONE, ry);
      box(px, y + h / 2, pz, 0.32 * k, h, 0.32 * k, wood(), ry, (rnd() - 0.5) * 0.04);
      box(px, y + h * 0.35, pz, 0.36 * k, 0.09 * k, 0.36 * k, IRON, ry); box(px, y + h * 0.8, pz, 0.36 * k, 0.09 * k, 0.36 * k, IRON, ry);
      // подкос: от стойки к верхняку, под 45°
      box(px - nx * sd * 0.55 * k * 1.4, y + h - 0.6 * k * 1.4, pz - nz * sd * 0.55 * k * 1.4, 1.3 * k * 1.4, 0.2 * k, 0.22 * k, wood(), ry, sd * Math.PI / 4);
    }
    box(x, y + h + 0.17 * k, z, w * 2 + 0.7 * k, 0.36 * k, 0.4 * k, wood(), ry);
    box(x + nx * (w - 0.2), y + h + 0.17 * k, z + nz * (w - 0.2), 0.42 * k, 0.42 * k, 0.44 * k, IRON, ry);
    box(x - nx * (w - 0.2), y + h + 0.17 * k, z - nz * (w - 0.2), 0.42 * k, 0.42 * k, 0.44 * k, IRON, ry);
    if (k > 1.5) { box(x, y + h + 0.17 * k, z, 0.5 * k, 0.5 * k, 0.44 * k, IRON, ry); }
    if (lamp) lantern(x + nx * (w - 1.0 * k) * (rnd() < 0.5 ? -1 : 1), y + h, z + nz * (w - 1.0 * k), 0.55 * k, 1.4 * Math.sqrt(k));
  }
  // рельсы: две полосы и шпалы, по прямой от a до b (пол хода — ровный уклон)
  function rails(a, b, f0, f1, off = 0) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 1) return;
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux, ry = rotY(ux, uz), pitch = Math.atan2(f1 - f0, len);
    a = [a[0] + nx * off, a[1] + nz * off];
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

  // палатка: два ската из досок и полотна, кол по углам
  function tent(x, y, z, ry) {
    const c = Math.cos(ry), sn = Math.sin(ry);
    for (const sd of [-1, 1]) {
      const ox = -sn * 0.9 * sd, oz = -c * 0.9 * sd;   // поперёк палатки
      geo(new THREE.BoxGeometry(1, 1, 1), x + ox, y + 1.0, z + oz, 0x8a7a5c, new THREE.Matrix4().compose(new THREE.Vector3(x + ox, y + 1.0, z + oz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, sd * 0.85, 'YXZ')), new THREE.Vector3(3.4, 0.06, 2.5)));
    }
    box(x, y + 1.95, z, 3.6, 0.12, 0.12, wood(), ry);
    for (const sd of [-1, 1]) box(x + c * 1.7 * sd, y + 1.0, z - sn * 1.7 * sd, 0.12, 2.0, 0.12, wood(), ry);
  }
  function campfire(x, y, z) {
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; rockLump(x + Math.cos(a) * 1.0, y - 0.1, z + Math.sin(a) * 1.0, 0.28); }
    for (let k = 0; k < 4; k++) box(x, y + 0.2, z, 1.4, 0.16, 0.16, 0x4a2e1a, k * 0.8, 0.25);
    geo(new THREE.ConeGeometry(0.45, 1.1, 6), x, y + 0.6, z, 0xff8a2a, M4(x, y + 0.6, z), 1);
    light(x, y + 1.2, z, 14, 1.3, [1.0, 0.55, 0.2]);
  }
  const lampPost = (x, y, z, h = 3.2) => { box(x, y + h / 2, z, 0.22, h, 0.22, wood()); box(x + 0.5, y + h - 0.1, z, 1.1, 0.14, 0.14, wood()); lantern(x + 0.95, y + h - 0.15, z, 0.35, 1.5); };
  const sign = (x, y, z, ry) => { box(x, y + 1.1, z, 0.14, 2.2, 0.14, wood()); box(x, y + 2.0, z, 1.4, 0.36, 0.07, 0x7a5232, ry); };

  // --- по ходам ---
  const halls = HALLS.map(([n, R]) => ({ x: N[n][0], z: N[n][1], R }));
  const inHall = (x, z, m = 1) => halls.some((h) => Math.hypot(x - h.x, z - h.z) < h.R + m);
  // над пустотой (край пропасти или лавы) раму не ставим
  const solidUnder = (x, z, y) => { const f = mineSpace(x, z, y + 0.4); return f !== null && Math.abs(f - y) < 0.6; };
  for (const e of ctx.segs) {
    const tier1 = e.fa > -226, big = e.hw > 6;
    // крепь: в штреках через 7 м, в боковых через 7 м, в лазах — изредка одна стойка
    if (e.kind === 'main' || e.kind === 'side' || e.kind === 'rough') {
      const step = e.kind === 'main' ? (big ? 8 : 5) : e.kind === 'side' ? 7 : 9;
      let n = 0;
      for (let s = 3; s < e.len - 2; s += step) {
        const x = e.ax + e.dx * s, z = e.az + e.dz * s;
        if (inHall(x, z, 1.5) || chE(x, z) < 1.12) continue;
        const t = s / e.len, y = segFloor(e, t), y2 = segFloor(e, Math.min(1, t + 0.6 / e.len)), y1 = segFloor(e, Math.max(0, t - 0.6 / e.len));
        if (Math.abs(y2 - y1) > 0.2) continue;   // на уступе раму не ставим
        // у обрыва рама уже и сдвинута к стене: обе стойки — на камне
        const nx = -e.dz, nz = e.dx;
        let fw = 0, fo = 0;
        for (let hw = e.hw; hw >= 3.5 && !fw; hw -= 0.5) for (const sd of [0, -1, 1]) {
          const o = (e.hw - hw) * sd, w = hw - 1.1;
          if ((sd === 0) !== (hw === e.hw)) continue;
          if (solidUnder(x + nx * (o + w), z + nz * (o + w), y) && solidUnder(x + nx * (o - w), z + nz * (o - w), y)) { fw = hw; fo = o; break; }
        }
        if (!fw) continue;
        frame(x + nx * fo, y, z + nz * fo, e.dx, e.dz, fw, big ? e.H * 0.62 : Math.min(e.H * 0.72, 4.6), (n++ % (e.kind === 'main' ? 3 : 2)) === 1);
        // кое-где у стены — ящик, бочка или доски
        if (rnd() < (big ? 0.4 : 0.22)) { const sd = rnd() < 0.5 ? -1 : 1, w2 = e.hw - 1.6; if (solidUnder(x - e.dz * w2 * sd, z + e.dx * w2 * sd, y)) (rnd() < 0.5 ? crate : barrel)(x - e.dz * w2 * sd + e.dx * 1.6, y, z + e.dx * w2 * sd + e.dz * 1.6); }
      }
    }
    if (e.kind === 'main') {
      // рельсы до края пропасти (и до края лавы); в широких штреках — ближе к стене
      let l = e.len;
      const off = big ? -2.6 : 0;
      for (let s = 0; s < e.len; s += 0.5) { const x = e.ax + e.dx * s - e.dz * off, z = e.az + e.dz * s + e.dx * off; if (chE(x, z) < 1.04 || !solidUnder(x, z, segFloor(e, s / e.len))) { l = s - 1; break; } }
      rails([e.ax, e.az], [e.ax + e.dx * l, e.az + e.dz * l], e.fa, segFloor(e, l / e.len), off);
      if (rnd() < 0.6 && e.len > 25) { const s = e.len * (0.3 + rnd() * 0.4); cart(e.ax + e.dx * s - e.dz * off, segFloor(e, s / e.len) + 0.12, e.az + e.dz * s + e.dx * off, e.dx, e.dz, 1 + (rnd() < 0.3 ? 1 : 0)); }
    }
    if (e.kind === 'narrow') {
      // в лазах — только редкие фонари на стене
      for (let s = 6; s < e.len - 3; s += 14) { const x = e.ax + e.dx * s, z = e.az + e.dz * s; lantern(x - e.dz * (e.hw - 0.4), segFloor(e, s / e.len) + 2.6, z + e.dx * (e.hw - 0.4), 0.15, 1.1); }
    }
    // кристаллы — на глубине и в глыбовых ходах
    if (!tier1 || e.kind === 'rough') for (let s = 5 + rnd() * 6; s < e.len - 3; s += 9 + rnd() * 10) {
      const sd = rnd() < 0.5 ? -1 : 1, w = e.hw - 0.7, x = e.ax + e.dx * s - e.dz * w * sd, z = e.az + e.dz * s + e.dx * w * sd;
      if (chE(x, z) < 1.1 || !solidUnder(x, z, segFloor(e, s / e.len))) continue;
      crystals(x, segFloor(e, s / e.len), z, 3 + Math.floor(rnd() * 3), e.fa < -270 ? 0.9 : 0.6);
    }
  }
  // --- лагерь шахтёров ---
  {
    const [x, z, y] = N.L;
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + 0.3, r = 17; box(x + Math.cos(a) * r, y + 4.5, z + Math.sin(a) * r, 0.5, 9, 0.5, wood()); lantern(x + Math.cos(a) * (r - 0.5), y + 6.2, z + Math.sin(a) * (r - 0.5), 0.3, 1.8); }
    // палатки и костёр — лагерь шахтёров
    for (const [a, r] of [[1.2, 12], [2.0, 13], [5.6, 12.5]]) tent(x + Math.cos(a) * r, y, z + Math.sin(a) * r, a + Math.PI / 2);
    campfire(x - 4, y, z + 3);
    cart(x - 6, y + 0.12, z + 5, 0.6, 0.8, 1); cart(x - 3.5, y + 0.12, z + 7, 0.6, 0.8, 2); cart(x + 2, y + 0.12, z - 8, 1, 0, 0);
    for (let k = 0; k < 12; k++) { const a = 4.3 + k * 0.13, r = 16 + rnd() * 2.5; (k % 3 ? crate : barrel)(x + Math.cos(a) * r, y, z + Math.sin(a) * r); }   // у стены, подальше от ямы
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
      const a = rnd() * TAU, r = 8 + rnd() * 10, h = 3 + rnd() * 10;
      web(x + Math.cos(a) * r, y + h, z + Math.sin(a) * r, Math.cos(a), (rnd() - 0.5) * 0.8, Math.sin(a), 2.2 + rnd() * 2.2);
    }
    for (let k = 0; k < 6; k++) web(x + (rnd() - 0.5) * 16, y + 11 + rnd() * 3, z + (rnd() - 0.5) * 12, 0, 1, 0, 3 + rnd() * 2);
    for (let k = 0; k < 12; k++) { const a = rnd() * TAU, r = 9 + rnd() * 9; cocoon(x + Math.cos(a) * r, y + 1 + rnd() * 6, z + Math.sin(a) * r, 0.8 + rnd() * 0.8); }
    spider(x + 3, y, z - 4, 2.2, 1.2); spider(x - 6, y, z + 3, 1.8, -0.6);
    for (let k = 0; k < 4; k++) spider(x + (rnd() - 0.5) * 14, y + 4 + rnd() * 4, z + (rnd() - 0.5) * 14, 0.8, rnd() * TAU, 3 + rnd() * 3);
    crystals(x - 9, y, z - 6, 4, 0.7); crystals(x + 8, y, z + 7, 3, 0.6);
    // у входа в гнездо — пара старых фонарей: светят тускло, дальше темно
    for (const [ox, oz] of [[13, 8], [15, 2]]) { box(x + ox, y + 1.6, z + oz, 0.2, 3.2, 0.2, wood(), 0, 0.15); lantern(x + ox + 0.4, y + 3.0, z + oz, 0.3); }
    for (let k = 0; k < 3; k++) cocoon(x + (rnd() - 0.5) * 4, y + 0.6, z + (rnd() - 0.5) * 4, 1.4);
    // по дороге к гнезду — паутина гуще и гуще
    for (const e of ctx.segs) if (e.from === 's1' || e.from === 's2') for (let s = 4; s < e.len; s += 4 + rnd() * 3) {
      const t = s / e.len, x2 = e.ax + e.dx * s, z2 = e.az + e.dz * s, f = segFloor(e, t), sd = rnd() < 0.5 ? -1 : 1;
      web(x2 - e.dz * (e.hw - 0.3) * sd, f + e.H * (0.45 + rnd() * 0.35), z2 + e.dx * (e.hw - 0.3) * sd, -e.dz * sd, -0.3, e.dx * sd, 1.0 + rnd() * 0.8 * (e.from === 's2' ? 1.6 : 1));
      if (e.from === 's2' && rnd() < 0.5) cocoon(x2, f + e.H - 1.2, z2, 0.7);
    }
  }
  // --- залы глубже ---
  { const [x, z, y] = N.H2; for (let k = 0; k < 5; k++) { const a = rnd() * TAU; crystals(x + Math.cos(a) * 12.5, y, z + Math.sin(a) * 12.5, 3, 0.8); } crate(x + 4, y, z - 6); barrel(x + 5, y, z - 4.8); lantern(x - 7, y + 4.2, z + 4, 0.3); }
  { const [x, z, y] = N.H3; for (let k = 0; k < 14; k++) { const a = k / 14 * TAU + rnd() * 0.3, r = 14 + rnd() * 7; crystals(x + Math.cos(a) * r, y + (rnd() < 0.3 ? 1.5 + rnd() * 3 : 0), z + Math.sin(a) * r, 4 + Math.floor(rnd() * 4), 1.1 + rnd() * 0.8, rnd() < 0.25 ? 0x7d8cff : 0x4aa6ff); } crystals(x, y, z, 5, 1.6); }
  { const [x, z, y] = N.JB; lantern(x + 4, y + 4.5, z, 0.4); cart(x - 3, y + 0.12, z + 3, 0.2, 1, 0); }
  // завалы
  for (const n of RUBBLE) { const [x, z, y] = N[n]; for (let k = 0; k < 9; k++) rockLump(x + (rnd() - 0.5) * 5, y + rnd() * 1.5, z + (rnd() - 0.5) * 5, 0.8 + rnd() * 1.3); box(x, y + 1.6, z, 0.3, 3.2, 0.3, wood(), 0, 0.5); }
  // таблички-указатели у развилок (пустые доски на стойке)
  for (const n of ['JB', 'a2', 'H2', 'K0']) { const [x, z, y] = N[n]; box(x + 2, y + 1.1, z + 2, 0.12, 2.2, 0.12, wood()); box(x + 2, y + 2.0, z + 2, 1.2, 0.3, 0.06, 0x7a5232, rnd() * TAU); }

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
    box(x + ux * 4, y + 0.55, z + uz * 4, 0.12, 1.1, 0.12, wood()); box(x + ux * 4, y + 1.08, z + uz * 4, 4.4, 0.1, 0.1, wood(), rotY(-uz, ux));
    for (const sd of [-1, 1]) box(x + ux * 3 - uz * 2 * sd, y - 3, z + uz * 3 + ux * 2 * sd, 0.3, 6, 0.3, wood(), rotY(ux, uz), 0.5);
    lantern(x + ux * 3.8 - uz * 2.2, y + 1.5, z + uz * 3.8 + ux * 2.2, 0.3);
  }
  // тропы вдоль стены пропасти: ступени из досок на кронштейнах, перила со стороны пустоты, фонари
  for (const P of ctx.paths) {
    let k = 0;
    for (let i = 0; i + 1 < P.pts.length; i++) {
      const [a0, y0, s0] = P.pts[i], [a1, y1, s1] = P.pts[i + 1], span = wrapA(a1 - a0);
      const conn = Math.abs(span) < 1e-4, wallLane = s0 === PATH_S && s1 === PATH_S;   // conn — площадка разворота
      const nextConn = i + 2 < P.pts.length && Math.abs(wrapA(P.pts[i + 2][0] - a1)) < 1e-4;
      // длина дуги
      let L = 0; for (let j = 0; j < 24; j++) { const [xa, za] = chAt(a0 + span * j / 24, s0 + (s1 - s0) * j / 24), [xb, zb] = chAt(a0 + span * (j + 1) / 24, s0 + (s1 - s0) * (j + 1) / 24); L += Math.hypot(xb - xa, zb - za); }
      const n = y0 === y1 ? Math.max(1, Math.round(L / 2)) : Math.max(1, Math.ceil(Math.abs(y1 - y0) / RISE));
      for (let j = 0; j < n; j++, k++) {
        const ta = a0 + span * j / n, tb = a0 + span * (j + 1) / n, y = y0 === y1 ? y0 : y0 + (y1 - y0) * (j + 1) / n;
        const [x0, z0] = chAt(ta, s0 + (s1 - s0) * j / n), [x1, z1] = chAt(tb, s0 + (s1 - s0) * (j + 1) / n), dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l, ry = rotY(ux, uz);
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        // к центру пропасти (сторона пустоты)
        let ix = CHASM.x - mx, iz = CHASM.z - mz; const il = Math.hypot(ix, iz); ix /= il; iz /= il;
        const st = y0 === y1 ? 0.5 : Math.max(0.5, l);
        for (let s2 = st / 2; s2 < l + 0.01; s2 += st) box(x0 + ux * s2, y - 0.06, z0 + uz * s2, Math.min(st, l) * 0.96 + 0.04, 0.12, PATH_W * (0.92 + rnd() * 0.08), wood(), ry);
        addBox(mx, mz, l / 2 + 0.06, PATH_W / 2, ry, y, y - 0.35);
        box(mx - ix * 0.2, y - 0.3, mz - iz * 0.2, l + 0.05, 0.18, 0.2, 0x4c3220, ry);   // брус под ступенью у стены
        box(mx + ix * (PATH_W / 2 - 0.15), y - 0.3, mz + iz * (PATH_W / 2 - 0.15), l + 0.05, 0.18, 0.2, 0x4c3220, ry);
        if (conn) { box(mx, y - 0.06, mz, l + PATH_W * 0.2, 0.12, PATH_W * 1.3, 0x5f3d24, ry); addBox(mx, mz, l / 2 + PATH_W * 0.15, PATH_W * 0.65, ry, y, y - 0.35); for (const sd of [-1, 1]) box(mx - uz * PATH_W * 0.6 * sd, y - 4, mz + ux * PATH_W * 0.6 * sd, 0.3, 8, 0.3, wood()); continue; }
        if (!wallLane) { if (k % 3 === 0) for (const sd of [-1, 1]) box(mx + ix * (PATH_W / 2 - 0.2) * sd, y - 3.2, mz + iz * (PATH_W / 2 - 0.2) * sd, 0.24, 6.2, 0.24, wood()); }
        else if (k % 3 === 0) {   // кронштейн: подкос от стены под край ступени
          const wx = mx - ix * (PATH_W / 2 - 0.2), wz = mz - iz * (PATH_W / 2 - 0.2);
          box(wx + ix * 1.2, y - 1.2, wz + iz * 1.2, 0.16, 2.6, 0.16, wood(), rotY(-iz, ix), 0.75);
        }
        // перила: стойка у каждой ступени, поручень уступом
        const px = mx + ix * (PATH_W / 2 - 0.12), pz = mz + iz * (PATH_W / 2 - 0.12);
        const nearTurn = nextConn && j >= n - 3;   // у разворота перила не ставим — там проход на нижний марш
        if (k % 4 !== 3 && !nearTurn) { box(px, y + 0.55, pz, 0.12, 1.1, 0.12, wood()); box(px, y + 1.05, pz, l + 0.1, 0.08, 0.08, 0x3a2a1c, ry); }
        if (!wallLane) { const qx = mx - ix * (PATH_W / 2 - 0.12), qz = mz - iz * (PATH_W / 2 - 0.12); if (k % 4 !== 1 && !(i > 0 && Math.abs(wrapA(P.pts[i - 1][0] - a0)) < 1e-4 && j < 3)) { box(qx, y + 0.55, qz, 0.12, 1.1, 0.12, wood()); box(qx, y + 1.05, qz, l + 0.1, 0.08, 0.08, 0x3a2a1c, ry); } }
        if (wallLane && k % 14 === 5) { const [wx, wz] = chAt((ta + tb) / 2, 0.998); lantern(wx, y + 2.7, wz, 0.4, 1.4); }
        if (k % 9 === 0) box(px + ix * 0.1, y - 2.5, pz + iz * 0.1, 0.22, 4.6, 0.22, wood());   // свая вниз
      }
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
  span(-0.2, 0.65, -250, true); span(3.35, 4.45, -282, false); span(0.1, 0.6, -298, false);
  // цепи и подвесные клети в пропасти
  for (let k = 0; k < 7; k++) {
    const a = rnd() * TAU, [x, z] = chAt(a, 0.35 + rnd() * 0.5), y = CHASM.roof + 6, L = 25 + rnd() * 55;
    box(x, y - L / 2, z, 0.08, L, 0.08, IRON);
    if (rnd() < 0.6) { box(x, y - L - 0.9, z, 1.4, 1.8, 1.4, 0x2a2426); lantern(x, y - L - 2, z, 0.3, 1.6, false); }
  }
  // ================= лавовые поля =================
  for (const e of ctx.lavas) {
    // лава: овал чуть больше грота (края прячутся в скале)
    {
      const g = new THREE.CircleGeometry(1, 96);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) * (e.a + 4), v = pos.getZ(i) * (e.b + 4);
        pos.setXYZ(i, e.x + e.ux * u - e.uz * v, e.y, e.z + e.uz * u + e.ux * v);
      }
      const m = new THREE.Mesh(g, lavaMaterial());
      m.matrixAutoUpdate = false; m.userData.mine = true; m.frustumCulled = true;
      g.computeBoundingSphere();
      scene.add(m);
    }
    // свет от лавы
    const nl = Math.max(3, Math.round(e.a / 9));
    for (let k = 0; k < nl; k++) { const a = k / nl * TAU + 0.4, x = e.x + (e.ux * Math.cos(a) * e.a - e.uz * Math.sin(a) * e.b) * 0.55, z = e.z + (e.uz * Math.cos(a) * e.a + e.ux * Math.sin(a) * e.b) * 0.55; light(x, e.y + 8, z, 30, 0.8, [1.0, 0.42, 0.1]); }
    // глыбы: на берегах — фонарный столб, на каждой 3-й глыбе пути — фонарь на колышке,
    // на прочих — оранжевые кристаллы и камни
    let ci = 0;
    for (const p of e.pil) {
      if (p.tag && p.tag[0] === 'S') { lampPost(p.x + p.m * 0.4, p.top, p.z - p.m * 0.3, 3.2); crate(p.x - p.m * 0.4, p.top, p.z + p.m * 0.3, 0.9, rnd()); }
      else if (p.tag) { if (ci++ % 3 === 1) { box(p.x, p.top + 0.9, p.z, 0.16, 1.8, 0.16, wood(), 0, 0.15); lantern(p.x + 0.15, p.top + 1.75, p.z, 0.25, 1.3); } }
      else if (p.top > e.y + 3 && rnd() < 0.5) crystals(p.x, p.top, p.z, 3 + Math.floor(rnd() * 3), 0.8, 0xff9a3a);
      else for (let k = 0; k < 2; k++) rockLump(p.x + (rnd() - 0.5) * p.m, p.top, p.z + (rnd() - 0.5) * p.m, 0.4 + rnd() * 0.6);
    }
    // цепи со свода, на некоторых — клети
    for (let k = 0; k < 4; k++) {
      const a = rnd() * TAU, rr = 0.3 + rnd() * 0.55, x = e.x + (e.ux * Math.cos(a) * e.a - e.uz * Math.sin(a) * e.b) * rr, z = e.z + (e.uz * Math.cos(a) * e.a + e.ux * Math.sin(a) * e.b) * rr;
      const y = lvRoof(e, rr) + 2, Ln = Math.min(y - e.y - 6, 6 + rnd() * 8);
      box(x, y - Ln / 2, z, 0.08, Ln, 0.08, IRON);
      if (rnd() < 0.6) { box(x, y - Ln - 0.9, z, 1.4, 1.8, 1.4, 0x2a2426); lantern(x, y - Ln - 2, z, 0.3, 1.6, false); }
    }
  }
  // ================= обвалы =================
  for (const e of ctx.segs) if (e.scree) {
    for (let s2 = 2; s2 < e.len - 1; s2 += 1.6 + rnd() * 1.5) {
      const t = s2 / e.len, sd = rnd() < 0.5 ? -1 : 1, w = e.hw - 0.8 - rnd() * 0.8;
      const x = e.ax + e.dx * s2 - e.dz * w * sd, z = e.az + e.dz * s2 + e.dx * w * sd;
      rockLump(x, segFloor(e, t), z, 0.5 + rnd() * 1.0);
    }
    // наверху — сломанная крепь
    const x = e.ax + e.dx * 2, z = e.az + e.dz * 2, y = e.fa;
    box(x - e.dz * (e.hw - 0.6), y + 1.8, z + e.dx * (e.hw - 0.6), 0.36, 3.6, 0.36, wood(), 0, 0.3);
    box(x, y + 0.5, z, e.hw * 1.6, 0.36, 0.4, wood(), rotY(-e.dz, e.dx), 0.25);
  }
  // ================= комнаты =================
  { const [x, z, y] = N.K0; lampPost(x + 7, y, z + 5, 4); lampPost(x - 8, y, z - 3, 4); cart(x + 3, y + 0.12, z - 6, 0, 1, 1); for (let k = 0; k < 4; k++) crate(x - 8 + k * 1.1, y, z + 6, 0.9, 0.3); }
  { const [x, z, y] = N.T1;   // забой: жила руды в стене, кирки, вагонетки
    for (let k = 0; k < 6; k++) { const a = -0.6 + k * 0.25; crystals(x + Math.cos(a) * 10.5, y + 1 + rnd() * 4, z + Math.sin(a) * 10.5, 3, 0.8, 0xffb04a); }
    cart(x - 3, y + 0.12, z - 2, 1, 0, 1); cart(x - 4, y + 0.12, z + 2, 1, 0.2, 1);
    for (let k = 0; k < 4; k++) box(x - 8, y + 0.9, z - 3 + k * 0.6, 0.08, 1.8, 0.08, wood(), 0, 0.2);
    lampPost(x - 6, y, z + 5); barrel(x + 2, y, z + 6); }
  { const [x, z, y] = N.T2;   // старый забой: обвал, сломанная крепь
    for (let k = 0; k < 14; k++) rockLump(x + (rnd() - 0.5) * 12, y + rnd() * 1.5, z + (rnd() - 0.5) * 12, 0.6 + rnd() * 1.6);
    box(x + 3, y + 2, z + 2, 0.4, 4.5, 0.4, wood(), 0.4, 0.6); box(x - 2, y + 1, z - 1, 6, 0.4, 0.4, wood(), 0.9, 0.2);
    cart(x + 5, y + 0.4, z - 4, 0.7, 0.7, 1); lantern(x - 4, y + 3.5, z + 6, 0, 1.4, false); }
  { const [x, z, y] = N.ST;   // склад: штабеля ящиков, бочки, полки
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) for (let h = 0; h < 1 + ((r + c) % 3); h++) crate(x - 8 + c * 1.0, y + h * 0.9, z - 5 + r * 2.2, 0.9);
    for (let k = 0; k < 8; k++) barrel(x + 4 + (k % 4) * 0.8, y, z + 6 + Math.floor(k / 4) * 0.8);
    for (let lv = 0; lv < 3; lv++) box(x + 7, y + 0.6 + lv * 1.0, z - 4, 0.8, 0.08, 5, 0x5f3d24);
    for (const sd of [-1, 1]) box(x + 7, y + 1.4, z - 4 + sd * 2.4, 0.1, 2.8, 0.8, wood());
    lampPost(x, y, z, 4); cart(x - 2, y + 0.12, z + 5, 1, 0, 0); }

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
