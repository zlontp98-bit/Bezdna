import * as THREE from '../vendor/three.min.js';

// Руки героя от первого лица: две «варежки» цвета героя перед камерой.
// Рисуются поверх мира (как в обычных играх), поэтому не прячутся в стене, к которой прижат герой.
// Движение: лазание — по очереди тянутся вверх и перехватывают; ходьба — покачивание в такт шагу;
// плавание — гребки; взмах инструментом — правая рука бьёт вниз.
function handGeo(sx) {
  const parts = [
    [new THREE.SphereGeometry(0.042, 12, 9), [0, 0, 0], [1, 0.85, 1.15]],              // ладонь
    [new THREE.SphereGeometry(0.019, 8, 6), [sx * 0.038, 0.008, -0.015], [1, 1, 1.3]],      // большой палец
    [new THREE.CylinderGeometry(0.021, 0.03, 0.6, 9), [0, -0.012, 0.3], [1, 1, 1], true], // предплечье назад к телу
  ];
  const geos = parts.map(([g, p, s, rot]) => {
    if (rot) g.rotateX(Math.PI / 2);
    g.scale(s[0], s[1], s[2]); g.translate(p[0], p[1], p[2]);
    return g.toNonIndexed();
  });
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    pos.set(P, o * 3);
    // свет «сверху-спереди» запечён в цвет вершин: сцена без ламп, а руки должны выглядеть объёмными
    for (let i = 0; i < g.attributes.position.count; i++) {
      const l = 0.62 + 0.38 * Math.max(0, N[i * 3 + 1] * 0.8 - N[i * 3 + 2] * 0.45 + N[i * 3] * 0.1);
      col[(o + i) * 3] = col[(o + i) * 3 + 1] = col[(o + i) * 3 + 2] = l;
    }
    o += g.attributes.position.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export function buildHands(scene) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, fog: false });
  const root = new THREE.Group();
  const L = new THREE.Mesh(handGeo(-1), mat), R = new THREE.Mesh(handGeo(1), mat);
  for (const h of [L, R]) { h.renderOrder = 1000; h.frustumCulled = false; root.add(h); }
  root.visible = false;
  scene.add(root);
  const wantL = new THREE.Vector3(), wantR = new THREE.Vector3();
  let t = 0, color = -1;
  return {
    hide() { root.visible = false; },
    update(dt, camera, player) {
      t += dt;
      if (player.look.color !== color) { color = player.look.color; mat.color.set(color); }
      root.visible = true;
      root.position.copy(camera.position); root.quaternion.copy(camera.quaternion);
      let lx = -0.2, ly = -0.2, lz = -0.44, rx = 0.2, ry = -0.2, rz = -0.44, tl = 0, tr = 0;
      if (player.climbing || player.mantle) {
        // руки перед лицом на скале, по очереди тянутся вверх и перехватывают
        const a = player.climbPhase, amt = player.mantle ? 1 : Math.max(0.25, player.climbAmt || 0);
        const sl = Math.sin(a), sr = Math.sin(a + Math.PI);
        lx = -0.19; rx = 0.19;
        ly = -0.08 + 0.12 * sl * amt; ry = -0.08 + 0.12 * sr * amt;
        lz = -0.46 - 0.05 * Math.max(0, sl) * amt; rz = -0.46 - 0.05 * Math.max(0, sr) * amt;
        tl = 0.5 + 0.3 * sl; tr = 0.5 + 0.3 * sr;
        if (player.mantle) { ly = ry = -0.12; lz = rz = -0.36; }
      } else if (player.swimming) {
        // гребки: руки вперёд, в стороны и назад
        const a = t * 3.2, s = Math.sin(a), c = Math.cos(a);
        lx = -0.1 - 0.13 * (1 - c) * 0.5; rx = -lx;
        ly = ry = -0.19 + 0.03 * s;
        lz = rz = -0.48 + 0.1 * c;
      } else {
        // шаг: руки в такт ходьбе, чуть разные по фазе
        const sp = Math.min(1, (player.speed || 0) / 6), a = player.phase || 0;
        ly = -0.2 + 0.02 * Math.sin(a * 2) * sp + 0.006 * Math.sin(t * 1.7);
        ry = -0.2 + 0.02 * Math.sin(a * 2 + 1) * sp + 0.006 * Math.sin(t * 1.7 + 1);
        lz = -0.44 + 0.06 * Math.sin(a) * sp; rz = -0.44 - 0.06 * Math.sin(a) * sp;
        if (!player.grounded) { ly += 0.05; ry += 0.05; }
      }
      if (player.swingT > 0) { // взмах инструментом: правая рука вверх и резко вниз
        const k = 1 - player.swingT / 0.42;
        ry = k < 0.35 ? -0.2 + 0.26 * (k / 0.35) : 0.06 - 0.36 * Math.min(1, (k - 0.35) / 0.3);
        rz = -0.46; rx = 0.16;
      }
      wantL.set(lx, ly, lz); wantR.set(rx, ry, rz);
      const k = 1 - Math.exp(-dt * 18);
      L.position.lerp(wantL, k); R.position.lerp(wantR, k);
      L.rotation.set(0.5 - tl * 0.4, -0.12, 0.2); R.rotation.set(0.5 - tr * 0.4, 0.12, -0.2); // предплечье уходит назад-вниз, к телу
    },
  };
}
