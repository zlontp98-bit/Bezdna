import * as THREE from '../vendor/three.min.js';
import { W, heightAt, POOLS } from './terrain.js';
import { part, merge, T, propMaterial } from './flora.js';
import { addCyl, addBox } from './solids.js';
import { mulberry32, SEED } from './noise.js';

// Руины и паркур: арка над тропой, стоячие камни, столбы-ступени, мостки.
// Каждая группа — одна модель (один вызов отрисовки) + твёрдые объекты для физики.
const STONE = [0xa39c90, 0x968f84, 0xaea79a, 0x8c867c];
const MOSS = 0x64a544, MOSS2 = 0x7bb850, WOOD = 0x8a5a3a, WOODD = 0x6b432b;

class Group {
  constructor(cx, cz) { this.cx = cx; this.cz = cz; this.parts = []; this.i = 0; }
  // блок: (x, z) — центр в мире, baseY — низ; на нём можно стоять
  block(x, z, w, h, d, ry, baseY, { color, solid = true, hang = false } = {}) {
    const c = color ?? STONE[this.i++ % STONE.length];
    this.parts.push(part(new THREE.BoxGeometry(w, h, d), c, { m: T(x - this.cx, baseY + h / 2, z - this.cz, 1, 1, 1, ry) }));
    if (solid) addBox(x, z, w / 2, d / 2, ry, baseY + h, hang ? baseY : -1e9);
  }
  // столб с моховой шапкой
  pillar(x, z, r, top, baseY, sides = 7) {
    const h = top - baseY, c = STONE[this.i++ % STONE.length];
    this.parts.push(
      part(new THREE.CylinderGeometry(r, r * 1.12, h, sides, 1), c, { m: T(x - this.cx, baseY + h / 2, z - this.cz, 1, 1, 1, this.i) }),
      part(new THREE.CylinderGeometry(r * 1.06, r * 1.1, 0.16, sides, 1), this.i % 2 ? MOSS : MOSS2, { m: T(x - this.cx, top - 0.06, z - this.cz, 1, 1, 1, this.i) }),
    );
    addCyl(x, z, r * 0.98, top + 0.02);
  }
  add(geo, color, x, y, z, opt = {}, s = [1, 1, 1], ry = 0, rz = 0) {
    this.parts.push(part(geo, color, { ...opt, m: T(x - this.cx, y, z - this.cz, s[0], s[1], s[2], ry, rz) }));
  }
  done(scene) {
    const mesh = new THREE.Mesh(merge(this.parts), propMaterial());
    mesh.position.set(this.cx, 0, this.cz);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
}

export function buildRuins(scene) {
  const rnd = mulberry32(SEED + 55);
  const blobs = [];
  const P = (r, th) => [Math.cos(th) * r, Math.sin(th) * r];

  // ---- арка над тропой от лагеря к спуску + ступени, чтобы залезть наверх ----
  {
    const ax = 101.5, az = 2.4, g = new Group(ax, az), ry = 0.14;
    const by = heightAt(ax, az) - 0.3;
    const side = (sz) => {
      const z = az + sz * 2.35, x = ax + sz * 0.33;
      g.block(x, z, 1.5, 1.35, 1.35, ry + 0.05, by);
      g.block(x + 0.05, z, 1.38, 1.3, 1.25, ry - 0.06, by + 1.35);
      g.block(x, z + sz * 0.03, 1.46, 1.3, 1.3, ry + 0.03, by + 2.65);
    };
    side(-1); side(1);
    g.block(ax, az, 1.5, 0.95, 6.5, ry, by + 3.95, { hang: true });        // перемычка
    g.block(ax, az, 1.62, 0.16, 6.62, ry, by + 4.9, { color: MOSS, hang: true }); // мох сверху
    // свисающий плющ
    for (let i = 0; i < 7; i++) {
      const o = -2.6 + i * 0.85 + rnd() * 0.3, len = 0.5 + rnd() * 1.1;
      g.add(new THREE.BoxGeometry(0.07, len, 0.3 + rnd() * 0.3), i % 2 ? MOSS : MOSS2, ax + (i % 2 ? 0.78 : -0.78) + o * 0.14, by + 4.0 - len / 2 + 0.9, az + o, {}, [1, 1, 1], ry);
    }
    // ступени сбоку: 1.2 → 2.4 → на столб → на перемычку
    g.block(ax + 0.5, az + 5.3, 1.5, 1.25, 1.5, 0.5, by);
    g.block(ax + 0.45, az + 3.95, 1.4, 2.5, 1.3, 0.2, by);
    blobs.push({ x: ax, z: az, r: 4.6, h: 3.5 });
    g.done(scene);
  }

  // ---- стоячие камни вдоль тропы и по лугу ----
  {
    const g = new Group(104, -6);
    const spots = [[108.5, 7.2], [97.5, -3.2], [95.2, 6.0], [112, -9], [103, -12], [118, 4], [90.5, -22], [86, 30]];
    for (const [x, z] of spots) {
      const h = 2.2 + rnd() * 1.6, r = 0.45 + rnd() * 0.25, y = heightAt(x, z) - 0.3;
      g.add(new THREE.CylinderGeometry(r * 0.55, r, h, 5, 1), STONE[g.i++ % 4], x, y + h / 2, z, {}, [1, 1, 0.7], rnd() * 3, (rnd() - 0.5) * 0.25);
      g.add(new THREE.CylinderGeometry(r * 0.6, r * 0.62, 0.14, 5, 1), MOSS, x, y + h * 0.99, z, {}, [1, 1, 0.7]);
      addCyl(x, z, r * 0.8, y + h);
      blobs.push({ x, z, r: 1.5, h: 1.2 });
    }
    g.done(scene);
  }

  // ---- лестница великана: столбы от кольца наверх (подъём по 1.3 м, прыжками) ----
  {
    const [cx, cz] = P(84, 1.16), g = new Group(cx, cz);
    for (let i = 0; i < 10; i++) {
      const [x, z] = P(78 + i * 1.17, 1.0 + i * 0.036);
      const top = -11.7 + i * 1.3;
      g.pillar(x, z, 0.95 + (i % 3) * 0.08, top, heightAt(x, z) - 0.5);
    }
    g.done(scene);
    blobs.push({ x: cx, z: cz, r: 5, h: 2 });
  }

  // ---- тропа над туманом: столбы дугой от кольца и обратно, на середине — кристалл ----
  {
    const [cx, cz] = P(65, 3.19), g = new Group(cx, cz);
    for (let i = 0; i < 10; i++) {
      const k = i / 9, [x, z] = P(69.2 - Math.sin(k * Math.PI) * 5, 3.0 + i * 0.039);
      const mid = i === 5, r = mid ? 1.7 : 0.9 + (i % 2) * 0.15;
      const top = -12.4 + Math.sin(i * 1.9) * 0.45;
      g.pillar(x, z, r, top, -52, mid ? 9 : 7);
      if (mid) {
        const o = new THREE.OctahedronGeometry(1, 0);
        g.add(o, 0xb6f7ff, x, top + 1.0, z, { glow: 0.9 }, [0.42, 1.25, 0.42]);
        g.add(o, 0x9be9ff, x + 0.55, top + 0.5, z + 0.2, { glow: 0.9 }, [0.26, 0.7, 0.26], 0, -0.4);
        g.add(o, 0xd2c1ff, x - 0.45, top + 0.42, z - 0.35, { glow: 0.9 }, [0.22, 0.6, 0.22], 0, 0.45);
        addCyl(x, z, 0.45, top + 2.2);
      }
    }
    g.done(scene);
  }

  // ---- у каждого ручья: камни-переступки наверху и дощатый мостик на кольце ----
  for (const th of W.STREAMS) {
    const tx = -Math.sin(th), tz = Math.cos(th);
    const [fx, fz] = P(92.6, th), g = new Group(fx, fz);
    for (const o of [-2.0, -0.65, 0.7, 2.05]) {
      const x = fx + tx * o, z = fz + tz * o, top = heightAt(x, z) + 0.34;
      g.add(new THREE.CylinderGeometry(0.58, 0.66, 0.5, 7, 1), STONE[g.i++ % 4], x, top - 0.25, z, {}, [1, 1, 1], o);
      addCyl(x, z, 0.6, top);
    }
    // мостик
    // мостик — между чашей и обрывом, если там хватает места
    const pool = POOLS[W.STREAMS.indexOf(th)], pr = Math.hypot(pool.x, pool.z);
    let re = pr - 5;
    while (re > 60 && heightAt(Math.cos(th) * re, Math.sin(th) * re) > -17) re -= 0.25;
    const br = re + 1.9;
    if (br > pr - 6.2) { g.done(scene); continue; }
    const [bx, bz] = P(br, th), ang = Math.atan2(tx, tz);
    const bank = Math.max(heightAt(bx + tx * 3.1, bz + tz * 3.1), heightAt(bx - tx * 3.1, bz - tz * 3.1));
    const top = bank + 0.3;
    for (let i = 0; i < 9; i++) {
      const o = -3.2 + i * 0.8;
      g.add(new THREE.BoxGeometry(1.7, 0.1, 0.7), i % 2 ? WOOD : 0x9a6a46, bx + tx * o, top - 0.05, bz + tz * o, {}, [1, 1, 1], ang + (rnd() - 0.5) * 0.08);
    }
    for (const s of [-0.75, 0.75]) {
      g.add(new THREE.CylinderGeometry(0.11, 0.11, 7.2, 6, 1), WOODD, bx - tz * s, top - 0.2, bz + tx * s, {}, [1, 1, 1], ang - Math.PI / 2, Math.PI / 2);
    }
    addBox(bx, bz, 0.85, 3.6, ang, top);
    g.done(scene);
  }
  return blobs;
}
