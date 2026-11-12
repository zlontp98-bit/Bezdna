import * as THREE from '../vendor/three.min.js';
import { propMaterial } from './flora.js';
import { SWING } from './player.js';
import { objId, RULES } from './world.js';

// Добыча камня. С киркой в руке у большого валуна — пять ударов: валун вздрагивает,
// на последнем рассыпается, камни подлетают и летят в руки. Через 3–4 минуты по часам
// мира валун снова на месте. Как и рубка: последний удар — просьба к миру ('mine'),
// всё остальное — ответ ('mined'), поэтому так же заработает и с сервером.
// Валун — экземпляр в общей сетке камней: двигаем только его матрицу, а пока его нет,
// выключаем его твёрдое тело.
const CELL = 8, BREAK = 0.35, GROW = 1.4, FLY = 0.7, CHIPS = 3;

export class Miner {
  constructor(scene, boulders, rockGeo, player, inv, world, toast) {
    this.list = boulders; this.player = player; this.inv = inv; this.world = world; this.toast = toast;
    this.target = null; this.cd = 0; this.busy = []; this.flying = []; this.pending = null;
    this.cells = new Map(); this.byId = new Map();
    for (const b of boulders) {
      b.id = objId('rock', b.x, b.z); b.hp = RULES.boulder.hits(b.s); b.state = 'idle'; b.t = 0;
      this.byId.set(b.id, b);
      const k = Math.floor(b.x / CELL) + ',' + Math.floor(b.z / CELL);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(b);
    }
    // осколки, летящие к герою
    this.chips = new THREE.InstancedMesh(rockGeo, propMaterial(), CHIPS * 2);
    const c = new THREE.Color(0.55, 0.52, 0.48);
    for (let i = 0; i < this.chips.count; i++) { this.chips.setMatrixAt(i, ZERO); this.chips.setColorAt(i, c); }
    this.chips.frustumCulled = false; this.chips.matrixAutoUpdate = false;
    scene.add(this.chips);
    const snap = world.snapshot();
    for (const id in snap.mined) { const b = this.byId.get(id); if (b) this.gone(b, snap.mined[id], false); }
    world.on((ev) => {
      if (ev.type !== 'mined') return;
      const b = this.byId.get(ev.id);
      if (!b) return;
      if (ev.by === world.me) b.reward = ev.reward;
      this.gone(b, ev.at, true);
    });
  }
  gone(b, at, animate) {
    b.at = at; b.solid.off = true;
    b.state = animate ? 'break' : 'gone'; b.t = 0;
    if (!animate) this.place(b, 0);
    if (!this.busy.includes(b)) this.busy.push(b);
  }
  // k — масштаб от полного; sx/sz — смещение (дрожь)
  place(b, k, sx = 0, sz = 0) {
    _m.copy(b.m);
    if (k !== 1) { _m.decompose(_p, _q, _s); _s.multiplyScalar(Math.max(1e-4, k)); _m.compose(_p, _q, _s); }
    _m.elements[12] += sx; _m.elements[14] += sz;
    b.mesh.setMatrixAt(b.i, _m);
    b.mesh.instanceMatrix.needsUpdate = true;
  }
  find() {
    const p = this.player.pos, cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    let best = null, bd = 1.3;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const l = this.cells.get((cx + a) + ',' + (cz + c));
      if (l) for (const b of l) {
        if (b.state !== 'idle' && b.state !== 'shake') continue;
        const d = Math.hypot(b.x - p.x, b.z - p.z) - b.s * 1.05;
        if (d < bd && Math.abs(b.y - p.y) < 3) { bd = d; best = b; }
      }
    }
    return best;
  }
  update(dt, want) {
    const pl = this.player;
    this.target = pl.held === 'pickaxe' && pl.grounded && !pl.climbing && !pl.swimming ? this.find() : null;
    this.cd -= dt;
    if (this.pending && (this.pending.at -= dt) <= 0) {
      const b = this.pending.b; this.pending = null;
      if (b.state === 'idle' || b.state === 'shake') {
        b.state = 'shake'; b.t = 0;
        if (!this.busy.includes(b)) this.busy.push(b);
        if (--b.hp <= 0) { b.hp = RULES.boulder.hits(b.s); this.world.send({ type: 'mine', id: b.id, s: b.s }); }
      }
    }
    if (want && this.target && this.cd <= 0) {
      const b = this.target;
      pl.facing = Math.atan2(b.x - pl.pos.x, b.z - pl.pos.z);
      pl.swingT = SWING; this.cd = SWING;
      this.pending = { b, at: SWING * 0.42 };
    }
    const now = this.world.now();
    for (let n = this.busy.length - 1; n >= 0; n--) {
      const b = this.busy[n];
      b.t += dt;
      if (b.state === 'shake') {
        const k = Math.max(0, 1 - b.t / 0.25);
        this.place(b, 1 - 0.04 * k, Math.sin(b.t * 70) * 0.06 * k, Math.cos(b.t * 55) * 0.05 * k);
        if (k === 0) { b.state = 'idle'; this.place(b, 1); this.busy.splice(n, 1); }
      } else if (b.state === 'break') {
        // рассыпается: сжимается и проседает
        const k = Math.min(1, b.t / BREAK);
        this.place(b, 1 - k * k);
        if (k === 1) { b.state = 'gone'; this.place(b, 0); this.drop(b); }
      } else if (b.state === 'gone') {
        if (now - b.at > RULES.boulder.respawnMs(b.id) && Math.hypot(b.x - pl.pos.x, b.z - pl.pos.z) > b.s + 1.5) { b.state = 'grow'; b.t = 0; }
      } else if (b.state === 'grow') {
        const k = Math.min(1, b.t / GROW), e = 1 - (1 - k) ** 3;
        this.place(b, e);
        if (k === 1) { b.state = 'idle'; b.hp = RULES.boulder.hits(b.s); b.solid.off = false; this.place(b, 1); this.busy.splice(n, 1); }
      }
    }
    if (this.flying.length || this.shown) {
      const ty = pl.pos.y + 0.8;
      for (let i = 0; i < this.chips.count; i++) {
        const f = this.flying[i];
        if (!f) { this.chips.setMatrixAt(i, ZERO); continue; }
        f.t += dt;
        const k = Math.max(0, f.t) / FLY, pop = Math.min(1, k / 0.5), home = Math.max(0, (k - 0.5) / 0.5) ** 2;
        const x = f.x + f.vx * pop, z = f.z + f.vz * pop, y = f.y + Math.sin(pop * Math.PI * 0.5) * 1.1;
        _e.set(k * 6, f.rot, k * 4);
        _m.compose(_p.set(x + (pl.pos.x - x) * home, y + (ty - y) * home, z + (pl.pos.z - z) * home), _q.setFromEuler(_e), _s.setScalar(f.t < 0 ? 1e-4 : 0.22 * (1 - home * 0.6)));
        this.chips.setMatrixAt(i, _m);
      }
      this.flying = this.flying.filter((f) => f.t < FLY);
      this.shown = this.flying.length > 0;
      this.chips.instanceMatrix.needsUpdate = true;
    }
  }
  drop(b) {
    const r = b.reward; b.reward = null;
    if (!r) return; // разбивал не я
    const n = r.stone || 0, left = this.inv.add('stone', n);
    this.toast(left === 0 ? `+${n} 🪨 Камень` : left < n ? `+${n - left} 🪨 — инвентарь полон` : 'Инвентарь полон');
    for (let i = 0; i < Math.min(n, CHIPS * 2); i++) {
      const a = i * 1.7 + b.x;
      this.flying.push({ t: -i * 0.06, x: b.x, y: b.y + b.s * 0.4, z: b.z, vx: Math.cos(a) * 1.2, vz: Math.sin(a) * 1.2, rot: a });
    }
  }
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
