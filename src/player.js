import * as THREE from '../vendor/three.min.js';
import { heightAt, normalAt, shadowAtCPU } from './terrain.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mat } from './shaders.js';

// ---------- модель исследователя: жёлтый дождевик, рюкзак, фонарик ----------
function buildModel() {
  const M = propMaterial();
  const root = new THREE.Group();
  const coat = 0xf2b632, coatD = 0xd9952a, skin = 0xf6cfae, dark = 0x34405e, boot = 0x5a3b2c, bag = 0x9a5f3c;
  const sph = (r, w = 10, h = 7) => new THREE.SphereGeometry(r, w, h);
  const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 3, 8);
  const mesh = (g) => { const m = new THREE.Mesh(g, M); m.frustumCulled = false; return m; };
  const C = new THREE.Vector3();

  const body = mesh(merge([
    part(new THREE.CylinderGeometry(0.2, 0.34, 0.62, 10), coat, { m: T(0, 0.78, 0), round: C.set(0, 0.7, 0).clone() }),
    part(sph(0.21), coat, { m: T(0, 1.07, 0, 1, 0.7, 1), round: C.set(0, 1.0, 0).clone() }),
    part(new THREE.TorusGeometry(0.335, 0.035, 5, 12), coatD, { m: new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.48, 0) }),
    // рюкзак со спальником и фонариком
    part(new THREE.BoxGeometry(0.36, 0.4, 0.2), bag, { m: T(0, 0.86, -0.27) }),
    part(new THREE.CylinderGeometry(0.09, 0.09, 0.42, 8), 0x6f8f5a, { m: T(0, 1.11, -0.27, 1, 1, 1, 0, Math.PI / 2) }),
    part(sph(0.06, 6, 5), 0xfff3b0, { glow: 1, m: T(0.2, 0.74, -0.34) }),
  ]));
  root.add(body);

  const head = new THREE.Group();
  head.position.set(0, 1.2, 0);
  head.add(mesh(merge([
    part(sph(0.25, 12, 9), skin, { m: T(0, 0.2, 0), round: C.set(0, 0.2, 0).clone() }),
    // капюшон
    part(new THREE.SphereGeometry(0.285, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), coat, { m: new THREE.Matrix4().makeRotationX(-0.5).setPosition(0, 0.22, -0.03), round: C.set(0, 0.2, 0).clone() }),
    part(new THREE.ConeGeometry(0.08, 0.2, 6), coatD, { m: new THREE.Matrix4().makeRotationX(-1.2).setPosition(0, 0.46, -0.17) }),
    part(sph(0.036, 6, 5), 0x2a2330, { m: T(-0.09, 0.2, 0.225, 1, 1.3, 0.6) }),
    part(sph(0.036, 6, 5), 0x2a2330, { m: T(0.09, 0.2, 0.225, 1, 1.3, 0.6) }),
    part(sph(0.045, 6, 5), 0xf2a593, { m: T(-0.15, 0.13, 0.19, 1, 0.6, 0.5) }),
    part(sph(0.045, 6, 5), 0xf2a593, { m: T(0.15, 0.13, 0.19, 1, 0.6, 0.5) }),
  ])));
  root.add(head);

  const limb = (x, y, geo) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    g.add(mesh(geo));
    root.add(g);
    return g;
  };
  const armGeo = merge([
    part(cap(0.075, 0.26), coat, { m: T(0, -0.2, 0), round: C.set(0, -0.2, 0).clone() }),
    part(sph(0.075, 7, 5), skin, { m: T(0, -0.42, 0) }),
  ]);
  const legGeo = merge([
    part(cap(0.085, 0.2), dark, { m: T(0, -0.2, 0), round: C.set(0, -0.2, 0).clone() }),
    part(sph(0.11, 8, 5), boot, { m: T(0, -0.4, 0.04, 1, 0.75, 1.35) }),
  ]);
  const armL = limb(-0.27, 1.06, armGeo), armR = limb(0.27, 1.06, armGeo);
  const legL = limb(-0.12, 0.5, legGeo), legR = limb(0.12, 0.5, legGeo);
  armL.rotation.z = -0.18; armR.rotation.z = 0.18;
  return { root, body, head, armL, armR, legL, legR };
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
const MAX_SLOPE = 1.25; // подъём круче ~51° не взять

export class Player {
  constructor(scene, spawn, colliders) {
    this.pos = new THREE.Vector3(spawn.x, heightAt(spawn.x, spawn.z), spawn.z);
    this.vel = new THREE.Vector3();
    this.grounded = true;
    this.facing = Math.atan2(-spawn.x, -spawn.z);
    this.safe = this.pos.clone();
    this.safeT = 0; this.airT = 0; this.phase = 0; this.speed = 0; this.landT = 0;
    this.m = buildModel();
    scene.add(this.m.root);
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
      if (ok(nx, p.z)) nz = p.z; else if (ok(p.x, nz)) nx = p.x; else { this.vel.x *= 0.5; this.vel.z *= 0.5; return; }
    }
    p.x = nx; p.z = nz;
    if (this.grounded) {
      const h = heightAt(nx, nz);
      if (h < p.y - Math.max(0.3, step * 1.6)) this.grounded = false; // шагнули с обрыва
      else p.y = h;
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
    const ml = Math.min(1, Math.hypot(mx, mz));
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
    }

    // запоминаем безопасное место для возврата после падения в колодец
    if (this.grounded && this.n.y > 0.9 && p.y > -118) {
      this.safeT += dt;
      if (this.safeT > 0.6) { this.safe.copy(p); this.safeT = 0; }
    }

    // ---- анимация ----
    const sp = Math.hypot(v.x, v.z);
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    if (ml > 0.05 && sp > 0.3) {
      let d = Math.atan2(v.x, v.z) - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.facing += d * Math.min(1, dt * 12);
    }
    const m = this.m, run = Math.min(1, this.speed / RUN);
    this.phase += dt * (4 + this.speed * 1.55);
    this.landT = Math.max(0, this.landT - dt * 4);
    const sw = Math.sin(this.phase) * (0.25 + run * 0.95) * Math.min(1, this.speed / 1.5);
    const t = performance.now() / 1000;
    m.root.position.copy(p);
    m.root.rotation.y = this.facing;
    if (this.grounded) {
      m.legL.rotation.x = sw; m.legR.rotation.x = -sw;
      m.armL.rotation.x = -sw * 0.85; m.armR.rotation.x = sw * 0.85;
      m.root.position.y += Math.abs(Math.cos(this.phase)) * 0.07 * Math.min(1, this.speed / 2) + Math.sin(t * 2) * 0.008;
      m.body.rotation.x = run * 0.22;
      m.root.scale.set(1 + this.landT * 0.14, 1 - this.landT * 0.2, 1 + this.landT * 0.14);
    } else {
      const up = v.y > 0 ? 1 : 0.4;
      m.legL.rotation.x = 0.5 * up; m.legR.rotation.x = -0.35;
      m.armL.rotation.x = m.armR.rotation.x = -2.4 * up - 0.4;
      m.body.rotation.x = 0.1;
      m.root.scale.set(0.95, 1.07, 0.95);
    }
    m.head.rotation.x = Math.sin(t * 1.3) * 0.03 - run * 0.08;

    // тень-пятно под ногами
    const gh = heightAt(p.x, p.z), above = p.y - gh;
    normalAt(p.x, p.z, this.n, 0.4);
    this.shadow.position.set(p.x, gh + 0.04, p.z);
    this.shadow.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.n);
    const ss = 0.5 + Math.min(1.2, above * 0.12);
    this.shadow.scale.set(ss, 1, ss);
    this.shadow.material.uniforms.uA.value = 0.42 * Math.max(0.15, 1 - above * 0.08) * (0.35 + 0.65 * shadowAtCPU(p.x, p.z));
  }

  respawn() {
    this.pos.copy(this.safe);
    this.vel.set(0, 0, 0);
    this.grounded = true;
  }
}
