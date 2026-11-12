import { heightAt } from './terrain.js';

// Твёрдые объекты поверх ландшафта: столбы, плиты, арки.
// На них можно стоять и запрыгивать, под арками — проходить.
const CELL = 6;
const grid = new Map();
export let hitSolid = false; // последняя точка опирается на объект, а не на землю
export let ceiling = 1e9;    // низ ближайшего объекта над головой

function insert(s, rad) {
  for (let cx = Math.floor((s.x - rad) / CELL); cx <= Math.floor((s.x + rad) / CELL); cx++)
    for (let cz = Math.floor((s.z - rad) / CELL); cz <= Math.floor((s.z + rad) / CELL); cz++) {
      const k = cx + ',' + cz;
      (grid.get(k) || grid.set(k, []).get(k)).push(s);
    }
}
export function addCyl(x, z, r, top, bottom = -1e9) {
  insert({ x, z, r, top, bottom, box: false }, r);
}
// Верх произвольной модели (валун, островок): треугольники в мире растеризуются
// в маленькую карту высот, поэтому опора совпадает с картинкой по построению.
// tris — плоский массив x,y,z по три вершины на треугольник.
// soft — мелочь, которую камера не считает преградой (перелетает, а не упирается);
// hang — модель висит (камень, торчащий из стены): под ней можно пройти
export function addMeshTop(tris, cell = 0.25, { soft = false, hang = false } = {}) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9;
  for (let i = 0; i < tris.length; i += 3) {
    x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]);
    z0 = Math.min(z0, tris[i + 2]); z1 = Math.max(z1, tris[i + 2]);
    y0 = Math.min(y0, tris[i + 1]);
  }
  const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const f = new Float32Array(nx * nz).fill(-1e9);
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-7) continue; // ребром к нам — это бок, не верх
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * cell;
        const u = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det;
        const v = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det;
        if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
        const y = ay + (by - ay) * u + (cy - ay) * v;
        const k = j * nx + i;
        if (y > f[k]) f[k] = y;
      }
    }
  }
  const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
  const s = { x: cxm, z: czm, field: f, x0, z0, nx, nz, cell, top: -1e9, bottom: hang ? y0 : -1e9, soft, off: false };
  insert(s, Math.hypot(x1 - x0, z1 - z0) / 2 + cell);
  return s; // off = true — объекта сейчас нет (разбитый валун)
}
function fieldAt(s, x, z) {
  const fx = (x - s.x0) / s.cell, fz = (z - s.z0) / s.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= s.nx - 1 || j >= s.nz - 1) return -1e9;
  const f = s.field, k = j * s.nx + i;
  const a = f[k], b = f[k + 1], c = f[k + s.nx], d = f[k + s.nx + 1];
  // на самом краю (часть углов вне модели) берём ближайшую опору — не шире одной клетки
  if (a < -1e8 || b < -1e8 || c < -1e8 || d < -1e8) return Math.max(a, b, c, d);
  const tx = fx - i, tz = fz - j;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export function addBox(x, z, hx, hz, rot, top, bottom = -1e9) {
  insert({ x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot), top, bottom, box: true }, Math.hypot(hx, hz));
}

// Высота опоры под точкой для героя, чьи ноги на высоте y
export function groundAt(x, z, y, forCamera = false) {
  let h = heightAt(x, z);
  hitSolid = false; ceiling = 1e9;
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return h;
  for (const s of list) {
    if (s.off || (forCamera && s.soft)) continue;
    const dx = x - s.x, dz = z - s.z;
    let top = s.top;
    if (s.field) {
      top = fieldAt(s, x, z);
      if (top < -1e8) continue;
    } else if (s.box) {
      if (Math.abs(dx * s.c - dz * s.s) > s.hx || Math.abs(dx * s.s + dz * s.c) > s.hz) continue;
    } else if (dx * dx + dz * dz > s.r * s.r) continue;
    if (y + 1.3 < s.bottom) { if (s.bottom < ceiling) ceiling = s.bottom; continue; } // проходим под ним
    // на уровне тела висящая плита — стена: отдаём её верх, и шаг/прыжок внутрь не пройдёт,
    // пока ноги не окажутся почти у верха (см. Player.tryMove)
    if (top > h) { h = top; hitSolid = true; }
  }
  return h;
}
