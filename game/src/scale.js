import * as THREE from '../vendor/three.min.js';
import { mat, LITE } from './shaders.js';
import { STONEAPI } from './descent.js';
import { TUN_GONE } from './tunnels.js';
import { rockAt, groundAt, addBox } from './solids.js';
import { waterNear } from './waterfall.js';
import { part, merge, T, propMaterial } from './flora.js';
import { mulberry32, SEED } from './noise.js';

// Масштаб шахты: фонари на кронштейнах по бокам глыб — тёплые огоньки вдалеке и в глубине — и мостики.
// Всё — украшение без коллизий; каждое — одна модель.

// ---------- фонари на кронштейнах ----------
// Возвращает список огоньков для общего света (Deep.lights): тёплые пятна на камне вокруг фонаря.
export function buildLanterns(scene) {
  const rnd = mulberry32(SEED + 5501);
  // убранные туннелями глыбы остаются в списке (порядок как раньше), но фонарь на них не вешаем
  const stones = [...STONEAPI.all(), ...TUN_GONE].sort((a, b) => a.id - b.id).filter((s) => s.spec.y < -85);
  for (let i = stones.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [stones[i], stones[j]] = [stones[j], stones[i]]; }
  const MAX = LITE ? 22 : 36;
  const parts = [], lights = [];
  const IRON = 0x3b3633, WOOD = 0x5a3b26, GLASS = 0xffc070, K = 1.4; // K — размер фонаря
  const edgeR = (cx, cz, ux, uz, y, r1) => {
    let last = -1;
    for (let r = 0; r <= r1; r += 0.1) { if (rockAt(cx + ux * r, cz + uz * r, y)) last = r; else if (last >= 0) break; }
    return last;
  };
  for (const st of stones) {
    if (lights.length >= MAX) break;
    if (TUN_GONE.includes(st)) continue;
    const sp = st.spec, R = Math.max(sp.A, sp.B);
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a), y = sp.y - 0.55 - rnd() * 1.2;
      const re = edgeR(sp.x, sp.z, ux, uz, y, R * 1.6);
      if (re < 0.5) continue;
      const ax = sp.x + ux * (re - 0.1), az = sp.z + uz * (re - 0.1);         // в камне
      const lx = sp.x + ux * (re + 0.6), lz = sp.z + uz * (re + 0.6), ly = y - 0.6;   // фонарь
      // под фонарём пусто (не в соседнем камне, не в земле, не в воде)
      if (rockAt(lx, lz, ly) || rockAt(lx, lz, ly - 0.4) || groundAt(lx, lz, ly) > ly - 0.6 || waterNear(lx, ly, lz, 1, 2)) continue;
      const ry = Math.atan2(-uz, ux);
      // кронштейн: брус из камня наружу, подкос, цепь
      parts.push(part(new THREE.BoxGeometry(0.85, 0.07, 0.07), IRON, { m: T((ax + lx) / 2 + ux * 0.05, y, (az + lz) / 2 + uz * 0.05, 1, 1, 1, ry) }));
      parts.push(part(new THREE.BoxGeometry(0.5, 0.05, 0.05), IRON, { m: T(ax + ux * 0.25, y - 0.18, az + uz * 0.25, 1, 1, 1, ry, 0.6) }));
      parts.push(part(new THREE.BoxGeometry(0.03, 0.32, 0.03), IRON, { m: T(lx, y - 0.17, lz) }));
      // сам фонарь: крышка, стекло (светится), донце, кольцо
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.2, 0.14, 6), IRON, { m: T(lx, ly + 0.25 * K, lz, K) }));
      parts.push(part(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 6), GLASS, { glow: 1, m: T(lx, ly + 0.03 * K, lz, K) }));
      parts.push(part(new THREE.CylinderGeometry(0.16, 0.1, 0.07, 6), WOOD, { m: T(lx, ly - 0.15 * K, lz, K) }));
      for (let j = 0; j < 3; j++) {
        const b = j * Math.PI * 2 / 3 + 0.5;
        parts.push(part(new THREE.BoxGeometry(0.025, 0.32, 0.025), IRON, { m: T(lx + Math.cos(b) * 0.135 * K, ly + 0.03 * K, lz + Math.sin(b) * 0.135 * K, K) }));
      }
      lights.push({ x: lx, y: ly, z: lz, r: 5.5, k: 0.85, col: [1.0, 0.62, 0.3] });
      break;
    }
  }
  if (!parts.length) return lights;
  const mesh = new THREE.Mesh(merge(parts), propMaterial());
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return lights;
}

// ---------- мостики между глыбами ----------
// Верёвочные мостики из досок через узкие пропасти между соседними глыбами. По ним можно ходить:
// каждая пара досок — плоская плита с низом (под мостом проходишь свободно, «невидимой стены до земли» нет).
export function buildBridges(scene) {
  const rnd = mulberry32(SEED + 6607);
  // убранные туннелями глыбы остаются в списке (порядок и случайный выбор пар — как раньше), но мост к ним не строим
  const all = [...STONEAPI.all(), ...TUN_GONE].sort((a, b) => a.id - b.id).filter((s) => s.spec.y < -95 && s.spec.y > -168);
  const MAX = LITE ? 7 : 11;
  const used = new Set(), list = [];
  // Геометрия моста — в свой материал (старое дерево, мох, верёвка): для каждой вершины помним
  // координаты вдоль волокон доски/столба/верёвки (aW.xy, метры), номер доски (aW.z) и вид (aW.w).
  const rw = mulberry32(SEED + 6611), BP = [], BN = [], BW = [];
  const bp = (geo, m, kind, axis) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone(), L = g.attributes.position, id = rw();
    const loc = [];
    for (let i = 0; i < L.count; i++) {
      const x = L.getX(i), y = L.getY(i), z = L.getZ(i);
      loc.push(axis === 'z' ? [z, x * 0.6 + y] : axis === 'y' ? [y, Math.atan2(z, x) * 0.08] : [x, y + z]);
    }
    g.applyMatrix4(m); g.computeVertexNormals();
    const P2 = g.attributes.position, N2 = g.attributes.normal;
    for (let i = 0; i < P2.count; i++) {
      BP.push(P2.getX(i), P2.getY(i), P2.getZ(i)); BN.push(N2.getX(i), N2.getY(i), N2.getZ(i));
      BW.push(loc[i][0], loc[i][1], id, kind);
    }
  };
  // свисающая травинка-плеть с края настила: стебель и листики, вид 3 (качается)
  const plant = (x, y, z, ox, oz, len) => {
    const id = rw(), segs = Math.max(2, Math.round(len / 0.14));
    const tri = (a, b, c, h) => { for (const v of [a, b, c]) { BP.push(v[0], v[1], v[2]); BN.push(ox, 0.3, oz); BW.push(h, 0, id, 3); } };
    for (let k = 0; k < segs; k++) {
      const y0 = y - k * 0.14, y1 = y0 - 0.14, h0 = k * 0.14, h1 = h0 + 0.14, w = 0.012;
      tri([x - oz * w, y0, z + ox * w], [x - oz * w, y1, z + ox * w], [x + oz * w, y0, z - ox * w], h0);
      const sd = k % 2 ? 1 : -1, sz = 0.05 + rw() * 0.04;
      tri([x, y0 - 0.03, z], [x - oz * sd * sz * 2 + ox * sz * 0.6, y0 - 0.03 - sz * 0.9, z + ox * sd * sz * 2 + oz * sz * 0.6], [x - oz * sd * sz + ox * sz, y0 + sz * 0.2, z + ox * sd * sz + oz * sz], h1);
    }
  };
  const edgeR = (cx, cz, ux, uz, y, r1) => {
    let last = -1;
    for (let r = 0; r <= r1; r += 0.1) { if (rockAt(cx + ux * r, cz + uz * r, y)) last = r; else if (last >= 0) break; }
    return last;
  };
  const pairs = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].spec, b = all[j].spec;
    const d = Math.hypot(b.x - a.x, b.z - a.z), gap = d - Math.max(a.A, a.B) - Math.max(b.A, b.B);
    if (gap > 2.0 && gap < 9 && Math.abs(a.y - b.y) < 1.4) pairs.push([i, j, rnd()]);
  }
  pairs.sort((p, q) => p[2] - q[2]);
  let made = 0;
  for (const [i, j] of pairs) {
    if (made >= MAX) break;
    if (used.has(i) || used.has(j)) continue;
    if (TUN_GONE.includes(all[i]) || TUN_GONE.includes(all[j])) continue;
    const A = all[i].spec, B = all[j].spec;
    const d = Math.hypot(B.x - A.x, B.z - A.z), ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
    const ra = edgeR(A.x, A.z, ux, uz, A.y - 0.15, Math.max(A.A, A.B) * 1.6), rb = edgeR(B.x, B.z, -ux, -uz, B.y - 0.15, Math.max(B.A, B.B) * 1.6);
    if (ra < 0.5 || rb < 0.5) continue;
    const p0 = [A.x + ux * (ra - 0.4), 0, A.z + uz * (ra - 0.4)], p1 = [B.x - ux * (rb - 0.4), 0, B.z - uz * (rb - 0.4)];
    p0[1] = groundAt(p0[0], p0[2], A.y + 3); p1[1] = groundAt(p1[0], p1[2], B.y + 3);
    if (Math.abs(p0[1] - A.y) > 1.2 || Math.abs(p1[1] - B.y) > 1.2) continue;
    const L = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), sag = 0.05 * L + 0.15;
    if (L < 2.5 || L > 11) continue;
    // пролёт свободен: не задевает соседние камни и воду, а под ним пропасть
    let ok = true;
    for (let t = 0.12; t <= 0.88 && ok; t += 0.04) {
      const x = p0[0] + (p1[0] - p0[0]) * t, z = p0[2] + (p1[2] - p0[2]) * t, y = p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t);
      for (const o of [-0.7, 0, 0.7]) {
        const qx = x - uz * o, qz = z + ux * o;
        if (rockAt(qx, qz, y + 0.3) || rockAt(qx, qz, y + 1.4) || groundAt(qx, qz, y + 0.1) > y - 1.0) ok = false;
      }
      if (waterNear(x, y, z, 2, 4)) ok = false;
    }
    if (!ok) continue;
    used.add(i); used.add(j); made++; list.push({ p0, p1 });
    const ry = Math.atan2(-uz, ux), n = Math.max(4, Math.round(L / 0.5));
    const at = (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - sag * 4 * t * (1 - t) + 0.02, p0[2] + (p1[2] - p0[2]) * t];
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, [x, y, z] = at(t);
      const slope = ((at(Math.min(1, t + 0.01))[1] - at(Math.max(0, t - 0.01))[1]) / (0.02 * L));
      bp(new THREE.BoxGeometry(0.42, 0.07, 1.1 + (k % 3 === 1 ? 0.12 : 0)), T(x, y - 0.035, z, 1, 1, 1, ry, Math.atan(slope)), 0, 'z');
      // плети травы свисают с концов некоторых досок
      if (rw() < 0.28) { const sd = rw() < 0.5 ? -1 : 1; plant(x - uz * sd * 0.5, y - 0.07, z + ux * sd * 0.5, -uz * sd, ux * sd, 0.3 + rw() * 0.9); }
    }
    // по паре досок — одна плита для ходьбы
    for (let k = 0; k < n; k += 2) {
      const t0 = k / n, t1 = Math.min(1, (k + 2) / n), [x0, y0, z0] = at(t0), [x1, y1, z1] = at(t1);
      const top = Math.max(y0, y1);
      addBox((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 0.02, 0.55, ry, top, top - 0.25);
    }
    // столбики и верёвочные перила
    for (const [px, py, pz] of [p0, p1]) for (const o of [-0.62, 0.62]) {
      bp(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 5), T(px - uz * o, py + 0.5, pz + ux * o), 1, 'y');
    }
    for (const o of [-0.62, 0.62]) for (let k = 0; k < n; k++) {
      const ta = k / n, tb = (k + 1) / n, a = at(ta), b = at(tb), h = 0.85 - 0.25 * Math.sin(Math.PI * (ta + tb) / 2);
      const mx = (a[0] + b[0]) / 2 - uz * o, my = (a[1] + b[1]) / 2 + h, mz = (a[2] + b[2]) / 2 + ux * o;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      bp(new THREE.BoxGeometry(len + 0.02, 0.035, 0.035), T(mx, my, mz, 1, 1, 1, ry, Math.atan2(b[1] - a[1], Math.hypot(b[0] - a[0], b[2] - a[2]))), 2, 'x');
      if (k % 2 === 0) bp(new THREE.BoxGeometry(0.025, h, 0.025), T(a[0] - uz * o, a[1] + h / 2, a[2] + ux * o), 2, 'y');
    }
  }
  buildBridges.list = list;
  if (!BP.length) return 0;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(BP, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(BN, 3));
  geo.setAttribute('aW', new THREE.Float32BufferAttribute(BW, 4));
  const mesh = new THREE.Mesh(geo, bridgeMaterial());
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return made;
}

// ---------- материал моста: старое мокрое дерево, мох, тёмная верёвка ----------
// Без текстур: рисунок — из общего шума (uNoise), свет — общий (shade + applyFog: кристаллы, туман, фонарик).
// aW: x, y — метры вдоль и поперёк волокон; z — случайное число доски; w — вид: 0 доска, 1 столб, 2 верёвка, 3 трава.
function bridgeMaterial() {
  return mat({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aW;
      varying vec3 vW; varying vec3 vN; varying vec4 vA;
      void main(){
        vec3 p = position;
        if (aW.w > 2.5) {   // трава у края: качается, сильнее к концу плети
          float k = aW.x * aW.x * 0.12;
          p.x += sin(uTime * 1.1 + aW.z * 20.0) * k; p.z += cos(uTime * 0.9 + aW.z * 17.0) * k;
        }
        vW = p; vN = normal; vA = aW;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying vec4 vA;
      void main(){
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        float kind = vA.w, id = vA.z;
        vec2 g = vA.xy;
        vec3 alb;
        if (kind < 1.5) {
          // ---- дерево ----
          // свой оттенок у каждой доски: тёмно-бурый, серо-бурый, чуть зеленоватый
          vec3 c0 = vec3(0.20, 0.15, 0.11), c1 = vec3(0.23, 0.21, 0.18), c2 = vec3(0.17, 0.18, 0.13);
          alb = mix(mix(c0, c1, smoothstep(0.2, 0.7, id)), c2, smoothstep(0.65, 0.95, fract(id * 7.3)));
          alb *= 0.85 + 0.3 * fract(id * 13.7);
          // волокна: шум, сильно вытянутый вдоль доски
          float gr = vnoise(vec2(g.y * 26.0 + id * 31.0, g.x * 1.6));
          float gr2 = vnoise(vec2(g.y * 60.0 - id * 17.0, g.x * 3.5));
          alb *= 0.8 + 0.25 * gr + 0.12 * gr2;
          // трещины: редкие тонкие тёмные линии вдоль волокон
          float cr = smoothstep(0.035, 0.0, abs(vnoise(vec2(g.y * 9.0 + id * 5.0, g.x * 0.7)) - 0.5));
          alb *= 1.0 - cr * 0.45;
          // потёртости сверху (там ходят): светлее и серее пятнами
          float wear = smoothstep(0.55, 0.8, vnoise(vec2(g.x * 2.2 + id * 9.0, g.y * 3.0))) * smoothstep(0.4, 0.9, n.y) * (1.0 - kind);
          alb = mix(alb, vec3(dot(alb, vec3(0.33))) * 1.25 + vec3(0.02, 0.02, 0.015), wear * 0.5);
          // сырость: снизу и на концах досок темнее
          float endK = smoothstep(0.38, 0.6, abs(g.x)) * (1.0 - kind);
          alb *= 1.0 - 0.35 * smoothstep(0.2, -0.6, n.y) - 0.25 * endK;
          // мох пятнами: у концов досок и по столбам снизу/сверху; не сплошь
          float mn = vnoise(vW.xz * 2.3 + vW.y * 1.7 + id * 11.0);
          float mossK = kind < 0.5 ? smoothstep(0.64, 0.82, mn + endK * 0.3) * smoothstep(-0.2, 0.5, n.y)
                                   : smoothstep(0.62, 0.8, mn + smoothstep(-0.1, -0.5, g.x) * 0.35);
          vec3 mc = mix(vec3(0.10, 0.18, 0.08), vec3(0.18, 0.28, 0.12), vnoise(vW.xz * 7.0 + vW.y * 5.0));
          alb = mix(alb, mc, mossK * 0.85);
        } else if (kind < 2.5) {
          // ---- верёвка: тёмная, старая, с витыми прядями ----
          float tw = sin(g.x * 70.0 + g.y * 140.0);
          alb = mix(vec3(0.16, 0.14, 0.12), vec3(0.24, 0.21, 0.17), 0.5 + 0.5 * tw);
          alb *= 0.8 + 0.35 * vnoise(vec2(g.x * 4.0 + id * 20.0, id));
          alb = mix(alb, vec3(0.13, 0.18, 0.11), smoothstep(0.62, 0.8, vnoise(vec2(g.x * 2.5, id * 9.0))) * 0.6); // зеленоватая сырость
        } else {
          // ---- свисающая трава ----
          alb = mix(vec3(0.10, 0.22, 0.10), vec3(0.20, 0.36, 0.15), fract(id * 5.1)) * (0.8 + 0.4 * fract(id * 9.7));
        }
        // свет как у всего мира, но без блика по краю: дерево матовое и не бросается в глаза
        vec3 c = shade(alb * 1.3, n, 0.65);
        gl_FragColor = vec4(applyFog(c, vW), 1.0);
      }`,
  });
}
