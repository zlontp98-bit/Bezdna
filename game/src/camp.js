import * as THREE from '../vendor/three.min.js';
import { heightAt } from './terrain.js';
import { part, merge, T, propMaterial } from './flora.js';

// Лагерь исследователя у места старта: палатка, костёр, указатель, ящики.
// Всё слито в одну модель — один вызов отрисовки.
export function buildCamp(scene, spawn) {
  const parts = [], colliders = [], blobs = [];
  const wood = 0x8a5a3a, woodD = 0x6b432b, canvas = 0xe8d9b8, canvasD = 0xc9b48c, stone = 0x8f8c88;
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (a, b, h, n = 7) => new THREE.CylinderGeometry(a, b, h, n);
  // поставить часть на землю в точке (dx, dz) от центра лагеря
  const cx = spawn.x + 5.5, cz = spawn.z - 5;
  const put = (geo, color, dx, dz, dy, opt = {}, sx = 1, sy = sx, sz = sx, ry = 0, rz = 0) => {
    const x = cx + dx, z = cz + dz;
    parts.push(part(geo, color, { ...opt, m: T(dx, heightAt(x, z) + dy, dz, sx, sy, sz, ry, rz) }));
  };

  const tentCol = { x: cx + 3.2, z: cz + 1.5, r: 1.5 };
  const before = parts.length;
  // палатка: двускатная, с тёмным входом
  {
    const s = new THREE.Shape();
    s.moveTo(-1.5, 0); s.lineTo(1.5, 0); s.lineTo(0, 1.9); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: false }).translate(0, 0, -1.5);
    put(g, canvas, 3.2, 1.5, -0.05, {}, 1, 1, 1, -2.2);
    const door = new THREE.Shape();
    door.moveTo(-0.6, 0); door.lineTo(0.6, 0); door.lineTo(0, 1.25); door.closePath();
    const a = -2.2, fx = Math.sin(a) * 1.52, fz = Math.cos(a) * 1.52;
    put(new THREE.ShapeGeometry(door), 0x3b3340, 3.2 + fx, 1.5 + fz, -0.02, {}, 1, 1, 1, a);
    put(cyl(0.05, 0.05, 2.2, 5), woodD, 3.2 + fx * 1.02, 1.5 + fz * 1.02, 1.05);
    put(box(3.2, 0.1, 0.35), canvasD, 3.2, 1.5, 1.86, {}, 1, 1, 1, a + Math.PI / 2);
    colliders.push(tentCol);
    blobs.push({ x: cx + 3.2, z: cz + 1.5, r: 3.2, h: 1.2 });
  }
  // палатка — отдельной моделью: когда построят дом, она исчезнет
  const tentParts = parts.splice(before);
  // костёр: камни кругом, поленья, пламя
  {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      put(new THREE.IcosahedronGeometry(0.2, 0), stone, Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.06, {}, 1, 0.75, 1.15, a);
    }
    for (let i = 0; i < 3; i++) put(cyl(0.07, 0.08, 0.95, 6), woodD, 0, 0, 0.2, {}, 1, 1, 1, i * 2.1, 1.15);
    const fl = { glow: 1, sway: 9 };
    put(new THREE.ConeGeometry(0.3, 0.9, 6), 0xff8a2a, 0, 0, 0.5, fl);
    put(new THREE.ConeGeometry(0.19, 0.62, 6), 0xffd257, 0.03, 0.02, 0.42, fl);
    put(new THREE.ConeGeometry(0.1, 0.36, 5), 0xfff3c4, -0.02, 0.01, 0.36, fl);
    colliders.push({ x: cx, z: cz, r: 0.6 });
  }
  // бревно-скамья
  put(cyl(0.24, 0.27, 2.3, 8), wood, -1.5, 1.3, 0.2, {}, 1, 1, 1, 0.7, Math.PI / 2);
  colliders.push({ x: cx - 1.5, z: cz + 1.3, r: 0.75 });
  // ящики и бочка
  put(box(0.8, 0.8, 0.8), wood, 1.9, -2.3, 0.38, {}, 1, 1, 1, 0.3);
  put(box(0.6, 0.6, 0.6), 0xa06c44, 2.1, -2.2, 1.06, {}, 1, 1, 1, 0.9);
  put(box(0.84, 0.08, 0.84), woodD, 1.9, -2.3, 0.6, {}, 1, 1, 1, 0.3);
  put(cyl(0.34, 0.3, 0.9, 9), 0x7b5a3c, 3.0, -2.6, 0.43);
  put(cyl(0.355, 0.355, 0.07, 9), 0x4a4a55, 3.0, -2.6, 0.65);
  colliders.push({ x: cx + 2.0, z: cz - 2.3, r: 0.7 }, { x: cx + 3.0, z: cz - 2.6, r: 0.4 });
  blobs.push({ x: cx + 2.3, z: cz - 2.4, r: 1.6, h: 0.5 });
  // указатель в сторону провала
  put(cyl(0.06, 0.08, 2.1, 6), woodD, -4.2, -1.2, 1.0);
  put(box(1.15, 0.3, 0.06), wood, -4.55, -1.2, 1.75, {}, 1, 1, 1, 0.25, 0.06);
  put(box(0.9, 0.26, 0.06), 0xa06c44, -3.95, -1.2, 1.38, {}, 1, 1, 1, 0.25 + Math.PI, -0.05);
  colliders.push({ x: cx - 4.2, z: cz - 1.2, r: 0.15 });
  // фонарь на столбике
  put(cyl(0.05, 0.07, 1.7, 6), woodD, -2.6, 3.4, 0.85);
  put(box(0.5, 0.06, 0.06), woodD, -2.4, 3.4, 1.66);
  put(box(0.2, 0.28, 0.2), 0xffe9a0, -2.18, 3.4, 1.44, { glow: 1 });
  put(box(0.24, 0.05, 0.24), 0x4a4a55, -2.18, 3.4, 1.6);
  colliders.push({ x: cx - 2.6, z: cz + 3.4, r: 0.15 });

  const mesh = new THREE.Mesh(merge(parts), propMaterial());
  // модель стоит в центре лагеря, чтобы тень бралась отсюда, а не из центра мира
  mesh.position.set(cx, 0, cz);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  const tent = new THREE.Mesh(merge(tentParts), propMaterial());
  tent.position.set(cx, 0, cz);
  tent.updateMatrix();
  tent.matrixAutoUpdate = false;
  tent.frustumCulled = false;
  scene.add(tent);
  // место под дом: там же, где палатка, входом к костру (угол a — как у палатки)
  return { colliders, blobs, tent, tentCol, site: { x: cx + 3.2, z: cz + 1.5, a: -2.2 }, fire: { x: cx, z: cz } };
}
