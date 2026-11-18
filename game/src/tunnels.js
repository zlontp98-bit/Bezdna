import * as THREE from '../vendor/three.min.js';
import { TUNNELS, tunLocal, tunFloor, tunRoof, heightAt, meshHeightAt, rockMat } from './terrain.js';
import { bakeStones, STONEAPI } from './descent.js';
import { chunkMesh } from './chunks.js';
import { fbm, mulberry32, SEED, smoothstep } from './noise.js';
import { part, merge, T as M4, propMaterial } from './flora.js';

// Два больших туннеля из шахты у самого дна (описание и физика пола — terrain.js TUNNELS / terrainAt).
// Рисуем: стену шахты у входа заново, с аркой (кусок сетки рельефа там вырезан), сам ход — каменная труба
// с полом, стенами и сводом, и глыбы: рамка у входа, валуны вдоль стен, завал в конце (дальше мир расширим).
// Ход идёт вперёд и полого вниз: по нему просто идёшь, без прыжков.

const TAU = Math.PI * 2;
const at = (T, t, w) => [T.x + T.dx * t + T.nx * w, T.z + T.dz * t + T.nz * w];
// неровность скалы внутрь хода, 0…0.6 м
const bump = (T, t, a) => 0.3 + 0.3 * fbm(t * 0.35 + T.th * 13, a * 2.2 + 4, 2);

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

// ход: кольца поперёк через каждый метр; сечение — свод (почти отвесные стены и плоский верх) и пол
function tube(T, scene) {
  const T0 = 0, KA = 22, KF = 9, NT = Math.round(T.L) + 1 + T0;
  const pos = [], idx = [];
  const ring = [];
  for (let i = 0; i < NT; i++) {
    const t = Math.min(T.L, i);
    const r = [];
    // свод: a = 0 (правый низ) … π (левый низ)
    for (let k = 0; k <= KA; k++) {
      const a = (k / KA) * Math.PI, ca = Math.cos(a);
      let w = T.hw * Math.sign(ca) * Math.pow(Math.abs(ca), 0.25);
      let y = tunFloor(T, t, w) + T.H * Math.sin(a);
      // неровность — внутрь хода (к оси), у пола сходит на нет
      const d = bump(T, t, a) * Math.min(1, Math.sin(a) * 4);
      const cx = -w, cy = T.H * 0.45 - (y - tunFloor(T, t, 0)), cl = Math.hypot(cx, cy) || 1;
      w += (cx / cl) * d; y += (cy / cl) * d;
      const [x, z] = at(T, t, w);
      r.push(pos.length / 3); pos.push(x, y, z);
    }
    // пол: от левой стены к правой (между краями свода)
    for (let k = 1; k < KF; k++) {
      // у входа пол хода чуть ниже: там поверх него ещё лежит пол шахты (сетка рельефа), чтобы не мерцали
      const w = -T.hw + (2 * T.hw * k) / KF, y = tunFloor(T, t, w) - 0.1 * (1 - smoothstep(2, 5, t));
      const [x, z] = at(T, t, w);
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
  // торец: глухая скала в конце хода (за ней — завал из глыб)
  const L = ring[NT - 1], [cx, cz] = at(T, T.L + 1.5, 0), ci = pos.length / 3;
  pos.push(cx, tunFloor(T, T.L, 0) + T.H * 0.45, cz);
  for (let k = 0; k < n; k++) idx.push(ci, L[k], L[(k + 1) % n]);
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
    return Math.abs(w) < T.hw - 0.7 && y > tunFloor(T, t, w) + 0.4 && y < tunRoof(T, t, Math.min(Math.abs(w), T.hw)) - 0.7;
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
    n: 3.0 + rnd() * 1.3, bump: 0.08 + rnd() * 0.12, dome: 0.2 + rnd() * 0.35, gs: 0, arch: 0, seg: R > 2.2 ? 16 : 12,
    T: Tt, prof: [[Math.min(1.2, Tt * 0.2), 1.03], [Math.min(3, Tt * 0.45), 0.98], [Math.min(5, Tt * 0.7), 1.0], [Tt, 0.95]],
    flt: false, hs: 1, col: true, rv: Array.from({ length: 9 }, rnd), kind: 'tunnel', ...extra,
  };
}

function boulders(T, rnd, scene) {
  const specs = [];
  const put = (t, w, h, R) => { const [x, z] = at(T, t, w), f = tunFloor(T, t, w); specs.push(column(rnd, x, z, f + h, f - 1.5, R)); };
  // рамка у входа: большие глыбы по бокам арки, со стороны шахты; внутренний край — не ближе hw−1 к оси
  const side = (t, sd, h, R) => put(t, sd * (T.hw - 1 + R * 1.2), h, R);
  for (const sd of [-1, 1]) {
    side(-1.2 + rnd(), sd, 6 + rnd() * 3, 2.6 + rnd() * 0.6);
    side(-2.0 + rnd(), sd, 3.5 + rnd() * 3, 2.2 + rnd() * 0.5);
  }
  // валуны вдоль стен хода: посередине остаётся широкий ровный проход (≈9 м)
  for (const sd of [-1, 1]) for (let t = 3 + rnd() * 2; t < T.L - 4; t += 4.5 + rnd() * 2.0) {
    if (rnd() < 0.3) continue;
    const R = 1.1 + rnd() * 0.6;
    put(t, sd * Math.max(T.hw - 0.4, 4.6 + R * 1.2), 1.2 + rnd() * 3.2, R);
  }
  // мелкие камни у стен
  for (let k = 0; k < 4; k++) { const sd = rnd() < 0.5 ? -1 : 1; put(2 + rnd() * (T.L - 6), sd * (T.hw - 1.4 - rnd() * 0.4), 0.3 + rnd() * 0.3, 0.5 + rnd() * 0.3); }
  // завал в конце: дальше ход откроем, когда будем расширять мир
  for (let k = 0; k < 4; k++) put(T.L - 2.5 + rnd() * 2, (rnd() - 0.5) * 2 * (T.hw - 1.5), 2 + rnd() * 5, 2.0 + rnd() * 0.8);
  const b = bakeStones(specs, (x, y, z) => heightAt(x, z) > y + 0.05 && Math.abs(tunLocal(T, x, z)[1]) > T.hw + 0.5);
  return b.meshes(scene);
}

// фонари на стенах хода (как фонари на глыбах): видно вход издалека, внутри не темно. Свет — в deep.lights.
export const TUN_LIGHTS = [];
function lanterns(T, scene) {
  const parts = [], IRON = 0x3b3633, WOOD = 0x5a3b26, GLASS = 0xffc070, K = 1.6;
  const spots = [[0.6, -1, 5.0], [0.6, 1, 5.0]];
  for (let t = 9, sd = -1; t < T.L - 4; t += 9, sd = -sd) spots.push([t, sd, 4.2]);
  for (const [t, sd, hy] of spots) {
    const f = tunFloor(T, t, 0), y = f + hy, ly = y - 0.6;
    const [ax, az] = at(T, t, sd * (T.hw - 0.2)), [lx, lz] = at(T, t, sd * (T.hw - 1.2));
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
  const mesh = new THREE.Mesh(merge(parts), propMaterial());
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return mesh;
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
    const meshes = [tube(T, scene), mouthWall(T, scene), ...boulders(T, rnd, scene)];
    for (const m of meshes) m.userData.tunnel = true;
    lanterns(T, scene).userData.tunnel = true;
    stats.push({ gone, meshes: meshes.length, tris: meshes.reduce((q, m) => q + m.geometry.attributes.position.count / 3, 0) });
  }
  buildTunnels.stats = stats;
  return stats;
}
