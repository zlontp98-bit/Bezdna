import * as THREE from '../vendor/three.min.js';
import { propMaterial } from './flora.js';
import { objId, RULES } from './world.js';

// Камушки на земле. Подошёл — кнопка «подобрать», камень летит в инвентарь.
// Подобранный пропадает у всех и через пару минут появляется снова (событие мира, общие часы).
// Все камушки — одна сетка-экземпляр; подобранный просто сжат в точку.
const REACH = 1.6, CELL = 8;

export class Pickups {
  constructor(scene, items, geo, player, inv, world, toast) {
    this.player = player; this.inv = inv; this.world = world; this.toast = toast;
    this.items = items; this.target = null; this.cells = new Map(); this.byId = new Map();
    const col = new THREE.Color();
    this.mesh = new THREE.InstancedMesh(geo, propMaterial(), items.length);
    items.forEach((p, i) => {
      p.i = i; p.id = objId('pebble', p.x, p.z); p.gone = undefined;
      this.byId.set(p.id, p);
      const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.z / CELL);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(p);
      const g = 0.5 + ((i * 7) % 5) * 0.03;
      this.mesh.setColorAt(i, col.setRGB(g * 1.02, g * 0.96, g * 0.88));
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
        const n = ev.reward.stone || 0, left = inv.add('stone', n);
        toast(left ? 'Инвентарь полон' : `+${n} 🪨 Камень`);
      }
    });
  }
  show(p, on) {
    _m.compose(_p.set(p.x, p.y - 0.03, p.z), _q.setFromAxisAngle(UP, p.rot), _s.set(on ? p.s : 1e-4, on ? p.s * 0.7 : 1e-4, on ? p.s * 1.15 : 1e-4));
    this.mesh.setMatrixAt(p.i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(want) {
    const pl = this.player, pp = pl.pos, cx = Math.floor(pp.x / CELL), cz = Math.floor(pp.z / CELL);
    let best = null, bd = REACH;
    const now = this.world.now();
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.cells.get((cx + a) + ',' + (cz + b));
      if (!list) continue;
      for (const p of list) {
        // вернулся на место — снова лежит
        if (p.gone !== undefined && now - p.gone > RULES.pebble.respawnMs(p.id)) { p.gone = undefined; this.show(p, true); }
        if (p.gone !== undefined) continue;
        const d = Math.hypot(p.x - pp.x, p.z - pp.z);
        if (d < bd && Math.abs(p.y - pp.y) < 1.5) { bd = d; best = p; }
      }
    }
    this.target = pl.grounded && !pl.climbing && !pl.swimming ? best : null;
    if (want && this.target) this.world.send({ type: 'pick', id: this.target.id });
  }
}
const UP = new THREE.Vector3(0, 1, 0), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
