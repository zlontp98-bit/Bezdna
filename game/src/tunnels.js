import * as THREE from '../vendor/three.min.js';
import { TUNNELS, tunLocal, tunFloor, tunRoof, tunC, tunHW, tunH, heightAt, meshHeightAt, rockMat } from './terrain.js';
import { bakeStones, STONEAPI } from './descent.js';
import { chunkMesh } from './chunks.js';
import { fbm, mulberry32, SEED, smoothstep } from './noise.js';
import { part, merge, T as M4, propMaterial } from './flora.js';

// Два больших туннеля из шахты у самого дна (описание и физика пола — terrain.js TUNNELS / terrainAt).
// Рисуем: стену шахты у входа заново, с аркой (кусок сетки рельефа там вырезан), сам ход — каменная труба
// с полом, стенами и сводом (выступы, трещины, ниши, провалы вверх), сталактиты и свисающие камни, лужи,
// голубые кристаллы и тёплые фонари, глыбы: рамка у входа, крупные глыбы у стен, камни на полу, завал в конце.
// Ход петляет и полого уходит вниз: по нему просто идёшь, без прыжков.

const TAU = Math.PI * 2;
const at = (T, t, w) => [T.x + T.dx * t + T.nx * w, T.z + T.dz * t + T.nz * w];
function meshFrom(pos, idx, scene) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const ng = g.toNonIndexed();
  ng.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  const m = chunkMesh(ng, rockMat);
  scene.add(m);
  return m;
}

// точка хода: t вдоль, u — поперёк от середины хода (она петляет)
const atU = (T, t, u) => at(T, t, tunC(T, t) + u);
// ниши в стенах: у каждого хода свои (t, сторона, высота над полом)
function niches(T, rnd) {
  const out = [];
  for (let t = 8 + rnd() * 6; t < T.L - 6; t += 9 + rnd() * 9) out.push({ t, sd: rnd() < 0.5 ? -1 : 1, y: 1.3 + rnd() * 1.5, h: 1.8 + rnd() * 1.6, l: 2 + rnd() * 2, d: 1.6 + rnd() * 1.2 });
  return out;
}
// сдвиг стены внутрь хода (+) или в скалу (−) в точке (t, a): выступы и уступы, трещины, ниши
function wallShift(T, t, a, yUp, N) {
  const n1 = fbm(t * 0.3 + T.seed * 13, a * 2.2 + 4, 2);
  const rid = 1 - Math.abs(fbm(t * 0.16 + T.seed * 3, a * 3.1 + 1, 2));          // гребни: выступы и карнизы
  let d = 0.35 + 0.3 * n1 + 0.65 * rid * rid * rid;
  const cr = 1 - Math.abs(fbm(t * 0.75 + T.seed * 7, a * 0.9 - 2, 2));            // узкие трещины
  d -= 0.9 * smoothstep(0.86, 0.97, cr);
  for (const q of N) {                                                         // ниша: углубление в скалу
    const side = q.sd > 0 ? a < 1.2 : a > Math.PI - 1.2;
    if (!side) continue;
    const kt = 1 - smoothstep(q.l * 0.5, q.l * 0.5 + 1.2, Math.abs(t - q.t)), ky = 1 - smoothstep(q.h * 0.5, q.h * 0.5 + 0.8, Math.abs(yUp - q.y - q.h * 0.5));
    d -= q.d * kt * ky;
  }
  return Math.min(1.25, d);
}

// ход: кольца поперёк через 0.7 м; сечение — свод (почти отвесные стены, верх; в провалах — высокая щель) и пол
function tube(T, rnd, scene) {
  const KA = 30, KF = 12, DT = 0.7, NT = Math.ceil(T.L / DT) + 1;
  const N = niches(T, rnd);
  const pos = [], idx = [];
  const ring = [];
  for (let i = 0; i < NT; i++) {
    const t = Math.min(T.L, i * DT), c = tunC(T, t), hw = tunHW(T, t), H = tunH(T, t), f0 = tunFloor(T, t, c);
    const kM = 0.35 + 0.65 * smoothstep(1, 6, t);   // у самого входа стены спокойнее (там стык со стеной шахты)
    const r = [];
    // свод: a = 0 (правый низ) … π (левый низ)
    for (let k = 0; k <= KA; k++) {
      const a = (k / KA) * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
      let u = hw * Math.sign(ca) * Math.pow(Math.abs(ca), 0.25);
      let y = tunFloor(T, t, c + u) + H * sa;
      // сдвиг — к оси хода (внутрь) или в скалу; у пола сходит на нет
      const d = wallShift(T, t, a, y - f0, N) * kM * Math.min(1, sa * 4);
      const cx = -u, cy = Math.min(H, 10) * 0.45 - (y - f0), cl = Math.hypot(cx, cy) || 1;
      u += (cx / cl) * d; y += (cy / cl) * d;
      const [x, z] = atU(T, t, u);
      r.push(pos.length / 3); pos.push(x, y, z);
    }
    // пол: от левой стены к правой (между краями свода)
    for (let k = 1; k < KF; k++) {
      // у входа пол хода чуть ниже: там поверх него ещё лежит пол шахты (сетка рельефа), чтобы не мерцали
      const u = -hw + (2 * hw * k) / KF, y = tunFloor(T, t, c + u) - 0.1 * (1 - smoothstep(2, 5, t));
      const [x, z] = atU(T, t, u);
      r.push(pos.length / 3); pos.push(x, y, z);
    }
    ring.push(r);
  }
  const n = ring[0].length;
  const air = (v) => heightAt(pos[v * 3], pos[v * 3 + 2]) < pos[v * 3 + 1] - 0.1;   // точка снаружи скалы (в шахте)
  for (let i = 0; i + 1 < NT; i++) {
    for (let k = 0; k < n; k++) {
      const a = ring[i][k], b = ring[i][(k + 1) % n], c = ring[i + 1][k], d = ring[i + 1][(k + 1) % n];
      const floor = k >= KA;          // пол рисуем весь, свод — только там, где он в толще скалы (без «козырька»)
      if (!floor && air(a) && air(b) && air(c) && air(d)) continue;
      idx.push(a, b, c, b, d, c);
    }
  }
  // «юбка» у входа: от края пола хода вниз на 1.5 м — пол шахты перед входом местами чуть ниже, и щели под краем не видно
  const R0 = ring[0], sk = [];
  for (let k = KA; k <= n; k++) { const v = R0[k % n]; sk.push(pos.length / 3); pos.push(pos[v * 3], pos[v * 3 + 1] - 1.5, pos[v * 3 + 2]); }
  for (let k = KA, j = 0; k < n; k++, j++) { const a = R0[k], b = R0[(k + 1) % n]; idx.push(a, sk[j], b, b, sk[j], sk[j + 1]); }
  // торец: глухая скала в конце хода (перед ней — завал из глыб)
  const L = ring[NT - 1], [cx, cz] = atU(T, T.L + 1.5, 0), ci = pos.length / 3;
  pos.push(cx, tunFloor(T, T.L, tunC(T, T.L)) + T.H * 0.45, cz);
  for (let k = 0; k < n; k++) idx.push(ci, L[k], L[(k + 1) % n]);
  return meshFrom(pos, idx, scene);
}

// сталактиты и свисающие камни под сводом (в провалах — гуще и длиннее)
function ceiling(T, rnd, scene) {
  const pos = [], idx = [];
  // geo — ещё в своих координатах (центр в нуле): неровность — от центра; потом переносим в точку (cx, cy, cz)
  const add = (geo, jit, cx, cy, cz) => {
    const P = geo.attributes.position, o = pos.length / 3;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i), q = jit ? 1 + jit * fbm(x * 1.7 + y * 0.9 + cx, z * 1.7 - y * 0.6 + cz, 2) : 1;
      pos.push(cx + x * q, cy + y, cz + z * q);
    }
    if (geo.index) { const I = geo.index.array; for (let i = 0; i < I.length; i++) idx.push(o + I[i]); }
    else for (let i = 0; i < P.count; i++) idx.push(o + i);
  };
  const tmp = new THREE.Matrix4(), rot = new THREE.Matrix4();
  for (let t = 3 + rnd() * 2; t < T.L - 2; t += 1.2 + rnd() * 2.6) {
    const hw = tunHW(T, t), u = (rnd() * 2 - 1) * (hw - 2), w = tunC(T, t) + u;
    const f = tunFloor(T, t, w), roof = tunRoof(T, t, w), room = roof - f;
    const chim = tunH(T, t) > T.H * 1.5;
    const [x, z] = at(T, t, w);
    if (rnd() < 0.22 && !chim) {
      // свисающий камень: приплюснутый ком, верх утоплен в своде
      const R = 0.9 + rnd() * 0.9, g = new THREE.IcosahedronGeometry(R, 1);
      const yb = Math.max(f + 4.2, roof - 1.3 - R * 0.5);
      g.applyMatrix4(tmp.makeScale(1 + rnd() * 0.4, 0.7 + rnd() * 0.3, 1 + rnd() * 0.4)).applyMatrix4(rot.makeRotationY(rnd() * TAU));
      add(g, 0.35, x, yb + R * 0.6, z);
      continue;
    }
    // сталактиты: пучок из 1–4 конусов остриём вниз; остриё не ниже 3.6 м над полом (над головой)
    const nC = 1 + Math.floor(rnd() * (chim ? 5 : 3.2));
    for (let j = 0; j < nC; j++) {
      const ox = (rnd() - 0.5) * 2.2, oz = (rnd() - 0.5) * 2.2;
      const len = Math.min(room - 3.6, (chim ? 2.5 : 1.0) + rnd() * (chim ? 4 : 2.6)), rr = 0.18 + len * (0.1 + rnd() * 0.08);
      if (len < 0.6) continue;
      const g = new THREE.ConeGeometry(rr, len + 0.8, 6, 2);
      g.applyMatrix4(rot.makeRotationX(Math.PI)).applyMatrix4(rot.makeRotationY(rnd() * TAU));
      add(g, 0.25, x + ox, roof + 0.35 - (len + 0.8) / 2 - (chim ? 0 : 0.5), z + oz);
    }
  }
  return meshFrom(pos, idx, scene);
}

// стена шахты у входа: тот же профиль, что у сетки рельефа (стыки совпадают), но мельче и с аркой
function mouthWall(T, scene) {
  const b = T.band, SUB = 2, M = 80, MD = 60;   // MD точек — на нижние 30 м профиля (пол и арка), остальные — на стену выше
  const pos = [], idx = [], grid = [];
  const nTh = b.n * SUB;
  for (let i = 0; i <= nTh; i++) {
    const th = ((b.c0 + i / SUB) / b.cols) * TAU, c = Math.cos(th), s = Math.sin(th);
    // профиль стены вдоль радиуса и его длина
    const pr = [];
    let len = 0, px = 0, py = 0;
    for (let r = b.rA; r <= b.rB + 1e-6; r += 0.1) {
      const y = meshHeightAt(c * r, s * r);
      if (pr.length) len += Math.hypot(r - px, y - py);
      pr.push([r, y, len]); px = r; py = y;
    }
    const col = [];
    let q = 0;
    for (let j = 0; j <= M; j++) {
      const Ld = Math.min(len * 0.5, 30), L = j <= MD ? (Ld * j) / MD : Ld + ((len - Ld) * (j - MD)) / (M - MD);
      while (q < pr.length - 2 && pr[q + 1][2] < L) q++;
      const p0 = pr[q], p1 = pr[q + 1], f = p1[2] > p0[2] ? (L - p0[2]) / (p1[2] - p0[2]) : 0;
      const r = p0[0] + (p1[0] - p0[0]) * f, y = p0[1] + (p1[1] - p0[1]) * f;
      col.push(pos.length / 3); pos.push(c * r, y, s * r);
    }
    grid.push(col);
  }
  const hole = (v) => {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const [t, w] = tunLocal(T, x, z);
    if (t < 0 || t > T.L) return false;   // перед входом стену шахты не трогаем: ход начинается ровно с t = 0
    // вырез чуть меньше сечения хода: край стены заходит на свод, и щёлок по краю арки нет
    const u = Math.abs(w - tunC(T, t)), hw = tunHW(T, t);
    return u < hw - 0.7 && y > tunFloor(T, t, w) + 0.4 && y < tunRoof(T, t, tunC(T, t) + Math.min(u, hw)) - 0.7;
  };
  for (let i = 0; i < nTh; i++) for (let j = 0; j < M; j++) {
    const a = grid[i][j], bb = grid[i + 1][j], c = grid[i][j + 1], d = grid[i + 1][j + 1];
    if (hole(a) && hole(bb) && hole(c) && hole(d)) continue;
    if ((hole(a) + hole(bb) + hole(c) + hole(d)) >= 2) continue;
    idx.push(a, bb, c, bb, d, c);
  }
  // нормали — в шахту: если вышли наружу, перевернём
  const m = meshFrom(pos, idx, scene);
  const P = m.geometry.attributes.position.array, N = m.geometry.attributes.normal.array;
  let dot = 0;
  for (let v = 0; v < P.length; v += 3) dot += -(P[v] * N[v] + P[v + 2] * N[v + 2]);
  if (dot < 0) {
    for (let v = 0; v < N.length; v++) N[v] = -N[v];
    for (let v = 0; v < P.length; v += 9) for (let k = 0; k < 3; k++) { const t = P[v + 3 + k]; P[v + 3 + k] = P[v + 6 + k]; P[v + 6 + k] = t; const u = N[v + 3 + k]; N[v + 3 + k] = N[v + 6 + k]; N[v + 6 + k] = u; }
  }
  return m;
}

// паспорт глыбы-столба (как у глыб поля): верх top, низ bot
function column(rnd, x, z, top, bot, R, extra = {}) {
  const Tt = Math.max(2, top - bot);
  return {
    x, z, y: top, A: R * (0.85 + rnd() * 0.3), B: R * (0.85 + rnd() * 0.3), ang: rnd() * TAU,
    n: 3.0 + rnd() * 1.3, bump: 0.08 + rnd() * 0.12, dome: 0.2 + rnd() * 0.35, gs: 0, arch: 0, seg: R > 2.2 ? 12 : 9,
    T: Tt, prof: [[Math.min(1.2, Tt * 0.2), 1.03], [Math.min(3, Tt * 0.45), 0.98], [Math.min(5, Tt * 0.7), 1.0], [Tt, 0.95]],
    flt: false, hs: 1, col: true, rv: Array.from({ length: 9 }, rnd), kind: 'tunnel', ...extra,
  };
}

function boulders(T, rnd, scene) {
  const specs = [];
  const put = (t, u, h, R) => { const w = tunC(T, t) + u, [x, z] = at(T, t, w), f = tunFloor(T, t, w); specs.push(column(rnd, x, z, f + h, f - 1.5, R)); };
  // рамка у входа: большие глыбы по бокам арки, со стороны шахты; внутренний край — не ближе hw−1 к оси
  const side = (t, sd, h, R) => put(t, sd * (T.hw - 1 + R * 1.2), h, R);
  for (const sd of [-1, 1]) {
    side(-1.2 + rnd(), sd, 6 + rnd() * 3, 2.6 + rnd() * 0.6);
    side(-2.0 + rnd(), sd, 3.5 + rnd() * 3, 2.2 + rnd() * 0.5);
  }
  // у стен: то крупная глыба, наполовину в скале, то пара валунов поменьше; стороны чередуются не строго
  let sd = rnd() < 0.5 ? -1 : 1;
  for (let t = 4 + rnd() * 3; t < T.L - 5; t += 4 + rnd() * 5) {
    const hw = tunHW(T, t);
    if (rnd() < 0.35) {
      const R = 1.9 + rnd() * 0.8;
      put(t, sd * (hw + 0.3), 2.5 + rnd() * 4.5, R);
    } else {
      const R = 1.0 + rnd() * 0.6;
      put(t, sd * Math.max(hw - 0.4, hw - 1.9 + R * 1.2), 1.0 + rnd() * 2.6, R);
      if (rnd() < 0.5) put(t + 1.6 + rnd(), sd * (hw - 1.2 + rnd() * 0.4), 0.5 + rnd() * 0.8, 0.6 + rnd() * 0.4);
    }
    sd = rnd() < 0.7 ? -sd : sd;
  }
  // камни на полу: невысокие (перешагнуть), то у стен, то ближе к середине
  for (let k = 0; k < 9; k++) {
    const t = 3 + rnd() * (T.L - 7), hw = tunHW(T, t), u = (rnd() * 2 - 1) * (hw - 1.6);
    put(t, u, 0.2 + rnd() * 0.25, 0.35 + rnd() * 0.35);
  }
  // завал в конце: дальше ход откроем, когда будем расширять мир
  for (let k = 0; k < 4; k++) put(T.L - 2.5 + rnd() * 2, (rnd() - 0.5) * 2 * (tunHW(T, T.L) - 1.5), 2 + rnd() * 5, 2.0 + rnd() * 0.8);
  const b = bakeStones(specs, (x, y, z) => { if (heightAt(x, z) <= y + 0.05) return false; const [t, w] = tunLocal(T, x, z); return Math.abs(w - tunC(T, t)) > tunHW(T, t) + 0.5; });
  return b.meshes(scene);
}

// лужи в ямках пола (ямки задаёт terrain.js: TUNNELS.pools) — тёмная вода с отблеском
function puddles(T, rnd, parts) {
  for (const [tp, up, rp] of T.pools) {
    const w = tunC(T, tp) + up, [x, z] = at(T, tp, w), y = tunFloor(T, tp, w) + 0.12;
    const g = new THREE.CircleGeometry(rp * 0.95, 16), P = g.attributes.position;
    for (let i = 1; i < P.count; i++) { const k = 0.8 + 0.35 * fbm(P.getX(i) * 0.9 + tp, P.getY(i) * 0.9 + up, 2); P.setXY(i, P.getX(i) * k, P.getY(i) * k); }
    parts.push(part(g, 0x173f4c, { glow: 0.12, m: M4(x, y, z).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)) }));
  }
}

// голубые кристаллы: холодный свет в нишах, у стен и в провалах
function crystals(T, rnd, parts) {
  const spots = [];
  for (let t = 6 + rnd() * 5; t < T.L - 3; t += 8 + rnd() * 8) spots.push(t);
  for (const t of spots) {
    const hw = tunHW(T, t), sd = rnd() < 0.5 ? -1 : 1, u = sd * (hw - 1.4), w = tunC(T, t) + u;
    const [x, z] = at(T, t, w), f = tunFloor(T, t, w), n = 3 + Math.floor(rnd() * 4);
    const col = rnd() < 0.7 ? 0x7fd8ff : 0x9fb8ff;
    for (let j = 0; j < n; j++) {
      const s = 0.5 + rnd() * 0.8, a = rnd() * TAU, r = rnd() * 0.7;
      const m = M4(x + Math.cos(a) * r, f + s * 0.45, z + Math.sin(a) * r, s * 0.35, s * 1.3, s * 0.35, rnd() * TAU, (rnd() - 0.5) * 0.7);
      parts.push(part(new THREE.CylinderGeometry(0.25, 0.4, 1, 5), col, { glow: 1, m }));
    }
    TUN_LIGHTS.push({ x, y: f + 0.8, z, r: 7, k: 0.9, col: [0.35, 0.65, 1.0] });
  }
}

// фонари на стенах хода (как фонари на глыбах): видно вход издалека, внутри не темно. Свет — в deep.lights.
export const TUN_LIGHTS = [];
function lanterns(T, scene, parts) {
  const IRON = 0x3b3633, WOOD = 0x5a3b26, GLASS = 0xffc070, K = 1.6;
  const spots = [[0.6, -1, 5.0], [0.6, 1, 5.0]];
  for (let t = 11, sd = -1; t < T.L - 4; t += 10 + ((t * 7.3) % 5), sd = -sd) spots.push([t, sd, 3.6 + ((t * 3.1) % 1.2)]);
  for (const [t, sd, hy] of spots) {
    const c = tunC(T, t), hw = tunHW(T, t), f = tunFloor(T, t, c), y = f + hy, ly = y - 0.6;
    const [ax, az] = at(T, t, c + sd * (hw - 0.2)), [lx, lz] = at(T, t, c + sd * (hw - 1.2));
    const ux = -sd * T.nx, uz = -sd * T.nz, ry = Math.atan2(-uz, ux);
    parts.push(part(new THREE.BoxGeometry(1.1, 0.08, 0.08), IRON, { m: M4((ax + lx) / 2, y, (az + lz) / 2, 1, 1, 1, ry) }));
    parts.push(part(new THREE.BoxGeometry(0.6, 0.06, 0.06), IRON, { m: M4(ax + ux * 0.3, y - 0.2, az + uz * 0.3, 1, 1, 1, ry, 0.6) }));
    parts.push(part(new THREE.BoxGeometry(0.03, 0.32, 0.03), IRON, { m: M4(lx, y - 0.17, lz) }));
    parts.push(part(new THREE.CylinderGeometry(0.03, 0.2, 0.14, 6), IRON, { m: M4(lx, ly + 0.25 * K, lz, K) }));
    parts.push(part(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 6), GLASS, { glow: 1, m: M4(lx, ly + 0.03 * K, lz, K) }));
    parts.push(part(new THREE.CylinderGeometry(0.16, 0.1, 0.07, 6), WOOD, { m: M4(lx, ly - 0.15 * K, lz, K) }));
    for (let j = 0; j < 3; j++) {
      const b = j * Math.PI * 2 / 3 + 0.5;
      parts.push(part(new THREE.BoxGeometry(0.025, 0.32, 0.025), IRON, { m: M4(lx + Math.cos(b) * 0.135 * K, ly + 0.03 * K, lz + Math.sin(b) * 0.135 * K, K) }));
    }
    TUN_LIGHTS.push({ x: lx, y: ly, z: lz, r: t < 1 ? 8 : 6.5, k: 0.95, col: [1.0, 0.62, 0.3] });
  }
}

// глыбы карты, убранные туннелями: мостики и фонари берут их в расчёт (порядок выбора — как раньше), но к ним не строят
export const TUN_GONE = [];

export function buildTunnels(scene) {
  const rnd = mulberry32(SEED + 5113);
  const stats = [];
  for (const T of TUNNELS) {
    // глыбы карты, стоящие прямо перед входом и в проходе, убираем, чтобы арку было видно от озера.
    // Глыбы, поставленные в редакторе (kind 'built'), не трогаем — кроме низких у самого пола в проходе.
    let gone = 0;
    for (const s of STONEAPI.all()) {
      const sp = s.spec, R = Math.max(sp.A, sp.B) * (sp.hs ?? 1);
      if (R > 20 || sp.y < T.F0 + 0.5 || sp.y - (sp.T || 3) > T.F0 + 12) continue;
      const [t, w] = tunLocal(T, sp.x, sp.z);
      const low = sp.y < T.F0 + 4;
      const inMouth = t > -7 - R * 0.5 && t < 2 + R * 0.5 && Math.abs(w) < T.hw - 1.5 + R * 0.5 && low;
      const inView = sp.kind !== 'built' && t > -12 - R && t < 1 + R && Math.abs(w) - R * 0.8 < 5.5;
      if (inMouth || inView) { TUN_GONE.push(s); STONEAPI.remove(s.id); gone++; }
    }
    const meshes = [tube(T, rnd, scene), mouthWall(T, scene), ceiling(T, rnd, scene), ...boulders(T, rnd, scene)];
    // мелочь одной моделью: фонари, кристаллы, лужи
    const parts = [];
    lanterns(T, scene, parts); crystals(T, rnd, parts); puddles(T, rnd, parts);
    const props = new THREE.Mesh(merge(parts), propMaterial());
    props.frustumCulled = false; props.matrixAutoUpdate = false;
    scene.add(props);
    meshes.push(props);
    for (const m of meshes) m.userData.tunnel = true;
    stats.push({ gone, meshes: meshes.length, tris: meshes.reduce((q, m) => q + m.geometry.attributes.position.count / 3, 0) });
  }
  buildTunnels.stats = stats;
  return stats;
}
