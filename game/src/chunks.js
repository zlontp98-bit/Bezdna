import * as THREE from '../vendor/three.min.js';

// Меш куска скалы с мировыми координатами в вершинах (шейдер скалы берёт position как мировую точку).
// Объект ставим в центр куска: по нему three.js сортирует непрозрачное «от ближнего к дальнему»
// (дальние пиксели отбрасываются тестом глубины — меньше перерисовки дорогим шейдером), а сферу
// для отсечения по камере задаём вокруг этого центра — куски вне кадра не рисуются вовсе.
export let backTris = 0, allTris = 0;
// inside(x, y, z) — точка внутри камня. Изнанку рисуем только у тех треугольников, за которыми
// пусто (складка, трещина): их обратная сторона видна снаружи. Остальная изнанка спрятана в камне.
function backGeo(geo, inside) {
  const P = geo.attributes.position.array, N = geo.attributes.normal.array, keep = [];
  const n = P.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
    const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
    let fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    const fl = Math.hypot(fx, fy, fz); if (fl < 1e-9) continue;
    fx /= fl; fy /= fl; fz /= fl;
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cy = (P[o + 1] + P[o + 4] + P[o + 7]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    allTris++;
    if (inside(cx - fx * 0.3, cy - fy * 0.3, cz - fz * 0.3) || inside(cx - fx * 0.8, cy - fy * 0.8, cz - fz * 0.8)) continue;
    keep.push(t);
  }
  if (!keep.length) return null;
  backTris += keep.length;
  const p = new Float32Array(keep.length * 9), nn = new Float32Array(keep.length * 9);
  keep.forEach((t, i) => { p.set(P.subarray(t * 9, t * 9 + 9), i * 9); nn.set(N.subarray(t * 9, t * 9 + 9), i * 9); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
  if (geo.attributes.aB) g.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(keep.length * 6), 2));
  g.boundingSphere = geo.boundingSphere;
  return g;
}
export function chunkMesh(geo, material, inside = null) {
  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center.clone(), r = geo.boundingSphere.radius;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), r);
  const m = new THREE.Mesh(geo, material);
  m.position.copy(c);
  m.updateMatrix(); m.updateMatrixWorld(true);
  m.matrixAutoUpdate = false;
  const back = inside && !geo.index && material.userData && material.userData.back;
  const bg = back && backGeo(geo, inside);
  if (bg) {
    const b = new THREE.Mesh(bg, back);
    b.renderOrder = 1; b.matrixAutoUpdate = false;
    m.add(b); b.updateMatrixWorld(true);
  }
  return m;
}
