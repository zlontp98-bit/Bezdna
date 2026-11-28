import * as THREE from '../vendor/three.min.js';

// Инструменты в руках — те же рисунки, что в инвентаре (assets/items/<id>.png), но вырезанные из пикселей в «кубики»:
// так кирка в руке выглядит как значок в меню и сидит в блочном мире с настоящим светом, а не плоской картинкой.
// Геометрия получается готовой к использованию: рукоять вдоль +y (головка вверху), хват — в начале координат,
// лицевая сторона рисунка смотрит в +z.

const N = 32;              // сколько кубиков по стороне значка
const LAYERS = 3;          // толщина инструмента в кубиках
// Измерено по самим значкам: поворот, чтобы рукоять встала вертикально; место хвата (доли значка);
// длина значка вдоль рукояти (доли ширины значка); длина инструмента в метрах
const META = {
  pickaxe: { theta: -0.0278, gx: 0.5127, gy: 0.6878, ext: 0.9074, size: 0.62 },
  axe:     { theta: 0.3912, gx: 0.2663, gy: 0.6878, ext: 0.971, size: 0.55 },
  spear:   { theta: 0.707, gx: 0.2514, gy: 0.7804, ext: 1.1872, size: 1.25 },
};
export const TOOL_IDS = Object.keys(META);

const cache = {};
function pixels(id) {
  return cache[id] || (cache[id] = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = N;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, N, N);
      resolve(g.getImageData(0, 0, N, N).data);
    };
    im.onerror = () => resolve(null);
    im.src = `./assets/items/${id}.png`;
  }));
}

// shade(nx, ny, nz) — необязательно: запечь «свет» в цвет граней (для сцены рук, где ламп нет)
function build(id, data, shade) {
  const M = META[id], vs = M.size / (M.ext * N), T = LAYERS;
  const solid = (i, j) => i >= 0 && j >= 0 && i < N && j < N && data[(j * N + i) * 4 + 3] > 120;
  const pos = [], nor = [], col = [];
  const quad = (p, n, c) => { // p — четыре угла по кругу
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...p[k]); nor.push(...n); col.push(c.r, c.g, c.b); }
  };
  const X = (i) => (i - M.gx * N) * vs, Y = (j) => (M.gy * N - j) * vs, Z = (k) => (k - T / 2) * vs;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (!solid(i, j)) continue;
    const o = (j * N + i) * 4;
    const base = new THREE.Color(`rgb(${data[o]},${data[o + 1]},${data[o + 2]})`);
    const paint = (n) => { if (!shade) return base; const s = shade(n[0], n[1], n[2]); return base.clone().multiplyScalar(s); };
    const x0 = X(i), x1 = X(i + 1), y0 = Y(j + 1), y1 = Y(j), z0 = Z(0), z1 = Z(T);
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], paint([0, 0, 1]));
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], paint([0, 0, -1]));
    if (!solid(i - 1, j)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], paint([-1, 0, 0]));
    if (!solid(i + 1, j)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], paint([1, 0, 0]));
    if (!solid(i, j - 1)) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], paint([0, 1, 0]));
    if (!solid(i, j + 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], paint([0, -1, 0]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aFx', new THREE.BufferAttribute(new Float32Array(pos.length), 3)); // нужен шейдеру предметов: без свечения и покачивания
  g.rotateZ(M.theta); // рукоять — вертикально, головка вверх
  return g;
}

// Меш инструмента: пока значок грузится, он пустой, потом наполняется сам
export function toolMesh(id, material, shade) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), material);
  m.frustumCulled = false;
  pixels(id).then((d) => { if (d) { m.geometry.dispose(); m.geometry = build(id, d, shade); } });
  return m;
}
