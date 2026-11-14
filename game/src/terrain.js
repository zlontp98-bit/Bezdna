import * as THREE from '../vendor/three.min.js';
import { fbm, smoothstep, clamp, hash2 } from './noise.js';
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
  DEEP: 250,    // и ещё столько вниз — дно шахты (новая локация с озером)
  PIT: 60,      // радиус шахты, уходящей в бездну
  SHELF: [4.55, 1.68], // карниз-спуск по стене: начальный угол и длина дуги (рад)
  MEADOW: 205,  // где луг переходит в горы
  OUTER: 340,   // край мира
  EXT: 232,     // половина стороны квадрата, покрытого текстурами высот/теней
  STREAMS: [2.155, 4.25], // углы, под которыми текут ручьи (сразу за началом пандусов)
  SRC_R: 213,   // радиус чаши под водопадом-истоком у подножия гор
  CRAG: { th: 0.42, r: 141, top: 24, w: 6.5 }, // утёс-смотровая у лагеря: на него лезут по стене
};
// Озеро на дне шахты: сюда стекают водопады с кольца. Глубина берега — со всех сторон камни.
export const LAKE = { x: 0, z: 0, r: 33, level: -(W.LOW + W.DEEP) - 2.0 };
W.CRAG.x = Math.cos(W.CRAG.th) * W.CRAG.r; W.CRAG.z = Math.sin(W.CRAG.th) * W.CRAG.r;

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
};

// 0..1 — насколько точка внутри русла ручья
export function streamAt(x, z) {
  const r = Math.hypot(x, z);
  if (r > W.SRC_R - 1 || r < 4) return 0;
  const th = Math.atan2(z, x);
  let c = 0;
  for (const tw of W.STREAMS) {
    const d = Math.abs(angDiff(th, tw)) * r;
    c = Math.max(c, smoothstep(3.4, 1.3, d));
  }
  return c * smoothstep(W.SRC_R - 1, W.SRC_R - 5, r);
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

// отдельные вершины хребта: угол, радиус, высота, ширина
const PEAKS = [
  [0.35, 300, 85, 55], [1.3, 290, 60, 45], [2.0, 310, 95, 60], [2.9, 285, 55, 40],
  [3.7, 305, 80, 50], [4.6, 295, 70, 48], [5.4, 300, 90, 58], [6.0, 285, 50, 38],
].map(([th, r, h, w]) => ({ x: Math.cos(th) * r, z: Math.sin(th) * r, h, w }));

// контрфорсы: край стены гуляет по углу, получаются колонны и ниши
const edgeR = (x, z) => W.HOLE + 0.6 + fbm(x * 0.11 + 7, z * 0.11 - 3, 3) * 3.2;
export const pitR = (x, z) => W.PIT + fbm(x * 0.09 - 11, z * 0.09 + 5, 3) * 4.0;
// высота карниза на угле th (или null — карниза нет)
export function shelfAt(th) {
  let t = th - W.SHELF[0];
  if (t < -0.04) t += TAU;
  t /= W.SHELF[1];
  if (t < -0.03 || t > 1.15) return null;
  return -W.DROP - (W.LOW - W.DROP) * clamp(t, 0, 1);
}

// ---- истоки ручьёв: водопад со скалы у подножия гор ----
// Локальные координаты истока: a — от центра чаши наружу (к горам), l — поперёк ручья.
// RC — радиус скальной чаши, POOL — радиус пруда, GORGE — длина ущелья над водопадом;
// A0..A1, L — прямоугольник, где рельеф хранится подробно (CELL м).
// Высота стены у каждого истока своя (s.H): кромка водопада стоит на уровне гребня хребта
// за ним, так что вода срывается с самого верха гор, а не из середины скалы.
export const SRC = { RC: 11.5, POOL: 8, GORGE: 52, A0: -26, A1: 70, L: 76, CELL: 0.7, VH: 1.6, WING: 110 };
SRC.NA = Math.floor((SRC.A1 - SRC.A0) / SRC.CELL) + 1;
SRC.NL = Math.floor((2 * SRC.L) / SRC.CELL) + 1;
SRC.LR = ((SRC.NL - 1) * SRC.CELL) / 2;
SRC.AR = SRC.A0 + (SRC.NA - 1) * SRC.CELL;
export const SOURCES = W.STREAMS.map((tw) => ({ tw, base: 0, H: 100, Hm: 160, lipA: 6.5, x: Math.cos(tw) * W.SRC_R, z: Math.sin(tw) * W.SRC_R }));
let srcOn = false;
// дно ущелья: от кромки водопада поднимается в горы ступенями-перекатами
export function gorgeBed(s, a) {
  const t = Math.max(0, a - s.lipA) / 5, k = Math.floor(t);
  // пологие перекаты: вверх по руслу можно пройти пешком
  return s.base + s.H - 2.2 + (k + smoothstep(0.55, 1.0, t - k)) * 0.8;
}
const srcEdge = (x, z) => SRC.RC + fbm(x * 0.22 + 3, z * 0.22, 2) * 1.1;
// «расстояние» от центра заводи: вниз по течению вытянута, чтобы перейти в русло
const basinDist = (s, a, l) => Math.hypot((a - s.pc) * (a < s.pc ? 0.55 : 1.3), l);
function shapeSource(h, x, z, a, l, s) {
  const { POOL, GORGE, WING } = SRC, H = s.H, Hm = s.Hm, base = s.base, al = Math.abs(l);
  // План. Передняя линия массива рваная: глыбы шириной ~15 м то выдвинуты к лугу, то отступают
  // (у самой ниши линия прямая). Посередине — полукруглая ниша под водопадом.
  const bl = Math.floor((l + 200) / 15);
  const jag = (hash2(bl, 9, 7) - 0.42) * 14 * smoothstep(13, 19, al);
  const line = -2 - 0.02 * Math.min(26, Math.max(0, al - 8.5)) ** 2 + jag;
  const dc = Math.hypot(a + 2, l);
  const edge = srcEdge(x, z);
  const inside = Math.max(smoothstep(edge + 0.9, edge - 0.1, dc), smoothstep(0.9, -0.1, a - line + (edge - SRC.RC) * 0.6));
  // Массив: это не отдельная горка, а передний край хребта — широкие плечи уходят в соседние
  // склоны, а гора за истоком выше самой кромки водопада (Hm > H): вода берётся из расщелины
  // между огромными глыбами, а не с вершины.
  const side = smoothstep(WING - 2, 22, al) ** 1.15, far = smoothstep(130, 90, a);
  const depth = Math.max(0, a - line);
  // у ниши глыбы доходят до самого верха; по бокам передние глыбы ниже и сходят уступами
  const bh = 0.5 + 0.5 * hash2(bl, 4, 7);
  const bk = 1 - (1 - bh) * smoothstep(24, 34, al) * (1 - smoothstep(14, 80, depth));
  let top = base + Hm * side * bk + depth * 0.1 + fbm(x * 0.12 + 5, z * 0.12, 3) * 2.2 * (0.3 + 0.7 * smoothstep(5, 9, al));
  // грани и швы между глыбами (те же, что у хребта)
  if (depth > 0) top += blocks(x, z).h * smoothstep(0, 25, depth) * smoothstep(WING, WING - 30, al) * 0.85;
  // Фасад — не отвесная стена, а гигантская лестница уступов: пласты высотой 20–34 м с полками
  // 5–12 м, у каждой глыбы свои. Рядом с нишей (она обрамляет воду) стены остаются высокими.
  if (depth > 0) {
    const sw = smoothstep(15, 23, al), hh = 20 + 14 * hash2(bl, 11, 7), tread = 5 + 7 * hash2(bl, 12, 7);
    const t = depth / tread + hash2(bl, 13, 7), k = Math.floor(t), f = t - k;
    const front = base + hh * (k + smoothstep(0.62, 1.0, f));
    top = top + (Math.min(top, front) - top) * sw;
  }
  let out = h + Math.max(0, top - h) * smoothstep(WING, WING - 24, al) * far;
  // Расщелина: узкая, с почти отвесными стенами, вглубь массива — русло из родника
  if (a > s.lipA - 1.5 && a < GORGE + 6) {
    const w = 3.2 + 1.8 * fbm(a * 0.11 + s.tw * 5, 3.1, 2); // ширина по дну гуляет
    const g = gorgeBed(s, a) + Math.max(0, al - w) * 4.0;
    out += (Math.min(out, g) - out) * smoothstep(GORGE + 6, GORGE + 1, a);
  }
  // перед стеной: ровная галечная площадка, к лугу и к концам стены — естественный рельеф.
  // Под водопадом ручей расширяется в заводь и дальше сужается в обычное русло
  let floor = base + (h - base) * Math.max(smoothstep(-12, -24, a), smoothstep(20, 30, al));
  const pd = basinDist(s, a, l);
  floor -= 0.25 * smoothstep(POOL + 4, POOL, pd) + 2.4 * smoothstep(POOL + 0.6, POOL - 4.4, pd);
  let res = floor * inside + out * (1 - inside);
  // Глыбы-контрфорсы по бокам от падающей воды: выдвинуты вперёд и перекрывают её края
  // с боковых ракурсов — вода видна «в глубине» между скал
  for (const sd of [-1, 1]) {
    const lq = l * sd, k = sd > 0 ? 1 : 0.72;
    for (const [a0, l0, wa, wl, hf] of [[-6.2, 14.2, 3.5, 3.4, 0.46], [-2.6, 19.8, 3.1, 2.8, 0.78]]) {
      const w = smoothstep(wa + 1.0, wa, Math.abs(a - a0)) * smoothstep(wl + 1.0, wl, Math.abs(lq - l0));
      if (w > 0) res += Math.max(0, base + H * hf * k + (a - a0) * 0.25 + (lq - l0) * 0.2 - res) * w;
    }
  }
  return res;
}
function applySources(h, x, z, r, th) {
  if (!srcOn) return h;
  const a = r - W.SRC_R;
  if (a < SRC.A0 - 10 || a > 136) return h;
  for (const s of SOURCES) {
    const l = angDiff(th, s.tw) * r;
    if (Math.abs(l) < SRC.WING + 4) h = shapeSource(h, x, z, a, l, s);
  }
  return h;
}

// Горы уступами: склон делится на пласты по 11–17 м — пологая полка (на ней трава и сосны)
// и крутая стенка. Линии уступов ломаются контрфорсами разного размера, а толщина пластов
// у каждого массива своя, поэтому это не ровная «лестница», а слоистые скальные массивы.
// У подножия (ниже ~8 м) склон остаётся плавным: луг переходит в горы без ступеньки.
function terraced(M, x, z) {
  if (M < 4) return M;
  const st = 17 + fbm(x * 0.006 + 11, z * 0.006 - 7, 2) * 7;
  const off = fbm(x * 0.03 + 2, z * 0.03 + 9, 2) * 0.7 + fbm(x * 0.1, z * 0.1 + 4, 2) * 0.22;
  const t = M / st + off, k = Math.floor(t), f = t - k;
  const Mt = st * (k + 0.1 * f + 0.9 * smoothstep(0.48, 0.86, f) - off);
  return M + (Mt - M) * smoothstep(4, 22, M) * 0.92;
}

// ---- крупные глыбы ----
// Хребет и массив у истока разбиты на огромные неправильные глыбы (ячейки ~70 м): у каждой
// свой наклон верха и своя высота, как у сколотых плит; между глыбами — глубокие швы.
// Те же ячейки отдают шейдеру тёмный шов и оттенок каждой глыбы (атрибут вершины aB).
const BLK = { cell: 70 };
const _b = { h: 0, crease: 0, tint: 0 };
function blocks(x, z) {
  const X = x / BLK.cell, Z = z / BLK.cell, ix = Math.floor(X), iz = Math.floor(Z);
  let f1 = 9, f2 = 9, bi = 0, bj = 0, bx = 0, bz = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const px = ix + i + 0.12 + 0.76 * hash2(ix + i, iz + j, 1), pz = iz + j + 0.12 + 0.76 * hash2(ix + i, iz + j, 2);
    const d = Math.hypot(px - X, pz - Z);
    if (d < f1) { f2 = f1; f1 = d; bi = ix + i; bj = iz + j; bx = px; bz = pz; } else if (d < f2) f2 = d;
  }
  // расстояние до шва между глыбами, м (разность расстояний до двух ближайших центров — половина)
  const edge = (f2 - f1) * BLK.cell * 0.5;
  const r = hash2(bi, bj, 3), sx = (hash2(bi, bj, 4) - 0.5) * 0.7, sz = (hash2(bi, bj, 5) - 0.5) * 0.7;
  _b.h = (r - 0.5) * 38 + sx * (X - bx) * BLK.cell + sz * (Z - bz) * BLK.cell // плоская наклонная грань
    - 16 * (1 - smoothstep(0, 6, edge));                                        // шов
  _b.crease = 1 - smoothstep(0.5, 6.5, edge);
  _b.tint = r - 0.5;
  return _b;
}
// сила глыбистости: у подножия хребта нет, ближе к краю мира — полная
const blockW = (r) => smoothstep(W.MEADOW - 22, W.MEADOW + 28, r);
// для шейдера: шов и оттенок глыбы в точке (атрибут вершины)
function blockAttr(x, z, out, o) {
  const r = Math.hypot(x, z), w = blockW(r);
  if (w < 0.01) { out[o] = 0; out[o + 1] = 0; return; }
  blocks(x, z);
  out[o] = _b.crease * w; out[o + 1] = _b.tint * w;
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
    // хребет: два слоя «гребней» разного масштаба + отдельные вершины для силуэта
    const r1 = 1 - Math.abs(fbm(x * 0.009 + 40, z * 0.009, 3));
    const r2 = 1 - Math.abs(fbm(x * 0.028 - 7, z * 0.028 + 2, 3));
    const r3 = 1 - Math.abs(fbm(x * 0.07 + 3, z * 0.07 - 9, 2));
    let mh = 14 + r1 * r1 * (70 + r2 * 40) + r2 * r2 * 18 + r3 * 5 * mt;
    for (const pk of PEAKS) {
      const d = Math.hypot(x - pk.x, z - pk.z) / pk.w;
      mh += pk.h * Math.max(0, 1 - d) ** 1.6 * (0.8 + 0.2 * r2);
    }
    // хребет огромный: ×1.45, пласты-уступы и поверх них — глыбы со швами
    let Mv = terraced(mt * mt * mh * 1.45, x, z);
    const bw = blockW(r) * smoothstep(10, 60, Mv);
    if (bw > 0.001) Mv += blocks(x, z).h * bw;
    m += Mv;
  }
  m += smoothstep(W.MEADOW - 30, W.MEADOW + 20, r) * 5;
  // утёс-смотровая: столовая скала с отвесными боками
  {
    const C = W.CRAG, d = Math.hypot(x - C.x, z - C.z);
    if (d < C.w + 9) {
      // контур с рёбрами-контрфорсами, стена ~3:1 с парой выпуклостей — по ней лезут, но не ходят
      const ang = Math.atan2(z - C.z, x - C.x);
      const rib = 1 - Math.abs(fbm(Math.cos(ang) * 2.6 + 4, Math.sin(ang) * 2.6, 2));
      const edge = C.w + fbm(x * 0.17 + 2, z * 0.17 - 5, 2) * 1.2 + rib * rib * 1.8;
      let k = clamp((edge + 8 - d) / 8, 0, 1);
      k = k < 0.1 ? k * k * 5 : k > 0.9 ? 1 - (1 - k) * (1 - k) * 5 : k;
      k += Math.sin(k * Math.PI * 3 + rib * 2) * 0.05 * k * (1 - k) * 4;
      const topH = C.top + fbm(x * 0.3, z * 0.3, 2) * 0.5;
      m = m + (topH - m) * k + smoothstep(edge + 9, edge + 2, d) * 1.2 * (1 - k);
      m += k * (1 - k) * 4 * (fbm(x * 0.5 + 1, z * 0.5 - 3, 2) * 0.8 + fbm(x * 1.6, z * 1.6, 1) * 0.2);
    }
  }

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
      low -= smoothstep(pitR(x, z) + 1.0, pitR(x, z) - 1.5, r) * W.DEEP;
      h += (low - h) * wall;
    }
  }
  // чаша озера на дне: пологий спуск от берега к середине (≈9 м глубины)
  if (r < LAKE.r + 14) h -= 9.5 * smoothstep(LAKE.r + 6, LAKE.r - 14, r) * (1 + fbm(x * 0.08 + 4, z * 0.08 - 2, 2) * 0.2);
  for (const p of POOLS) if (!p.src) h -= 1.5 * smoothstep(5.2, 2.0, Math.hypot(x - p.x, z - p.z)); // чаша под водопадом
  return applySources(h, x, z, r, th);
}

// ---- полярная сетка: густая на стенах, редкая в горах ----
const COLS = 256;
const radii = [];
{
  let r = 1;
  while (r < W.PIT - 7) { radii.push(r); r += 3; }
  while (r < W.R + 8) { radii.push(r); r += 1.0; }
  while (r < W.MEADOW) { radii.push(r); r += 3; }
  while (r < W.MEADOW + 40) { radii.push(r); r += 2.5; }
  while (r < W.OUTER) { radii.push(r); r += 3; } // в горах — чаще: уступам нужны свои ряды
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
const COSC = new Float64Array(COLS), SINC = new Float64Array(COLS);
for (let c = 0; c < COLS; c++) { COSC[c] = Math.cos((c / COLS) * TAU); SINC[c] = Math.sin((c / COLS) * TAU); }
// вокруг русла ручья: уровень воды, уровень берега и «пологость» (0 — водопад по стене)
const WG = new Float32Array(ROWS * COLS).fill(-1e9);
const LG = new Float32Array(ROWS * COLS).fill(-1e9);
const FG = new Float32Array(ROWS * COLS);
const DG = new Float32Array(ROWS * COLS); // глубина русла от кромки: у обрыва мелеет в перекат
// копия высот для отрисовки: под лентой русла сетка продавлена глубже, чтобы не торчать сквозь неё
let MG = HG;
const BAND = 12;

// Высота земли в любой точке. Очень дёшево: читает готовую сетку.
// Этим же пользуется физика, поэтому ноги всегда совпадают с картинкой.
export function heightAt(x, z) {
  if (PATCHES.length) {
    const v = patchAt(x, z);
    if (v !== null) return v;
  }
  return applyChannel(sampleGrid(HG, x, z), x, z);
}
// Возле истоков рельеф хранится подробно (сетка 0.7 м) — иначе отвесную скалу и пруд не нарисовать
const PATCHES = [];
function patchAt(x, z) {
  const r = Math.sqrt(x * x + z * z), a = r - W.SRC_R;
  if (a < SRC.A0 || a > SRC.AR) return null;
  const th = Math.atan2(z, x);
  for (const P of PATCHES) {
    const l = angDiff(th, P.tw) * r;
    if (l < -SRC.LR || l > SRC.LR) continue;
    return sampleRect(P.F, (a - SRC.A0) / SRC.CELL, (l + SRC.LR) / SRC.CELL);
  }
  return null;
}
// те же два треугольника на клетку, что и в сетке заплатки (диагональ (i,j+1)–(i+1,j))
function sampleRect(F, fa, fl) {
  const NL = SRC.NL;
  let i = Math.floor(fa), j = Math.floor(fl);
  if (i > SRC.NA - 2) i = SRC.NA - 2;
  if (j > NL - 2) j = NL - 2;
  const tx = fa - i, tz = fl - j, k = i * NL + j;
  const c00 = F[k], c01 = F[k + 1], c10 = F[k + NL], c11 = F[k + NL + 1];
  if (tx + tz <= 1) return c00 + (c10 - c00) * tx + (c01 - c00) * tz;
  return c11 + (c01 - c11) * (1 - tx) + (c10 - c11) * (1 - tz);
}
function applyChannel(h, x, z) {
  const r = Math.sqrt(x * x + z * z);
  if (r < W.PIT - 8 || r > W.SRC_R - 3) return h;
  const th = Math.atan2(z, x);
  let d = 1e9;
  for (const tw of W.STREAMS) d = Math.min(d, Math.abs(angDiff(th, tw)) * r);
  if (d > 7.6) return h;
  // русло: плоское дно и берега с уклоном, по которому ещё можно выйти из воды;
  // врезано в сетку точно, а не по её ячейкам
  const flat = sampleGrid(FG, x, z);
  if (flat <= 0.001) return h;
  const rim = sampleGrid(LG, x, z) + 0.25; // кромка берега чуть выше воды
  // Берега пологие: от кромки у воды земля плавно поднимается к лугу на 4–5 метрах (раньше —
  // на 0.8 м, получалась прямоугольная канава с отвесной стенкой), а дно вогнутое, без ступеньки
  const ch = rim + (h - rim) * smoothstep(3.0, 7.4, d) - sampleGrid(DG, x, z) * smoothstep(3.7, 0.7, d);
  return Math.min(h, h + (ch - h) * flat);
}
// Уровень воды под точкой: ручей или чаша; -1e9 — суши
export function waterAt(x, z) {
  let w = -1e9;
  const r = Math.hypot(x, z);
  if (r > W.PIT - 5 && r < W.SRC_R - 1 && streamAt(x, z) > 0.01) w = sampleGrid(WG, x, z);
  for (const p of POOLS) {
    // в чаше одна ровная гладь: уровень чаши, а не ручья, который через неё течёт
    if (poolDist(p, x, z) < 1.01) w = p.src ? p.level : Math.max(w, p.level);
  }
  if (r < LAKE.r + 0.4) w = Math.max(w, LAKE.level);
  // ручей в ущелье над водопадом: неглубокий, по щиколотку
  const a = r - W.SRC_R;
  if (a > 3 && a < SRC.GORGE + 0.5) {
    const th = Math.atan2(z, x);
    for (const s of SOURCES) if (a > s.lipA - 0.2 && Math.abs(angDiff(th, s.tw) * r) < 4.6) w = Math.max(w, gorgeBed(s, a) + 0.3);
  }
  return w;
}
// 0 — центр чаши, 1 — её берег (чаша под истоком вытянута вниз по течению)
export function poolDist(p, x, z) {
  if (!p.src) return Math.hypot(x - p.x, z - p.z) / p.rad;
  const r = Math.hypot(x, z);
  return basinDist(p.s, r - W.SRC_R, angDiff(Math.atan2(z, x), p.s.tw) * r) / SRC.POOL;
}
function sampleGrid(G, x, z) {
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
  const a = G[r0 * COLS + c0], b = G[r0 * COLS + c1];
  const c = G[r1 * COLS + c0], d = G[r1 * COLS + c1];
  // те же два треугольника, что и в отрисованной сетке (диагональ b–c), и в тех же
  // мировых координатах — иначе на отвесных стенах физика расходится с картинкой на метры
  if (r1 === r0) return a + (b - a) * tc;
  const ra = radii[r0], rb = radii[r1];
  const ax = COSC[c0] * ra, az = SINC[c0] * ra, bx = COSC[c1] * ra, bz = SINC[c1] * ra;
  const cx = COSC[c0] * rb, cz = SINC[c0] * rb, dx = COSC[c1] * rb, dz = SINC[c1] * rb;
  // по какую сторону диагонали b–c лежит точка (a — по одну, d — по другую)
  const side = (px, pz) => (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
  const inA = side(x, z) * side(ax, az) >= 0;
  const [p0x, p0z, h0] = inA ? [ax, az, a] : [dx, dz, d];
  // барицентрика в треугольнике (p0, b, c)
  const e1x = bx - p0x, e1z = bz - p0z, e2x = cx - p0x, e2z = cz - p0z;
  const det = e1x * e2z - e2x * e1z;
  if (Math.abs(det) < 1e-9) return a;
  const qx = x - p0x, qz = z - p0z;
  const u = (qx * e2z - e2x * qz) / det, v = (e1x * qz - qx * e1z) / det;
  return h0 + (b - h0) * u + (c - h0) * v;
}

const _n = new THREE.Vector3();
export function normalAt(x, z, out = _n, e = 0.5) {
  out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e));
  return out.normalize();
}

// костёр лагеря (см. flora.js: spawn, camp.js: центр лагеря) — вокруг него земля вытоптана
const CAMP = { x: W.R + 10 + 5.5, z: 8 - 5 };

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
        m = smoothstep(0.84, 0.94, n.y) * smoothstep(236, 222, r);
      }
      let pth = pathAt(x, z);
      // вытоптанные проплешины на лугу и кольце: редкие, неправильной формы; и пятачок у костра
      if (m > 0.5) {
        const pt = fbm(x * 0.05 + 31, z * 0.05 - 17, 3) + fbm(x * 0.013, z * 0.013 + 5, 2) * 0.6;
        pth = Math.max(pth, smoothstep(0.42, 0.62, pt) * 0.85, smoothstep(3.4, 1.2, Math.hypot(x - CAMP.x, z - CAMP.z)) * 0.9);
      }
      let beach = -2;
      for (const p of POOLS) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (!p.src) { m *= smoothstep(p.rad - 0.8, p.rad + 0.2, d); continue; }
        // у пруда под истоком — широкий галечный берег
        m *= smoothstep(p.rad + 2.5, p.rad + 4.5, d);
        beach = Math.max(beach, -0.45 + 0.4 * smoothstep(p.rad + 4.5, p.rad + 1, d));
      }
      let wl = waterAt(x, z);
      m *= smoothstep(-0.3, -0.9, wl - h); // у воды — галька, не трава
      if (wl < -1e8 && beach > -2) wl = h + beach;
      const o = (j * N + i) * 4;
      data[o] = toHalf(h);
      data[o + 1] = toHalf(m * (1 - smoothstep(0.3, 0.8, pth))); // по краям грунта трава ещё растёт
      data[o + 2] = toHalf(pth);
      data[o + 3] = toHalf(wl > -1e8 ? clamp(wl - h, -2, 4) : -2);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  U.uHmap.value = tex;
}

// Русло: на пологих местах ручей врезан в землю на полтора метра, вода стоит
// на уровне берега. На крутых стенах русла нет — вода бежит по камню.
function carveStreams() {
  MG = HG.slice();
  const preAt = (x, z) => sampleGrid(HG, x, z);
  // Профиль вдоль оси каждого ручья, шаг 0.5 м (вода течёт к центру, r убывает):
  //  flat — пологость (0 — водопад по стене),
  //  lvl  — уровень воды: ниже нижнего берега и никогда не растёт вниз по течению,
  //         поэтому природные пороги русло прорезает насквозь, без запруд;
  //  depth — глубина от кромки: в последние 4.5 м перед обрывом мелеет в перекат,
  //  cut  — сила врезки: ещё 3 м после пологого участка, чтобы срезать каменный гребень
  //         на кромке водопада (иначе вода «перелезала» через горку).
  const R0 = W.PIT - 20, R1 = W.SRC_R - 15, NA = Math.round((R1 - R0) / 0.5) + 1, prof = {};
  for (const tw of W.STREAMS) {
    const cx = Math.cos(tw), cz = Math.sin(tw), px = -cz, pz = cx, e = 1.2;
    const flat = new Float32Array(NA), lvl = new Float32Array(NA), depth = new Float32Array(NA), cut = new Float32Array(NA);
    const lvlCut = new Float32Array(NA); // уровень, до которого режем: на кромке — уровень пологого русла выше
    for (let k = 0; k < NA; k++) {
      const r = R0 + k * 0.5, x = cx * r, z = cz * r;
      const gx = (preAt(x + e, z) - preAt(x - e, z)) / (2 * e), gz = (preAt(x, z + e) - preAt(x, z - e)) / (2 * e);
      flat[k] = smoothstep(1.1, 0.6, Math.hypot(gx, gz));
      lvl[k] = Math.min(preAt(x, z), preAt(x + px * 3.3, z + pz * 3.3), preAt(x - px * 3.3, z - pz * 3.3)) - 0.45;
    }
    for (let k = NA - 2; k >= 0; k--) lvl[k] = Math.min(lvl[k], lvl[k + 1]);
    for (let k = 0; k < NA; k++) {
      let ahead = 1;
      for (let j = 0; j <= 9 && k - j >= 0; j++) ahead = Math.min(ahead, flat[k - j]);
      depth[k] = 0.45 + 1.25 * smoothstep(0.25, 0.9, ahead);
      let behind = 0;
      for (let j = 0; j <= 6 && k + j < NA; j++) behind = Math.max(behind, flat[k + j]);
      cut[k] = behind;
    }
    // идём вниз по течению и помним уровень последнего пологого места: кромку срезаем до него,
    // а скалу ниже не трогаем (местный «уровень» на стене водопада проваливается вместе с ней)
    let lastL = lvl[NA - 1], since = 1e9;
    for (let k = NA - 1; k >= 0; k--) {
      if (flat[k] > 0.8) { lastL = lvl[k]; since = 0; } else since += 0.5;
      lvlCut[k] = since <= 3 ? lastL : lvl[k];
    }
    prof[tw] = { flat, lvl, depth, cut, lvlCut };
  }
  const at = (arr, r) => arr[Math.max(0, Math.min(NA - 1, Math.round((r - R0) / 0.5)))];
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    if (r < W.PIT - 12 || r > W.SRC_R) continue;
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      let tw = W.STREAMS[0], best = 1e9;
      for (const a of W.STREAMS) { const d = Math.abs(angDiff(th, a)); if (d < best) { best = d; tw = a; } }
      const d = best * r;
      if (d > BAND) continue;
      const i = ri * COLS + c, P = prof[tw];
      const cut = at(P.cut, r), level = at(P.lvlCut, r);
      LG[i] = level; FG[i] = cut; DG[i] = at(P.depth, r);
    }
  }
  // Ряды ленты русла: только там, где русло реально есть — пологое дно или срезанная кромка.
  // На отвесной стене водопада ленты нет (её редкие ряды «срезали бы угол» обрыва).
  for (const tw of W.STREAMS) {
    const on = new Uint8Array(SN), cx = Math.cos(tw), cz = Math.sin(tw), px = -cz, pz = cx;
    for (let k = 0; k < SN; k++) {
      const r = SR0 - k * SDR;
      let carved = at(prof[tw].flat, r) > 0.02;
      for (let o = -4.2; o <= 4.21 && !carved; o += 0.6) {
        const x = cx * r + px * o, z = cz * r + pz * o;
        carved = heightAt(x, z) < sampleGrid(HG, x, z) - 0.02;
      }
      on[k] = carved ? 1 : 0;
    }
    STRIP_ON[tw] = on;
  }
  // вода: на пологом — гладь на уровне, на крутом — плёнка поверх уже прорезанного дна
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    if (r < W.PIT - 12 || r > W.SRC_R) continue;
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      let tw = W.STREAMS[0], best = 1e9;
      for (const a of W.STREAMS) { const d = Math.abs(angDiff(th, a)); if (d < best) { best = d; tw = a; } }
      if (best * r > BAND) continue;
      const i = ri * COLS + c, P = prof[tw], flat = at(P.flat, r);
      const g = heightAt(Math.cos(th) * r, Math.sin(th) * r);
      WG[i] = Math.max(at(P.lvl, r) * flat + (g + 0.2) * (1 - flat), g + 0.2 * (1 - flat));
      // грубую сетку под лентой русла притапливаем ниже точной поверхности — видна только лента.
      // Только там, где лента закрывает и сам узел, и соседние по радиусу ряды сетки.
      const spacing = (TAU * r) / COLS;
      const dr = Math.max(radii[Math.min(ROWS - 1, ri + 1)] - r, r - radii[Math.max(0, ri - 1)]);
      // На стыке ленты со стеной узел спрятать нельзя (откроется дыра) — опускаем его хотя бы
      // до точного прорезанного дна, чтобы сетка не стояла над руслом.
      if (best * r < STRIP - spacing && stripCovers(tw, r - dr) && stripCovers(tw, r + dr)) MG[i] = Math.min(HG[i], g - 0.3);
      else if (best * r < 4.4) MG[i] = Math.min(HG[i], g);
    }
  }
}
const STRIP = 8; // полуширина ленты русла
// ряды ленты вдоль ручья: от края подробной заплатки истока до шахты
const SR0 = W.SRC_R + SRC.A0, SDR = 0.8, SN = Math.floor((SR0 - (W.PIT - 7)) / 0.8) + 1;
const STRIP_ON = {};
// лента закрывает радиус r: оба соседних ряда существуют
function stripCovers(tw, r) {
  const f = (SR0 - r) / SDR, k = Math.floor(f);
  if (k < 0 || k + 1 >= SN) return false;
  return STRIP_ON[tw][k] === 1 && STRIP_ON[tw][k + 1] === 1;
}

// Уровень дна у чаши (берём луг перед ней), кромка водопада и сам пруд
function setupSources() {
  for (const s of SOURCES) {
    const cx = Math.cos(s.tw), cz = Math.sin(s.tw);
    s.base = rawHeight(cx * (W.SRC_R - 14), cz * (W.SRC_R - 14)) - 0.3;
    // гребень хребта за истоком: самая высокая точка гор в створе ручья
    let ridge = 0;
    for (let r = W.SRC_R + 20; r < W.OUTER - 10; r += 4)
      for (let l = -24; l <= 24; l += 8) ridge = Math.max(ridge, rawHeight(Math.cos(s.tw + l / r) * r, Math.sin(s.tw + l / r) * r));
    // кромка водопада — на ~60% высоты массива: над ней ещё порядочно скалы, а родник в глубине
    s.H = clamp(ridge * 0.62 - s.base, 95, 135);
    s.Hm = clamp(ridge * 1.04 - s.base, s.H * 1.4, s.H * 2.0);
    // кромка: внешний край верха скалы на оси ручья
    let a = 0;
    for (; a < 14; a += 0.05) {
      const x = cx * (W.SRC_R + a), z = cz * (W.SRC_R + a);
      if (a + 2 >= srcEdge(x, z) + 0.9) break;
    }
    s.lipA = a;
    const fallH = s.H - 2.2, T = Math.sqrt((2 * fallH) / 9.8);
    s.hitA = a - SRC.VH * T; // куда бьёт струя
    s.pc = s.hitA - 0.5;     // центр заводи
    const r = W.SRC_R + s.pc;
    POOLS.push({ x: cx * r, z: cz * r, level: s.base - 0.45, dx: -cx, dz: -cz, rad: SRC.POOL, src: true, s });
  }
  srcOn = true;
}
function buildPatches() {
  const { NA, NL, CELL, A0, AR, LR } = SRC;
  for (const s of SOURCES) {
    const F = new Float32Array(NA * NL);
    for (let i = 0; i < NA; i++) {
      const a = A0 + i * CELL, r = W.SRC_R + a;
      for (let j = 0; j < NL; j++) {
        const l = -LR + j * CELL, th = s.tw + l / r, x = Math.cos(th) * r, z = Math.sin(th) * r;
        const coarse = applyChannel(sampleGrid(HG, x, z), x, z);
        const fine = applyChannel(rawHeight(x, z), x, z);
        // у краёв заплатка сходится с общей сеткой, чтобы не было ступеньки
        const w = smoothstep(0, 6, Math.min(a - A0, AR - a, LR - Math.abs(l)));
        F[i * NL + j] = coarse + (fine - coarse) * w;
      }
    }
    PATCHES.push({ tw: s.tw, F });
  }
  // общую сетку под заплаткой прячем: каждый её узел ниже самой низкой точки заплатки
  // в радиусе 8 м — тогда её крупные треугольники нигде не проткнут подробный рельеф
  const reach = Math.ceil(8 / CELL);
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri], a = r - W.SRC_R;
    if (a < A0 || a > AR) continue;
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      for (const P of PATCHES) {
        const l = angDiff(th, P.tw) * r;
        if (Math.abs(l) > LR) continue;
        const ia = Math.round((a - A0) / CELL), il = Math.round((l + LR) / CELL);
        let mn = 1e9;
        for (let i = Math.max(0, ia - reach); i <= Math.min(NA - 1, ia + reach); i++)
          for (let j = Math.max(0, il - reach); j <= Math.min(NL - 1, il + reach); j++) mn = Math.min(mn, P.F[i * NL + j]);
        const k = ri * COLS + c, sink = smoothstep(0.5, 6, Math.min(a - A0, AR - a, LR - Math.abs(l)));
        MG[k] += (Math.min(MG[k], mn - 1.0) - MG[k]) * sink;
      }
    }
  }
}
function buildPatchMesh(scene, material, P) {
  const { NA, NL, CELL, A0, LR } = SRC, n = new THREE.Vector3();
  const pos = new Float32Array(NA * NL * 3), nor = new Float32Array(NA * NL * 3), bb = new Float32Array(NA * NL * 2), idx = [];
  for (let i = 0; i < NA; i++) {
    const r = W.SRC_R + A0 + i * CELL;
    for (let j = 0; j < NL; j++) {
      const th = P.tw + (-LR + j * CELL) / r, x = Math.cos(th) * r, z = Math.sin(th) * r, k = (i * NL + j) * 3;
      // чуть выше общей сетки, чтобы у краёв не мерцали две поверхности
      pos[k] = x; pos[k + 1] = P.F[i * NL + j] + 0.03; pos[k + 2] = z;
      normalAt(x, z, n, 0.35);
      nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
      blockAttr(x, z, bb, (i * NL + j) * 2);
    }
  }
  for (let i = 0; i < NA - 1; i++)
    for (let j = 0; j < NL - 1; j++) {
      const v00 = i * NL + j, v01 = v00 + 1, v10 = v00 + NL, v11 = v10 + 1;
      idx.push(v00, v01, v10, v01, v11, v10);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aB', new THREE.BufferAttribute(bb, 2));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
}

// Заплатка под утёс: мелкая круговая сетка по точной высоте, полярная сетка под ней притоплена
const CRAG_R = 27;
function sinkUnderCrag() {
  const C = W.CRAG;
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    if (Math.abs(r - C.r) > CRAG_R + 4) continue;
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU, x = Math.cos(th) * r, z = Math.sin(th) * r;
      const d = Math.hypot(x - C.x, z - C.z);
      if (d > CRAG_R) continue;
      const i = ri * COLS + c;
      MG[i] = Math.min(MG[i], HG[i] - 0.7 * smoothstep(CRAG_R, CRAG_R - 6, d));
    }
  }
}
function buildCragPatch(scene, material) {
  const C = W.CRAG, SEG = 112, n = new THREE.Vector3();
  const rings = [0];
  for (let r = 0.5; r < CRAG_R; r += r < 17 ? 0.45 : 1.0) rings.push(r);
  rings.push(CRAG_R);
  const pos = [], nor = [], idx = [];
  for (let j = 0; j < rings.length; j++) {
    const rr = rings[j];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * TAU, x = C.x + Math.cos(a) * rr, z = C.z + Math.sin(a) * rr;
      pos.push(x, heightAt(x, z) + 0.03, z);
      normalAt(x, z, n, 0.3);
      nor.push(n.x, n.y, n.z);
    }
  }
  for (let j = 0; j < rings.length - 1; j++) {
    const a0 = j * SEG, b0 = a0 + SEG;
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      if (j === 0) { if (i1 === 0) continue; idx.push(a0, b0 + i, b0 + i1); continue; }
      idx.push(a0 + i, b0 + i, a0 + i1, a0 + i1, b0 + i, b0 + i1);
    }
  }
  // первое кольцо замыкаем отдельно
  idx.push(0, SEG + SEG - 1, SEG);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
}

// Лента русла: узкая полоса рельефа вдоль ручья, построенная по точной высоте heightAt.
// По краям она лежит на сетке, в середине — повторяет врезанное русло.
function buildChannelStrips(scene, material) {
  // только само русло и узкая кромка; на водопадах (где русла нет) ленты нет
  const offs = [-STRIP, -6.6, -5.4, -4.6, -4.0, -3.5, -3.1, -2.7, -2.2, -1.4, 0, 1.4, 2.2, 2.7, 3.1, 3.5, 4.0, 4.6, 5.4, 6.6, STRIP];
  const K = offs.length, n = new THREE.Vector3();
  for (const th of W.STREAMS) {
    const cx = Math.cos(th), cz = Math.sin(th), px = -cz, pz = cx;
    const pos = [], nor = [], idx = [];
    let row = 0, prevOk = false;
    for (let k = 0; k < SN; k++) {
      const r = SR0 - k * SDR;
      if (!STRIP_ON[th][k]) { prevOk = false; continue; }
      for (let k = 0; k < K; k++) {
        const o = offs[k], x = cx * r + px * o, z = cz * r + pz * o;
        pos.push(x, heightAt(x, z) + (Math.abs(o) > 7 ? 0.02 : 0), z);
        normalAt(x, z, n, Math.abs(o) > 4.3 ? 0.8 : 0.3);
        nor.push(n.x, n.y, n.z);
      }
      if (prevOk) {
        const a = (row - 1) * K, b = row * K;
        for (let k = 0; k < K - 1; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
      row++; prevOk = true;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
}

const terrainMat = () => mat({
  vertexShader: /* glsl */ `
    attribute vec2 aB; varying vec2 vB;
    varying vec3 vW; varying vec3 vN;
    void main(){
      vW = position; vN = normal; vB = aB;
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uHmap, uRockWall, uRockPlain, uGround, uRockMtn, uGrass, uPath;
    varying vec3 vW; varying vec3 vN; varying vec2 vB;
    float lumOf(vec3 c){ return dot(c, vec3(0.30, 0.59, 0.11)); }
    void main(){
      vec3 n = normalize(vN);
      // скала рисуется с обеих сторон, когда камера у стены (см. main.js): изнутри нормаль разворачиваем
      if (!gl_FrontFacing) n = -n;
      float camD = distance(vW, cameraPosition);
      float rr = length(vW.xz);
      float mtnK = max(smoothstep(14.0, 34.0, vW.y), smoothstep(196.0, 218.0, rr)); // «горность»: форма, трава, снег
      float deepK = smoothstep(8.0, 50.0, -vW.y);
      // рублёные грани: настоящая нормаль треугольника + гладкая
      vec3 fn = normalize(cross(dFdx(vW), dFdy(vW)));
      fn *= sign(fn.y + 1e-5);
      // в горах грани чуть жёстче; а крупные плоскости глыб и так заданы самой формой
      vec3 ng = normalize(mix(n, fn, 0.4 + 0.2*mtnK));
      float steepM = smoothstep(0.2, 0.5, 1.0 - ng.y);
      float facet = vnoise(vW.xz*0.035 + 3.0);
      float facet2 = vnoise(vW.xz*0.012 - 5.0);

      // Трава закрывает землю почти везде на лугу, тогда скала не видна вовсе и 8 выборок текстур
      // можно не делать. Маску травы считаем заранее (по нормали), а скалу — только там, где она нужна.
      float gn0 = mix(n.y, ng.y, mtnK);
      float gm0 = smoothstep(mix(0.72, 0.70, mtnK), mix(0.86, 0.84, mtnK), gn0 + (vnoise(vW.xz*0.9)-0.5)*0.08) * (1.0 - smoothstep(84.0, 104.0, vW.y + facet*10.0)) * (1.0 - smoothstep(-235.0, -262.0, vW.y)); // на дне шахты травы нет: галька и камень
      vec3 rock = vec3(0.35, 0.3, 0.28), nn = n;
      float snow = 0.0;
      if (gm0 < 0.995) {
      // ---- скала: нарисованные текстуры ----
      // Стены спуска, кольца и бездны — тёплые земляные плиты со мхом (текстура стены);
      // внешние горы — серый камень (отдельная текстура). Отвесные места проецируются по двум
      // осям и плавно переходят друг в друга; плоские — светлая скала сверху.
      vec2 axz = pow(abs(ng.xz) + 1e-3, vec2(4.0));
      float wx = axz.x / (axz.x + axz.y);
      vec3 tW = texture2D(uRockWall, vW.zy*0.085).rgb * wx + texture2D(uRockWall, vW.xy*0.085 + 0.31).rgb * (1.0 - wx);
      vec3 tP = texture2D(uRockPlain, vW.xz*0.12 + 0.17).rgb;
      rock = mix(tP, tW, steepM);
      // Серые горы. Масштаб плавно растёт от подножия к хребту: у долины плитка 20 м, в горах 60 м
      float bigK = smoothstep(190.0, 218.0, rr);
      vec3 tM = vec3(0.0);
      if (bigK < 0.999) {
        vec3 a1 = texture2D(uRockMtn, vW.zy*0.05).rgb * wx + texture2D(uRockMtn, vW.xy*0.05 + 0.31).rgb * (1.0 - wx);
        tM += mix(texture2D(uRockMtn, vW.xz*0.06 + 0.17).rgb, a1, steepM) * (1.0 - bigK);
      }
      if (bigK > 0.001) {
        vec3 a2 = texture2D(uRockMtn, vW.zy*0.017).rgb * wx + texture2D(uRockMtn, vW.xy*0.017 + 0.31).rgb * (1.0 - wx);
        tM += mix(texture2D(uRockMtn, vW.xz*0.024 + 0.17).rgb, a2, steepM) * bigK;
      }
      tM = mix(vec3(lumOf(tM)), tM, 0.78) * vec3(0.98,0.98,1.02);
      // Глыбы: у каждой свой оттенок (серо-бурые, песочные, тёплые), между ними тёмные швы
      // (vB.x — шов, vB.y — оттенок из ячеек глыб в terrain.js)
      float bt = vB.y;
      tM *= 1.0 + bt*0.42;
      tM = mix(tM, tM * vec3(1.16,1.04,0.84), smoothstep(0.05, 0.4, bt));     // песочные
      tM = mix(tM, tM * vec3(0.86,0.9,1.0), smoothstep(-0.05, -0.4, bt));      // холодные серые
      tM *= 1.0 - vB.x * 0.62;
      // Переход земляные стены → серые горы: граница рваная (по шуму), растянута на ~25 м высоты
      // и по радиусу, так что горы не «начинаются» ровной линией
      float mixK = clamp(smoothstep(8.0, 36.0, vW.y + (facet - 0.5)*26.0 + (vnoise(vW.xz*0.11) - 0.5)*10.0)
                  + smoothstep(188.0, 222.0, rr + (facet2 - 0.5)*30.0) - 0.0, 0.0, 1.0);
      rock = mix(rock, tM, mixK);
      // контраст: картинка нарисована мягко, а в игре её надо читать издалека
      rock = pow(rock, vec3(1.3)) * 1.2;
      // Рисунок вдали усредняется в ровный цвет, поэтому структуру горы задаёт форма:
      // широкие и тонкие пласты, тёмные щели между ними, стенки темнее полок
      float yw = vW.y + (facet - 0.5)*7.0;
      float tang = atan(vW.z, vW.x) * length(vW.xz);
      float strata = vnoise(vec2(tang*0.006, yw*0.11));
      float thin = vnoise(vec2(tang*0.025, yw*0.5));
      float seam = smoothstep(0.1, 0.0, abs(fract(yw*0.05) - 0.5) - 0.43) * steepM;
      float jn = vnoise(vec2(tang*0.07 + floor(yw*0.05)*3.7, vW.y*0.004));
      float joint = smoothstep(0.06, 0.0, abs(jn - 0.5)) * steepM;
      rock *= (0.88 + 0.24*strata) * (0.97 + 0.06*thin);
      rock *= mix(1.1, 0.8, steepM) * (1.0 - seam*0.2 * (1.0 - mtnK*0.6) - joint*0.14);
      rock *= mix(1.0, 0.9 + 0.2*facet2, mtnK);
      // глубже — холоднее и темнее; высоко и вдали — серее (воздух и камень, а не охра)
      rock = mix(rock, vec3(lumOf(rock)) * vec3(0.78,0.86,1.02), deepK*0.85);
      rock = mix(rock, mix(vec3(lumOf(rock)), rock, 0.7) * vec3(0.94,0.96,1.0), mtnK*smoothstep(60.0, 220.0, camD)*0.6);
      // небольшой рельеф по яркости картинки: плиты чуть выпуклые и ловят свет
      float hh = lumOf(rock);
      vec3 dpx = dFdx(vW), dpy = dFdy(vW);
      vec3 r1 = cross(dpy, ng), r2 = cross(ng, dpx);
      float det = dot(dpx, r1);
      vec3 grad = sign(det) * (dFdx(hh)*r1 + dFdy(hh)*r2);
      // рельеф только на скале и сглаженный по яркости (на земле производные дают «пунктир»)
      float bumpK = smoothstep(0.15, 0.45, steepM) * smoothstep(60.0, 12.0, camD) * 0.12;
      nn = normalize(abs(det)*ng - bumpK*clamp(grad, vec3(-3.0), vec3(3.0)));
      // грани треугольников нужны только скалам; на траве и тропах свет считаем по гладкой нормали
      nn = normalize(mix(n, nn, smoothstep(0.12, 0.42, 1.0 - ng.y)));
      // снег — только на самых высоких вершинах и в их складках
      float snowLine = 168.0 + facet2*18.0 + (1.0 - ng.y)*30.0; // хребет стал выше — снег только на самых пиках
      snow = smoothstep(snowLine, snowLine + 10.0, vW.y) * smoothstep(0.45, 0.72, ng.y + (facet - 0.5)*0.25);

      }
      // ---- трава ----
      // Нарисованный газон в двух масштабах (8 и 32 м, второй повёрнут): рисунок не повторяется.
      // Цвет подтягиваем к цвету настоящих травинок (grassCol), чтобы стебли не торчали
      // из чужого по тону ковра; от рисунка берём пучки, тёмные низины и светлые пятна.
      vec4 hm = texture2D(uHmap, vW.xz/(2.0*uExt)+0.5);
      float gm = gm0;
      vec3 alb = rock; vec4 d2 = vec4(0.5); vec3 pA = vec3(0.55);
      // трава и тропа считаются только там, где они есть: на скалах и стенах (gm = 0) это 8 выборок текстур даром
      if (gm > 0.004) {
        vec3 gA = texture2D(uGrass, vW.xz*0.12).rgb;
        vec3 gB = texture2D(uGrass, vec2(vW.z, -vW.x)*0.031 + 0.37).rgb;
        d2 = texture2D(uDetail, vec2(vW.z, -vW.x)*0.027 + 0.37);
        vec3 grass = grassCol(vW);
        grass = mix(grass, vec3(0.40,0.47,0.24), smoothstep(20.0, 80.0, vW.y));
        float gl = lumOf(gA)*0.65 + lumOf(gB)*0.35;
        grass = mix(grass * (0.45 + 1.25*gl), mix(gA, gB, 0.35) * vec3(0.70,0.80,0.62), 0.4);
        grass *= 0.88 + 0.24*d2.b;
        // у скал на пологих полках трава переходит в каменистую землю (старая текстура земли)
        vec3 scree = texture2D(uGround, vW.xz*0.22).rgb * vec3(0.9,0.88,0.85);
        alb = mix(rock, mix(scree, grass, smoothstep(0.35, 0.8, gm + (1.0 - mtnK))), smoothstep(0.0, 0.3, gm));

        // Граница трава ↔ камень: рваная (по пятнам), с тёмной каймой дёрна и мшистым ободком на камне —
        // трава не «обрезана» по линии, а вползает на камень языками и затеняет стык
        float ge = gm * (1.0 - gm) * 4.0;
        alb = mix(alb, alb * vec3(0.78, 0.9, 0.72), ge * 0.5);
        alb = mix(alb, vec3(0.20, 0.36, 0.16) * (0.8 + 0.5*d2.b), ge * 0.22 * (1.0 - mtnK));

        // ---- тропы и вытоптанные проплешины (канал B карты) ----
        // Край рваный — в него заходят языки травы. Грунт — нарисованная тропа в двух масштабах (10 и 38 м).
        pA = texture2D(uPath, vW.xz*0.1).rgb;
        vec3 pB = texture2D(uPath, vec2(vW.z, -vW.x)*0.026 + 0.21).rgb;
        float e = hm.b + (d2.b - 0.5)*0.5 + (lumOf(pA) - 0.55)*0.35*smoothstep(70.0, 18.0, camD);
        float dirtK = smoothstep(0.36, 0.5, e);
        float core = smoothstep(0.55, 0.9, e);
        vec3 soil = mix(pA, pB, 0.25);
        soil = mix(vec3(lumOf(soil)), soil, 0.85) * vec3(0.92,0.9,0.86); // чуть спокойнее: не оранжевая
        soil = mix(soil*0.84, soil*1.05, core);
        alb = mix(alb, soil, dirtK * gm);
      }
      // у воды: мокрая галька (та же скала, темнее и холоднее)
      float wd = hm.a;
      float wet = smoothstep(-0.45, 0.0, wd) * (1.0 - mtnK);
      vec3 pebble = rock * vec3(0.7,0.74,0.8) * (0.85 + 0.3*lumOf(pA)); // мокрая галька: та же скала, темнее и холоднее
      alb = mix(alb, pebble, wet);
      alb *= 1.0 - smoothstep(-0.1, 0.6, wd)*0.35;
      alb = mix(alb, vec3(0.90,0.92,0.97), snow);

      // на дне шахты темно, но не чёрно: мягкое голубое свечение от воды, кристаллов и грибов
      float deepGlow = smoothstep(-150.0, -230.0, vW.y) * (1.0 - smoothstep(52.0, 84.0, rr));
      alb = alb * (1.0 + deepGlow * 0.6);
      float ao = 1.0 - mtnK*0.1*(1.0-facet2);
      vec3 c = shade(alb, nn, shadowAt(vW.xz)) * ao;
      c += alb * vec3(0.10, 0.20, 0.25) * deepGlow;
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
    POOLS.push({ x: cx * pr, z: cz * pr, level: 0, dx: -cx, dz: -cz, rTop: r + 5.5, rad: 5.4, hit: 3 });
  }
  setupSources();
  for (let ri = 0; ri < ROWS; ri++) {
    const r = radii[ri];
    for (let c = 0; c < COLS; c++) {
      const th = (c / COLS) * TAU;
      HG[ri * COLS + c] = rawHeight(Math.cos(th) * r, Math.sin(th) * r);
    }
  }

  carveStreams();
  sinkUnderCrag();

  // уровень воды в чаше — чуть ниже самого низкого берега
  for (const p of POOLS) {
    if (p.src) {
      // пруд под истоком — расширение ручья: уровень тот же, что у русла на выходе из него,
      // поэтому между прудом и ручьём нет ни ступеньки, ни двух плоскостей воды
      const r = W.SRC_R + p.s.pc - SRC.POOL / 0.55 - 0.6;
      p.level = sampleGrid(WG, Math.cos(p.s.tw) * r, Math.sin(p.s.tw) * r);
      continue;
    }
    let lo = 1e9;
    for (let a = 0; a < 16; a++) {
      const x = p.x + Math.cos(a * 0.3927) * 5.3, z = p.z + Math.sin(a * 0.3927) * 5.3;
      if (streamAt(x, z) < 0.2 && Math.hypot(x, z) < Math.hypot(p.x, p.z) + 2) lo = Math.min(lo, heightAt(x, z));
    }
    p.level = lo - 0.12;
  }

  buildPatches();

  const material = rockMat = terrainMat();
  const SECT = 8, per = COLS / SECT;
  const n = new THREE.Vector3();
  for (let s = 0; s < SECT; s++) {
    const pos = new Float32Array(ROWS * (per + 1) * 3);
    const nor = new Float32Array(ROWS * (per + 1) * 3);
    const bb = new Float32Array(ROWS * (per + 1) * 2); // шов и оттенок глыбы
    const idx = [];
    let p = 0, q = 0;
    for (let ri = 0; ri < ROWS; ri++) {
      const r = radii[ri];
      for (let ci = 0; ci <= per; ci++) {
        const c = (s * per + ci) % COLS;
        const th = (c / COLS) * TAU;
        const x = Math.cos(th) * r, z = Math.sin(th) * r;
        pos[p] = x; pos[p + 1] = MG[ri * COLS + c]; pos[p + 2] = z;
        normalAt(x, z, n, r < W.R + 10 ? 0.45 : 1.5);
        nor[p] = n.x; nor[p + 1] = n.y; nor[p + 2] = n.z;
        if (r > W.MEADOW - 24) blockAttr(x, z, bb, q);
        p += 3; q += 2;
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
    g.setAttribute('aB', new THREE.BufferAttribute(bb, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }
  buildChannelStrips(scene, material);
  buildCragPatch(scene, material);
  for (const P of PATCHES) buildPatchMesh(scene, material, P);
  bakeHeightTexture();
}

// Убрать траву под постройкой: прямоугольник (hx×hz, повёрнут на rot) в текстуре высот
export function clearGrass(x, z, hx, hz, rot) {
  const tex = U.uHmap.value, d = tex.image.data, N = tex.image.width, cell = (2 * W.EXT) / N;
  const c = Math.cos(rot), s = Math.sin(rot), R = Math.hypot(hx, hz) + cell;
  for (let j = Math.floor((z - R + W.EXT) / cell); j <= Math.ceil((z + R + W.EXT) / cell); j++)
    for (let i = Math.floor((x - R + W.EXT) / cell); i <= Math.ceil((x + R + W.EXT) / cell); i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const dx = (i + 0.5) * cell - W.EXT - x, dz = (j + 0.5) * cell - W.EXT - z;
      if (Math.abs(dx * c - dz * s) <= hx + cell && Math.abs(dx * s + dz * c) <= hz + cell) d[(j * N + i) * 4 + 1] = 0;
    }
  tex.needsUpdate = true;
}

export { bakeShadows };
// материал скал — им же покрыты островки-столпы
export let rockMat;
