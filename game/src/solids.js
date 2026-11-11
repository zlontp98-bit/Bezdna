import { heightAt, streamAt, POOLS } from './terrain.js';

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
export function addBox(x, z, hx, hz, rot, top, bottom = -1e9) {
  insert({ x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot), top, bottom, box: true }, Math.hypot(hx, hz));
}

// Высота опоры под точкой для героя, чьи ноги на высоте y
export function groundAt(x, z, y) {
  let h = heightAt(x, z);
  // вода мелкая: в ручье герой идёт по щиколотку, в чаше под водопадом — по колено,
  // а не уходит под поверхность по пояс
  const st = streamAt(x, z);
  if (st > 0) h += st * 0.34;
  for (const p of POOLS) {
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < 27 && h < p.level - 0.3) h = p.level - 0.3;
  }
  hitSolid = false; ceiling = 1e9;
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return h;
  for (const s of list) {
    const dx = x - s.x, dz = z - s.z;
    if (s.box) {
      if (Math.abs(dx * s.c - dz * s.s) > s.hx || Math.abs(dx * s.s + dz * s.c) > s.hz) continue;
    } else if (dx * dx + dz * dz > s.r * s.r) continue;
    if (y + 1.3 < s.bottom) { if (s.bottom < ceiling) ceiling = s.bottom; continue; } // проходим под ним
    if (s.top > h) { h = s.top; hitSolid = true; }
  }
  return h;
}
