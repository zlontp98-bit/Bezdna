import * as THREE from '../vendor/three.min.js';

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
  hand.add(new THREE.Mesh(lit(new THREE.CylinderGeometry(0.036, 0.04, 0.035, 14).translate(0, -0.012, 0), 0.62), mat));
  // предплечье и плечо уходят вниз-назад за край кадра
  const arm = new THREE.Mesh(lit(new THREE.CylinderGeometry(0.03, 0.04, 0.7, 10).translate(0, -0.35, 0), 0.92), mat);
  hand.add(arm);
  return { hand, fingers, thumb };
}

export function buildHands() {
  const hs = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const root = new THREE.Group();
  hs.add(root);
  const H = [buildHand(mat, -1), buildHand(mat, 1)];
  for (const h of H) { h.hand.traverse((o) => { o.frustumCulled = false; }); root.add(h.hand); h.curl = 0.5; h.pos = new THREE.Vector3(); h.rot = new THREE.Vector3(); h.init = false; }
  let t = 0, hangT = 0, color = -1, on = false;
  const want = [new THREE.Vector3(), new THREE.Vector3()], wrot = [new THREE.Vector3(), new THREE.Vector3()], wcurl = [0, 0];
  const pose = (i, x, y, z, rx, ry, rz, curl) => { want[i].set(x, y, z); wrot[i].set(rx, ry, rz); wcurl[i] = curl; };

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
          const mx = player.climbMx || 0, my = player.climbMy || 0, amt = player.climbAmt || 0;
          const ph = player.climbPhase + (i === 0 ? 0 : Math.PI);
          const reach = Math.max(0, Math.sin(ph)) * amt, hold = 1 - reach; // эта рука тянется / держит
          let x = 0.18 * s, y = -0.04, z = -0.41;
          if (Math.abs(mx) > Math.abs(my) && Math.abs(mx) > 0.2) {
            // вбок: рука по ходу уходит в сторону и перехватывает, другая подтягивается следом
            x += Math.sign(mx) * (0.1 * reach - 0.04 * hold * amt);
            y += 0.03 * reach;
          } else if (my < -0.2) {
            // спуск: рука опускается и ищет зацепку внизу, другая держит выше
            y += -0.15 * reach + 0.05 * hold * amt;
            z += 0.03 * reach;
            x += Math.sin(t * 6 + i) * 0.025 * reach; // нащупывает опору: водит рукой из стороны в сторону
          } else {
            // подъём: рука тянется вверх, держащая подтягивает тело (уходит вниз)
            y += 0.16 * reach - 0.06 * hold * amt;
            z -= 0.04 * reach;
          }
          y += Math.sin(t * 2.1 + i) * 0.006; // вис: лёгкое дыхание
          // вис на месте: время от времени одна рука ищет зацепку — отрывается, шарит рядом и снова хватается
          let feel = 0;
          if (amt < 0.15) {
            const cyc = hangT % 3.2, who = Math.floor(hangT / 3.2) % 2;
            if (who === i && cyc > 1.6 && cyc < 2.8) {
              feel = Math.sin(((cyc - 1.6) / 1.2) * Math.PI);
              x += (0.05 * s + Math.sin(t * 7) * 0.03) * feel;
              y += 0.06 * feel; z += 0.02 * feel;
            }
          }
          // пальцы: тянущаяся рука раскрыта, держащая — сжата крючком
          pose(i, x, y, z, 0.12 - 0.25 * Math.max(reach, feel), -0.1 * s, -0.12 * s, 0.15 + 0.85 * Math.min(hold, 1 - feel));
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
      for (let i = 0; i < 2; i++) {
        const h = H[i];
        if (!h.init) { h.pos.copy(want[i]); h.rot.copy(wrot[i]); h.curl = wcurl[i]; h.init = true; }
        h.pos.lerp(want[i], k); h.rot.lerp(wrot[i], k); h.curl += (wcurl[i] - h.curl) * kc;
        h.hand.position.copy(h.pos); h.hand.rotation.set(h.rot.x, h.rot.y, h.rot.z);
        // пальцы сгибаются к ладони (к −z): два сустава
        h.fingers.forEach(([p, tip], j) => { const c = h.curl * (0.9 + j * 0.05); p.rotation.x = -c * 1.2; tip.rotation.x = -c * 1.4; });
        h.thumb.rotation.x = -h.curl * 0.8;
      }
    },
  };
}
