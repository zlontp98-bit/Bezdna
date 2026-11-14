import * as THREE from '../vendor/three.min.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mulberry32 } from './noise.js';
import { groundAt } from './solids.js';
import { ITEMS } from './inventory.js';

// Старый потрёпанный деревянный ящик на одном из островков.
// Где он стоит, решает мир (остров и «зерно»); точное место на острове игра выводит из них
// сама — одинаково у всех. Подошёл — кнопка 🗝️: крышка откидывается, добыча — в инвентарь,
// ящик рассыпается. Через несколько минут мир ставит новый на другом острове.
// Нагрузка: две маленькие модели, обновляются, только пока идёт анимация.
const TAU = Math.PI * 2, OPEN = 0.55, VANISH = 2.4, FADE = 0.45;

function chestParts() {
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const W1 = 0x6e4a2e, W2 = 0x5c3c24, W3 = 0x80573a, D = 0x2e1d12, IRON = 0x4c4f55, RUST = 0x7a4a2a;
  const W = 0.92, H = 0.5, Dp = 0.6;
  const body = [
    part(box(W - 0.04, H - 0.04, Dp - 0.04), D, { m: T(0, H / 2, 0) }), // тёмное нутро между досками
  ];
  // доски спереди и сзади — разного тона, с зазорами; одна выбита
  for (const z of [Dp / 2 - 0.02, -Dp / 2 + 0.02]) for (let i = 0; i < 3; i++) {
    if (z > 0 && i === 1) { body.push(part(box(W * 0.55, 0.13, 0.04), W2, { m: T(-0.17, 0.08 + i * 0.165 + 0.02, z, 1, 1, 1, 0, 0.08) })); continue; }
    body.push(part(box(W, 0.145, 0.04), [W1, W3, W2][(i + (z > 0 ? 0 : 1)) % 3], { m: T(0, 0.08 + i * 0.165, z) }));
  }
  for (const x of [W / 2 - 0.02, -W / 2 + 0.02]) for (let i = 0; i < 3; i++) body.push(part(box(0.04, 0.145, Dp), [W3, W1, W2][i], { m: T(x, 0.08 + i * 0.165, 0) }));
  body.push(part(box(W, 0.04, Dp), W2, { m: T(0, 0.02, 0) }));
  // уголки и железные полосы с ржавчиной
  for (const x of [-1, 1]) for (const z of [-1, 1]) body.push(part(box(0.07, H + 0.02, 0.07), IRON, { m: T(x * (W / 2), H / 2, z * (Dp / 2)) }));
  for (const x of [-0.27, 0.27]) {
    body.push(part(box(0.07, H, Dp + 0.03), IRON, { m: T(x, H / 2, 0) }));
    body.push(part(box(0.075, 0.08, Dp + 0.035), RUST, { m: T(x, 0.06, 0) }));
  }
  // скоба замка (светится чуть-чуть, чтобы ящик было видно в тумане)
  body.push(part(box(0.14, 0.16, 0.04), 0xc9a54a, { glow: 0.55, m: T(0, H - 0.1, Dp / 2 + 0.03) }));
  // крышка: полукруглая, крепится на петлях сзади (ось вращения — задний верхний край)
  const lid = [
    part(new THREE.CylinderGeometry(Dp / 2, Dp / 2, W, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), W1, { m: T(0, 0, Dp / 2) }),
  ];
  for (const x of [-0.27, 0.27]) lid.push(part(new THREE.CylinderGeometry(Dp / 2 + 0.02, Dp / 2 + 0.02, 0.07, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), IRON, { m: T(x, 0, Dp / 2) }));
  // Дно крышки: у полукруглого свода его нет, и откинутая крышка изнутри была невидимой
  // (грани смотрели от камеры). Доски нутра и железные полосы под ней.
  lid.push(part(box(W - 0.02, 0.03, Dp - 0.02), D, { m: T(0, 0.012, Dp / 2) }));
  for (let i = 0; i < 3; i++) lid.push(part(box(W - 0.04, 0.012, 0.15), [W2, W1, W3][i], { m: T(0, 0.03, 0.12 + i * 0.17) }));
  for (const x of [-0.27, 0.27]) lid.push(part(box(0.075, 0.02, Dp), IRON, { m: T(x, 0.03, Dp / 2) }));
  // мох на крышке и щели
  lid.push(part(new THREE.SphereGeometry(1, 7, 4, 0, TAU, 0, Math.PI / 2), 0x4f6b2f, { m: T(-0.18, 0.23, Dp / 2 - 0.05, 0.2, 0.06, 0.16) }));
  lid.push(part(box(0.5, 0.02, 0.02), D, { m: T(0.12, Dp / 2 - 0.005, Dp / 2) }));
  return { body: merge(body), lid: merge(lid), H, Dp };
}

export class Chests {
  constructor(scene, stacks, trees, player, inv, world, toast) {
    this.stacks = stacks; this.trees = trees; this.player = player; this.inv = inv; this.world = world; this.toast = toast;
    const { body, lid, H, Dp } = chestParts(), M = propMaterial();
    this.root = new THREE.Group();
    this.root.add(new THREE.Mesh(body, M));
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(0, H, -Dp / 2);
    this.lidPivot.add(new THREE.Mesh(lid, M));
    this.root.add(this.lidPivot);
    this.root.visible = false;
    scene.add(this.root);
    this.col = { x: 0, z: 0, r: -10 };
    player.addCollider(this.col);
    this.c = null; this.t = 0; this.tickT = 0; this.target = null;
    const snap = world.snapshot();
    this.set(snap.chest, false);
    world.on((ev) => {
      if (ev.type === 'chestSpawned') { this.set(ev.chest, false); toast('📦 На одном из островков над бездной появился старый ящик'); }
      if (ev.type === 'chestOpened' && this.c && ev.id === this.c.id) {
        this.c.opened = ev.at; this.anim = 'open'; this.t = 0;
        if (ev.by === world.me) {
          const got = [];
          for (const id in ev.loot) if (inv.add(id, ev.loot[id]) < ev.loot[id]) got.push(`${ITEMS[id].name}`);
          toast(got.length ? `🗝️ В старом ящике: ${got.join(', ')}` : 'Инвентарь полон — ящик пуст для тебя');
        }
      }
    });
  }

  // место на острове по зерну: на вершине, не под деревом и не у края
  spot(c) {
    const s = this.stacks[c.island], rnd = mulberry32(c.seed);
    for (let k = 0; k < 40; k++) {
      const a = rnd() * TAU, rr = s.w * (0.12 + rnd() * 0.45), x = s.x + Math.cos(a) * rr, z = s.z + Math.sin(a) * rr, rot = rnd() * TAU;
      if (this.trees.some((t) => Math.hypot(t.x - x, t.z - z) < 1.7)) continue;
      const y = groundAt(x, z, s.top + 5);
      if (Math.abs(y - s.top) > 0.9) continue;
      return { x, y, z, rot };
    }
    return { x: s.x, y: groundAt(s.x, s.z, s.top + 5), z: s.z, rot: 0 };
  }
  set(c, animate) {
    this.c = c && { ...c };
    this.anim = null; this.lidPivot.rotation.x = 0; this.root.scale.setScalar(1);
    if (!c || c.opened) { this.root.visible = false; this.col.r = -10; return; }
    const p = this.spot(c);
    this.p = p;
    this.root.position.set(p.x, p.y - 0.04, p.z);
    // стоит чуть криво — старый
    this.root.rotation.set(0.04, p.rot, -0.05);
    this.root.visible = true;
    this.col.x = p.x; this.col.z = p.z; this.col.r = 0.42;
  }
  update(dt, want) {
    // раз в пару секунд спрашиваем мир, не пора ли поставить новый ящик
    if ((this.tickT -= dt) <= 0) { this.tickT = 2; this.world.send({ type: 'tick' }); }
    const pl = this.player, c = this.c;
    this.target = null;
    if (c && !c.opened && this.root.visible && pl.grounded && !pl.climbing && !pl.swimming) {
      const d = Math.hypot(this.p.x - pl.pos.x, this.p.z - pl.pos.z);
      if (d < 1.6 && Math.abs(this.p.y - pl.pos.y) < 1.5) this.target = c;
    }
    if (want && this.target) {
      pl.facing = Math.atan2(this.p.x - pl.pos.x, this.p.z - pl.pos.z);
      this.world.send({ type: 'openChest', id: c.id });
    }
    if (!this.anim) return;
    this.t += Math.min(dt, 0.1); // кадр бывает длинным — анимация не должна перескакивать
    if (this.anim === 'open') {
      // крышка откидывается с небольшим отскоком
      const k = Math.min(1, this.t / OPEN);
      this.lidPivot.rotation.x = -1.95 * (1 - (1 - k) ** 3) + Math.sin(k * Math.PI) * 0.12;
      if (this.t > VANISH) { this.anim = 'fade'; this.t = 0; this.col.r = -10; }
    } else if (this.anim === 'fade') {
      const k = Math.min(1, this.t / FADE);
      this.root.scale.set(1 + k * 0.15, 1 - k, 1 + k * 0.15);
      if (k === 1) { this.anim = null; this.root.visible = false; }
    }
  }
}
