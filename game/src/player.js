import * as THREE from '../vendor/three.min.js';
import { heightAt, normalAt, shadowAtCPU, waterAt } from './terrain.js';
import { groundAt, hitSolid, ceiling } from './solids.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mat, U } from './shaders.js';
const _lp = new THREE.Vector3();

// ---------- герой: «глубинник» ----------
// Большая голова, выпученные глаза разного размера, один зуб, фонарик-удочка на макушке,
// тонкие руки и крошечные ноги. Отдельные голова / туловище / руки / ступни —
// это будущие слоты брони и скинов. Цвет тела — параметр.
export const SKIN_COLORS = [0xff7a52, 0xffc93a, 0xa3dc4c, 0x58d3ae, 0x6fb1ff, 0xb48bff, 0xff8fc0, 0xf1ece0];

export function buildModel(look) {
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
  if (look.beard) {
    // борода лопатой и усы — так выглядит строитель из лагеря
    const bc = 0xf1ece0, bd = 0xd9d2c2;
    hp.push(
      part(sph(1, 9, 7), bc, { m: T(0, 0.05, 0.27, 0.27, 0.24, 0.13), round: R(0, 0.1, 0.2) }),
      part(sph(1, 7, 5), bd, { m: T(-0.2, 0.13, 0.25, 0.13, 0.15, 0.1), round: R(-0.2, 0.15, 0.2) }),
      part(sph(1, 7, 5), bd, { m: T(0.2, 0.13, 0.25, 0.13, 0.15, 0.1), round: R(0.2, 0.15, 0.2) }),
      part(sph(1, 7, 5), bc, { m: T(-0.09, 0.2, 0.35, 0.1, 0.045, 0.05), round: R(-0.09, 0.2, 0.3) }),
      part(sph(1, 7, 5), bc, { m: T(0.09, 0.2, 0.35, 0.1, 0.045, 0.05), round: R(0.09, 0.2, 0.3) }),
      part(sph(1, 7, 5), bc, { m: T(-0.16, 0.52, 0.3, 0.1, 0.03, 0.04), round: R(-0.16, 0.5, 0.25) }), // брови
      part(sph(1, 7, 5), bc, { m: T(0.16, 0.5, 0.3, 0.09, 0.03, 0.04), round: R(0.16, 0.48, 0.25) }),
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
  // топорик в правой руке: виден, когда выбран в слоте
  const axe = mesh([
    part(new THREE.CylinderGeometry(0.02, 0.024, 0.5, 5), 0x8a5a3a, { m: rotX(Math.PI / 2, 0, -0.41, 0.2) }),
    part(new THREE.BoxGeometry(0.045, 0.2, 0.15), 0xb9c2cb, { m: T(0, -0.47, 0.4) }),
    part(new THREE.BoxGeometry(0.03, 0.24, 0.05), 0xe6ecf2, { m: T(0, -0.5, 0.33) }),
  ]);
  axe.visible = false;
  armR.add(axe);
  // кирка: та же рукоять, поперёк — изогнутый двузубый клюв
  const pickaxe = mesh([
    part(new THREE.CylinderGeometry(0.02, 0.025, 0.56, 5), 0x8a5a3a, { m: rotX(Math.PI / 2, 0, -0.41, 0.23) }),
    part(new THREE.BoxGeometry(0.05, 0.07, 0.07), 0x5a3824, { m: T(0, -0.41, 0.48) }),
    part(new THREE.ConeGeometry(0.035, 0.26, 5), 0xb9c2cb, { m: rotX(0.25, 0, -0.27, 0.5) }),
    part(new THREE.ConeGeometry(0.035, 0.26, 5), 0xb9c2cb, { m: rotX(Math.PI - 0.25, 0, -0.55, 0.5) }),
  ]);
  pickaxe.visible = false;
  armR.add(pickaxe);
  // копьё: длинное древко вперёд, листовидный наконечник и красная обмотка
  const spear = mesh([
    part(new THREE.CylinderGeometry(0.018, 0.022, 1.35, 5), 0x8a5a3a, { m: rotX(Math.PI / 2, 0, -0.41, 0.3) }),
    part(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 6), 0x5a3824, { m: rotX(Math.PI / 2, 0, -0.41, 0.96) }),
    part(new THREE.OctahedronGeometry(0.06, 0), 0xc8d1da, { m: T(0, -0.41, 1.1, 0.8, 0.4, 2.1) }),
    part(new THREE.BoxGeometry(0.012, 0.012, 0.09), 0xe5483a, { m: T(0.03, -0.44, 0.93) }),
  ]);
  spear.visible = false;
  armR.add(spear);
  const legL = limb(-0.13, 0.345, leg()), legR = limb(0.13, 0.345, leg());
  return { root, rig, body: torsoM, head, eyes, pupils, lure, armL, armR, legL, legR, axe, tools: { axe, pickaxe, spear } };
}

// мягкое свечение: точка, всегда повёрнутая к камере, складывается со сценой
function haloMat() {
  return mat({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPx: { value: 1 } },
    vertexShader: `uniform float uPx;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(uPx * 700.0 * (0.20 + 0.16 * uLure.w) / max(-mv.z, 0.3), 320.0);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `void main(){ float r = length(gl_PointCoord - 0.5) * 2.0;
      float a = (exp(-r * r * 9.0) * 0.38 + exp(-r * r * 2.5) * 0.13) * (0.25 + 0.75 * uLure.w) * (1.0 - smoothstep(0.85, 1.0, r));
      gl_FragColor = vec4(vec3(1.0, 0.85, 0.55) * a, 1.0); }`,
  });
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

export const SWING = 0.42; // длительность взмаха топором
const WALK = 5.2, RUN = 8.6, GRAV = 27, JUMP = 9.4;
// Пешком — до ~42°. Съезжать начинаем только круче ~46°, а останавливаемся положе ~40°:
// так герой не попадает в петлю «зашёл — съехал — зашёл», от которой его дёргало
const MAX_SLOPE = 0.9;
const SLIDE_IN = 1.05, SLIDE_OUT = 0.8;
const CLIMB = 2.5, STEEP = 0.77, SWIM = 2.6, SWIM_FAST = 4.0;
// толщина тела у стен: радиус, высота «стены» (круче ~65° на длине радиуса) и куда щупаем
const MANTLE_MIN = 0.45, MANTLE_MAX = 1.9; // перелезть можно уступ такой высоты, м
const BODY = 0.3, WALL_H = 0.66, FEEL = [[1, 0], [0.64, 0.77], [0.64, -0.77]];
const TURN = [0.5, -0.5, 1.0, -1.0].map((a) => [Math.cos(a), Math.sin(a)]);

export class Player {
  constructor(scene, spawn, colliders) {
    this.pos = new THREE.Vector3(spawn.x, heightAt(spawn.x, spawn.z), spawn.z);
    this.vel = new THREE.Vector3();
    this.grounded = true;
    this.facing = Math.atan2(-spawn.x, -spawn.z);
    this.safe = this.pos.clone();
    this.safeT = 0; this.airT = 0; this.phase = 0; this.speed = 0; this.landT = 0;
    this.scene = scene;
    this.look = { color: SKIN_COLORS[0], armor: false }; // броня появится вместе с крафтом
    this.m = buildModel(this.look);
    scene.add(this.m.root);
    this.swimming = false; this.swimT = 0; this.sliding = false;
    // «заклинило»: съезжаем, а с места не двигаемся (узкая крутая выемка) — тогда тут можно стоять
    this.wedge = new THREE.Vector3(1e9, 0, 0); this.stuckRef = new THREE.Vector3(); this.stuckT = 0; this.steepT = 0;
    // визуальное смещение модели: физика может «перескочить» (ступенька, хват за стену),
    // а картинка догоняет за десятую долю секунды — без рывков
    this.vOff = new THREE.Vector3();
    this.viewPos = this.pos.clone();
    this.climbing = false; this.climbCd = 0; this.climbPhase = 0; this.slideGrace = 0; this.pushT = 0; this.mantle = null; this.mantleCd = 0; this.climbLean = 0; this.canGrab = false; this.walkable = true;
    this.swingT = 0; this.held = null; // взмах инструментом (сек. до конца) и что в руке (id предмета)
    this.lureA = 0; this.lureV = 0; this.lureB = 0; this.lureBV = 0; this.pvy = 0;
    this.blinkT = 2; this.gazeT = 0; this.gaze = 0; this.px = 0; this.py = 0; this.waddle = 0;
    this.shadow = blobShadow();
    scene.add(this.shadow);
    // ореол вокруг лампочки фонарика; яркость — U.uLure.w
    this.halo = haloMat();
    this.haloPts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), this.halo);
    this.haloPts.frustumCulled = false;
    this.haloPts.renderOrder = 10;
    scene.add(this.haloPts);
    this.lureGlow = 0;
    this.n = new THREE.Vector3(); this._n2 = new THREE.Vector3();
    // сетка для быстрых столкновений со стволами и валунами
    this.cells = new Map();
    for (const c of colliders) {
      const k = ((c.x / 8) | 0) + ',' + ((c.z / 8) | 0);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(c);
    }
  }

  // опора под точкой (земля или твёрдый объект) и её наклон
  G(x, z) { return groundAt(x, z, this.pos.y); }
  N(x, z, out, e) {
    normalAt(x, z, out, e);
    groundAt(x, z, this.pos.y);
    if (hitSolid) out.set(0, 1, 0);
    return out;
  }

  // новое препятствие-круг (житель, постройка), появившееся после старта
  addCollider(c) {
    const k = ((c.x / 8) | 0) + ',' + ((c.z / 8) | 0);
    (this.cells.get(k) || this.cells.set(k, []).get(k)).push(c);
  }

  tryMove(dx, dz) {
    const p = this.pos;
    const step = Math.hypot(dx, dz);
    if (step < 1e-6) return;
    const ok = (x, z) => {
      const h = this.G(x, z);
      // допуск — доли миллиметра: раньше 1.5 см на каждый микрошаг давали на малой скорости
      // вползать на склоны под 60° и тут же съезжать обратно
      if (this.grounded) return h - p.y <= Math.hypot(x - p.x, z - p.z) * MAX_SLOPE + 0.0005 || (hitSolid && h - p.y <= 0.36);
      return h <= p.y + 0.3;
    };
    let nx = p.x + dx, nz = p.z + dz;
    // У героя есть толщина: перед отвесной стеной или боком валуна он останавливается
    // на BODY от неё, а не входит в камень по пояс. Щупаем вперёд и чуть в стороны.
    const wall = (x, z, ux, uz) => {
      for (const [c, s] of FEEL) {
        const qx = x + (ux * c - uz * s) * BODY, qz = z + (uz * c + ux * s) * BODY;
        if (this.G(qx, qz) - p.y > WALL_H) return true;
      }
      return false;
    };
    if (wall(nx, nz, dx / step, dz / step)) {
      // в стену — нет, вдоль неё — да: поворачиваем шаг, пока он не пойдёт по касательной
      let done = false;
      for (const [c, s] of TURN) {
        const tx = (dx * c - dz * s) * c, tz = (dz * c + dx * s) * c, tl = Math.hypot(tx, tz);
        if (wall(p.x + tx, p.z + tz, tx / tl, tz / tl) || !ok(p.x + tx, p.z + tz)) continue;
        nx = p.x + tx; nz = p.z + tz; done = true;
        break;
      }
      if (!done) { this.vel.x *= 0.5; this.vel.z *= 0.5; return; }
    }
    if (!ok(nx, nz)) {
      // Упёрлись: скользим вдоль склона/стены по горизонтали. Обходной шаг не должен
      // набирать высоту — иначе герой «лесенкой» вползал туда, куда прямо не пускает.
      const flat = (x, z) => ok(x, z) && this.G(x, z) - p.y <= Math.hypot(x - p.x, z - p.z) * 0.35 + 0.0005;
      let done = false;
      const n = normalAt(nx, nz, this._n2, 0.3), hl = Math.hypot(n.x, n.z);
      if (hl > 0.05) {
        const ux = -n.x / hl, uz = -n.z / hl, up = dx * ux + dz * uz;
        if (up > 0) {
          const tx = p.x + dx - ux * up, tz = p.z + dz - uz * up;
          if (flat(tx, tz)) { nx = tx; nz = tz; done = true; }
        }
      }
      if (!done) {
        if (flat(nx, p.z)) nz = p.z; else if (flat(p.x, nz)) nx = p.x; else { this.vel.x *= 0.5; this.vel.z *= 0.5; return; }
      }
    }
    p.x = nx; p.z = nz;
    if (this.grounded) {
      const h = this.G(nx, nz);
      if (h < p.y - Math.max(0.3, step * 1.6)) this.grounded = false; // шагнули с обрыва
      else {
        if (Math.abs(h - p.y) > step * MAX_SLOPE + 0.03) this.vOff.y += p.y - h; // ступенька
        p.y = h;
      }
    }
  }

  // Небольшой уступ (0.45–1.9 м) с ровным верхом: перелезаем сами, плавной дугой, без кнопки.
  // Условие — игрок давит в уступ и стоит у него вплотную; верх проверяем на 0.5 м вглубь,
  // чтобы не «запрыгнуть» на острый гребень или обрыв.
  tryMantle(mx, mz, ml) {
    if (!this.grounded || this.sliding || ml < 0.6 || this.mantleCd > 0 || this.speed > 1.6) return false;
    const p = this.pos, l = Math.hypot(mx, mz), ux = mx / l, uz = mz / l;
    for (let d = 0.25; d <= 0.95; d += 0.1) {
      const h = this.G(p.x + ux * d, p.z + uz * d);
      if (h - p.y < MANTLE_MIN) continue;
      if (h - p.y > MANTLE_MAX + 0.4) return false;
      // верхняя кромка найдена: смотрим площадку за ней
      const tx = p.x + ux * (d + 0.55), tz = p.z + uz * (d + 0.55), ty = this.G(tx, tz), up = ty - p.y;
      if (up < MANTLE_MIN || up > MANTLE_MAX) return false;
      this.N(tx, tz, this._n2, 0.35);
      if (this._n2.y < 0.75) return false;                          // наверху не ровно
      if (Math.abs(this.G(tx + ux * 0.4, tz + uz * 0.4) - ty) > 0.5) return false; // там обрыв или шип
      this.mantle = { sx: p.x, sy: p.y, sz: p.z, tx, ty, tz, t: 0, dur: 0.28 + up * 0.12 };
      this.mantleCd = 0.5; this.speed = 0;
      return true;
    }
    return false;
  }
  mantleStep(dt) {
    const m = this.mantle, p = this.pos;
    m.t += dt;
    const k = Math.min(1, m.t / m.dur), e = k * k * (3 - 2 * k);
    p.x = m.sx + (m.tx - m.sx) * e; p.z = m.sz + (m.tz - m.sz) * e;
    // дуга: сначала вверх, потом вперёд; в верхней точке чуть выше уступа
    p.y = m.sy + (m.ty - m.sy) * Math.min(1, k * 1.5) + Math.sin(k * Math.PI) * 0.35;
    this.vel.set(0, 0, 0); this.grounded = false; this.airT = 0.5;
    if (k >= 1) { this.mantle = null; this.grounded = true; p.y = this.G(p.x, p.z); this.airT = 0; }
  }

  // Упёрся в крутую стену и давит на неё: хватаемся сами (на уступах не нужно жать «Хват»
  // заново после каждой полки). Нужно ~0.3 с упора, чтобы случайное касание не цепляло.
  autoGrab(ml, dt) {
    if (!this.grounded || this.sliding || ml < 0.6 || this.climbCd > 0 || this.speed > 1.2) { this.pushT = 0; return false; }
    if ((this.pushT += dt) < 0.3) return false;
    this.pushT = 0;
    return !!this.findWall();
  }

  // Ищем рядом крутую стену, за которую можно схватиться (по кнопке «Хват»)
  findWall() {
    const p = this.pos, n = this.n;
    const dirs = [[Math.sin(this.facing), Math.cos(this.facing)]];
    this.N(p.x, p.z, n, 0.35);
    const hl = Math.hypot(n.x, n.z);
    if (hl > 0.08) dirs.push([-n.x / hl, -n.z / hl]); // в сторону подъёма
    for (const [dx, dz] of dirs) {
      for (let d = 0; d <= 1.25; d += 0.25) {
        const x = p.x + dx * d, z = p.z + dz * d;
        this.N(x, z, n, 0.35);
        if (n.y >= STEEP) continue;
        const dh = this.G(x, z) - p.y;
        if (dh > -0.6 && dh < 1.9) return { x, z };
      }
    }
    return null;
  }

  grab() {
    const w = this.findWall();
    if (!w) return false;
    const ox = this.pos.x, oy = this.pos.y, oz = this.pos.z;
    this.pos.set(w.x, this.G(w.x, w.z), w.z);
    this.vOff.x += ox - this.pos.x; this.vOff.y += oy - this.pos.y; this.vOff.z += oz - this.pos.z;
    this.climbing = true; this.grounded = false;
    this.vel.set(0, 0, 0);
    return true;
  }

  // Лазание: стик вверх/вниз — по стене, влево/вправо — вбок. Выносливости пока нет.
  climbStep(dt, inp) {
    const p = this.pos, v = this.vel;
    const n = this.N(p.x, p.z, this.n, 0.35), hl = Math.hypot(n.x, n.z);
    if (n.y > 0.8 || hl < 1e-3) { // вылезли на ровное
      this.climbing = false; this.grounded = true; p.y = this.G(p.x, p.z);
      // Мы стоим прямо на кромке: уклон «вниз от ног» тут огромный, и сразу включалось бы
      // скольжение вниз по той самой стене, на которую только что залезли. Отступаем
      // от края вглубь уступа и на секунду отключаем скольжение.
      if (hl > 1e-3) {
        const ix = -n.x / hl, iz = -n.z / hl;
        for (let d = 0.1; d <= 0.7; d += 0.1) {
          const qx = p.x + ix * d, qz = p.z + iz * d, h = this.G(qx, qz);
          if (h - p.y < -0.15 || h - p.y > 0.45) break;
          p.x = qx; p.z = qz; p.y = h;
        }
      }
      this.slideGrace = 1.0; this.sliding = false;
      return;
    }
    const ux = -n.x / hl, uz = -n.z / hl; // вверх по склону (в плане)
    // Скорость вдоль самой поверхности постоянная. Наклон меряем прямо под рукой, в сторону движения:
    // усреднённая нормаль на полке посреди отвесной стены «видит» стену, и герой полз по полке
    // секундами, будто застрял
    const sg = inp.my < 0 ? -1 : 1, e = 0.06 * sg;
    const sl = (this.G(p.x + ux * e, p.z + uz * e) - p.y) / e;
    const fwd = Math.max(n.y * 0.5, 1 / Math.hypot(1, sl));
    const mvx = ux * inp.my * fwd - uz * inp.mx, mvz = uz * inp.my * fwd + ux * inp.mx;
    const amt = Math.min(1, Math.hypot(inp.mx, inp.my));
    p.x += mvx * CLIMB * dt; p.z += mvz * CLIMB * dt;
    this.collide();
    p.y = this.G(p.x, p.z);
    this.facing = Math.atan2(ux, uz);
    this.climbLean = Math.asin(Math.min(1, n.y));
    this.climbPhase += dt * amt * 7.5 * (inp.my < -0.3 ? -1 : 1);
    this.climbAmt = amt;
    v.set(0, 0, 0);
    if (inp.jump) { // оттолкнуться от стены
      this.climbing = false; this.climbCd = 0.35; this.airT = 1;
      v.set(n.x / hl * 4.5, 7.5, n.z / hl * 4.5);
    } else if (inp.grab) { // отпустить стену
      this.climbing = false; this.climbCd = 0.3; this.airT = 1;
      v.set(n.x / hl * 1.5, 0, n.z / hl * 1.5);
    }
  }

  // Плавание: держимся у поверхности, гребём медленно, у берега встаём на дно
  swimStep(dt, inp, mx, mz, wl) {
    const p = this.pos, v = this.vel;
    this.swimT += dt;
    const top = inp.sprint ? SWIM_FAST : SWIM;
    const k = Math.min(1, dt * 4);
    v.x += (mx * top - v.x) * k; v.z += (mz * top - v.z) * k;
    // всплываем к уровню «голова над водой»
    const want = wl - 1.0;
    v.y += ((want - p.y) * 14 - v.y * 5) * dt;
    p.y += v.y * dt;
    const dist = Math.hypot(v.x, v.z) * dt, n = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i < n; i++) {
      const nx = p.x + (v.x * dt) / n, nz = p.z + (v.z * dt) / n;
      const h = this.G(nx, nz);
      if (h - p.y > 0.9) { v.x *= 0.3; v.z *= 0.3; break; } // крутой берег — упёрлись
      p.x = nx; p.z = nz;
    }
    this.collide();
    const g = this.G(p.x, p.z);
    if (p.y <= g) { // нащупали дно
      p.y = g; this.swimming = false; this.grounded = true; v.y = 0;
      return;
    }
    if (inp.jump && this.swimT > 0.3 && p.y > want - 0.15) { // выпрыгнуть из воды
      this.swimming = false; this.grounded = false; this.airT = 1;
      v.y = 6.2;
    }
  }

  // Падаем вдоль отвесной стены: «приземлиться» на её грань нельзя — отодвигаемся
  // от стены и летим дальше, а не сползаем внутри камня
  slipOffWall() {
    const p = this.pos, n = this.N(p.x, p.z, this.n, 0.35);
    if (n.y >= 0.5 || hitSolid) return false;
    const hl = Math.hypot(n.x, n.z) || 1, ox = n.x / hl, oz = n.z / hl;
    for (let d = 0.1; d <= 1.6; d += 0.1) {
      if (this.G(p.x + ox * d, p.z + oz * d) < p.y - 0.05) {
        p.x += ox * d; p.z += oz * d;
        this.vOff.x -= ox * d; this.vOff.z -= oz * d;
        this.vel.x = ox * 1.2; this.vel.z = oz * 1.2;
        return true;
      }
    }
    return false;
  }

  // Насколько круто земля уходит вниз прямо от ног, в сторону склона (tg угла).
  // Меряем в одну сторону: у подножия стены там ровно, и герой не «съезжает» от стены,
  // в которую просто упёрся (усреднённая нормаль цепляла стену — отсюда были дёрганья)
  footSlope() {
    const p = this.pos, n = this.N(p.x, p.z, this.n, 0.35);
    if (hitSolid) return 0;
    const hl = Math.hypot(n.x, n.z);
    if (hl < 0.05) return 0;
    const e = 0.18, dx = n.x / hl, dz = n.z / hl;
    return (p.y - this.G(p.x + dx * e, p.z + dz * e)) / e;
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
    const px0 = p.x, pz0 = p.z;
    // желаемая скорость относительно камеры
    const s = Math.sin(camYaw), c = Math.cos(camYaw);
    const mx = inp.mx * c - inp.my * s, mz = -inp.mx * s - inp.my * c;
    const ml = this.climbing ? 0 : Math.min(1, Math.hypot(mx, mz));
    this.climbCd = Math.max(0, this.climbCd - dt);
    this.slideGrace = Math.max(0, this.slideGrace - dt);
    this.mantleCd = Math.max(0, this.mantleCd - dt);
    // вода: если под ногами глубже роста по грудь — плывём
    const wl = waterAt(p.x, p.z);
    if (!this.climbing && wl > -1e8 && p.y < wl - 0.85 && wl - this.G(p.x, p.z) > 1.0) {
      if (!this.swimming) { this.swimming = true; this.grounded = false; this.swimT = 0; v.y = Math.max(v.y, -1.5); }
    }
    if (this.swimming) this.swimStep(dt, inp, mx, mz, wl);
    else if (this.climbing) this.climbStep(dt, inp);
    else if (this.mantle) this.mantleStep(dt);
    else if (!inp.grab && this.tryMantle(mx, mz, ml)) { this.mantleStep(0); }
    else if ((inp.grab || this.autoGrab(ml, dt)) && this.climbCd <= 0 && this.grab()) { /* схватились */ } else {
    const top = inp.sprint ? RUN : WALK;
    // на крутом склоне стоять нельзя: герой съезжает вниз, пока не схватится
    if (this.grounded) {
      const fs = this.footSlope();
      // застряли в узкой крутой выемке (съезжать некуда) — разрешаем стоять и прыгать
      const wedged = Math.hypot(p.x - this.wedge.x, p.z - this.wedge.z) < 0.6;
      if (this.sliding) { if (fs < SLIDE_OUT || wedged) this.sliding = false; }
      else if (fs > SLIDE_IN && !wedged && this.slideGrace <= 0) this.sliding = true;
    } else this.sliding = false;
    if (this.sliding) {
      // скорость раскладываем на «вниз по склону» и «поперёк»: вниз разгоняемся,
      // поперёк можно рулить, вверх — нельзя
      const n = this.n, hl = Math.hypot(n.x, n.z) || 1, dx = n.x / hl, dz = n.z / hl, lx = -dz, lz = dx;
      let vd = Math.max(0, v.x * dx + v.z * dz), vl = v.x * lx + v.z * lz;
      vd = Math.min(12, vd + 26 * hl * dt);
      vl += ((mx * lx + mz * lz) * top * 0.6 - vl) * Math.min(1, dt * 4);
      v.x = dx * vd + lx * vl; v.z = dz * vd + lz * vl;
      this.slideDir = Math.atan2(dx, dz);
    } else {
      const k = Math.min(1, dt * (this.grounded ? 11 : 2.5));
      v.x += (mx * top - v.x) * k; v.z += (mz * top - v.z) * k;
    }
    // прыгать можно только с ровного: по крутой стене прыжками не забраться
    if (this.grounded) this.walkable = !this.sliding;
    if (inp.jump && this.walkable && (this.grounded || this.airT < 0.12) && v.y <= 0.01) {
      v.y = JUMP; this.grounded = false; this.airT = 1;
    }

    const dist = Math.hypot(v.x, v.z) * dt, n = Math.max(1, Math.ceil(dist / 0.2));
    for (let i = 0; i < n; i++) this.tryMove((v.x * dt) / n, (v.z * dt) / n);
    this.collide();
    this.steepT = this.sliding ? 0.2 : this.steepT - dt;
    if (this.steepT > 0) {
      if (Math.hypot(p.x - this.stuckRef.x, p.z - this.stuckRef.z) > 0.3) { this.stuckRef.copy(p); this.stuckT = 0; }
      else if ((this.stuckT += dt) > 0.5) { this.wedge.copy(p); this.sliding = false; this.stuckT = 0; }
    } else { this.stuckRef.copy(p); this.stuckT = 0; }

    if (!this.grounded) {
      this.airT += dt;
      v.y -= GRAV * dt;
      // потолок берём ДО шага вверх: иначе за один кадр голова проскакивала
      // сквозь низ плиты, и героя выбрасывало на её верх
      this.G(p.x, p.z);
      const ceil = ceiling, prevY = p.y;
      p.y += v.y * dt;
      if (v.y > 0 && p.y + 1.3 > ceil) { p.y = Math.max(prevY, ceil - 1.3); v.y = 0; } // стукнулись головой
      const h = this.G(p.x, p.z);
      if (p.y <= h && !this.slipOffWall()) {
        // если ноги уже были ниже края (зацепились за уступ) — поднимаемся плавно
        const assist = h - Math.max(p.y, prevY);
        if (assist > 0.03) this.vOff.y -= assist;
        p.y = h; this.grounded = true; this.airT = 0;
        this.landT = Math.min(1, -v.y / 22); v.y = 0;
      }
    } else {
      this.airT = 0; v.y = 0;
      const h = this.G(p.x, p.z);
      if (p.y - h > 0.4) this.grounded = false;
      else { if (Math.abs(h - p.y) > 0.12) this.vOff.y += p.y - h; p.y = h; }
    }
    }

    this.canGrab = !this.climbing && this.climbCd <= 0 && !!this.findWall();
    this.N(p.x, p.z, this.n, 0.35);

    // запоминаем безопасное место для возврата после падения в колодец
    if (this.grounded && !this.swimming && !this.sliding && this.n.y > 0.9 && p.y > -60 && waterAt(p.x, p.z) < p.y) {
      this.safeT += dt;
      if (this.safeT > 0.6) { this.safe.copy(p); this.safeT = 0; }
    }

    // ---- анимация: вразвалку, с болтающимися руками, глазами и фонариком ----
    // скорость для анимации — по тому, сколько герой реально прошёл: упёрся в стену — стоит
    const sp = this.climbing ? Math.hypot(v.x, v.z) : Math.hypot(p.x - px0, p.z - pz0) / Math.max(dt, 1e-3);
    const prevSpeed = this.speed;
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    // смотрим туда, куда ведёт стик (а не туда, куда несёт скорость), а при съезде — вниз по склону
    const want = this.climbing ? null : this.sliding ? this.slideDir : ml > 0.05 ? Math.atan2(mx, mz) : null;
    if (want !== null) {
      let d = want - this.facing;
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

    this.vOff.multiplyScalar(Math.exp(-dt * 14));
    if (this.vOff.lengthSq() < 1e-6) this.vOff.set(0, 0, 0);
    this.viewPos.copy(p).add(this.vOff);
    m.root.position.copy(this.viewPos);
    m.root.rotation.y = this.facing;
    const rig = m.rig;
    rig.position.z = 0;
    if (this.swimming) {
      // гребём по-собачьи: тело лежит на воде, лапы молотят, голова задрана
      const sw = Math.min(1, this.speed / SWIM + 0.35);
      const ph = this.swimT * (6 + this.speed * 1.5);
      const a = Math.sin(ph), b = Math.cos(ph);
      m.armL.rotation.x = -1.4 + a * 0.9 * sw; m.armR.rotation.x = -1.4 - a * 0.9 * sw;
      m.armL.rotation.z = -0.45; m.armR.rotation.z = 0.45;
      m.legL.rotation.x = b * 0.7 * sw; m.legR.rotation.x = -b * 0.7 * sw;
      rig.rotation.set(1.0 - sw * 0.1, 0, a * 0.06);
      rig.position.set(0, 0.58 + Math.sin(t * 2.6) * 0.03, -0.05);
      rig.scale.set(1, 1, 1);
      m.head.rotation.x = -0.85; m.head.rotation.z = a * 0.08;
      this.waddle = a * 0.05;
    } else if (this.climbing) {
      // перебираем руками и ногами по очереди, тело прижато к стене
      const a = Math.sin(this.climbPhase), b = Math.cos(this.climbPhase);
      m.armL.rotation.x = -2.5 + a * 0.6; m.armR.rotation.x = -2.5 - a * 0.6;
      m.armL.rotation.z = -0.22 - Math.max(0, -a) * 0.15; m.armR.rotation.z = 0.22 + Math.max(0, a) * 0.15;
      m.legL.rotation.x = -0.8 - a * 0.6; m.legR.rotation.x = -0.8 + a * 0.6;
      rig.rotation.set(this.climbLean, 0, a * 0.1);
      // тело держим перед стеной: чем она отвеснее, тем дальше, иначе голова уходит в камень
      rig.position.set(0, Math.abs(b) * 0.07 * (this.climbAmt || 0), -0.26 - 0.2 * Math.cos(this.climbLean));
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

    // взмах топором: замах назад-вверх и удар вперёд
    for (const k in m.tools) m.tools[k].visible = this.held === k;
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt);
      const k = 1 - this.swingT / SWING;
      m.armR.rotation.x = k < 0.35 ? -0.4 - 2.4 * (k / 0.35) : -2.8 + 2.6 * Math.min(1, (k - 0.35) / 0.3);
      m.armR.rotation.z = 0.15;
      rig.rotation.x += 0.12 * Math.sin(k * Math.PI);
    } else if (this.held in m.tools && this.grounded && !this.swimming) m.armR.rotation.x -= this.held === 'spear' ? 0.6 : 0.35;

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
    // фонарик светит тем ярче, чем темнее вокруг (глубже в провале)
    // днём на лугу — слабый тёплый свет (виден в тени), глубже — сильнее
    const dark = 0.3 + 0.7 * Math.max(0, Math.min(1, (-6 - p.y) / 30));
    this.lureGlow += (dark - this.lureGlow) * Math.min(1, dt * 2);
    m.root.updateMatrixWorld(true);
    _lp.set(0, 0.27, 0.22);
    m.lure.localToWorld(_lp);
    this.haloPts.position.copy(_lp);
    U.uLure.value.set(_lp.x, _lp.y, _lp.z, this.lureGlow);

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
    const gh = this.G(p.x, p.z), above = p.y - gh;
    this.N(p.x, p.z, this.n, 0.4);
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
    this.vOff.set(0, 0, 0);
    this.grounded = true; this.climbing = false; this.swimming = false; this.sliding = false;
  }
}
