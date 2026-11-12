import * as THREE from '../vendor/three.min.js';
import { fbm } from './noise.js';
import { rockMat } from './terrain.js';
import { addCyl } from './solids.js';

// Скальные островки, торчащие из шахты. Плоская вершина с травой,
// отвесные рёбристые бока, книзу сужаются и тонут в тумане.
// th — угол, r — расстояние от центра, w — радиус, top — высота вершины
export const STACKS = [
  { th: 0.50, r: 37, w: 6.5, top: -13.0, trees: 2 }, // к нему ведёт разрушенный мост
  { th: 1.55, r: 31, w: 4.0, top: -23, trees: 1 },
  { th: 2.55, r: 41, w: 3.0, top: -33, trees: 1 },
  { th: 3.45, r: 23, w: 7.5, top: -27, trees: 3 },
  { th: 4.35, r: 37, w: 3.4, top: -17, trees: 1 },
  { th: 5.30, r: 29, w: 5.0, top: -39, trees: 2 },
  { th: 6.05, r: 17, w: 3.2, top: -47, trees: 1 },
  { th: 2.10, r: 9, w: 9.5, top: -58, trees: 2 },
];
for (const s of STACKS) { s.x = Math.cos(s.th) * s.r; s.z = Math.sin(s.th) * s.r; }

function stackGeo(s, pos, idx) {
  const SEG = 30, base = pos.length / 3;
  // кольца сверху вниз: вершина подробно, ниже — реже
  const ys = [0.35, 0.05, -0.5, -1.4];
  for (let d = 3; d < 150; d *= 1.35) ys.push(-d);
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
      const rr = s.w * k * (1 + big * 0.35 + rib * (dy > -0.6 ? 0.08 : 0.16));
      const yy = y + (dy >= 0 ? fbm(cx * 3 + s.r, cz * 3, 2) * 0.25 : 0);
      P.push(s.x + ox + cx * rr, yy, s.z + oz + cz * rr);
    }
  }
  for (let i = 0; i < P.length; i++) pos.push(P[i]);
  // треугольники: веер на вершине и кольца вниз
  for (let i = 0; i < SEG; i++) idx.push(base, base + 1 + ((i + 1) % SEG), base + 1 + i);
  for (let j = 0; j < ys.length - 1; j++) {
    const a0 = base + 1 + j * SEG, b0 = a0 + SEG;
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      idx.push(a0 + i, a0 + i1, b0 + i, a0 + i1, b0 + i1, b0 + i);
    }
  }
}

export function buildStacks(scene) {
  const pos = [], idx = [];
  for (const s of STACKS) {
    stackGeo(s, pos, idx);
    addCyl(s.x, s.z, s.w * 0.75, s.top + 0.25);
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
