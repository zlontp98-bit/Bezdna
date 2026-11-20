import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat } from './shaders.js';
import { LAKE, heightAt } from './terrain.js';
import { SWING } from './player.js';
import { sfx } from './sound.js';
import { RULES } from './world.js';

// Первый моб: медузы в озере на дне шахты.
// Светящийся полупрозрачный купол (розовый к макушке, оранжевый по краю), под ним
// кружевные ротовые лопасти и длинные тонкие щупальца. Плавают толчками: купол сжимается —
// медуза рывком идёт вперёд, расслабляется — дрейфует и чуть тонет.
// Убить можно чем угодно (копьём быстрее): последний удар — просьба к миру ('hunt'),
// ответ — 'hunted' с добычей «Желе медузы». Через 3–4 минуты в озере появляется новая.
//
// Для телефона: одна медуза — один вызов отрисовки (купол, лопасти, щупальца и отсвет
// на воде — одна сетка), всё движение частей — в вершинном шейдере, ~1.5 тыс. вершин.
// Смешивание сложением: светится в темноте и не требует сортировки прозрачного.

const COUNT = 3;
const R = 0.62;                 // радиус купола, м
const TOP = LAKE.level - 0.5;   // выше центр купола не поднимается (макушка чуть под водой)
const LOW = LAKE.level - 2.0;   // и не опускается ниже
const DIE = 1.6, GROW = 2.0, FLY = 0.8;

// ---------- модель ----------
// aJ: x — часть (0 купол, 1 внутренний купол, 2 лопасти, 3 щупальца, 4 отсвет на воде),
// y — доля длины (купол: от макушки 0 к краю 1; лопасть/щупальце: от корня 0 к кончику 1),
// z — фаза качания, w — сторона ленты (−1..1, в середине 0)
function jellyGeo() {
  const P = [], J = [], I = [];
  const v = (x, y, z, a, b, c, d) => { P.push(x, y, z); J.push(a, b, c, d); return P.length / 3 - 1; };
  // купол: тело вращения, по краю — зубчики
  const dome = (part, r0, h0, y0, NV, NA) => {
    const base = P.length / 3;
    for (let i = 0; i <= NV; i++) {
      const t = i / NV, th = t * Math.PI * 0.53;
      for (let j = 0; j <= NA; j++) {
        const a = (j / NA) * Math.PI * 2;
        const sc = 1 + 0.05 * Math.sin(a * 16) * t ** 6;
        const r = r0 * Math.sin(th) * sc * (1 + 0.06 * t), y = y0 + h0 * Math.cos(th) - 0.04 * t ** 4;
        v(Math.cos(a) * r, y, Math.sin(a) * r, part, t, a, 0);
      }
    }
    for (let i = 0; i < NV; i++) for (let j = 0; j < NA; j++) {
      const a = base + i * (NA + 1) + j, b = a + 1, c = a + NA + 1, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
  };
  dome(0, R, R * 0.82, 0, 9, 28);
  dome(1, R * 0.6, R * 0.5, -0.02, 5, 16);
  // лента вдоль линии: две скрещённые полосы, чтобы было видно с любой стороны
  const ribbon = (part, N, at, width, phase) => {
    for (const cross of [0, 1]) {
      const base = P.length / 3;
      for (let i = 0; i <= N; i++) {
        const s = i / N, [x, y, z, dx, dz] = at(s), w = width(s);
        const ox = cross ? -dz : dx, oz = cross ? dx : dz;
        v(x - ox * w, y, z - oz * w, part, s, phase, -1);
        v(x + ox * w, y, z + oz * w, part, s, phase, 1);
      }
      for (let i = 0; i < N; i++) { const a = base + i * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
  };
  // ротовые лопасти: 4 закрученные кружевные ленты из-под купола
  for (let k = 0; k < 4; k++) {
    const a0 = k * Math.PI / 2 + 0.4, L = 1.7 + (k % 2) * 0.35;
    ribbon(2, 26, (s) => {
      const a = a0 + s * 3.2, rr = 0.05 + 0.1 * s;
      return [Math.cos(a) * rr, -0.02 - s * L, Math.sin(a) * rr, Math.cos(a0 + s * 5), Math.sin(a0 + s * 5)];
    }, (s) => (0.06 + 0.11 * (0.5 + 0.5 * Math.sin(s * 23 + k))) * (1 - s * 0.55) * Math.min(1, s * 6 + 0.35), k * 1.7);
  }
  // щупальца: тонкие нити от края купола
  const rnd = mulberry32(SEED ^ 0x5e11f);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2 + rnd() * 0.2, r = R * 0.93, L = 2.2 + rnd() * 1.4;
    ribbon(3, 18, (s) => [Math.cos(a) * r * (1 - 0.25 * s), -0.03 - s * L, Math.sin(a) * r * (1 - 0.25 * s), Math.cos(a + 1.57), Math.sin(a + 1.57)],
      () => 0.014, rnd() * 6.28);
  }
  // отсвет на воде над медузой
  const q = P.length / 3;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) v(x, 0, z, 4, 0, 0, 0);
  I.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aJ', new THREE.Float32BufferAttribute(J, 4));
  g.setIndex(I);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1.2, 0), 4.5);
  return g;
}

function jellyMaterial() {
  return mat({
    uniforms: { uPulse: { value: 0 }, uHit: { value: 0 }, uK: { value: 1 }, uLevel: { value: LAKE.level }, uPh: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      uniform float uPulse, uK, uLevel, uPh;
      attribute vec4 aJ;
      varying vec4 vJ; varying vec3 vW; varying vec3 vN; varying vec3 vL;
      void main(){
        vJ = aJ; vL = position;
        vec3 p = position;
        float part = aJ.x, s = aJ.y;
        if (part > 3.5) {             // отсвет: плоский круг на глади, всегда горизонтален
          vec3 o = modelMatrix[3].xyz;
          float S = 3.4 * uK;
          vW = vec3(o.x + p.x * S, uLevel + 0.04, o.z + p.z * S);
          vN = vec3(0.0, 1.0, 0.0);
          vJ.z = clamp(1.0 - (uLevel - o.y) * 0.3, 0.0, 1.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
          return;
        }
        float c = uPulse;
        // купол: сжимается к краю и чуть вытягивается вверх
        float squeeze = part < 1.5 ? 1.0 - 0.2 * c * s : 1.0 - 0.17 * c * (1.0 - min(1.0, s * 3.0));
        p.xz *= squeeze;
        if (part < 1.5) p.y *= 1.0 + 0.14 * c;
        // лопасти и щупальца колышутся: волна бежит от корня к кончику
        if (part > 1.5) {
          float w = s * s * (part > 2.5 ? 0.45 : 0.3);
          p.x += sin(uTime * 1.4 + uPh + aJ.z - s * 5.0) * w;
          p.z += cos(uTime * 1.1 + uPh + aJ.z * 1.3 - s * 4.0) * w;
          p.y += c * s * 0.35;      // при толчке щупальца подтягиваются
        }
        // смерть: никнет и тает
        p *= mix(0.35, 1.0, uK);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vW = wp.xyz;
        // нормаль купола — от центра сферы под ним
        vN = normalize(mat3(modelMatrix) * (position - vec3(0.0, -0.25, 0.0)));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uHit, uK, uLevel, uPulse;
      varying vec4 vJ; varying vec3 vW; varying vec3 vN; varying vec3 vL;
      const vec3 PINK = vec3(1.0, 0.45, 0.6), ORANGE = vec3(1.0, 0.5, 0.18), PALE = vec3(1.0, 0.82, 0.78);
      void main(){
        float part = vJ.x, s = vJ.y;
        vec3 v = normalize(cameraPosition - vW);
        vec3 em;
        if (part > 3.5) {
          float r = length(vL.xz);
          float a = 1.0 - smoothstep(0.0, 1.0, r); a *= a;
          em = mix(PINK, ORANGE, 0.35) * a * 0.4 * vJ.z * uK * (0.85 + 0.25 * uPulse);
          gl_FragColor = vec4(em * exp(-distance(vW, cameraPosition) * 0.014), 0.0);
          return;
        }
        float fres = 1.0 - abs(dot(normalize(vN), v));
        if (part < 0.5) {               // купол: прозрачный, светится по контуру, вертикальные складки
          float ribs = 0.5 + 0.5 * cos(atan(vL.z, vL.x) * 8.0);
          vec3 col = mix(PINK, ORANGE, smoothstep(0.45, 1.0, s));
          em = col * (0.07 + 0.55 * pow(fres, 2.0) + 0.12 * ribs * (0.4 + fres));
          em += ORANGE * smoothstep(0.86, 1.0, s) * 0.7;          // светящийся край
          em += PALE * smoothstep(0.25, 0.0, s) * 0.08;
        } else if (part < 1.5) {        // внутренний купол: тёплое ядро
          em = mix(ORANGE, PINK, s) * (0.16 + 0.22 * fres);
        } else if (part < 2.5) {        // лопасти: бледные, кружевной оранжевый край
          float edge = abs(vJ.w);
          em = mix(PALE * 0.16, ORANGE * 0.55, edge * edge * edge) * (1.0 - s * 0.55);
          em *= 0.8 + 0.4 * vnoise(vec2(s * 30.0, vJ.z * 7.0));
        } else {                        // щупальца: тонкие светлые нити, к кончику гаснут
          em = mix(PALE, PINK, 0.4) * 0.42 * (1.0 - s) * (1.0 - abs(vJ.w) * 0.5);
        }
        em *= 0.85 + 0.35 * uPulse;
        em += vec3(1.0, 0.9, 0.85) * uHit * 0.45 * (0.3 + fres);
        em *= uK;
        // под водой: чем глубже и чем положе взгляд, тем глуше и зеленее
        float dd = uLevel - vW.y;
        if (dd > 0.0 && cameraPosition.y > uLevel) {
          float path = dd / max(0.3, v.y);
          float att = exp(-path * 0.2);
          em *= mix(vec3(0.6, 0.85, 0.9), vec3(1.0), att) * (0.45 + 0.55 * att);
        }
        em *= exp(-distance(vW, cameraPosition) * 0.014);
        // свет складывается с фоном, но плотные места ещё и чуть закрывают воду — так розовый не тонет в бирюзе
        gl_FragColor = vec4(em, clamp(max(em.r, max(em.g, em.b)) * 0.8, 0.0, 0.6));
      }`,
  });
}

// ---------- плавание ----------
const rndIn = (rnd) => {
  // случайная точка в озере, где под медузой есть глубина для щупалец
  for (let k = 0; k < 40; k++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (LAKE.r - 5);
    const x = LAKE.x + Math.cos(a) * d, z = LAKE.z + Math.sin(a) * d;
    if (heightAt(x, z) < LAKE.level - 4.5) return [x, z];
  }
  return [LAKE.x, LAKE.z];
};
const floorY = (x, z) => Math.max(LOW, heightAt(x, z) + 3.6);

export class Jellies {
  constructor(scene, player, inv, world, toast) {
    this.player = player; this.inv = inv; this.world = world; this.toast = toast;
    this.target = null; this.cd = 0; this.pending = null; this.flying = [];
    this.rnd = mulberry32(SEED ^ 0x7e11);
    const geo = jellyGeo();
    this.list = [];
    const spots = [];
    for (let i = 0; i < COUNT; i++) {
      let x, z;
      for (let k = 0; k < 20; k++) { [x, z] = rndIn(this.rnd); if (spots.every((q) => Math.hypot(q[0] - x, q[1] - z) > 14)) break; }
      spots.push([x, z]);
      const mesh = new THREE.Mesh(geo, jellyMaterial());
      mesh.renderOrder = 3; // после глади озера (2)
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      const j = {
        id: 'jelly:' + i, mesh, u: mesh.material.uniforms, x, z, y: (TOP + LOW) / 2,
        vx: 0, vy: 0, vz: 0, tx: x, tz: z, ty: TOP, tT: 0, per: 2.3 + this.rnd() * 0.7, ph: this.rnd() * 10,
        ax: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(), hp: RULES.mob.jelly.hp, hit: 0, flee: 0, fx: 0, fz: 0,
        state: 'alive', t: 0, k: 1,
      };
      j.u.uPh.value = j.ph;
      this.pickTarget(j);
      this.list.push(j);
    }
    // добыча, летящая в руки: маленький светящийся комочек
    this.blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), new THREE.MeshBasicMaterial({ color: 0xff8fa0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.blob.visible = false; this.blob.renderOrder = 4;
    scene.add(this.blob);
    const snap = world.snapshot();
    for (const id in snap.killed || {}) { const j = this.list.find((q) => q.id === id); if (j) this.gone(j, snap.killed[id], false); }
    world.on((ev) => {
      if (ev.type !== 'hunted') return;
      const j = this.list.find((q) => q.id === ev.id);
      if (!j) return;
      if (ev.by === world.me) j.reward = ev.reward;
      this.gone(j, ev.at, true);
    });
  }
  gone(j, at, animate) {
    j.at = at; j.state = animate ? 'die' : 'gone'; j.t = 0;
    if (animate) sfx('jellyDie');
    if (!animate) { j.k = 0; j.mesh.visible = false; }
  }
  pickTarget(j, away) {
    const p = this.player.pos;
    for (let k = 0; k < 8; k++) {
      let x, z;
      if (away) {
        const a = Math.atan2(j.z - p.z, j.x - p.x) + (this.rnd() - 0.5) * 1.2, d = 6 + this.rnd() * 6;
        x = j.x + Math.cos(a) * d; z = j.z + Math.sin(a) * d;
        const r = Math.hypot(x - LAKE.x, z - LAKE.z);
        if (r > LAKE.r - 5) { x = LAKE.x + (x - LAKE.x) * (LAKE.r - 5) / r; z = LAKE.z + (z - LAKE.z) * (LAKE.r - 5) / r; }
      } else {
        const a = this.rnd() * Math.PI * 2, d = 3 + this.rnd() * 9;
        x = j.x + Math.cos(a) * d; z = j.z + Math.sin(a) * d;
        if (Math.hypot(x - LAKE.x, z - LAKE.z) > LAKE.r - 5) continue;
      }
      if (heightAt(x, z) > LAKE.level - 4.5) continue;
      j.tx = x; j.tz = z; j.ty = LOW + this.rnd() * (TOP - LOW); j.tT = 8 + this.rnd() * 8;
      return;
    }
    j.tx = LAKE.x; j.tz = LAKE.z; j.tT = 6;
  }
  find() {
    const pl = this.player, p = pl.pos, reach = pl.held === 'spear' ? 2.4 : 1.7;
    let best = null, bd = reach;
    for (const j of this.list) {
      if (j.state !== 'alive') continue;
      const d = Math.hypot(j.x - p.x, j.y - (p.y + 0.9), j.z - p.z) - R;
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  get icon() { return this.player.held === 'spear' ? '🗡️' : '👊'; }
  update(dt, want) {
    const pl = this.player;
    this.target = (pl.grounded || pl.swimming) && !pl.climbing && Math.abs(pl.pos.y - LAKE.level) < 6 ? this.find() : null;
    this.cd -= dt;
    // удар доходит до медузы в середине взмаха
    if (this.pending && (this.pending.at -= dt) <= 0) {
      const j = this.pending.j; this.pending = null;
      if (j.state === 'alive') {
        j.hit = 1; j.hp -= RULES.mob.jelly.dmg(pl.held); sfx('jelly');
        // отпрянула и уплывает прочь
        const dx = j.x - pl.pos.x, dz = j.z - pl.pos.z, l = Math.hypot(dx, dz) || 1;
        j.vx += dx / l * 1.6; j.vz += dz / l * 1.6; j.vy -= 0.4;
        j.flee = 3; this.pickTarget(j, true);
        if (j.hp <= 0) { j.hp = RULES.mob.jelly.hp; this.world.send({ type: 'hunt', id: j.id, kind: 'jelly' }); }
      }
    }
    if (want && this.target && this.cd <= 0) {
      const j = this.target;
      pl.facing = Math.atan2(j.x - pl.pos.x, j.z - pl.pos.z);
      pl.swingT = SWING; this.cd = SWING;
      this.pending = { j, at: SWING * 0.42 };
    }
    const now = this.world.now(), time = performance.now() / 1000;
    for (const j of this.list) this.step(j, dt, time, now);
    if (this.flying.length) this.animFly(dt);
  }
  step(j, dt, time, now) {
    const pl = this.player;
    j.t += dt;
    if (j.state === 'gone') {
      // новая медуза появляется вдали от героя, где-нибудь в другом месте озера
      if (now - j.at > RULES.mob.jelly.respawnMs(j.id)) {
        for (let k = 0; k < 10; k++) {
          const [x, z] = rndIn(this.rnd);
          if (Math.hypot(x - pl.pos.x, z - pl.pos.z) > 12) { j.x = x; j.z = z; j.y = LOW + 0.3; break; }
        }
        j.state = 'grow'; j.t = 0; j.k = 0; j.vx = j.vy = j.vz = 0; j.hp = RULES.mob.jelly.hp; j.mesh.visible = true;
        this.pickTarget(j);
      }
      return;
    }
    // ритм купола: быстрое сжатие (толчок), долгое расслабление
    const u = ((time + j.ph) / j.per) % 1;
    let c = u < 0.28 ? Math.sin((u / 0.28) * Math.PI * 0.5) : (1 - (u - 0.28) / 0.72) ** 2;
    if (j.state === 'die') {
      const k = Math.min(1, j.t / DIE);
      j.k = 1 - k * k; c *= 1 - k;
      j.vy = -0.5;
      if (k === 1) { j.state = 'gone'; j.mesh.visible = false; this.drop(j); return; }
    } else if (j.state === 'grow') {
      j.k = Math.min(1, j.t / GROW);
      if (j.k === 1) j.state = 'alive';
    }
    if (j.state !== 'die') {
      // куда плыть: к цели, снизу вверх — медуза идёт куполом вперёд
      j.tT -= dt; j.flee = Math.max(0, j.flee - dt);
      if (j.tT <= 0 || Math.hypot(j.tx - j.x, j.tz - j.z) < 1.2) this.pickTarget(j);
      _d.set(j.tx - j.x, (j.ty - j.y) * 1.5, j.tz - j.z);
      if (_d.lengthSq() > 1e-4) _d.normalize();
      _d.y += 0.9; _d.normalize();
      j.ax.lerp(_d, 1 - Math.exp(-dt * 0.8)).normalize();
      // толчок — пока купол сжимается
      if (u < 0.28) {
        const f = (j.flee > 0 ? 3.4 : 1.25) * dt;
        j.vx += j.ax.x * f; j.vy += j.ax.y * f; j.vz += j.ax.z * f;
      }
      j.vy -= 0.12 * dt; // медленно тонет
    }
    const drag = Math.exp(-dt * 1.3);
    j.vx *= drag; j.vy *= drag; j.vz *= drag;
    j.x += j.vx * dt; j.y += j.vy * dt; j.z += j.vz * dt;
    // держимся в озере: у берега разворачиваемся, сверху — не выше глади, снизу — над дном
    const r = Math.hypot(j.x - LAKE.x, j.z - LAKE.z);
    if (r > LAKE.r - 4) { const k = (LAKE.r - 4) / r; j.x = LAKE.x + (j.x - LAKE.x) * k; j.z = LAKE.z + (j.z - LAKE.z) * k; j.vx *= -0.3; j.vz *= -0.3; }
    if (j.state !== 'die') {
      const fy = floorY(j.x, j.z);
      if (j.y > TOP) { j.y = TOP; j.vy = Math.min(0, j.vy); }
      if (j.y < fy) { j.y = fy; j.vy = Math.max(0, j.vy); }
    }
    j.hit = Math.max(0, j.hit - dt * 3);
    // ось купола наклонена по ходу
    j.q.setFromUnitVectors(_up, j.ax);
    j.mesh.matrix.compose(_p.set(j.x, j.y, j.z), j.q, _s.setScalar(1));
    j.mesh.matrixWorldNeedsUpdate = true;
    j.u.uPulse.value = c; j.u.uHit.value = j.hit; j.u.uK.value = j.k;
  }
  drop(j) {
    const r = j.reward; j.reward = null;
    if (!r) return; // убивал не я
    const n = r.jelly || 0, left = this.inv.add('jelly', n);
    this.toast(left === 0 ? `+${n} Желе медузы` : left < n ? `+${n - left} Желе медузы — инвентарь полон` : 'Инвентарь полон');
    this.flying.push({ t: 0, x: j.x, y: j.y, z: j.z });
  }
  animFly(dt) {
    const pl = this.player, f = this.flying[0];
    f.t += dt;
    const k = f.t / FLY, pop = Math.min(1, k / 0.45), home = Math.max(0, (k - 0.45) / 0.55) ** 2;
    const y = f.y + Math.sin(pop * Math.PI * 0.5) * 1.4;
    this.blob.position.set(f.x + (pl.pos.x - f.x) * home, y + (pl.pos.y + 0.8 - y) * home, f.z + (pl.pos.z - f.z) * home);
    this.blob.scale.setScalar(1 - home * 0.6);
    this.blob.visible = k < 1;
    if (k >= 1) this.flying.shift();
  }
}
const _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3(), _s = new THREE.Vector3();
