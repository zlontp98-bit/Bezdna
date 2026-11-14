import * as THREE from '../vendor/three.min.js';
import { fbm } from './noise.js';
import { rockMat, heightAt } from './terrain.js';
import { addMeshTop, groundAt } from './solids.js';
import { mulberry32, SEED } from './noise.js';

// Скальные островки, торчащие из шахты. Плоская вершина с травой,
// отвесные рёбристые бока, книзу сужаются и тонут в тумане.
// th — угол, r — расстояние от центра, w — радиус, top — высота вершины
// Посередине — большой остров, вокруг него кольцом шесть малых. Все связаны паркуром:
// цепочки каменных столбов по кольцу между соседями и «спицы» к центральному острову.
export const STACKS = [
  { th: 0.50, r: 37, w: 6.5, top: -13.0, trees: 2 }, // к нему ведёт разрушенный мост
  { th: 1.40, r: 35, w: 4.2, top: -17, trees: 1 },
  { th: 2.75, r: 36, w: 3.8, top: -20, trees: 1 },
  { th: 3.55, r: 33, w: 5.5, top: -24, trees: 2 },
  { th: 4.85, r: 36, w: 3.6, top: -19, trees: 1 },
  { th: 5.55, r: 33, w: 4.8, top: -18, trees: 2 },
  { th: 0, r: 0, w: 11, top: -22, trees: 6, big: true }, // большой остров в центре шахты
];
// какие острова связаны цепочками столбов (номера в STACKS)
const LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], // по кольцу
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],          // к центру (с острова у моста — через соседей)
];
// Входы с кольца (−13 м) прямо на острова — с других сторон, не только по мосту.
// th — откуда с кольца начинается цепочка, to — на какой остров. Угол 4.40 выбран так,
// чтобы цепочка не перегородила карниз-спуск по стене (он начинается с 4.5 рад)
const ENTRIES = [{ th: 2.75, to: 2 }, { th: 4.40, to: 4 }];
// столбы для прыжков: { x, z, w, top, th, r }
export const PILLARS = [];
// цепочки целиком: край острова, столбы, край другого острова (для проверок и подсказок)
export const CHAINS = [];
for (const s of STACKS) { s.x = Math.cos(s.th) * s.r; s.z = Math.sin(s.th) * s.r; }

function stackGeo(s, pos, idx, SEG = 30) {
  const base = pos.length / 3;
  // кольца сверху вниз: вершина подробно, ниже — реже
  const ys = [0.35, 0.05, -0.5, -1.4];
  // Длина тела: столбы-ступени и малые острова — висящие обломки (70 и 130 м), большой остров тянется до дна.
  // Раньше все доходили до дна, а теперь там идёт спуск: колонны мешали бы плитам.
  const maxD = s.pillar ? 20 : s.big ? 330 : 130;
  for (let d = 3; d < maxD; d *= 1.35) ys.push(-d);
  const P = [];
  P.push(s.x, s.top + 0.45, s.z); // центр вершины
  for (let j = 0; j < ys.length; j++) {
    const dy = ys[j], y = s.top + dy;
    // шапка чуть нависает, ниже ствол сужается и слегка изгибается
    let k;
    if (dy > 0) k = 0.86; else if (dy > -0.6) k = 1.0;
    else k = 0.96 - 0.22 * Math.min(1, -dy / 14) - 0.12 * Math.min(1, -dy / 90);
    const lean = Math.min(1, -Math.min(dy, 0) / 60);
    const ox = Math.cos(s.th * 3.1) * s.w * 0.5 * lean, oz = Math.sin(s.th * 2.3) * s.w * 0.5 * lean;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      // крупные выступы-контрфорсы + мелкие рёбра; вершина неровная
      const big = fbm(cx * 0.9 + s.th * 5, cz * 0.9 + s.r, 2);
      const rib = fbm(cx * 3.0 + s.th * 5, cz * 3.0 + y * 0.025, 2);
      // у столбов выступы скромнее: край вершины там, где его ждёшь при прыжке
      const rr = s.w * k * (1 + big * (s.pillar ? 0.12 : 0.35) + rib * (dy > -0.6 ? 0.08 : 0.16));
      const yy = y + (dy >= 0 ? fbm(cx * 3 + s.r, cz * 3, 2) * 0.25 : 0);
      P.push(s.x + ox + cx * rr, yy, s.z + oz + cz * rr);
    }
  }
  for (let i = 0; i < P.length; i++) pos.push(P[i]);
  // треугольники: веер на вершине и кольца вниз
  for (let i = 0; i < SEG; i++) idx.push(base, base + 1 + ((i + 1) % SEG), base + 1 + i);
  const nRings = ys.length;
  for (let j = 0; j < ys.length - 1; j++) {
    const a0 = base + 1 + j * SEG, b0 = a0 + SEG;
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      idx.push(a0 + i, a0 + i1, b0 + i, a0 + i1, b0 + i1, b0 + i);
    }
  }
  // дно: острый конус под последним кольцом, чтобы обломок не был открытой трубой, если смотреть снизу
  if (maxD < 330) {
    const last = base + 1 + (nRings - 1) * SEG, apex = pos.length / 3;
    let ax = 0, az = 0;
    for (let i = 0; i < SEG; i++) { ax += pos[(last + i) * 3]; az += pos[(last + i) * 3 + 2]; }
    pos.push(ax / SEG, s.top + ys[nRings - 1] - 9, az / SEG);
    // тот же порядок обхода, что у боковых стенок, но наружу — вниз
    for (let i = 0; i < SEG; i++) idx.push(last + ((i + 1) % SEG), last + i, apex);
  }
}

// Прыжок героя: вверх до ~1.6 м, в длину 3.5 м шагом и 6 м бегом. Цепочку строим с запасом:
// зазор между краями опор 1.3–2 м, по высоте не больше 0.9 м за прыжок — в обе стороны.
const RISE = 0.9;

// край острова в направлении (dx,dz): дальняя точка, где под ногами ещё его вершина
function edgeOf(s, dx, dz) {
  if (s.ring) return 0; // точка на краю кольца — уже край
  let e = 0;
  for (let d = 0; d < s.w * 2; d += 0.1) {
    if (groundAt(s.x + dx * d, s.z + dz * d, s.top + 5) > s.top - 0.35) e = d; else if (d > s.w * 0.6) break;
  }
  return Math.max(0, e - 0.25);
}

function planChain(A, B, rnd) {
  let dx = B.x - A.x, dz = B.z - A.z;
  const l = Math.hypot(dx, dz); dx /= l; dz /= l;
  const eA = edgeOf(A, dx, dz), eB = edgeOf(B, -dx, -dz);
  const ax = A.x + dx * eA, az = A.z + dz * eA, bx = B.x - dx * eB, bz = B.z - dz * eB;
  const D = Math.hypot(bx - ax, bz - az), dy = B.top - A.top;
  // ширины столбов заранее: каждый четвёртый — широкий, на нём можно отдышаться и прицелиться
  const W = [];
  for (let k = 1; k < 40; k++) W.push(k % 4 === 0 ? 1.45 + rnd() * 0.25 : 0.85 + rnd() * 0.25);
  // зазор между краями — ровный, 1.3–2.0 м: это всегда настоящий прыжок, а не шаг
  const gapFor = (n) => { let s = 0; for (let k = 0; k < n - 1; k++) s += W[k] * 2.1; return (D - s) / n; };
  let n = Math.max(2, Math.ceil(Math.abs(dy) / RISE));
  while (gapFor(n) > 2.0) n++;
  if (gapFor(n) < 1.3) for (let k = 0; k < n - 1; k++) W[k] = Math.min(W[k], 0.9); // крутой подъём — столбы тоньше
  const gap = gapFor(n);
  // цепочка чуть выгнута дугой — так она живее, чем по линейке
  const bow = (rnd() - 0.5) * Math.min(5, D * 0.18), px = -dz, pz = dx;
  const chain = [{ x: ax, z: az, top: A.top, w: 0 }];
  let cur = 0;
  for (let k = 1; k < n; k++) {
    const w = W[k - 1], c = cur + gap + w * 1.05;
    cur = c + w * 1.05;
    const t = c / D, side = Math.sin(t * Math.PI) * bow;
    const x = ax + dx * c + px * side, z = az + dz * c + pz * side;
    const p = { pillar: true, x, z, w, top: A.top + dy * (k / n) + (rnd() - 0.5) * 0.12, th: Math.atan2(z, x) + k, r: Math.hypot(x, z) };
    PILLARS.push(p); chain.push(p);
  }
  chain.push({ x: bx, z: bz, top: B.top, w: 0 });
  CHAINS.push(chain);
}

export function buildStacks(scene) {
  const pos = [], idx = [];
  const solid = (i0, SEG, under) => {
    // верх (веер и три верхних кольца) — в физику, точно по треугольникам
    const top = idx.slice(i0, i0 + SEG * 3 + SEG * 6 * 3), tris = new Float32Array(top.length * 3);
    top.forEach((v, k) => { tris[k * 3] = pos[v * 3]; tris[k * 3 + 1] = pos[v * 3 + 1]; tris[k * 3 + 2] = pos[v * 3 + 2]; });
    // у тела настоящий низ: ниже него (на спуске, у озера) верхушка не считается землёй
    addMeshTop(tris, 0.35, under === undefined ? {} : { under });
  };
  for (const s of STACKS) {
    const i0 = idx.length;
    stackGeo(s, pos, idx, s.big ? 48 : 30);
    solid(i0, s.big ? 48 : 30, s.big ? s.top - 340 : s.top - 130 - 9);
  }
  // столбы ставим, когда острова уже твёрдые: края меряем по настоящей вершине
  const rnd = mulberry32(SEED + 404);
  for (const [a, b] of LINKS) planChain(STACKS[a], STACKS[b], rnd);
  // входы с кольца: идём от кольца к острову, пока земля не оборвётся
  for (const e of ENTRIES) {
    const B = STACKS[e.to], cx = Math.cos(e.th), cz = Math.sin(e.th), ring = heightAt(cx * 76, cz * 76);
    let r = 76;
    while (r > 60 && heightAt(cx * r, cz * r) > ring - 0.5) r -= 0.1;
    r += 0.6;
    planChain({ ring: true, x: cx * r, z: cz * r, top: heightAt(cx * r, cz * r), w: 0 }, B, rnd);
  }
  for (const p of PILLARS) {
    const i0 = idx.length;
    stackGeo(p, pos, idx, 11);
    solid(i0, 11, p.top - 20 - 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, rockMat);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
}
