import * as THREE from '../vendor/three.min.js';
import { heightAt, normalAt, shadowAtCPU } from './terrain.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mat } from './shaders.js';

// ---------- герой: «глубинник» ----------
// Большая голова, выпученные глаза разного размера, один зуб, фонарик-удочка на макушке,
// тонкие руки и крошечные ноги. Отдельные голова / туловище / руки / ступни —
// это будущие слоты брони и скинов. Цвет тела — параметр.
export const SKIN_COLORS = [0xff7a52, 0x58d3ae, 0x6fb1ff, 0xb48bff, 0xffc93a, 0xa3dc4c];

function buildModel(look) {
  const M = propMaterial();
  const skin = new THREE.Color(look.color);
  const dark = skin.clone().multiplyScalar(0.72).getHex();
  const belly = skin.clone().lerp(new THREE.Color(0xfff6e0), 0.72).getHex();
  const body = skin.getHex();
  const steel = 0xa9b3bd, steelD = 0x7d8791, gold = 0xe7b43c, leather = 0x8a5a3a;
  const sph = (r = 1, w = 12, h = 9) => new THREE.SphereGeometry(r, w, h);
  const R = (x, y, z) => new THREE.Vector3(x, y, z);
  const mesh = (parts) => { const m = new THREE.Mesh(merge(parts), M); m.frustumCulled = false; return m; };
  const rotX = (a, x, y, z, sx = 1, sy = sx, sz = sx) => new THREE.Matrix4().compose(
    R(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)), R(sx, sy, sz));
  const A = look.armor;

  const root = new THREE.Group();
  const rig = new THREE.Group(); // раскачка и сплющивание, не трогая направление
  root.add(rig);

  // --- туловище-груша ---
  const torso = [
    part(sph(1, 18, 12), body, { m: T(0, 0.62, 0, 0.3, 0.33, 0.27), round: R(0, 0.6, 0) }),
    part(sph(1, 18, 12), belly, { m: T(0, 0.57, 0.12, 0.21, 0.23, 0.175), round: R(0, 0.57, 0.02) }),
    part(sph(1, 7, 5), body, { m: T(0, 0.44, -0.27, 0.085), round: R(0, 0.44, -0.25) }), // хвостик
  ];
  for (const [x, y, s] of [[-0.1, 0.78, 0.07], [0.09, 0.66, 0.06], [-0.04, 0.55, 0.05]]) // пятна на спине
    torso.push(part(sph(1, 7, 5), dark, { m: T(x, y, -0.235 - (0.7 - y) * 0.06, s, s, 0.03), round: R(x, y, 0) }));
  if (A) {
    torso.push(
      part(sph(1, 12, 8), steel, { m: T(0, 0.71, 0, 0.335, 0.25, 0.305), round: R(0, 0.68, 0) }),
      part(new THREE.TorusGeometry(0.315, 0.03, 5, 14), gold, { m: rotX(Math.PI / 2, 0, 0.56, 0, 1, 0.93, 1) }),
      part(new THREE.OctahedronGeometry(0.075, 0), gold, { m: T(0, 0.74, 0.295, 1, 1.25, 0.35) }),
    );
  } else {
    torso.push(
      part(new THREE.TorusGeometry(0.29, 0.028, 5, 14), leather, { m: rotX(Math.PI / 2 + 0.12, 0, 0.5, 0, 1, 0.92, 1) }),
      part(new THREE.BoxGeometry(0.13, 0.13, 0.08), 0xa06c44, { m: T(0.24, 0.46, 0.12, 1, 1, 1, 0.9) }),
    );
  }
  const torsoM = mesh(torso);
  rig.add(torsoM);

  // --- голова ---
  const head = new THREE.Group();
  head.position.set(0, 0.9, 0);
  const hc = R(0, 0.3, 0);
  const hp = [
    part(sph(1, 16, 12), body, { m: T(0, 0.3, 0, 0.42, 0.34, 0.36), round: hc }),
    part(new THREE.ConeGeometry(0.085, 0.2, 6), body, { m: T(-0.4, 0.4, -0.02, 1, 1, 0.6, 0, 1.0), round: R(-0.36, 0.36, 0) }),
    part(new THREE.ConeGeometry(0.085, 0.2, 6), body, { m: T(0.4, 0.4, -0.02, 1, 1, 0.6, 0, -1.0), round: R(0.36, 0.36, 0) }),
    // рот с одним зубом
    part(new THREE.CircleGeometry(0.1, 10, Math.PI, Math.PI), 0x4a1f33, { m: rotX(0.55, 0, 0.19, 0.348) }),
    part(new THREE.BoxGeometry(0.05, 0.055, 0.02), 0xffffff, { m: rotX(0.5, -0.03, 0.166, 0.343) }),
    part(sph(1, 7, 5), 0xff9f8a, { m: T(-0.27, 0.2, 0.235, 0.06, 0.035, 0.02), round: R(-0.27, 0.2, 0.2) }),
    part(sph(1, 7, 5), 0xff9f8a, { m: T(0.27, 0.2, 0.235, 0.06, 0.035, 0.02), round: R(0.27, 0.2, 0.2) }),
  ];
  if (A) {
    // шлем-котелок с рожками; фонарик торчит сквозь него
    hp.push(
      part(new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), steel, { m: T(0, 0.43, -0.01, 0.445, 0.27, 0.39), round: R(0, 0.36, 0) }),
      part(new THREE.TorusGeometry(0.44, 0.035, 5, 16), gold, { m: rotX(Math.PI / 2, 0, 0.43, -0.01, 1, 0.88, 1) }),
      part(new THREE.ConeGeometry(0.06, 0.2, 6), 0xfff1d6, { m: T(-0.36, 0.62, -0.01, 1, 1, 1, 0, 0.7) }),
      part(new THREE.ConeGeometry(0.06, 0.2, 6), 0xfff1d6, { m: T(0.36, 0.62, -0.01, 1, 1, 1, 0, -0.7) }),
    );
  }
  head.add(mesh(hp));
  rig.add(head);

  // глаза: белки отдельно (моргание), зрачки отдельно (болтаются)
  const eyes = new THREE.Group();
  eyes.position.set(0, 0.37, 0.29);
  eyes.add(mesh([
    part(sph(0.128, 12, 9), 0xffffff, { m: T(-0.155, 0, 0), round: R(-0.155, 0, -0.05) }),
    part(sph(0.104, 12, 9), 0xffffff, { m: T(0.15, -0.01, 0.005), round: R(0.15, -0.01, -0.05) }),
  ]));
  const pupils = mesh([
    part(sph(0.058, 8, 6), 0x1d1a26, { m: T(-0.155, 0, 0.112, 1, 1, 0.45) }),
    part(sph(0.047, 8, 6), 0x1d1a26, { m: T(0.15, -0.01, 0.095, 1, 1, 0.45) }),
    part(sph(0.017, 5, 4), 0xffffff, { glow: 1, m: T(-0.135, 0.022, 0.137) }),
    part(sph(0.014, 5, 4), 0xffffff, { glow: 1, m: T(0.166, 0.008, 0.115) }),
  ]);
  eyes.add(pupils);
  head.add(eyes);

  // фонарик-удочка на пружинке
  const lure = new THREE.Group();
  lure.position.set(0, 0.62, 0.04);
  lure.add(mesh([
    part(new THREE.CylinderGeometry(0.016, 0.022, 0.24, 5), dark, { m: rotX(0.25, 0, 0.11, 0.03) }),
    part(new THREE.CylinderGeometry(0.013, 0.016, 0.16, 5), dark, { m: rotX(1.05, 0, 0.255, 0.125) }),
    part(sph(0.07, 9, 7), 0xfff2a8, { glow: 1, m: T(0, 0.27, 0.22) }),
  ]));
  head.add(lure);

  // --- руки-макаронины и ноги-коротышки ---
  const limb = (x, y, parts) => { const g = new THREE.Group(); g.position.set(x, y, 0); g.add(mesh(parts)); rig.add(g); return g; };
  const arm = (sx) => {
    const p = [
      part(new THREE.CapsuleGeometry(0.048, 0.27, 3, 7), body, { m: T(0, -0.19, 0), round: R(0, -0.19, 0) }),
      part(sph(0.088, 9, 7), body, { m: T(0, -0.41, 0), round: R(0, -0.41, 0) }),
      part(sph(0.04, 6, 4), body, { m: T(sx * 0.02, -0.4, 0.085), round: R(0, -0.41, 0) }), // большой палец
    ];
    if (A) p.push(
      part(sph(0.115, 9, 6), steel, { m: T(sx * 0.02, -0.02, 0, 1, 0.8, 1), round: R(0, -0.06, 0) }),
      part(new THREE.CylinderGeometry(0.095, 0.085, 0.1, 8), steelD, { m: T(0, -0.31, 0) }),
    );
    return p;
  };
  const leg = () => {
    const p = [
      part(new THREE.CapsuleGeometry(0.07, 0.1, 3, 7), body, { m: T(0, -0.12, 0), round: R(0, -0.12, 0) }),
      part(sph(1, 9, 6), dark, { m: T(0, -0.265, 0.05, 0.125, 0.078, 0.185), round: R(0, -0.3, 0.05) }),
    ];
    if (A) p.push(
      part(sph(1, 9, 6), steel, { m: T(0, -0.25, 0.05, 0.14, 0.095, 0.2), round: R(0, -0.3, 0.05) }),
      part(sph(1, 7, 5), gold, { m: T(0, -0.26, 0.2, 0.08, 0.06, 0.06), round: R(0, -0.26, 0.17) }),
    );
    return p;
  };
  const armL = limb(-0.29, 0.82, arm(-1)), armR = limb(0.29, 0.82, arm(1));
  const legL = limb(-0.13, 0.345, leg()), legR = limb(0.13, 0.345, leg());
  return { root, rig, body: torsoM, head, eyes, pupils, lure, armL, armR, legL, legR };
}

function blobShadow() {
  const m = mat({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { uA: { value: 0.4 } },
    vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uA; varying vec2 vP; void main(){ gl_FragColor = vec4(0.05,0.08,0.15, uA*smoothstep(1.0,0.2,length(vP))); }`,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), m);
  mesh.renderOrder = 1;
  return mesh;
}

const WALK = 5.2, RUN = 8.6, GRAV = 27, JUMP = 9.4;
const MAX_SLOPE = 1.25; // подъём круче ~51° пешком не взять — только карабкаться
const CLIMB = 2.5, STEEP = 0.72;

export class Player {
  constructor(scene, spawn, colliders) {
    this.pos = new THREE.Vector3(spawn.x, heightAt(spawn.x, spawn.z), spawn.z);
    this.vel = new THREE.Vector3();
    this.grounded = true;
    this.facing = Math.atan2(-spawn.x, -spawn.z);
    this.safe = this.pos.clone();
    this.safeT = 0; this.airT = 0; this.phase = 0; this.speed = 0; this.landT = 0;
    this.scene = scene;
    this.look = { color: SKIN_COLORS[0], armor: false };
    this.m = buildModel(this.look);
    scene.add(this.m.root);
    this.climbing = false; this.stamina = 100; this.climbCd = 0; this.climbPhase = 0; this.climbLean = 0; this.wantClimb = false;
    this.lureA = 0; this.lureV = 0; this.lureB = 0; this.lureBV = 0; this.pvy = 0;
    this.blinkT = 2; this.gazeT = 0; this.gaze = 0; this.px = 0; this.py = 0; this.waddle = 0;
    this.shadow = blobShadow();
    scene.add(this.shadow);
    this.n = new THREE.Vector3();
    // сетка для быстрых столкновений со стволами и валунами
    this.cells = new Map();
    for (const c of colliders) {
      const k = ((c.x / 8) | 0) + ',' + ((c.z / 8) | 0);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(c);
    }
  }

  tryMove(dx, dz) {
    const p = this.pos;
    const step = Math.hypot(dx, dz);
    if (step < 1e-6) return;
    const ok = (x, z) => {
      const h = heightAt(x, z);
      return this.grounded ? h - p.y <= Math.max(0.1, Math.hypot(x - p.x, z - p.z) * MAX_SLOPE) : h <= p.y + 0.3;
    };
    let nx = p.x + dx, nz = p.z + dz;
    if (!ok(nx, nz)) {
      if (this.wantClimb && this.tryGrab(nx, nz, dx / step, dz / step)) return;
      if (ok(nx, p.z)) nz = p.z; else if (ok(p.x, nz)) nx = p.x; else { this.vel.x *= 0.5; this.vel.z *= 0.5; return; }
    }
    p.x = nx; p.z = nz;
    if (this.grounded) {
      const h = heightAt(nx, nz);
      if (h < p.y - Math.max(0.3, step * 1.6)) this.grounded = false; // шагнули с обрыва
      else p.y = h;
    }
  }

  // Упёрлись в крутую стену и жмём в её сторону — хватаемся
  tryGrab(x, z, dx, dz) {
    const n = normalAt(x, z, this.n, 0.35), hl = Math.hypot(n.x, n.z);
    if (n.y >= STEEP || hl < 1e-3) return false;
    if ((-n.x * dx - n.z * dz) / hl < 0.45) return false; // идём вдоль стены, а не в неё
    const h = heightAt(x, z);
    if (h - this.pos.y > 1.8) return false;
    this.pos.set(x, Math.max(h, this.pos.y), z);
    this.climbing = true; this.grounded = false;
    this.vel.set(0, 0, 0);
    return true;
  }

  // Лазание: стик вверх/вниз — по стене, влево/вправо — вбок. Тратит выносливость.
  climbStep(dt, inp) {
    const p = this.pos, v = this.vel;
    const n = normalAt(p.x, p.z, this.n, 0.35), hl = Math.hypot(n.x, n.z);
    if (n.y > 0.8 || hl < 1e-3) { // вылезли на ровное
      this.climbing = false; this.grounded = true; p.y = heightAt(p.x, p.z);
      return;
    }
    const ux = -n.x / hl, uz = -n.z / hl; // вверх по склону (в плане)
    const mvx = ux * inp.my * n.y - uz * inp.mx, mvz = uz * inp.my * n.y + ux * inp.mx;
    const amt = Math.min(1, Math.hypot(inp.mx, inp.my));
    p.x += mvx * CLIMB * dt; p.z += mvz * CLIMB * dt;
    this.collide();
    p.y = heightAt(p.x, p.z);
    this.facing = Math.atan2(ux, uz);
    this.climbLean = Math.asin(Math.min(1, n.y));
    this.climbPhase += dt * amt * 7.5 * (inp.my < -0.3 ? -1 : 1);
    this.climbAmt = amt;
    this.stamina -= dt * (3 + 8 * amt);
    v.set(0, 0, 0);
    if (inp.jump) { // оттолкнуться от стены
      this.climbing = false; this.climbCd = 0.35; this.airT = 1;
      v.set(n.x / hl * 4.5, 7.5, n.z / hl * 4.5);
    } else if (this.stamina <= 0) { // силы кончились — срываемся
      this.stamina = 0; this.climbing = false; this.climbCd = 1.2; this.airT = 1;
      v.set(n.x / hl * 2, 0, n.z / hl * 2);
    }
  }

  collide() {
    const p = this.pos, cx = (p.x / 8) | 0, cz = (p.z / 8) | 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.cells.get((cx + a) + ',' + (cz + b));
      if (!list) continue;
      for (const c of list) {
        const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), R = c.r + 0.3;
        if (d < R && d > 1e-4) { p.x += (dx / d) * (R - d); p.z += (dz / d) * (R - d); }
      }
    }
  }

  update(dt, inp, camYaw) {
    const p = this.pos, v = this.vel;
    // желаемая скорость относительно камеры
    const s = Math.sin(camYaw), c = Math.cos(camYaw);
    const mx = inp.mx * c - inp.my * s, mz = -inp.mx * s - inp.my * c;
    const ml = this.climbing ? 0 : Math.min(1, Math.hypot(mx, mz));
    this.climbCd = Math.max(0, this.climbCd - dt);
    this.wantClimb = ml > 0.4 && this.stamina > 15 && this.climbCd <= 0;
    if (this.climbing) this.climbStep(dt, inp); else {
    const top = inp.sprint ? RUN : WALK;
    const k = Math.min(1, dt * (this.grounded ? 11 : 2.5));
    v.x += (mx * top - v.x) * k; v.z += (mz * top - v.z) * k;

    // на крутом склоне съезжаем вниз
    if (this.grounded) {
      normalAt(p.x, p.z, this.n, 0.35);
      if (this.n.y < 0.74) { v.x += this.n.x * 22 * dt; v.z += this.n.z * 22 * dt; }
    }
    if (inp.jump && (this.grounded || this.airT < 0.12) && v.y <= 0.01) {
      v.y = JUMP; this.grounded = false; this.airT = 1;
    }

    const dist = Math.hypot(v.x, v.z) * dt, n = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i < n; i++) this.tryMove((v.x * dt) / n, (v.z * dt) / n);
    this.collide();

    if (!this.grounded) {
      this.airT += dt;
      v.y -= GRAV * dt;
      p.y += v.y * dt;
      const h = heightAt(p.x, p.z);
      if (p.y <= h) {
        p.y = h; this.grounded = true; this.airT = 0;
        this.landT = Math.min(1, -v.y / 22); v.y = 0;
      }
    } else {
      this.airT = 0; v.y = 0;
      const h = heightAt(p.x, p.z);
      if (p.y - h > 0.4) this.grounded = false; else p.y = h;
      if (this.n.y > 0.74) this.stamina = Math.min(100, this.stamina + 30 * dt);
    }
    }

    // запоминаем безопасное место для возврата после падения в колодец
    if (this.grounded && this.n.y > 0.9 && p.y > -20) {
      this.safeT += dt;
      if (this.safeT > 0.6) { this.safe.copy(p); this.safeT = 0; }
    }

    // ---- анимация: вразвалку, с болтающимися руками, глазами и фонариком ----
    const sp = Math.hypot(v.x, v.z);
    const prevSpeed = this.speed;
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    if (ml > 0.05 && sp > 0.3) {
      let d = Math.atan2(v.x, v.z) - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.facing += d * Math.min(1, dt * 12);
    }
    const m = this.m, run = Math.min(1, this.speed / RUN), mv = Math.min(1, this.speed / 1.5);
    const fast = Math.max(0, Math.min(1, (this.speed - WALK) / (RUN - WALK)));
    this.phase += dt * (5 + this.speed * 1.7);
    this.landT = Math.max(0, this.landT - dt * 3.2);
    const t = performance.now() / 1000;
    const sn = Math.sin(this.phase), cs = Math.cos(this.phase);
    const panic = !this.grounded && v.y < -9 ? 1 : 0;

    m.root.position.copy(p);
    m.root.rotation.y = this.facing;
    const rig = m.rig;
    rig.position.z = 0;
    if (this.climbing) {
      // перебираем руками и ногами по очереди, тело прижато к стене
      const a = Math.sin(this.climbPhase), b = Math.cos(this.climbPhase);
      m.armL.rotation.x = -2.5 + a * 0.6; m.armR.rotation.x = -2.5 - a * 0.6;
      m.armL.rotation.z = -0.22 - Math.max(0, -a) * 0.15; m.armR.rotation.z = 0.22 + Math.max(0, a) * 0.15;
      m.legL.rotation.x = -0.8 - a * 0.6; m.legR.rotation.x = -0.8 + a * 0.6;
      rig.rotation.set(this.climbLean, 0, a * 0.1);
      rig.position.set(0, Math.abs(b) * 0.07 * (this.climbAmt || 0), -0.26);
      rig.scale.set(1, 1, 1);
      m.head.rotation.x = -0.4; m.head.rotation.z = -a * 0.12;
      this.waddle = a * 0.1;
    } else if (this.grounded) {
      const sw = sn * (0.35 + run * 0.9) * mv;
      m.legL.rotation.x = sw * 1.25; m.legR.rotation.x = -sw * 1.25;
      // шагом руки машут, на бегу — отлетают назад и болтаются
      const back = fast * 1.25;
      m.armL.rotation.x = -sw * 1.1 * (1 - fast) + back + Math.sin(this.phase * 2.0) * 0.22 * fast;
      m.armR.rotation.x = sw * 1.1 * (1 - fast) + back + Math.sin(this.phase * 2.0 + 1.3) * 0.22 * fast;
      m.armL.rotation.z = -0.3 - fast * 0.45 - Math.abs(sn) * 0.1 * mv;
      m.armR.rotation.z = 0.3 + fast * 0.45 + Math.abs(sn) * 0.1 * mv;
      this.waddle = sn * (0.07 + 0.07 * run) * mv;
      rig.rotation.z = this.waddle;
      rig.rotation.x = run * 0.2 + fast * 0.12;
      rig.position.y = Math.abs(cs) * 0.075 * mv + Math.sin(t * 2.2) * 0.012;
      const sq = this.landT * 0.32 + Math.sin(t * 2.2) * 0.012;
      rig.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
      m.head.rotation.z = -this.waddle * 0.9 + Math.sin(t * 0.7) * 0.03 * (1 - mv);
      m.head.rotation.x = -run * 0.16 + this.landT * 0.35;
    } else {
      const up = v.y > 0 ? 1 : 0;
      m.legL.rotation.x = 0.7 * up + Math.sin(t * 22) * 0.5 * panic;
      m.legR.rotation.x = -0.5 * up - Math.sin(t * 22) * 0.5 * panic;
      // в прыжке руки вверх; в долгом падении — паника
      m.armL.rotation.x = m.armR.rotation.x = -2.7 + Math.sin(t * 26) * 0.45 * panic;
      m.armL.rotation.z = -0.5 - Math.cos(t * 26) * 0.4 * panic;
      m.armR.rotation.z = 0.5 + Math.cos(t * 26 + 1) * 0.4 * panic;
      rig.rotation.z *= 0.9;
      rig.rotation.x = up ? -0.12 : 0.22;
      rig.position.y = 0;
      const st = Math.min(0.16, Math.abs(v.y) * 0.012);
      rig.scale.set(1 - st * 0.5, 1 + st, 1 - st * 0.5);
      m.head.rotation.z = Math.sin(t * 18) * 0.06 * panic;
      m.head.rotation.x = up ? -0.2 : 0.18;
    }

    // фонарик: пружина, которую дёргают разгон, торможение и прыжки
    const acc = (this.speed - prevSpeed) / Math.max(dt, 1e-3);
    const vyAcc = (v.y - this.pvy) / Math.max(dt, 1e-3);
    this.pvy = v.y;
    this.lureV += (-70 * this.lureA - 5.5 * this.lureV - acc * 0.9 + vyAcc * 0.35 - sn * 14 * mv) * dt;
    this.lureA = Math.max(-1.1, Math.min(1.1, this.lureA + this.lureV * dt));
    this.lureBV += (-70 * this.lureB - 5.5 * this.lureBV + cs * 16 * mv) * dt;
    this.lureB = Math.max(-0.9, Math.min(0.9, this.lureB + this.lureBV * dt));
    m.lure.rotation.x = this.lureA;
    m.lure.rotation.z = this.lureB;

    // глаза: моргают, зрачки отстают от движения и иногда косятся по сторонам
    this.blinkT -= dt;
    if (this.blinkT < -0.13) this.blinkT = 1.5 + Math.random() * 3.5;
    const open = this.blinkT < 0 && !panic ? 0.12 : 1;
    const wide = 1 + panic * 0.22 + this.landT * 0.25;
    m.eyes.scale.set(wide, open * wide, 1);
    this.gazeT -= dt;
    if (this.gazeT < 0) { this.gazeT = 1.2 + Math.random() * 2.5; this.gaze = mv > 0.3 ? 0 : (Math.random() - 0.5) * 2; }
    const tx = this.gaze * 0.035 * (1 - mv) - this.waddle * 0.25;
    const ty = panic ? -0.035 : (-cs * 0.012 * mv - Math.max(-0.03, Math.min(0.03, v.y * 0.004)));
    this.px += (tx - this.px) * Math.min(1, dt * 9);
    this.py += (ty - this.py) * Math.min(1, dt * 9);
    m.pupils.position.set(this.px, this.py, 0);
    m.pupils.scale.setScalar(panic ? 0.6 : 1);

    // тень-пятно под ногами
    const gh = heightAt(p.x, p.z), above = p.y - gh;
    normalAt(p.x, p.z, this.n, 0.4);
    this.shadow.position.set(p.x, gh + 0.04, p.z);
    this.shadow.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.n);
    const ss = 0.5 + Math.min(1.2, above * 0.12);
    this.shadow.scale.set(ss, 1, ss);
    this.shadow.material.uniforms.uA.value = 0.42 * Math.max(0.15, 1 - above * 0.08) * (0.35 + 0.65 * shadowAtCPU(p.x, p.z));
  }

  // смена облика (цвет тела, броня) — задел под скины
  setLook(look) {
    Object.assign(this.look, look);
    const old = this.m.root;
    this.scene.remove(old);
    old.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.m = buildModel(this.look);
    this.m.root.visible = old.visible;
    this.scene.add(this.m.root);
  }

  respawn() {
    this.pos.copy(this.safe);
    this.vel.set(0, 0, 0);
    this.grounded = true; this.climbing = false; this.stamina = 100;
  }
}
