import * as THREE from '../vendor/three.min.js';
import { mat, LITE } from './shaders.js';
import { STONEAPI } from './descent.js';
import { rockAt, groundAt, addBox } from './solids.js';
import { waterNear } from './waterfall.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mulberry32, SEED } from './noise.js';

// Масштаб шахты: фонари на кронштейнах по бокам глыб — тёплые огоньки вдалеке и в глубине — и мостики.
// Всё — украшение без коллизий; каждое — одна модель.

// ---------- фонари на кронштейнах ----------
// Возвращает список огоньков для общего света (Deep.lights): тёплые пятна на камне вокруг фонаря.
export function buildLanterns(scene) {
  const rnd = mulberry32(SEED + 5501);
  const stones = STONEAPI.all().filter((s) => s.spec.y < -85);
  for (let i = stones.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [stones[i], stones[j]] = [stones[j], stones[i]]; }
  const MAX = LITE ? 22 : 36;
  const parts = [], lights = [];
  const IRON = 0x3b3633, WOOD = 0x5a3b26, GLASS = 0xffc070, K = 1.4; // K — размер фонаря
  const edgeR = (cx, cz, ux, uz, y, r1) => {
    let last = -1;
    for (let r = 0; r <= r1; r += 0.1) { if (rockAt(cx + ux * r, cz + uz * r, y)) last = r; else if (last >= 0) break; }
    return last;
  };
  for (const st of stones) {
    if (lights.length >= MAX) break;
    const sp = st.spec, R = Math.max(sp.A, sp.B);
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a), y = sp.y - 0.55 - rnd() * 1.2;
      const re = edgeR(sp.x, sp.z, ux, uz, y, R * 1.6);
      if (re < 0.5) continue;
      const ax = sp.x + ux * (re - 0.1), az = sp.z + uz * (re - 0.1);         // в камне
      const lx = sp.x + ux * (re + 0.6), lz = sp.z + uz * (re + 0.6), ly = y - 0.6;   // фонарь
      // под фонарём пусто (не в соседнем камне, не в земле, не в воде)
      if (rockAt(lx, lz, ly) || rockAt(lx, lz, ly - 0.4) || groundAt(lx, lz, ly) > ly - 0.6 || waterNear(lx, ly, lz, 1, 2)) continue;
      const ry = Math.atan2(-uz, ux);
      // кронштейн: брус из камня наружу, подкос, цепь
      parts.push(part(new THREE.BoxGeometry(0.85, 0.07, 0.07), IRON, { m: T((ax + lx) / 2 + ux * 0.05, y, (az + lz) / 2 + uz * 0.05, 1, 1, 1, ry) }));
      parts.push(part(new THREE.BoxGeometry(0.5, 0.05, 0.05), IRON, { m: T(ax + ux * 0.25, y - 0.18, az + uz * 0.25, 1, 1, 1, ry, 0.6) }));
      parts.push(part(new THREE.BoxGeometry(0.03, 0.32, 0.03), IRON, { m: T(lx, y - 0.17, lz) }));
      // сам фонарь: крышка, стекло (светится), донце, кольцо
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.2, 0.14, 6), IRON, { m: T(lx, ly + 0.25 * K, lz, K) }));
      parts.push(part(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 6), GLASS, { glow: 1, m: T(lx, ly + 0.03 * K, lz, K) }));
      parts.push(part(new THREE.CylinderGeometry(0.16, 0.1, 0.07, 6), WOOD, { m: T(lx, ly - 0.15 * K, lz, K) }));
      for (let j = 0; j < 3; j++) {
        const b = j * Math.PI * 2 / 3 + 0.5;
        parts.push(part(new THREE.BoxGeometry(0.025, 0.32, 0.025), IRON, { m: T(lx + Math.cos(b) * 0.135 * K, ly + 0.03 * K, lz + Math.sin(b) * 0.135 * K, K) }));
      }
      lights.push({ x: lx, y: ly, z: lz, r: 5.5, k: 0.85, col: [1.0, 0.62, 0.3] });
      break;
    }
  }
  if (!parts.length) return lights;
  const mesh = new THREE.Mesh(merge(parts), propMaterial());
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return lights;
}

// ---------- мостики между глыбами ----------
// Верёвочные мостики из досок через узкие пропасти между соседними глыбами. По ним можно ходить:
// каждая пара досок — плоская плита с низом (под мостом проходишь свободно, «невидимой стены до земли» нет).
export function buildBridges(scene) {
  const rnd = mulberry32(SEED + 6607);
  const all = STONEAPI.all().filter((s) => s.spec.y < -95 && s.spec.y > -168);
  const MAX = LITE ? 7 : 11;
  const parts = [], used = new Set(), list = [];
  const WOOD = [0x7a5034, 0x6b4630, 0x86593a], ROPE = 0x9c8662, POST = 0x5a3b26;
  const edgeR = (cx, cz, ux, uz, y, r1) => {
    let last = -1;
    for (let r = 0; r <= r1; r += 0.1) { if (rockAt(cx + ux * r, cz + uz * r, y)) last = r; else if (last >= 0) break; }
    return last;
  };
  const pairs = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].spec, b = all[j].spec;
    const d = Math.hypot(b.x - a.x, b.z - a.z), gap = d - Math.max(a.A, a.B) - Math.max(b.A, b.B);
    if (gap > 2.0 && gap < 9 && Math.abs(a.y - b.y) < 1.4) pairs.push([i, j, rnd()]);
  }
  pairs.sort((p, q) => p[2] - q[2]);
  let made = 0;
  for (const [i, j] of pairs) {
    if (made >= MAX) break;
    if (used.has(i) || used.has(j)) continue;
    const A = all[i].spec, B = all[j].spec;
    const d = Math.hypot(B.x - A.x, B.z - A.z), ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
    const ra = edgeR(A.x, A.z, ux, uz, A.y - 0.15, Math.max(A.A, A.B) * 1.6), rb = edgeR(B.x, B.z, -ux, -uz, B.y - 0.15, Math.max(B.A, B.B) * 1.6);
    if (ra < 0.5 || rb < 0.5) continue;
    const p0 = [A.x + ux * (ra - 0.4), 0, A.z + uz * (ra - 0.4)], p1 = [B.x - ux * (rb - 0.4), 0, B.z - uz * (rb - 0.4)];
    p0[1] = groundAt(p0[0], p0[2], A.y + 3); p1[1] = groundAt(p1[0], p1[2], B.y + 3);
    if (Math.abs(p0[1] - A.y) > 1.2 || Math.abs(p1[1] - B.y) > 1.2) continue;
    const L = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), sag = 0.05 * L + 0.15;
    if (L < 2.5 || L > 11) continue;
    // пролёт свободен: не задевает соседние камни и воду, а под ним пропасть
    let ok = true;
    for (let t = 0.12; t <= 0.88 && ok; t += 0.04) {
      const x = p0[0] + (p1[0] - p0[0]) * t, z = p0[2] + (p1[2] - p0[2]) * t, y = p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t);
      for (const o of [-0.7, 0, 0.7]) {
        const qx = x - uz * o, qz = z + ux * o;
        if (rockAt(qx, qz, y + 0.3) || rockAt(qx, qz, y + 1.4) || groundAt(qx, qz, y + 0.1) > y - 1.0) ok = false;
      }
      if (waterNear(x, y, z, 2, 4)) ok = false;
    }
    if (!ok) continue;
    used.add(i); used.add(j); made++; list.push({ p0, p1 });
    const ry = Math.atan2(-uz, ux), n = Math.max(4, Math.round(L / 0.5));
    const at = (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t) + 0.02, p0[2] + (p1[2] - p0[2]) * t];
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, [x, y, z] = at(t);
      const slope = ((at(Math.min(1, t + 0.01))[1] - at(Math.max(0, t - 0.01))[1]) / (0.02 * L));
      parts.push(part(new THREE.BoxGeometry(0.42, 0.07, 1.1 + (k % 3 === 1 ? 0.12 : 0)), WOOD[k % 3], { m: T(x, y - 0.035, z, 1, 1, 1, ry, Math.atan(slope)) }));
    }
    // по паре досок — одна плита для ходьбы
    for (let k = 0; k < n; k += 2) {
      const t0 = k / n, t1 = Math.min(1, (k + 2) / n), [x0, y0, z0] = at(t0), [x1, y1, z1] = at(t1);
      const top = Math.max(y0, y1);
      addBox((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 0.02, 0.55, ry, top, top - 0.25);
    }
    // столбики и верёвочные перила
    for (const [px, py, pz] of [p0, p1]) for (const o of [-0.62, 0.62]) {
      parts.push(part(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 5), POST, { m: T(px - uz * o, py + 0.5, pz + ux * o) }));
    }
    for (const o of [-0.62, 0.62]) for (let k = 0; k < n; k++) {
      const ta = k / n, tb = (k + 1) / n, a = at(ta), b = at(tb), h = 0.85 - 0.25 * Math.sin(Math.PI * (ta + tb) / 2);
      const mx = (a[0] + b[0]) / 2 - uz * o, my = (a[1] + b[1]) / 2 + h, mz = (a[2] + b[2]) / 2 + ux * o;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      parts.push(part(new THREE.BoxGeometry(len + 0.02, 0.035, 0.035), ROPE, { m: T(mx, my, mz, 1, 1, 1, ry, Math.atan2(b[1] - a[1], Math.hypot(b[0] - a[0], b[2] - a[2]))) }));
      if (k % 2 === 0) parts.push(part(new THREE.BoxGeometry(0.025, h, 0.025), ROPE, { m: T(a[0] - uz * o, a[1] + h / 2, a[2] + ux * o) }));
    }
  }
  if (!parts.length) return 0;
  const mesh = new THREE.Mesh(merge(parts), propMaterial());
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  buildBridges.list = list;
  return made;
}
