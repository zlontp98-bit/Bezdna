import { galleryPlan } from './gallery-plan.js';
import { buildMineStrata, buildRibs } from './mine-strata.js';
import * as THREE from '../vendor/three.min.js';
import { TUNNELS, tunLocal, tunC, tunHW, tunH, tunFloor, rockMat, setMineSpace } from './terrain.js';
import { chunkMesh } from './chunks.js';
import { mulberry32, SEED, smoothstep } from './noise.js';
import { part, merge, T as M4, propMaterial } from './flora.js';
import { WR, WoodBuf, woodBox, woodMaterial } from './minewood.js';

const TAU = Math.PI * 2;
export const CHASM = { x: 150, z: -25, rx: 52, rz: 46, floor: -369, fog: -322, death: -316, roof: -187 };
const chE = (x, z) => Math.hypot((x - CHASM.x) / CHASM.rx, (z - CHASM.z) / CHASM.rz);
const KIND = {side:{hw:5,H:8,amp:.7},main:{hw:7,H:12,amp:1},rough:{hw:7,H:12,amp:1.1}};
export const MINE_LIGHTS = [];

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
  const e = { type: 0, kind: extra.kind || K.kind || kind, ax: a[0], az: a[1], fa: a[2], bx: b[0], bz: b[1], fb: b[2], dx: dx / len, dz: dz / len, len,
    hw: K.hw, H: K.H, amp: K.amp, rough: kind === 'rough', scree: kind === 'scree', seed: EL.length * 1.7, ...extra };
  e.box = [Math.min(a[0], b[0]) - e.hw, Math.max(a[0], b[0]) + e.hw, Math.min(a[1], b[1]) - e.hw, Math.max(a[1], b[1]) + e.hw, Math.min(a[2], b[2]) - 2, Math.max(a[2], b[2]) + e.H + 2];
  EL.push(e);
  return e;
}
function addHall(c, R, H) {
  EL.push({ type: 1, x: c[0], z: c[1], f: c[2], R, H, amp: 1.0, box: [c[0] - R, c[0] + R, c[1] - R, c[1] + R, c[2] - 2, c[2] + H + 2] });
}
function chasmRoof(e) { return CHASM.roof + 16 * Math.max(0, 1 - e * e); }

const segT = (e, x, z) => { const t = ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.len; return t < 0 ? 0 : t > 1 ? 1 : t; };
// поле: > 0 — воздух, < 0 — скала (примерно расстояние до стены, м)
function segD(e, x, y, z) {
  let t = ((x - e.ax) * e.dx + (z - e.az) * e.dz) / e.len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (e.ax + e.dx * e.len * t), dz = z - (e.az + e.dz * e.len * t);
  const u = Math.hypot(dx, dz);
  const base = segFloor(e, t), f = base, v = y - f;
  if (v < 0 && u < e.hw) return v;
  const rb = base;
  const vr = y - rb;
  const q = Math.pow(u / e.hw, 4) + Math.pow(Math.max(0, vr) / e.H, 4);
  return Math.min(v, (1 - Math.sqrt(Math.sqrt(q))) * Math.min(e.hw, e.H));
}
function hallD(e, x, y, z) {
  const r = Math.hypot(x - e.x, z - e.z), v = y - e.f;
  const q = Math.pow(r / e.R, 4) + Math.pow(Math.max(0, v) / e.H, 2);
  return Math.min(v, (1 - Math.sqrt(Math.sqrt(q))) * Math.min(e.R, e.H));
}
function chasmD(x, y, z) {
  const e = chE(x, z);
  return Math.min((1 - e) * Math.min(CHASM.rx, CHASM.rz), y - CHASM.floor, chasmRoof(e) - y);
}
const baseD = (e, x, y, z) => e.type === 0 ? segD(e, x, y, z) : e.type === 1 ? hallD(e, x, y, z) : chasmD(x, y, z);

function field(x, y, z, list) {
  let best = -1e9, n = null;
  for (const e of list) {
    let d = baseD(e, x, y, z);
    if (d < (e.type >= 3 ? -11 : -4)) { if (d > best) best = d; continue; }
    if (e.type === 3) {
      // стены пропасти: крупные выступы, слои-карнизы и мелкий скол

      // стена только отступает в скалу (не выпирает внутрь): край пустоты для физики — ровный эллипс, и
      // у выходов к пропасти под ногами никогда не оказывается «камень, которого нет»
      const big = vn3(x * 0.045, y * 0.06, z * 0.045) * 3.4 + vn3(x * 0.11 + 3, y * 0.14, z * 0.11) * 1.5 + Math.sin(y * 0.42 + vn3(x * 0.03, 0, z * 0.03) * 4) * 0.9;
      d += Math.max(0, 2.0 + big);
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
      const dx = x - (e.ax + e.dx * e.len * t), dz = z - (e.az + e.dz * e.len * t);
      const u = Math.hypot(dx, dz);
      const hw = e.hw - PAD * (e.hw < 2 ? 0.6 : 1);
      if (u > hw) continue;
      const base = segFloor(e, t), f = base;
      const rb = base;
      const roof = (rb + e.H * Math.pow(Math.max(0, 1 - Math.pow(u / e.hw, 4)), 0.25)) - 0.3;
      if (roof > f) _iv.push(f, roof);
    } else if (e.type === 1) {
      const r = Math.hypot(x - e.x, z - e.z);
      if (r > e.R - PAD * 1.4) continue;
      _iv.push(e.f, e.f + e.H * Math.sqrt(Math.max(0, 1 - Math.pow(r / e.R, 4))) - 0.3);
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
;
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
    // складки (тонкий лист породы) видны и с изнанки — иначе в них «дыры» насквозь
    const m = chunkMesh(ng, rockMat, (x, y, z) => field(x, y, z, list) < 0);
    m.userData.mine = true;
    scene.add(m); meshes.push(m);
    tris += idx.length / 3;
  }
  return { meshes, evals, tris };
}

// ---- сборка ----
export function buildMines(scene, mineSeed = SEED) {
  const t0 = performance.now();
  const rnd = mulberry32(SEED + 9091);
  // начало: концы двух туннелей
  const ends = TUNNELS.map((T) => {
    const pt = (t) => { const c = tunC(T, t); return [T.x + T.dx * t + T.nx * c, T.z + T.dz * t + T.nz * c, tunFloor(T, t, c)]; };
    return { T, at: pt, end: pt(T.L) };
  });
  const plan = galleryPlan(CHASM, ends.map(e=>e.end), mulberry32(mineSeed ^ 0x832acd));
  EL.length = 0;
  MINE_LIGHTS.length = 0;
  const segs = plan.legs.map(({a,b,kind,hw,H}) => addSeg(a,b,kind,{hw,H,branch:'gallery'}));
  for (const r of plan.rooms) addHall(r.p,r.r,r.h);
  EL.push({type:3,amp:0,box:[CHASM.x-CHASM.rx-8,CHASM.x+CHASM.rx+8,
    CHASM.z-CHASM.rz-8,CHASM.z+CHASM.rz+8,CHASM.floor-4,CHASM.roof+22]});
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
  const props = buildProps(scene,rnd,{plan,segs});
  const strata = buildMineStrata(scene,rockMat,segs,[],plan.ribs.flatMap(r=>[r.a,r.b]),mineSeed);
  buildRibs(scene,rockMat,plan.ribs);
  buildMines.stats = {rooms:plan.rooms.length, passages:segs.length, bridges:plan.ribs.length,
    strata,mineSeed,ms:Math.round(performance.now()-t0),chunks:rock.meshes.length,tris:rock.tris,props:props.tris};
  return buildMines.stats;
}
// смерть в красном тумане (ноги ниже этой высоты над дном пропасти) или в лаве
export function inDeadlyFog(p) {
  return (p.y < CHASM.death && chE(p.x, p.z) < 1.1);
}
// раскалённый низ столбов и стен у лавы: 2 м над лавой
// пол хода (для расстановки)
export const mineFloor = (x, z, y) => mineSpace(x, z, y);

// ================= обстановка =================
const WOOD = [0x6e4729, 0x5f3d24, 0x7a5232, 0x664229], IRON = 0x3a3638, STONE = 0x5a5550, GLASS = 0xffc070, WEB = 0xb8acc8;
const rotY = (dx, dz) => Math.atan2(-dz, dx);   // поворот, при котором своя ось x смотрит вдоль (dx, dz)
function buildProps(scene, rnd, ctx) {
  const B = new Map();
  const put = (x, z, p) => { const k = Math.floor(x / 40) + ',' + Math.floor(z / 40); (B.get(k) || B.set(k, []).get(k)).push(p); };
  // дерево — с нарисованной текстурой (minewood.js), свой буфер на кусок 40 м
  const W = new Map();
  const wbuf = (x, z) => { const k = Math.floor(x / 40) + ',' + Math.floor(z / 40); return W.get(k) || W.set(k, new WoodBuf()).get(k); };
  const lum = (c) => { const q = new THREE.Color(c); return q.r + q.g + q.b; }, LUM0 = lum(0x6e4729), WG = 0.78;
  const tintOf = (col) => { const l = WG * Math.pow(lum(col) / LUM0, 0.6) * (0.88 + rnd() * 0.22); return [l, l, l]; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const wbox = (x, y, z, sx, sy, sz, rect, ry = 0, rz = 0, tint = null, opt) => woodBox(wbuf(x, z), x, y, z, sx, sy, sz, ry, rz, rect, tint || tintOf(0x6e4729), rnd, opt);
  const beam = (x, y, z, sx, sy, sz, ry = 0, rz = 0, col = 0x6e4729) => wbox(x, y, z, sx, sy, sz, pick(WR.beam), ry, rz, tintOf(col));
  const WOODC = new Set([...WOOD, 0x4c3220, 0x3a2a1c, 0x5f3d24, 0x7a5232]);
  const box = (x, y, z, sx, sy, sz, col, ry = 0, rz = 0, glow = 0) => WOODC.has(col) && !glow ? beam(x, y, z, sx, sy, sz, ry, rz, col)
    : put(x, z, part(new THREE.BoxGeometry(1, 1, 1), col, { glow, m: M4(x, y, z, sx, sy, sz, ry, rz) }));
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
  // ящик с косой планкой (картинка из листа на каждой грани), бочка с обручами, мешок
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

  for (const e of ctx.segs) {
    const y=(e.fa+e.fb)/2, x=(e.ax+e.bx)/2, z=(e.az+e.bz)/2;
    if(e.kind==='main'){
      rails([e.ax,e.az],[e.bx,e.bz],e.fa,e.fb,-1.8);
      frame(x,y,z,e.dx,e.dz,e.hw*.86,Math.min(5,e.H*.55),true);
    } else {
      const cool=y>-249;
      light(x,y+2.8,z,18,.67,cool?[.50,.76,1]:[1,.55,.31]);
    }
  }
  for (const {p:[x,z,y],r,h,theme} of ctx.plan.rooms){
    const cold=theme==='frost';
    light(x,y+4,z,r*1.65,1.1,cold?[.53,.80,1]:[1,.64,.37]);
    if(theme==='brood'){
      for(let k=0;k<10;k++){
        const a=k*TAU/10+rnd()*.26, dx=Math.cos(a),dz=Math.sin(a);
        web(x+dx*r*.76,y+h*(.32+rnd()*.32),z+dz*r*.76,dx,-.32,dz,2.6+rnd()*2);
        cocoon(x+dx*r*.65,y+.8+rnd()*3,z+dz*r*.65,.8+rnd()*.75);
      }
      spider(x+4,y,z-2,1.85,rnd()*TAU); spider(x-3,y+h*.5,z+4,1.05,rnd()*TAU,h*.38);
    } else {
      const seamAngle=rnd()*TAU;
      for(let k=0;k<7;k++){
        const a=seamAngle+k*.16, px=x+Math.cos(a)*r*.89,pz=z+Math.sin(a)*r*.89;
        if(cold) crystals(px,y,pz,2,.8,0x94cce6);
        else geo(new THREE.IcosahedronGeometry(1,0),px,y+1,pz,0xb07850,
          M4(px,y+1+k*.19,pz,1.7,.42,.83,-a),.09);
      }
      if(theme==='iron') cart(x+r*.45,y+.1,z,0,1,1);
    }
    lantern(x+r*.38,y+3.8,z+r*.38,.5,1.45);
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
  const wm = woodMaterial();
  for (const b of W.values()) {
    if (!b.count) continue;
    tris += b.count / 3;
    const m = new THREE.Mesh(b.geometry(), wm);
    m.matrixAutoUpdate = false; m.userData.mine = true;
    scene.add(m);
  }
  return { tris };
}
