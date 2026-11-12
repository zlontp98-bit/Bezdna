import * as THREE from '../vendor/three.min.js';
import { part, merge, T, propMaterial } from './flora.js';
import { SWING } from './player.js';
import { objId, RULES } from './world.js';

// Рубка деревьев. С топором в руке у ствола — несколько ударов, дерево валится,
// выпадают три бревна и летят к герою. Остаётся пенёк; через пару минут дерево вырастает снова.
// Сама игра ничего не решает: последний удар — это просьба к миру (world.send), а падение,
// брёвна и рост — ответ мира. Поэтому то же самое заработает и с сервером, и для чужих рубок.
// Всё дёшево: двигаем матрицу одного экземпляра в уже существующей сетке деревьев,
// пеньки и брёвна — по одной сетке на все.
const HITS = 4, LOGS = 3, REACH = 1.7, FALL = 0.95, GROW = 2.6, FLY = 0.75;
const CELL = 8;

export class Woodcutter {
  constructor(scene, trees, player, inv, toast, world) {
    this.trees = trees; this.player = player; this.inv = inv; this.toast = toast; this.world = world;
    this.target = null; this.cd = 0; this.busy = []; // деревья с идущей анимацией или ждущие роста
    this.cells = new Map(); this.byId = new Map();
    trees.forEach((t) => {
      t.hp = HITS; t.state = 'idle'; t.t = 0; t.dx = 1; t.dz = 0;
      t.id = objId('tree', t.x, t.z);
      this.byId.set(t.id, t);
      const k = Math.floor(t.x / CELL) + ',' + Math.floor(t.z / CELL);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(t);
    });
    const M = propMaterial();
    // пеньки: по одному на дерево, пока дерево стоит — нулевого размера
    const stump = merge([
      part(new THREE.CylinderGeometry(0.3, 0.4, 0.5, 7, 1, true), 0x7a5236, { m: T(0, 0.25, 0) }),
      part(new THREE.CircleGeometry(0.3, 7), 0xd9b98a, { m: new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.5, 0) }),
    ]);
    this.stumps = new THREE.InstancedMesh(stump, M, trees.length);
    const logGeo = merge([
      part(new THREE.CylinderGeometry(0.13, 0.13, 0.62, 6, 1, true), 0x7a5236, { m: new THREE.Matrix4().makeRotationZ(Math.PI / 2) }),
      part(new THREE.CircleGeometry(0.13, 6), 0xd9b98a, { m: new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0.31, 0, 0) }),
      part(new THREE.CircleGeometry(0.13, 6), 0xd9b98a, { m: new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-0.31, 0, 0) }),
    ]);
    this.logs = new THREE.InstancedMesh(logGeo, M, LOGS * 3); // одновременно летящих брёвен
    this.flying = [];
    const white = new THREE.Color(1, 1, 1);
    for (const im of [this.stumps, this.logs]) {
      for (let i = 0; i < im.count; i++) { im.setMatrixAt(i, ZERO); im.setColorAt(i, white); }
      im.frustumCulled = false; im.matrixAutoUpdate = false;
      scene.add(im);
    }
    // срубленные раньше (этим или другими игроками) — сразу пеньки
    const snap = world.snapshot();
    for (const id in snap.cut) { const t = this.byId.get(id); if (t) this.setCut(t, snap.cut[id], false); }
    world.on((ev) => {
      if (ev.type !== 'chopped') return;
      const t = this.byId.get(ev.id);
      if (!t) return;
      if (ev.by === world.me) t.reward = ev.reward; // брёвна отдадим, когда дерево упадёт
      this.setCut(t, ev.at, true);
    });
  }

  // дерево срублено в момент at: animate — уронить (видно, как падает), иначе сразу пенёк
  setCut(t, at, animate) {
    t.cutAt = at;
    if (t.col && t.r0 === undefined) t.r0 = t.col.r;
    if (t.col) t.col.r = -10; // ствол больше не мешает пройти
    this.stump(t, true);
    if (animate && (t.state === 'idle' || t.state === 'shake')) { t.state = 'fall'; t.t = 0; }
    else { t.state = 'gone'; this.place(t, 0, 0); }
    if (!this.busy.includes(t)) this.busy.push(t);
  }

  // ближайшее стоящее дерево, до ствола которого можно дотянуться
  find() {
    const p = this.player.pos, cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    let best = null, bd = 1e9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.cells.get((cx + a) + ',' + (cz + b));
      if (!list) continue;
      for (const t of list) {
        if (t.state !== 'idle' && t.state !== 'shake') continue;
        const d = Math.hypot(t.x - p.x, t.z - p.z) - 0.4 * t.s;
        if (d < REACH && d < bd && Math.abs(t.y - p.y) < 2.5) { bd = d; best = t; }
      }
    }
    return best;
  }

  // ставим экземпляр дерева: наклон на угол tilt в сторону (dx,dz), масштаб k от полного
  place(t, tilt, k) {
    _q.setFromAxisAngle(_ax.set(t.dz, 0, -t.dx), tilt).multiply(_qy.setFromAxisAngle(UP, t.rot));
    _m.compose(_p.set(t.x, t.y, t.z), _q, _s.setScalar(Math.max(1e-4, t.s * k)));
    t.mesh.setMatrixAt(t.i, _m);
    t.mesh.instanceMatrix.needsUpdate = true;
  }
  stump(t, on) {
    _m.compose(_p.set(t.x, t.y + 0.05, t.z), _qy.setFromAxisAngle(UP, t.rot), _s.setScalar(on ? t.s : 1e-4));
    this.stumps.setMatrixAt(this.trees.indexOf(t), on ? _m : ZERO);
    this.stumps.instanceMatrix.needsUpdate = true;
  }

  hit(t) {
    const pl = this.player, dx = t.x - pl.pos.x, dz = t.z - pl.pos.z, d = Math.hypot(dx, dz) || 1;
    pl.facing = Math.atan2(dx, dz);
    pl.swingT = SWING;
    this.cd = SWING;
    this.pending = { t, at: SWING * 0.42, dx: dx / d, dz: dz / d }; // удар приходится на середину взмаха
  }
  land({ t, dx, dz }) {
    if (t.state !== 'idle' && t.state !== 'shake') return;
    t.dx = dx; t.dz = dz; t.t = 0;
    t.state = 'shake';
    if (!this.busy.includes(t)) this.busy.push(t);
    // последний удар: просим мир срубить дерево; ответ (setCut) уронит его
    if (--t.hp <= 0) { t.hp = HITS; this.world.send({ type: 'chop', id: t.id }); }
  }
  drop(t) {
    const r = t.reward; t.reward = null;
    if (!r) return; // рубил не я — брёвна не мои
    const n = r.log || 0, left = this.inv.add('log', n);
    this.toast(left === 0 ? `+${n} 🪵 Бревно` : left < n ? `+${n - left} 🪵 — инвентарь полон` : 'Инвентарь полон');
    for (let i = 0; i < n; i++) {
      const a = i * 2.1 + t.rot;
      this.flying.push({ t: -i * 0.07, x: t.x + t.dx * (0.6 + i * 0.5), y: t.y + 0.6, z: t.z + t.dz * (0.6 + i * 0.5), vx: Math.cos(a) * 1.6, vz: Math.sin(a) * 1.6, rot: a });
    }
  }

  update(dt, want) {
    const pl = this.player;
    const can = pl.held === 'axe' && pl.grounded && !pl.climbing && !pl.swimming;
    this.target = can ? this.find() : null;
    this.cd -= dt;
    if (this.pending && (this.pending.at -= dt) <= 0) { this.land(this.pending); this.pending = null; }
    if (want && this.target && this.cd <= 0) this.hit(this.target);

    for (let n = this.busy.length - 1; n >= 0; n--) {
      const t = this.busy[n];
      t.t += dt;
      if (t.state === 'shake') {
        // дрожь от удара: быстро затухающее качание от героя
        const k = Math.max(0, 1 - t.t / 0.3);
        this.place(t, Math.sin(t.t * 42) * 0.07 * k * k + 0.03 * k, 1);
        if (k === 0) { t.state = 'idle'; this.busy.splice(n, 1); }
      } else if (t.state === 'fall') {
        // падает от героя, ускоряясь; у земли съёживается и пропадает
        const k = Math.min(1, t.t / FALL);
        this.place(t, 1.5 * k * k, 1 - Math.max(0, (k - 0.75) / 0.25) ** 2);
        if (k === 1) { t.state = 'gone'; this.place(t, 0, 0); this.drop(t); }
      } else if (t.state === 'gone') {
        // вырастает по общим часам мира — у всех игроков в один момент; не прямо на герое
        if (this.world.now() - t.cutAt > RULES.tree.regrowMs(t.id) && Math.hypot(t.x - pl.pos.x, t.z - pl.pos.z) > 2.5) { t.state = 'grow'; t.t = 0; }
      } else if (t.state === 'grow') {
        // саженец вытягивается из пенька с лёгким «пружинящим» перелётом
        const k = Math.min(1, t.t / GROW), e = 1 - (1 - k) ** 3;
        this.place(t, 0, e * (1 + 0.12 * Math.sin(k * Math.PI)));
        if (k === 1) {
          t.state = 'idle'; t.hp = HITS;
          if (t.col) t.col.r = t.r0;
          t.cutAt = undefined;
          this.stump(t, false);
          this.busy.splice(n, 1);
        }
      }
    }

    // брёвна: подпрыгивают из ствола и летят в руки
    if (this.flying.length || this.logsShown) {
      const tgtY = pl.pos.y + 0.8;
      for (let i = 0; i < this.logs.count; i++) {
        const f = this.flying[i];
        if (!f) { this.logs.setMatrixAt(i, ZERO); continue; }
        f.t += dt;
        const k = Math.max(0, f.t) / FLY, pop = Math.min(1, k / 0.5), home = Math.max(0, (k - 0.5) / 0.5) ** 2;
        const x = f.x + f.vx * pop * 0.5, z = f.z + f.vz * pop * 0.5, y = f.y + Math.sin(pop * Math.PI * 0.5) * 1.2 - pop * 0.5;
        _e.set(f.rot + k * 5, f.rot, 0);
        _m.compose(_p.set(x + (pl.pos.x - x) * home, y + (tgtY - y) * home, z + (pl.pos.z - z) * home), _q.setFromEuler(_e), _s.setScalar(f.t < 0 ? 1e-4 : 1 - home * 0.7));
        this.logs.setMatrixAt(i, _m);
      }
      this.flying = this.flying.filter((f) => f.t < FLY);
      this.logsShown = this.flying.length > 0;
      this.logs.instanceMatrix.needsUpdate = true;
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _e = new THREE.Euler();
