import * as THREE from '../vendor/three.min.js';
import { rockAt } from './solids.js';
import { heightAt } from './terrain.js';

// Руки героя от первого лица: кисти-варежки цвета героя — ладонь, четыре пальца, большой палец, предплечье.
// Рисуются отдельным проходом после всего мира (своя сцена, буфер глубины очищен), поэтому всегда поверх:
// не уходят под небо, воду, туман и стену, к которой прижат герой.
// Движения разные: подъём (рука тянется вверх и хватает, другая подтягивает), спуск (рука ищет опору внизу),
// вбок (перехват в сторону), вис, перелезание (ладони упираются в верх), шаг, бег, прыжок, плавание, удар.

// Геометрия с «запечённым» светом в цветах вершин: в сцене рук нет ламп
function lit(geo, shade = 1) {
  geo = geo.toNonIndexed();
  const N = geo.attributes.normal.array, n = geo.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = shade * (0.6 + 0.4 * Math.max(0, N[i * 3 + 1] * 0.75 + N[i * 3 + 2] * 0.45 - N[i * 3] * 0.15));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = l;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 8);

// Кисть в своей системе: запястье в (0,0,0), пальцы вдоль +y, ладонь смотрит в −z (от камеры — к стене)
function buildHand(mat, side) {
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(lit(new THREE.SphereGeometry(1, 16, 12).scale(0.048, 0.056, 0.027).translate(0, 0.048, 0)), mat);
  hand.add(palm);
  const fingers = [];
  for (let i = 0; i < 4; i++) {
    const x = (-0.03 + i * 0.02) * side, len = i === 0 || i === 3 ? 0.03 : 0.037;
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.092, -0.004);
    const seg = new THREE.Mesh(lit(capsule(0.0125, len).translate(0, len / 2 + 0.006, 0)), mat);
    pivot.add(seg);
    // второй сустав — чтобы пальцы сгибались крючком, а не палкой
    const tip = new THREE.Group(); tip.position.set(0, len + 0.012, 0);
    tip.add(new THREE.Mesh(lit(capsule(0.0115, len * 0.7).translate(0, len * 0.35 + 0.005, 0)), mat));
    pivot.add(tip);
    hand.add(pivot);
    fingers.push([pivot, tip]);
  }
  const thumb = new THREE.Group();
  thumb.position.set(-0.045 * side, 0.03, -0.008);
  thumb.rotation.z = 0.9 * side;
  thumb.add(new THREE.Mesh(lit(capsule(0.014, 0.036).translate(0, 0.026, 0)), mat));
  hand.add(thumb);
  // манжета рукава — тёмное кольцо на запястье, чтобы кисть читалась отдельно от руки
  const cuff = new THREE.Mesh(lit(new THREE.CylinderGeometry(0.036, 0.04, 0.035, 14).translate(0, -0.012, 0), 0.62), mat);
  hand.add(cuff);
  // предплечье и плечо уходят вниз-назад за край кадра
  // длина 1: каждый кадр тянем его от запястья к плечу (см. update)
  const arm = new THREE.Mesh(lit(new THREE.CylinderGeometry(0.03, 0.042, 1, 10).translate(0, -0.5, 0), 0.92), mat);
  hand.add(arm);
  return { hand, fingers, thumb, arm, cuff };
}

export function buildHands() {
  const hs = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const root = new THREE.Group();
  hs.add(root);
  const H = [buildHand(mat, -1), buildHand(mat, 1)];
  for (const h of H) { h.hand.traverse((o) => { o.frustumCulled = false; }); root.add(h.hand); h.curl = 0.5; h.pos = new THREE.Vector3(); h.rot = new THREE.Vector3(); h.init = false; h.wpos = new THREE.Vector3(); h.wq = new THREE.Quaternion(); h.wmode = false; }
  let t = 0, hangT = 0, color = -1, on = false;
  const want = [new THREE.Vector3(), new THREE.Vector3()], wrot = [new THREE.Vector3(), new THREE.Vector3()], wcurl = [0, 0];
  const pose = (i, x, y, z, rx, ry, rz, curl) => { want[i].set(x, y, z); wrot[i].set(rx, ry, rz); wcurl[i] = curl; inWorld[i] = false; };
  const inWorld = [false, false], wwant = [new THREE.Vector3(), new THREE.Vector3()], wwq = [new THREE.Quaternion(), new THREE.Quaternion()];
  const lock = [null, null];
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _m = new THREE.Matrix4(), _e = new THREE.Euler();
  const _down = new THREE.Vector3(0, -1, 0), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  // Лазание: руки держатся за саму стену (в мире), а не за камеру — отвёл взгляд, а они остались на камне.
  // Держащая рука стоит на месте, пока тело ползёт; тянущаяся — переносится на новую зацепку.
  function climbPose(i, s, player) {
    const f = player.face;
    let nx, nz;
    if (f) { nx = f.nx; nz = f.nz; }
    else if (player.n && Math.hypot(player.n.x, player.n.z) > 1e-3) { nx = player.n.x; nz = player.n.z; }
    else { nx = -Math.sin(player.facing || 0); nz = -Math.cos(player.facing || 0); }
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const rx = nz, rz = -nx; // вправо вдоль стены (смотрим в стену)
    const mx = player.climbMx || 0, my = player.climbMy || 0, amt = player.climbAmt || 0;
    const ph = player.climbPhase + (i === 0 ? 0 : Math.PI);
    const reach = Math.max(0, Math.sin(ph)) * amt, hold = 1 - reach;
    let side = 0.27 * s, up = -0.08;
    if (Math.abs(mx) > Math.abs(my) && Math.abs(mx) > 0.2) { side += Math.sign(mx) * 0.22 * reach; up += 0.06 * reach; }
    else if (my < -0.2) { up -= 0.24 * reach; side += Math.sin(t * 6 + i) * 0.07 * reach; }
    else { up += 0.26 * reach; }
    // вис на месте: время от времени одна рука ищет зацепку рядом
    let feel = 0;
    if (amt < 0.15) {
      const cyc = hangT % 3.2, who = Math.floor(hangT / 3.2) % 2;
      if (who === i && cyc > 1.6 && cyc < 2.8) {
        feel = Math.sin(((cyc - 1.6) / 1.2) * Math.PI);
        side += (0.12 * s + Math.sin(t * 7) * 0.07) * feel; up += 0.16 * feel;
      }
    }
    up += Math.sin(t * 2.1 + i) * 0.01;
    const p = player.pos, bx = p.x + rx * side, by = p.y + 1.28 + up, bz = p.z + rz * side;
    // до стены на высоте руки: ладонь ложится на камень
    let d = 0.45;
    for (let q = 0; q < 1.2; q += 0.04) {
      const qx = bx - nx * q, qz = bz - nz * q;
      if (rockAt(qx, qz, by + 0.05) || heightAt(qx, qz) > by + 0.05) { d = q; break; }
    }
    const lift = 0.04 * Math.max(reach, feel); // тянущаяся рука чуть отходит от камня
    _v.set(bx - nx * (d - 0.035 - lift), by, bz - nz * (d - 0.035 - lift));
    // держащая рука не едет вместе с телом: стоит на месте, пока не потянется снова
    if (hold > 0.95 && feel < 0.05 && amt > 0.2) {
      if (!lock[i] || lock[i].distanceTo(_v) > 0.45) lock[i] = _v.clone();
      _v.copy(lock[i]);
    } else lock[i] = null;
    wwant[i].copy(_v);
    // пальцы вверх и чуть к стене, ладонь — к стене (рука в своей системе смотрит ладонью в −z)
    _y.set(-nx * 0.2, 1, -nz * 0.2).normalize();
    _z.set(nx, 0, nz); _z.addScaledVector(_y, -_z.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x, _y, _z);
    wwq[i].setFromRotationMatrix(_m);
    _q.setFromAxisAngle(_y, -0.15 * s); wwq[i].premultiply(_q);
    wcurl[i] = 0.15 + 0.85 * Math.min(hold, 1 - feel);
    inWorld[i] = true;
  }

  return {
    hide() { on = false; },
    // нарисовать руки поверх готового кадра
    render(renderer, camera) {
      if (!on) return;
      root.position.copy(camera.position); root.quaternion.copy(camera.quaternion);
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(hs, camera);
      renderer.autoClear = ac;
    },
    update(dt, camera, player) {
      on = true;
      t += dt;
      hangT = player.climbing ? hangT + dt : 0;
      if (player.look.color !== color) { color = player.look.color; mat.color.set(color); }
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1; // левая / правая
        if (player.mantle) {
          // перелезаем: ладони упираются в верх уступа, пальцы вперёд
          const k = Math.min(1, (player.mantle.t || 0) / (player.mantle.dur || 0.5));
          pose(i, 0.15 * s, -0.12 - 0.12 * k, -0.4 + 0.05 * k, -1.35, 0.15 * s, 0, 0.35);
        } else if (player.climbing) {
          climbPose(i, s, player);
          continue;
        } else if (player.swimming) {
          // брасс: ладони вперёд вместе, разводим в стороны и назад
          const a = t * 3.0, c = Math.cos(a), sn = Math.sin(a);
          const out = (1 - c) * 0.5;
          pose(i, (0.06 + 0.2 * out) * s, -0.2 + 0.03 * sn, -0.5 + 0.18 * out, -1.5, (0.3 + 0.8 * out) * s, 0, 0.1);
        } else if (!player.grounded) {
          // прыжок / падение: руки чуть вверх и в стороны, пальцы растопырены
          const up = Math.max(-1, Math.min(1, (player.vel ? player.vel.y : 0) / 8));
          pose(i, 0.22 * s, -0.14 + 0.06 * up, -0.42, -0.9 - 0.3 * up, 0.2 * s, 0.25 * s, 0.05);
        } else {
          // шаг и бег: кулаки перед собой качаются в такт шагу; на бегу сильнее и выше
          const sp = Math.min(1, (player.speed || 0) / 8.6), a = (player.phase || 0) + (i === 0 ? 0 : Math.PI);
          const sw = Math.sin(a) * (0.03 + 0.07 * sp);
          pose(i, 0.2 * s, -0.22 + 0.03 * sp + Math.abs(Math.cos(a)) * 0.015 * sp + Math.sin(t * 1.7 + i) * 0.004,
            -0.44 + sw, -1.25 - 0.2 * sp, 0.12 * s, (0.3 - 0.15 * sp) * s, 0.55 + 0.35 * sp);
        }
      }
      if (player.swingT > 0) { // взмах инструментом: правая рука вверх и резко вниз
        const k = 1 - player.swingT / 0.42;
        const y = k < 0.35 ? -0.2 + 0.28 * (k / 0.35) : 0.08 - 0.38 * Math.min(1, (k - 0.35) / 0.3);
        pose(1, 0.15, y, -0.46, -1.0 + (k < 0.35 ? 0.6 : -0.4), -0.1, -0.3, 1);
      }
      const k = 1 - Math.exp(-dt * 16), kc = 1 - Math.exp(-dt * 12);
      _qi.copy(camera.quaternion).invert();
      for (let i = 0; i < 2; i++) {
        const h = H[i];
        if (inWorld[i]) {
          // в мире: плавно ведём точку на стене, потом переводим в систему камеры
          if (!h.wmode) {
            if (!h.init) { h.wpos.copy(wwant[i]); h.wq.copy(wwq[i]); h.init = true; }
            else { h.wpos.copy(h.pos).applyQuaternion(camera.quaternion).add(camera.position); h.wq.copy(camera.quaternion).multiply(_q.setFromEuler(_e.set(h.rot.x, h.rot.y, h.rot.z))); }
            h.wmode = true;
          }
          h.wpos.lerp(wwant[i], k); h.wq.slerp(wwq[i], k);
          h.hand.position.copy(h.wpos).sub(camera.position).applyQuaternion(_qi);
          h.hand.quaternion.copy(_qi).multiply(h.wq);
          h.pos.copy(h.hand.position); _e.setFromQuaternion(h.hand.quaternion); h.rot.set(_e.x, _e.y, _e.z);
        } else {
          h.wmode = false;
          if (!h.init) { h.pos.copy(want[i]); h.rot.copy(wrot[i]); h.init = true; }
          h.pos.lerp(want[i], k); h.rot.lerp(wrot[i], k);
          h.hand.position.copy(h.pos); h.hand.rotation.set(h.rot.x, h.rot.y, h.rot.z);
        }
        h.curl += (wcurl[i] - h.curl) * kc;
        // предплечье — от запястья к плечу (плечо чуть ниже и сбоку от глаз), где бы ни была кисть
        _v.set(0.2 * (i === 0 ? -1 : 1), -0.34, 0.02).sub(h.hand.position).applyQuaternion(_q.copy(h.hand.quaternion).invert());
        const al = _v.length();
        h.arm.quaternion.setFromUnitVectors(_down, _v.normalize());
        h.arm.scale.set(1, Math.max(0.2, al), 1);
        h.cuff.quaternion.copy(h.arm.quaternion);
        // пальцы сгибаются к ладони (к −z): два сустава
        h.fingers.forEach(([p, tip], j) => { const c = h.curl * (0.9 + j * 0.05); p.rotation.x = -c * 1.2; tip.rotation.x = -c * 1.4; });
        h.thumb.rotation.x = -h.curl * 0.8;
      }
    },
  };
}
