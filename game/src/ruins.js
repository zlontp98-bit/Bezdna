import * as THREE from '../vendor/three.min.js';
import { W, heightAt, waterAt, POOLS, ROAD } from './terrain.js';
import { STACKS } from './stacks.js';
import { part, merge, T, propMaterial } from './flora.js';
import { addCyl, addBox } from './solids.js';
import { mulberry32, SEED } from './noise.js';

// Руины и паркур: арка над тропой, стоячие камни, столбы-ступени, мостки.
// Каждая группа — одна модель (один вызов отрисовки) + твёрдые объекты для физики.
const STONE = [0x8f877b, 0x837c71, 0x9a9285, 0x7a746b];
const MOSS = 0x4f8a3a, MOSS2 = 0x63994a, WOOD = 0x7a5034, WOODD = 0x5a3b26, WOODG = 0x6b5a48;
const RUST = 0x7c3f22, RUST2 = 0x94532c, IRON = 0x4b4643, ROPE = 0x9c8662;
const SYMBOL = 0x7ff3ff;

class Group {
  constructor(cx, cz) { this.cx = cx; this.cz = cz; this.parts = []; this.i = 0; }
  // блок: (x, z) — центр в мире, baseY — низ; на нём можно стоять
  block(x, z, w, h, d, ry, baseY, { color, solid = true, hang = false, rz = 0, stone = 1 } = {}) {
    const c = color ?? STONE[this.i++ % STONE.length];
    this.parts.push(part(new THREE.BoxGeometry(w, h, d), c, { stone, m: T(x - this.cx, baseY + h / 2, z - this.cz, 1, 1, 1, ry, rz) }));
    if (solid) addBox(x, z, w / 2, d / 2, ry, baseY + h, hang ? baseY : -1e9);
  }
  // столб с моховой шапкой
  pillar(x, z, r, top, baseY, sides = 7) {
    const h = top - baseY, c = STONE[this.i++ % STONE.length];
    this.parts.push(
      part(new THREE.CylinderGeometry(r, r * 1.12, h, sides, 1), c, { stone: 1, m: T(x - this.cx, baseY + h / 2, z - this.cz, 1, 1, 1, this.i) }),
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
    // третья ступень сбоку: с неё уже допрыгнуть до верха перемычки
    g.block(ax - 1.25, az + 4.15, 1.1, 3.65, 1.1, -0.15, by);
    blobs.push({ x: ax, z: az, r: 4.6, h: 3.5 });
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
    for (const o of [-2.6, -1.3, 0, 1.3, 2.6]) {
      const x = fx + tx * o, z = fz + tz * o, gy = heightAt(x, z);
      const top = Math.max(gy + 0.34, waterAt(x, z) + 0.22), h = top - gy + 0.4;
      g.add(new THREE.CylinderGeometry(0.6, 0.72, h, 7, 1), STONE[g.i++ % 4], x, top - h / 2, z, { stone: 1 }, [1, 1, 1], o);
      addCyl(x, z, 0.62, top);
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
    // Старый дощатый мостик: всё одной моделью (один вызов отрисовки).
    // Вдоль — две балки-лаги, поперёк — доски разной длины и тона, по бокам столбики
    // с перилами из жердей, перевязанных верёвкой; под концами — подкосы к берегу.
    const tones = [0x8a5d3c, 0x9a6a46, 0x7a5034, 0xa57850, 0x6e4a31];
    const A = (geo, color, o, sd, y, ry = 0, rz = 0, opt = {}) =>
      g.add(geo, color, bx + tx * o - tz * sd, y, bz + tz * o + tx * sd, opt, [1, 1, 1], ang + ry, rz);
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    // лаги
    for (const sd of [-0.55, 0.55]) A(box(0.16, 0.2, 7.5), WOODD, 0, sd, top - 0.2);
    // настил: 13 досок, у каждой своя длина, тон, лёгкий перекос; пара досок просела
    for (let i = 0; i < 13; i++) {
      const o = -3.36 + i * 0.56, len = 1.62 + rnd() * 0.26, sag = i === 4 || i === 9 ? 0.035 : 0;
      A(box(len, 0.09, 0.5), tones[(i * 3 + (rnd() * 2 | 0)) % tones.length], o, (rnd() - 0.5) * 0.1, top - 0.045 - sag - rnd() * 0.012, (rnd() - 0.5) * 0.07, (rnd() - 0.5) * 0.02 + sag * 0.6);
    }
    // столбики (по три с каждой стороны), перила-жерди между ними и верёвочные обвязки
    const posts = [-3.3, 0, 3.3];
    for (const sd of [-0.92, 0.92]) {
      posts.forEach((o, k) => {
        const lean = (rnd() - 0.5) * 0.08, hgt = k === 1 ? 2.3 : 1.9;
        A(new THREE.CylinderGeometry(0.075, 0.095, hgt, 6, 1), k === 1 ? WOOD : WOODD, o, sd, top + 1.0 - hgt / 2, 0, lean);
        A(box(0.2, 0.09, 0.2), ROPE, o, sd, top + 0.84);
        A(box(0.19, 0.07, 0.19), ROPE, o, sd, top + 0.02);
      });
      for (let k = 0; k < 2; k++) {
        // жердь чуть провисает к середине пролёта и лежит неровно
        const o = (posts[k] + posts[k + 1]) / 2, tilt = (k ? 1 : -1) * 0.012 + (rnd() - 0.5) * 0.02;
        g.add(new THREE.CylinderGeometry(0.045, 0.055, 3.42, 5, 1).rotateX(Math.PI / 2), tones[k + (sd > 0 ? 2 : 0)],
          bx + tx * o - tz * sd, top + 0.84 + (rnd() - 0.5) * 0.03, bz + tz * o + tx * sd, {}, [1, 1, 1], ang + tilt);
        g.add(new THREE.CylinderGeometry(0.035, 0.035, 3.4, 5, 1).rotateX(Math.PI / 2), WOODG,
          bx + tx * o - tz * sd, top + 0.42, bz + tz * o + tx * sd, {}, [1, 1, 1], ang - tilt);
      }
    }
    // подкосы под концами и поперечины, на которых лежат лаги
    for (const o of [-3.3, 3.3]) {
      A(box(2.0, 0.16, 0.18), WOODD, o, 0, top - 0.36);
      for (const sd of [-0.75, 0.75]) g.add(box(0.12, 1.3, 0.12), WOODD, bx + tx * (o * 0.86) - tz * sd, top - 0.85, bz + tz * (o * 0.86) + tx * sd, {}, [1, 1, 1], ang, 0);
    }
    blobs.push({ x: bx, z: bz, r: 2.6, h: 0.6 });
    addBox(bx, bz, 0.85, 3.6, ang, top, top - 0.3); // под мостком можно проплыть
    g.done(scene);
  }
  buildOldWorld(scene, rnd, blobs);
  return blobs;
}

// ---------- следы старой цивилизации: немного и по делу ----------
function buildOldWorld(scene, rnd, blobs) {
  const P = (r, th) => [Math.cos(th) * r, Math.sin(th) * r];
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (a, b, h, n = 7) => new THREE.CylinderGeometry(a, b, h, n, 1);
  const S = { stone: 1 };

  // ---- кусок мощёной дороги: плиты, часть провалилась или пропала ----
  {
    const [ax, az, bx, bz] = ROAD, len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len, dz = (bz - az) / len, ry = Math.atan2(dx, dz);
    const g = new Group((ax + bx) / 2, (az + bz) / 2);
    for (let t = 0.6; t < len - 0.4; t += 1.3) {
      const edge = Math.min(t, len - t);
      for (const o of [-1.3, 0, 1.3]) {
        if (rnd() < 0.18 + (edge < 5 ? 0.45 : 0) + (o ? 0.1 : 0)) continue;
        const x = ax + dx * t + dz * o + (rnd() - 0.5) * 0.15, z = az + dz * t - dx * o + (rnd() - 0.5) * 0.15;
        const sink = rnd() < 0.15 ? 0.12 : 0;
        g.block(x, z, 1.18 + rnd() * 0.08, 0.26, 1.18, ry + (rnd() - 0.5) * 0.12, heightAt(x, z) - 0.2 - sink,
          { solid: false, rz: (rnd() - 0.5) * (sink ? 0.25 : 0.06) });
      }
    }
    // бордюр местами
    for (let t = 2; t < len - 3; t += 2.4) {
      if (rnd() < 0.4) continue;
      for (const o of [-2.15, 2.15]) {
        const x = ax + dx * t + dz * o, z = az + dz * t - dx * o;
        g.block(x, z, 0.5, 0.38, 2.0, ry + (rnd() - 0.5) * 0.1, heightAt(x, z) - 0.2, { solid: false });
      }
    }
    // три старых столба вдоль дороги: целый, обломанный и с резной полосой
    const pillars = [[0.22, 2.9, 5.2], [0.5, -3.0, 2.6], [0.78, 3.1, 4.4]];
    for (const [k, o, h] of pillars) {
      const x = ax + dx * len * k + dz * o, z = az + dz * len * k - dx * o, y = heightAt(x, z) - 0.25;
      g.add(box(1.3, 0.5, 1.3), STONE[1], x, y + 0.25, z, S, [1, 1, 1], ry + 0.1);
      g.add(cyl(0.48, 0.55, h, 8), STONE[2], x, y + 0.5 + h / 2, z, S, [1, 1, 1], k * 3, (rnd() - 0.5) * 0.06);
      g.add(cyl(0.53, 0.53, 0.18, 8), STONE[3], x, y + 0.5 + h * 0.55, z, S);
      if (h > 4) g.add(box(1.15, 0.35, 1.15), STONE[0], x, y + 0.5 + h + 0.17, z, S, [1, 1, 1], ry + 0.25);
      else g.add(cyl(0.4, 0.5, 0.35, 6), STONE[0], x, y + 0.5 + h + 0.12, z, S, [1, 0.6, 1], 0, 0.3); // скол
      addCyl(x, z, 0.6, y + 0.5 + h + (h > 4 ? 0.35 : 0.2));
      blobs.push({ x, z, r: 1.6, h: h * 0.4 });
    }
    // упавший обломок столба
    {
      const x = ax + dx * len * 0.52 - dz * 4.6, z = az + dz * len * 0.52 + dx * 4.6, y = heightAt(x, z);
      g.add(cyl(0.48, 0.5, 2.6, 8), STONE[2], x, y + 0.3, z, S, [1, 1, 1], ry + 1.2, Math.PI / 2);
      addBox(x, z, 1.3, 0.5, ry + 1.2 + Math.PI / 2, y + 0.75);
    }
    // камень с непонятным знаком
    {
      const x = ax + dx * len * 0.36 - dz * 3.4, z = az + dz * len * 0.36 + dx * 3.4, y = heightAt(x, z) - 0.3;
      const fy = ry + Math.PI / 2; // знак смотрит на дорогу
      g.add(box(1.7, 2.4, 0.5), STONE[3], x, y + 1.2, z, S, [1, 1, 1], fy, 0.04);
      g.add(box(1.5, 0.3, 0.6), STONE[1], x, y + 2.45, z, S, [1, 1, 1], fy + 0.05);
      const fx = Math.sin(fy) * 0.26, fz = Math.cos(fy) * 0.26;
      const sx = x + fx, sz = z + fz, sy = y + 1.45;
      const G = { glow: 0.9 };
      // круг-«глаз», вертикальная черта, три точки и перевёрнутый уголок
      g.add(new THREE.TorusGeometry(0.36, 0.045, 5, 18), SYMBOL, sx, sy, sz, G, [1, 1, 1], fy);
      g.add(box(0.07, 0.95, 0.04), SYMBOL, sx, sy + 0.02, sz, G, [1, 1, 1], fy);
      for (const k of [-0.22, 0, 0.22]) {
        const ox = Math.cos(fy) * k, oz = -Math.sin(fy) * k;
        g.add(new THREE.OctahedronGeometry(0.06, 0), SYMBOL, sx + ox, sy - 0.66, sz + oz, G, [1, 1, 1], fy);
      }
      for (const sgn of [-1, 1]) {
        const ox = Math.cos(fy) * 0.16 * sgn, oz = -Math.sin(fy) * 0.16 * sgn;
        g.add(box(0.06, 0.28, 0.04), SYMBOL, sx + ox, sy + 0.62, sz + oz, G, [1, 1, 1], fy, 0.7 * sgn);
      }
      addBox(x, z, 0.85, 0.3, fy, y + 2.6);
      blobs.push({ x, z, r: 1.5, h: 1.6 });
    }
    g.done(scene);
  }

  // ---- ржавый подъёмник на краю: рама, шестерня, барабан и клеть на тросе ----
  {
    const th = 5.95, [ex, ez] = P(93.2, th), g = new Group(ex, ez);
    const ox = -Math.cos(th), oz = -Math.sin(th);   // к провалу
    const sx = -oz, sz = ox;                        // вбок
    const ry = Math.atan2(ox, oz);
    const y0 = heightAt(ex, ez);
    // деревянный настил, нависающий над краем
    for (let i = 0; i < 6; i++) {
      const o = -1.2 + i * 0.85;
      if (i === 4) continue; // одна доска выпала
      const x = ex + ox * o, z = ez + oz * o;
      g.block(x, z, 2.8, 0.14, 0.75, ry, y0 + 0.18, { color: i % 2 ? WOOD : WOODG, stone: 0, solid: false, rz: (rnd() - 0.5) * 0.05 });
    }
    addBox(ex + ox * 0.6, ez + oz * 0.6, 1.4, 2.7, ry, y0 + 0.32, y0 + 0.18); // настил висит над обрывом
    for (const s of [-1.2, 1.2]) {
      g.add(box(0.22, 0.22, 5.4), WOODD, ex + sx * s + ox * 0.9, y0 + 0.14, ez + sz * s + oz * 0.9, {}, [1, 1, 1], ry);
    }
    // рама: две ржавые стойки и балка-стрела над пропастью
    const H = 4.6;
    for (const s of [-1.15, 1.15]) {
      const x = ex + sx * s - ox * 0.6, z = ez + sz * s - oz * 0.6;
      g.add(box(0.26, H, 0.26), RUST, x, y0 + H / 2, z, {}, [1, 1, 1], ry);
      addCyl(x, z, 0.2, y0 + H);
    }
    g.add(box(2.6, 0.26, 0.26), RUST, ex - ox * 0.6, y0 + H, ez - oz * 0.6, {}, [1, 1, 1], ry);
    const boomL = 4.2, bmx = ex + ox * (boomL / 2 - 0.6), bmz = ez + oz * (boomL / 2 - 0.6);
    g.add(box(0.3, 0.3, boomL), RUST2, bmx, y0 + H + 0.25, bmz, {}, [1, 1, 1], ry);
    // шкив на конце стрелы
    const px = ex + ox * (boomL - 0.7), pz = ez + oz * (boomL - 0.7), py = y0 + H - 0.15;
    g.add(cyl(0.42, 0.42, 0.16, 14), IRON, px, py, pz, {}, [1, 1, 1], ry + Math.PI / 2, Math.PI / 2);
    // большая шестерня с рукоятью и барабан с намотанным тросом
    const gx = ex + sx * 1.9 - ox * 0.4, gz = ez + sz * 1.9 - oz * 0.4, gy = y0 + 1.5;
    g.add(box(0.3, 1.3, 0.3), RUST, gx, y0 + 0.65, gz, {}, [1, 1, 1], ry);
    g.add(cyl(1.0, 1.0, 0.18, 16), RUST2, gx + sx * 0.25, gy, gz + sz * 0.25, {}, [1, 1, 1], ry, Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ux = Math.cos(a) * 1.08, uy = Math.sin(a) * 1.08;
      g.add(box(0.2, 0.22, 0.17), RUST, gx + sx * 0.25 + ox * ux, gy + uy, gz + sz * 0.25 + oz * ux, {}, [1, 1, 1], ry, -a);
    }
    g.add(cyl(0.16, 0.16, 0.5, 8), IRON, gx + sx * 0.25, gy, gz + sz * 0.25, {}, [1, 1, 1], ry, Math.PI / 2);
    g.add(box(0.1, 0.9, 0.1), IRON, gx + sx * 0.5 + ox * 0.35, gy + 0.3, gz + sz * 0.5 + oz * 0.35, {}, [1, 1, 1], ry, 0.6);
    g.add(cyl(0.38, 0.38, 1.7, 10), ROPE, ex - ox * 0.6, y0 + 0.95, ez - oz * 0.6, {}, [1, 1, 1], ry + Math.PI / 2, Math.PI / 2);
    for (const s of [-1, 1]) g.add(cyl(0.5, 0.5, 0.12, 10), RUST, ex - ox * 0.6 + sx * 0.9 * s, y0 + 0.95, ez - oz * 0.6 + sz * 0.9 * s, {}, [1, 1, 1], ry + Math.PI / 2, Math.PI / 2);
    addCyl(gx, gz, 0.9, y0 + 2.5);
    // трос вниз и ржавая клеть, застрявшая на полпути
    const ropeL = 7.5;
    g.add(cyl(0.035, 0.035, ropeL, 4), ROPE, px, py - ropeL / 2, pz);
    const cy = py - ropeL - 0.9;
    for (const a of [0, 1, 2, 3]) {
      const ang = ry + a * Math.PI / 2 + Math.PI / 4;
      g.add(box(0.07, 1.6, 0.07), IRON, px + Math.sin(ang) * 0.7, cy, pz + Math.cos(ang) * 0.7, {}, [1, 1, 1], 0, 0.02 * a);
    }
    for (const yy of [-0.78, 0.78]) {
      g.add(box(1.0, 0.08, 1.0), RUST, px, cy + yy, pz, {}, [1, 1, 1], ry + 0.08);
    }
    g.add(box(1.0, 0.06, 1.0), WOODG, px, cy - 0.72, pz, {}, [1, 1, 1], ry + 0.08);
    for (let i = 0; i < 4; i++) g.add(cyl(0.02, 0.02, 0.95, 3), ROPE, px + Math.sin(ry + i * 1.57 + 0.78) * 0.35, cy + 1.2, pz + Math.cos(ry + i * 1.57 + 0.78) * 0.35, {}, [1, 1, 1], 0, 0.3);
    // обломки и брошенный ящик у подъёмника
    g.block(ex + sx * -2.4 - ox * 1.8, ez + sz * -2.4 - oz * 1.8, 0.9, 0.7, 0.9, ry + 0.4, heightAt(ex + sx * -2.4 - ox * 1.8, ez + sz * -2.4 - oz * 1.8) - 0.05, { color: WOODG, stone: 0 });
    blobs.push({ x: ex, z: ez, r: 3.2, h: 3 });
    g.done(scene);
  }

  // ---- остов деревянного помоста на краю: столбы, балки, половина настила ----
  {
    const th = 0.86, [ex, ez] = P(95.6, th), g = new Group(ex, ez);
    const ox = -Math.cos(th), oz = -Math.sin(th), sx = -oz, sz = ox, ry = Math.atan2(ox, oz);
    const y0 = heightAt(ex, ez);
    const post = (o, s, h, tilt) => {
      const x = ex + ox * o + sx * s, z = ez + oz * o + sz * s, y = heightAt(x, z) - 0.3;
      g.add(box(0.26, h, 0.26), WOODD, x, y + h / 2, z, {}, [1, 1, 1], ry, tilt);
      return [x, y + h, z];
    };
    post(-1.5, -1.4, 3.6, 0.03); post(-1.5, 1.4, 2.1, -0.05); // один обломан
    post(1.2, -1.4, 3.9, 0.12); post(1.2, 1.4, 3.3, 0.22);    // наклонились к пропасти
    for (const s of [-1.4, 1.4]) g.add(box(0.2, 0.2, 3.4), WOOD, ex + sx * s, y0 + 2.4, ez + sz * s, {}, [1, 1, 1], ry, 0.06 * s);
    g.add(box(3.1, 0.2, 0.2), WOOD, ex - ox * 1.5, y0 + 3.0, ez - oz * 1.5, {}, [1, 1, 1], ry, 0.04);
    // настил наверху — только несколько досок
    for (let i = 0; i < 5; i++) {
      if (i === 2) continue;
      const o = -1.5 + i * 0.6;
      g.add(box(3.0, 0.08, 0.5), i % 2 ? WOOD : WOODG, ex + ox * o, y0 + 2.58 - i * 0.03, ez + oz * o, {}, [1, 1, 1], ry, (rnd() - 0.5) * 0.1);
    }
    // лестница, уходящая вниз по склону, и упавшая балка
    for (const s of [-0.35, 0.35]) g.add(box(0.1, 4.2, 0.1), WOODD, ex + ox * 2.7 + sx * s, y0 - 2.4, ez + oz * 2.7 + sz * s, {}, [1, 1, 1], ry, 0);
    for (let i = 0; i < 6; i++) g.add(box(0.75, 0.07, 0.08), WOOD, ex + ox * 2.7, y0 - 4.2 + i * 0.6, ez + oz * 2.7, {}, [1, 1, 1], ry);
    const fx = ex - ox * 2.2 + sx * 2.4, fz = ez - oz * 2.2 + sz * 2.4;
    g.add(box(0.22, 0.22, 3.2), WOOD, fx, heightAt(fx, fz) + 0.1, fz, {}, [1, 1, 1], ry + 0.7);
    blobs.push({ x: ex, z: ez, r: 2.6, h: 2.5 });
    g.done(scene);
  }

  // ---- разрушенный каменный мост с кольца на островок ----
  {
    const st = STACKS[0], th = st.th;
    const ox = -Math.cos(th), oz = -Math.sin(th), ry = Math.atan2(ox, oz);
    const r0 = 76.5, r1 = st.r + st.w * 0.55;            // от кольца до островка
    const gapA = 58.5, gapB = 51.5;                       // провал посередине
    const deckY = -12.95;
    const g = new Group(Math.cos(th) * 60, Math.sin(th) * 60);
    const at = (r, s = 0) => [Math.cos(th) * r - oz * s, Math.sin(th) * r + ox * s];
    // плиты настила
    for (let r = r0; r > r1; r -= 1.6) {
      if (r < gapA && r > gapB) continue;
      const nearA = r < gapA + 2.2 && r >= gapA, nearB = r > gapB - 2.2 && r <= gapB;
      const [x, z] = at(r);
      const sag = nearA ? (gapA + 2.2 - r) * 0.12 : nearB ? (r - gapB + 2.2) * 0.1 : 0;
      g.block(x, z, 3.2 - (nearA || nearB ? 0.8 : 0), 0.6, 1.62, ry + (rnd() - 0.5) * 0.03, deckY - 0.6 - sag,
        { rz: nearA || nearB ? (rnd() - 0.5) * 0.12 : 0, hang: true });
      // парапет: блоки по краям, местами выпали
      for (const s of [-1.45, 1.45]) {
        if (rnd() < 0.3 || nearA || nearB) continue;
        const [px, pz] = at(r, s);
        g.block(px, pz, 0.35, 0.55, 1.4, ry, deckY - 0.02, { solid: false });
      }
    }
    // опоры: высокая на нижнем уступе и вторая у края шахты
    const pier = (r, w) => {
      const [x, z] = at(r);
      const base = heightAt(x, z) - 1.0, top = deckY - 1.4;
      g.add(box(w, top - base, w * 0.85), STONE[1], x, base + (top - base) / 2, z, S, [1, 1, 1], ry);
      g.add(box(w + 0.5, 0.8, w * 0.85 + 0.5), STONE[0], x, top + 0.4, z, S, [1, 1, 1], ry);
      addBox(x, z, w / 2, w * 0.42, ry, top);
    };
    pier(64.5, 2.6); pier(47.5, 2.3);
    // арка под настилом между краем и первой опорой
    const arc = (ra, rb) => {
      const mid = (ra + rb) / 2, half = (ra - rb) / 2;
      for (let i = 1; i < 10; i++) {
        const a = (i / 10) * Math.PI;
        const r = mid + Math.cos(a) * half, y = deckY - 1.2 - (1 - Math.sin(a)) * half * 0.9;
        const [x, z] = at(r);
        g.add(box(2.6, 1.0, 1.4), STONE[i % 4], x, y - 0.5, z, S, [1, 1, 1], ry, 0);
      }
    };
    arc(r0 - 0.5, 65.8); arc(46.3, r1 + 0.5);
    // обломки пролёта на нижнем уступе
    for (let i = 0; i < 6; i++) {
      const r = gapB + 1 + rnd() * 6, s = (rnd() - 0.5) * 6;
      const [x, z] = at(r, s);
      const y = heightAt(x, z);
      if (y < -60) continue;
      const w = 0.8 + rnd() * 1.4;
      g.block(x, z, w, w * 0.6, w * 1.2, rnd() * 3, y - 0.2, { rz: (rnd() - 0.5) * 0.5 });
    }
    blobs.push({ x: at(70)[0], z: at(70)[1], r: 3, h: 1 });
    g.done(scene);
  }

  // ---- смотровая на утёсе: дощатый помост с перилами и обломок лестницы у стены ----
  {
    const C = W.CRAG, g = new Group(C.x, C.z);
    const y0 = heightAt(C.x, C.z);
    const ry = C.th + Math.PI / 2 - 0.3; // доски смотрят на провал
    const fx = -Math.cos(C.th), fz = -Math.sin(C.th), sx = -fz, sz = fx;
    const px = C.x + fx * 2.6, pz = C.z + fz * 2.6; // помост вынесен к обрыву
    for (let i = 0; i < 8; i++) {
      const o = -1.4 + i * 0.4;
      if (i === 5) continue;
      g.add(box(0.4, 0.09, 3.2), i % 2 ? WOOD : WOODG, px + sx * o, y0 + 0.28, pz + sz * o, {}, [1, 1, 1], ry, (rnd() - 0.5) * 0.04);
    }
    addBox(px, pz, 1.7, 1.6, ry, y0 + 0.33);
    for (const [a, b] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
      const x = px + sx * a + fx * b, z = pz + sz * a + fz * b;
      g.add(box(0.16, 1.5, 0.16), WOODD, x, heightAt(x, z) + 0.6, z, {}, [1, 1, 1], ry, (rnd() - 0.5) * 0.1);
    }
    for (const b of [1.5]) g.add(box(3.3, 0.1, 0.1), WOOD, px + fx * b, y0 + 1.2, pz + fz * b, {}, [1, 1, 1], ry);
    for (const a of [-1.5, 1.5]) g.add(box(0.1, 0.1, 3.0), WOOD, px + sx * a, y0 + 1.15, pz + sz * a, {}, [1, 1, 1], ry, 0.03 * a);
    // остатки лестницы у подножия стены — намёк, что сюда поднимались
    const lx = C.x - fx * (C.w + 4.5), lz = C.z - fz * (C.w + 4.5), ly = heightAt(lx, lz);
    for (const a of [-0.35, 0.35]) g.add(box(0.1, 5.5, 0.1), WOODD, lx + sx * a, ly + 2.3, lz + sz * a, {}, [1, 1, 1], ry, 0.0);
    for (let i = 0; i < 7; i++) if (i !== 3) g.add(box(0.8, 0.07, 0.08), WOOD, lx, ly + 0.5 + i * 0.6, lz, {}, [1, 1, 1], ry);
    g.block(lx + sx * 1.6, lz + sz * 1.6, 0.9, 0.5, 0.9, 0.4, ly - 0.1, { color: WOODG, stone: 0 });
    blobs.push({ x: px, z: pz, r: 2.4, h: 1 });
    g.done(scene);
  }

  // ---- несколько обломков по краю луга ----
  {
    const g = new Group(100, -10);
    for (const [r, th] of [[99, 0.25], [102, 5.75], [97.5, 0.62], [110, 5.9], [104, 0.4]]) {
      const [x, z] = P(r, th), w = 0.7 + rnd() * 0.8;
      g.block(x, z, w * 1.3, w * 0.55, w, rnd() * 3, heightAt(x, z) - 0.2, { rz: (rnd() - 0.5) * 0.3, solid: w > 1.1 });
    }
    g.done(scene);
  }
}
