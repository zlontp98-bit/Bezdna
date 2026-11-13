import * as THREE from '../vendor/three.min.js';
import { propMaterial } from './flora.js';
import { objId, RULES } from './world.js';

// То, что можно подобрать: камушки на земле и ягоды на кустах.
// Подошёл — кнопка «подобрать», добыча летит в инвентарь. Собранное пропадает у всех
// и через пару минут появляется снова (событие мира, общие часы).
// Все предметы одного вида — одна сетка-экземпляр; собранный просто сжат в точку.
const CELL = 8;
const KINDS = {
  pebble: { rule: () => RULES.pebble, reach: () => 1.6, toast: (n) => `+${n} 🪨 Камень`, item: 'stone' },
  bush: { rule: () => RULES.bush, reach: (p) => p.s * 0.95 + 1.0, toast: (n) => `+${n} 🫐 Ягоды`, item: 'berry' },
};

export class Pickups {
  constructor(scene, kind, items, geo, player, inv, world, toast) {
    this.K = KINDS[kind]; this.player = player; this.inv = inv; this.world = world;
    this.items = items; this.target = null; this.cells = new Map(); this.byId = new Map();
    const col = new THREE.Color();
    this.mesh = new THREE.InstancedMesh(geo, propMaterial(), items.length);
    items.forEach((p, i) => {
      p.i = i; p.id = objId(kind, p.x, p.z); p.gone = undefined;
      if (!p.m) p.m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y - 0.03, p.z), new THREE.Quaternion().setFromAxisAngle(UP, p.rot), new THREE.Vector3(p.s, p.s * 0.7, p.s * 1.15));
      this.byId.set(p.id, p);
      const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.z / CELL);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(p);
      const g = kind === 'pebble' ? 0.5 + ((i * 7) % 5) * 0.03 : 1;
      this.mesh.setColorAt(i, kind === 'pebble' ? col.setRGB(g * 1.02, g * 0.96, g * 0.88) : col.setRGB(1, 1, 1));
      this.show(p, true);
    });
    this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    const snap = world.snapshot();
    for (const id in snap.picked) { const p = this.byId.get(id); if (p) { p.gone = snap.picked[id]; this.show(p, false); } }
    world.on((ev) => {
      if (ev.type !== 'picked') return;
      const p = this.byId.get(ev.id);
      if (!p) return;
      p.gone = ev.at; this.show(p, false);
      if (ev.by === world.me) {
        const n = ev.reward[this.K.item] || 0, left = inv.add(this.K.item, n);
        toast(left ? 'Инвентарь полон' : this.K.toast(n));
      }
    });
  }
  show(p, on) {
    this.mesh.setMatrixAt(p.i, on ? p.m : ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(want) {
    const pl = this.player, pp = pl.pos, cx = Math.floor(pp.x / CELL), cz = Math.floor(pp.z / CELL);
    let best = null, bd = 1e9;
    const now = this.world.now(), rule = this.K.rule();
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.cells.get((cx + a) + ',' + (cz + b));
      if (!list) continue;
      for (const p of list) {
        // вернулось на место — снова лежит / висит
        if (p.gone !== undefined && now - p.gone > rule.respawnMs(p.id)) { p.gone = undefined; this.show(p, true); }
        if (p.gone !== undefined) continue;
        const d = Math.hypot(p.x - pp.x, p.z - pp.z);
        if (d < this.K.reach(p) && d < bd && Math.abs(p.y - pp.y) < 1.5) { bd = d; best = p; }
      }
    }
    this.target = pl.grounded && !pl.climbing && !pl.swimming ? best : null;
    if (want && this.target) this.world.send({ type: 'pick', id: this.target.id });
  }
}
const UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
