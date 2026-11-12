import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED, fbm } from './noise.js';
import { U, mat } from './shaders.js';
import { W, SRC, SOURCES, heightAt, normalAt, streamAt, waterAt, pathAt, POOLS } from './terrain.js';
import { STACKS } from './stacks.js';
import { addMeshTop } from './solids.js';

const TAU = Math.PI * 2;
// камни-ступени, поставленные вручную (для проверки маршрутов)
export const STONES = [];

// ---------- сборка моделей из простых форм ----------
// Каждая часть: геометрия + цвет + свечение + «качается ли на ветру».
// Всё сливается в одну геометрию => один вызов отрисовки на весь вид объектов.
export function part(geo, color, { glow = 0, sway = 0, m = null, round = null, stone = 0 } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (m) g.applyMatrix4(m);
  if (!round) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), fx = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  const P = g.attributes.position, N = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    fx[i * 3] = glow; fx[i * 3 + 1] = sway; fx[i * 3 + 2] = stone;
    if (round) {
      // «пухлые» нормали от центра — мягкая мультяшная листва
      const x = P.getX(i) - round.x, y = P.getY(i) - round.y, z = P.getZ(i) - round.z;
      const l = Math.hypot(x, y, z) || 1;
      N.setXYZ(i, x / l, y / l, z / l);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aFx', new THREE.BufferAttribute(fx, 3));
  return g;
}

export function merge(parts) {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3), fx = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    pos.set(p.attributes.position.array, o * 3);
    nor.set(p.attributes.normal.array, o * 3);
    col.set(p.attributes.color.array, o * 3);
    fx.set(p.attributes.aFx.array, o * 3);
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aFx', new THREE.BufferAttribute(fx, 3));
  return g;
}

export const T = (x, y, z, sx = 1, sy = sx, sz = sx, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)),
    new THREE.Vector3(sx, sy, sz));

// Один материал на деревья, камни, грибы, кристаллы и персонажа
let _prop;
export function propMaterial() {
  if (_prop) return _prop;
  _prop = mat({
    vertexColors: true,
    vertexShader: /* glsl */ `
      attribute vec3 aFx;
      varying vec3 vW; varying vec3 vN; varying vec3 vC; varying float vSh; varying float vGlow; varying float vStone; varying vec3 vL; varying float vProp;
      void main(){
        mat4 mm = modelMatrix;
        vec3 tint = vec3(1.0);
        vProp = 0.0;
        #ifdef USE_INSTANCING
          mm = modelMatrix * instanceMatrix;
          vProp = 1.0;
        #endif
        #ifdef USE_INSTANCING_COLOR
          tint = instanceColor;
        #endif
        vec4 wp = mm * vec4(position, 1.0);
        vec3 o = mm[3].xyz;
        float sw = aFx.y * position.y;
        wp.x += sin(uTime*1.3 + o.x*0.37 + o.z*0.21 + position.y*0.4) * 0.045 * sw;
        wp.z += cos(uTime*1.1 + o.z*0.33 + position.y*0.5) * 0.035 * sw;
        vW = wp.xyz;
        vN = normalize(mat3(mm) * normal);
        vC = color * tint;
        vGlow = aFx.x; vStone = aFx.z; vL = position;
        vSh = shadowAt(o.xz + uSun.xz*2.5);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying vec3 vC; varying float vSh; varying float vGlow; varying float vStone; varying vec3 vL; varying float vProp;
      void main(){
        // Гриб, крона или куст вплотную к камере тают «в сеточку»: камера проходит сквозь них,
        // а не застревает внутри шляпки и не закрывает героя
        float cd = distance(vW, cameraPosition);
        if (vProp > 0.5 && cd < 2.4) {
          float dth = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (dth > smoothstep(0.9, 2.4, cd)) discard;
        }
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        vec3 alb = vC;
        if (vStone > 0.5) {
          // старый камень: пятна, сколы, тёмные прожилки и мох на верхних гранях
          vec3 q = vL * 1.7;
          float t = vnoise(q.xz + q.y*0.7) * 0.6 + vnoise(q.zy*2.3 + q.x) * 0.4;
          float vein = smoothstep(0.03, 0.0, abs(vnoise(q.xy*2.2 + q.z*1.3) - 0.5));
          alb *= 0.78 + 0.38*t;
          alb *= 1.0 - vein*0.2;
          float moss = smoothstep(0.5, 0.9, n.y) * smoothstep(0.58, 0.78, vnoise(q.xz*0.45 + q.y*0.3));
          alb = mix(alb, vec3(0.24,0.34,0.17) * (0.8 + 0.4*t), moss*0.8);
        }
        vec3 c = shade(alb, n, vSh);
        float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        c += uSunCol * rim * 0.16 * (0.4 + 0.6*vSh);
        c = mix(c, vC * (1.25 + 0.2*sin(uTime*1.7 + vW.x + vW.z)), vGlow);
        gl_FragColor = vec4(applyFog(c, vW), 1.0);
      }`,
  });
  return _prop;
}

// ---------- модели ----------
function leafTree() {
  const trunk = new THREE.CylinderGeometry(0.2, 0.36, 2.8, 6, 1, true);
  const blob = new THREE.IcosahedronGeometry(1, 1), blob0 = new THREE.IcosahedronGeometry(1, 0);
  const ctr = new THREE.Vector3(0, 3.7, 0);
  const o = { sway: 1, round: ctr };
  return merge([
    part(trunk, 0x7a5236, { m: T(0, 1.4, 0) }),
    part(new THREE.CylinderGeometry(0.09, 0.14, 1.3, 5, 1, true), 0x7a5236, { m: T(0.45, 2.5, 0.1, 1, 1, 1, 0, -0.8) }),
    part(blob, 0xffffff, { ...o, m: T(0, 3.9, 0, 1.75, 1.45, 1.75) }),
    part(blob0, 0xe9f5d8, { ...o, m: T(1.2, 3.3, 0.3, 1.3, 1.1, 1.3, 0.4) }),
    part(blob0, 0xdcefd0, { ...o, m: T(-1.05, 3.2, -0.5, 1.35, 1.1, 1.35, 1.1) }),
    part(blob0, 0xf4fbe6, { ...o, m: T(0.1, 3.3, 1.1, 1.2, 1.0, 1.2, 2.0) }),
  ]);
}
function pineTree() {
  const cone = (r, h) => new THREE.ConeGeometry(r, h, 8, 1);
  const ctr = (y) => new THREE.Vector3(0, y, 0);
  return merge([
    part(new THREE.CylinderGeometry(0.16, 0.3, 2.2, 6, 1, true), 0x6b4a34, { m: T(0, 1.1, 0) }),
    part(cone(1.7, 2.6), 0xd9ecd2, { sway: 0.6, round: ctr(1.6), m: T(0, 2.7, 0) }),
    part(cone(1.35, 2.3), 0xe9f5dc, { sway: 0.8, round: ctr(3.0), m: T(0, 4.2, 0) }),
    part(cone(0.95, 2.1), 0xffffff, { sway: 1, round: ctr(4.6), m: T(0, 5.6, 0) }),
  ]);
}
function giantShroom() {
  const cap = new THREE.SphereGeometry(1, 10, 4, 0, TAU, 0, Math.PI * 0.5);
  const spots = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3, r = 0.95 + (i % 2) * 0.45;
    spots.push(part(new THREE.SphereGeometry(0.2, 5, 3), 0xdffcff,
      { glow: 1, m: T(Math.cos(a) * r, 3.42 + (i % 2 ? -0.22 : 0.08), Math.sin(a) * r, 1, 0.5, 1) }));
  }
  return merge([
    part(new THREE.CylinderGeometry(0.22, 0.42, 3.1, 7, 1, true), 0xe7e0d2, { m: T(0, 1.55, 0) }),
    part(cap, 0xffffff, { round: new THREE.Vector3(0, 2.6, 0), m: T(0, 3.0, 0, 2.1, 1.0, 2.1) }),
    part(new THREE.CircleGeometry(2.05, 12), 0xbfeee6, { glow: 0.55, m: new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 3.02, 0) }),
    ...spots,
  ]);
}
function bushGeo() {
  const b = new THREE.IcosahedronGeometry(1, 0);
  const o = (c) => ({ sway: 0.6, round: new THREE.Vector3(c[0], -0.2, c[1]) });
  return merge([
    part(b, 0xffffff, { ...o([0, 0]), m: T(0, 0.5, 0, 0.85, 0.7, 0.85, 0.3) }),
    part(b, 0xe6f4d6, { ...o([0.6, 0.1]), m: T(0.62, 0.38, 0.12, 0.6, 0.5, 0.6, 1.2) }),
    part(b, 0xdcefd0, { ...o([-0.5, -0.2]), m: T(-0.55, 0.36, -0.2, 0.62, 0.5, 0.62, 2.1) }),
    // ягоды/цветы
    part(new THREE.OctahedronGeometry(0.07, 0), 0xfff3c4, { glow: 0.5, m: T(0.3, 0.95, 0.45) }),
    part(new THREE.OctahedronGeometry(0.07, 0), 0xfff3c4, { glow: 0.5, m: T(-0.5, 0.7, 0.4) }),
    part(new THREE.OctahedronGeometry(0.07, 0), 0xfff3c4, { glow: 0.5, m: T(0.75, 0.6, -0.3) }),
  ]);
}
function rockGeo() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const k = 1 + fbm(x * 1.3 + 5, z * 1.3 + y * 1.7, 2) * 0.55;
    P.setXYZ(i, x * k, Math.max(-0.25, y * k * 0.72), z * k);
  }
  return merge([part(g, 0xffffff, { stone: 1 })]);
}
function crystalGeo() {
  const s = new THREE.OctahedronGeometry(1, 0);
  return merge([
    part(s, 0xffffff, { glow: 0.85, m: T(0, 0.8, 0, 0.3, 1.0, 0.3) }),
    part(s, 0xe8fbff, { glow: 0.85, m: T(0.3, 0.45, 0.1, 0.2, 0.6, 0.2, 0, -0.5) }),
    part(s, 0xe8fbff, { glow: 0.85, m: T(-0.22, 0.38, -0.2, 0.16, 0.5, 0.16, 0, 0.45) }),
  ]);
}
function smallShroom() {
  return merge([
    part(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 5, 1, true), 0xf2ecdf, { m: T(0, 0.15, 0) }),
    part(new THREE.SphereGeometry(0.2, 6, 3, 0, TAU, 0, Math.PI * 0.5), 0xffffff, { glow: 0.7, m: T(0, 0.27, 0, 1, 0.8, 1) }),
  ]);
}

// ---------- расстановка ----------
export function buildFlora(scene) {
  const rnd = mulberry32(SEED + 7);
  const material = propMaterial();
  const colliders = [];   // круги для столкновений
  const blobs = [];       // пятна тени для запекания
  const n = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();

  const trees = [];
  const lists = { leaf: [], pine: [], shroom: [], rock: [], crystal: [], small: [], bush: [] };
  const spawn = { x: W.R + 10, z: 8 };
  const taken = [];
  const free = (x, z, rad) => {
    for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < t.r + rad) return false;
    return true;
  };

  function scatter(count, rMin, rMax, fn, tries = 30) {
    let placed = 0;
    for (let i = 0; i < count * tries && placed < count; i++) {
      const a = rnd() * TAU;
      const r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = heightAt(x, z);
      normalAt(x, z, n, 0.8);
      if (streamAt(x, z) > 0.01 || pathAt(x, z) > 0.05) continue;
      if (POOLS.some((p) => Math.hypot(x - p.x, z - p.z) < p.rad + (p.src ? 5 : 1.6))) continue;
      if (waterAt(x, z) > -1e8) continue;
      if (Math.hypot(x - spawn.x, z - spawn.z) < 9) continue;
      if (Math.hypot(x - spawn.x - 9.5, z - spawn.z + 3) < 8) continue; // место под дом в лагере
      if (fn(x, y, z, n.y, r)) placed++;
    }
  }
  const add = (list, x, y, z, s, color, rot = rnd() * TAU, tilt = 0) =>
    list.push({ x, y, z, s, color, rot, tilt });

  // ---- камни у водопадов: каждый поставлен вручную ----
  // Не кольцо одинаковых валунов, а маршрут: по камням через чашу, по выступам в стене
  // за пелену водопада и вверх на смотровой камень. top — высота верха камня (по ней
  // рассчитаны прыжки: герой прыгает на 1.6 м вверх и на 3.5–6 м в длину).
  const grey = (g, warm = 1) => col.setRGB(g * (1 + 0.06 * warm), g * 1.01, g * (1 - 0.04 * warm)).getHex();
  const stone = (x, z, o) => {
    if (o.top !== undefined) STONES.push({ x, z, top: o.top, s: o.s, hang: !!o.hang });
    add(lists.rock, x, o.top !== undefined ? o.top : heightAt(x, z) - (o.sink ?? 0.12), z, o.s, grey(o.g ?? 0.54, o.warm ?? 1), o.rot ?? 0, o.tilt ?? 0);
    Object.assign(lists.rock[lists.rock.length - 1], { sy: o.sy ?? 0.8, sz: o.sz ?? 1, top: o.top, hang: !!o.hang });
    taken.push({ x, z, r: o.s });
    if (!o.hang && o.s > 0.8) blobs.push({ x, z, r: o.s * 1.5, h: o.s * 0.5 });
  };
  for (const p of POOLS) {
    if (p.src) {
      const s = p.s, B = s.base, wl = p.level;
      const at = (a, l) => { const r = W.SRC_R + a, th = s.tw + l / r; return [Math.cos(th) * r, Math.sin(th) * r]; };
      // 1) брод: пять камней через чашу перед самой пеленой, шаг 3–3.5 м, высота «лесенкой»
      for (const [a, l, sz, up, rot] of [[-3.6, -6.9, 1.25, 0.55, 0.4], [-2.4, -3.7, 1.05, 0.85, 2.1], [-4.3, -0.5, 1.35, 0.6, 3.3], [-2.2, 2.7, 1.0, 0.95, 5.0], [-3.8, 6.2, 1.3, 0.5, 1.2]]) {
        const [x, z] = at(s.pc + a + 1.5, l);
        stone(x, z, { s: sz, sy: 2.3, sz: 0.9, top: wl + up, rot, g: 0.5, warm: 0 });
      }
      // 2) выступы в стене ниши: слева по дуге, за пеленой водопада и вверх направо.
      //    Центр ниши — (a = −2, l = 0); камень наполовину сидит в скале
      const ledge = (deg, up, sz, o = {}) => {
        const ph = (deg * Math.PI) / 180;
        let rho = 6;
        while (rho < 15) { const [x, z] = at(-2 + Math.cos(ph) * rho, Math.sin(ph) * rho); if (heightAt(x, z) > B + up + 1.5) break; rho += 0.1; }
        rho -= sz * 0.42;
        const [x, z] = at(-2 + Math.cos(ph) * rho, Math.sin(ph) * rho);
        stone(x, z, { s: sz, sy: 0.62, top: B + up, hang: true, rot: deg * 0.13, tilt: 0.06, g: 0.47, warm: 0, ...o });
      };
      [[-80, 1.0, 1.5], [-64, 2.0, 1.4], [-48, 3.1, 1.55], [-32, 4.1, 1.4], [-16, 5.2, 1.6], [1, 6.2, 1.45],
        [18, 7.3, 1.5], [35, 8.4, 1.4], [52, 9.5, 1.55]].forEach(([deg, up, sz]) => ledge(deg, up, sz));
      ledge(70, 10.4, 2.5, { sy: 0.5, g: 0.5 }); // смотровой камень над чашей
      // 3) берег: камни разного размера, группами, а не через равные промежутки
      for (const [a, l, sz, sy, rot, tilt] of [[-7.5, -11.6, 1.7, 0.75, 0.7, 0.15], [-9.3, -13.4, 0.75, 0.8, 2.2, 0.3], [-5.4, -13.8, 0.5, 0.9, 4.0, 0.2],
        [-6.2, 12.4, 2.0, 0.7, 1.9, 0.1], [-9.0, 14.3, 0.95, 0.85, 3.6, 0.35], [-16.0, -6.4, 1.15, 0.7, 5.2, 0.2], [-17.6, 7.0, 0.85, 0.8, 0.3, 0.25],
        [-15.0, 8.6, 0.5, 1.0, 2.8, 0.1], [-3.2, 15.5, 1.3, 0.9, 4.4, 0.2]]) {
        const [x, z] = at(s.pc + a, l);
        stone(x, z, { s: sz, sy, rot, tilt, g: 0.5 + sz * 0.03 });
      }
      continue;
    }
    // чаша на первом кольце: u — вниз по течению от центра чаши, v — поперёк
    const at = (u, v) => [p.x + p.dx * u - p.dz * v, p.z + p.dz * u + p.dx * v];
    for (const [u, v, sz, up, rot] of [[1.4, -3.3, 1.0, 0.5, 0.9], [2.3, -0.2, 1.15, 0.8, 2.6], [1.2, 3.1, 0.95, 0.55, 4.1]]) {
      const [x, z] = at(u, v);
      stone(x, z, { s: sz, sy: 2.0, sz: 0.9, top: p.level + up, rot, g: 0.5, warm: 0 });
    }
    for (const [u, v, sz, sy, rot, tilt] of [[-0.6, -6.8, 1.6, 0.75, 1.3, 0.15], [2.4, -7.3, 0.7, 0.85, 3.0, 0.3], [0.2, 6.6, 1.25, 0.8, 5.1, 0.2],
      [3.4, 6.4, 0.6, 0.9, 0.8, 0.25], [5.9, -5.2, 0.9, 0.7, 2.0, 0.2]]) {
      const [x, z] = at(u, v);
      if (waterAt(x, z) > -1e8 || heightAt(x, z) > p.level + 1.2) continue;
      stone(x, z, { s: sz, sy, rot, tilt });
    }
    for (const side of [-1, 1]) {
      const x = -p.dx * p.rTop + p.dz * side * 3.3, z = -p.dz * p.rTop - p.dx * side * 3.3;
      add(lists.rock, x, heightAt(x, z) - 0.2, z, 1.7, 0x8f8a82, rnd() * TAU, 0.2);
      taken.push({ x, z, r: 1.7 });
    }
  }
  // родник в верховье ущелья: вода выходит из-под камней
  for (const s of SOURCES) {
    for (const [da, l, sc] of [[1.4, 0, 1.9], [0.4, -2.2, 1.4], [0.6, 2.4, 1.6], [-1.2, -2.7, 1.0], [2.8, 1.2, 1.5]]) {
      const a = SRC.GORGE + da, r = W.SRC_R + a, th = s.tw + l / r, x = Math.cos(th) * r, z = Math.sin(th) * r;
      const g = 0.46 + rnd() * 0.1;
      add(lists.rock, x, heightAt(x, z) - 0.25, z, sc, col.setRGB(g * 0.95, g, g * 0.92).getHex(), rnd() * TAU, rnd() * 0.3);
      taken.push({ x, z, r: sc });
    }
  }
  // кусты: много, по лугу и кольцу
  scatter(230, W.PIT + 3, W.MEADOW - 10, (x, y, z, ny) => {
    if (ny < 0.9 || !free(x, z, 1.2)) return false;
    const deep = y < -9;
    col.setHSL(deep ? 0.44 + rnd() * 0.05 : 0.26 + rnd() * 0.09, 0.5, 0.36 + rnd() * 0.1);
    add(lists.bush, x, y - 0.05, z, 0.7 + rnd() * 0.9, col.getHex());
    return true;
  });

  // лиственные деревья: луг и верхние уступы, растут рощами
  scatter(300, W.HOLE + 4, W.MEADOW + 8, (x, y, z, ny) => {
    if (ny < 0.93 || y < -34) return false;
    if (fbm(x * 0.02 + 3, z * 0.02, 2) < -0.08 && y > -2) return false;
    if (!free(x, z, 2.6)) return false;
    const s = (y < -2 ? 0.75 : 0.95) + rnd() * 0.6;
    const hue = 0.25 + rnd() * 0.09, deep = y < -9;
    col.setHSL(deep ? 0.42 + rnd() * 0.05 : hue, 0.45, 0.29 + rnd() * 0.07);
    // осенние деревья для пятен цвета
    if (!deep && rnd() < 0.09) col.setHSL(0.06 + rnd() * 0.04, 0.6, 0.42);
    add(lists.leaf, x, y - 0.1, z, s, col.getHex());
    taken.push({ x, z, r: 2.2 });
    colliders.push({ x, z, r: 0.42 * s });
    blobs.push({ x, z, r: 3.3 * s, h: 3.2 * s });
    return true;
  });
  // сосны: ближе к горам
  scatter(170, W.MEADOW - 60, W.MEADOW + 55, (x, y, z, ny) => {
    if (ny < 0.86 || !free(x, z, 2.2)) return false;
    const s = 0.9 + rnd() * 0.8;
    col.setHSL(0.36 + rnd() * 0.05, 0.42, 0.27 + rnd() * 0.07);
    add(lists.pine, x, y - 0.1, z, s, col.getHex());
    taken.push({ x, z, r: 1.8 });
    colliders.push({ x, z, r: 0.36 * s });
    blobs.push({ x, z, r: 2.4 * s, h: 3.5 * s });
    return true;
  });
  // гигантские светящиеся грибы на глубоких уступах
  scatter(14, W.PIT + 3, W.R - 6, (x, y, z, ny) => {
    if (ny < 0.93 || y > -11.5 || !free(x, z, 2.8)) return false;
    const s = 0.7 + rnd() * 0.9;
    col.setHSL(y < -66 ? 0.74 + rnd() * 0.08 : 0.47 + rnd() * 0.07, 0.6, 0.55);
    add(lists.shroom, x, y - 0.1, z, s, col.getHex());
    taken.push({ x, z, r: 2.4 });
    colliders.push({ x, z, r: 0.45 * s });
    blobs.push({ x, z, r: 2.6 * s, h: 2.4 * s });
    return true;
  });
  // камни: везде, особенно у края
  scatter(250, W.PIT + 2, W.MEADOW + 40, (x, y, z, ny, r) => {
    if (ny < 0.8) return false;
    const big = rnd() < 0.22;
    const s = big ? 1.3 + rnd() * 1.5 : 0.35 + rnd() * 0.6;
    if (!free(x, z, s + 0.6)) return false;
    if (r > W.R + 30 && r < W.MEADOW - 30 && rnd() < 0.5) return false;
    const g = 0.5 + rnd() * 0.16;
    if (y < -30) col.setRGB(g * 0.7, g * 0.74, g * 0.9); else col.setRGB(g * 1.0, g * 0.92, g * 0.82);
    add(lists.rock, x, y, z, s, col.getHex(), rnd() * TAU, rnd() * 0.5);
    if (s > 0.8) { taken.push({ x, z, r: s }); blobs.push({ x, z, r: s * 1.5, h: s * 0.5 }); }
    return true;
  });
  // одинокие деревья на островках
  for (const st of STACKS) {
    for (let i = 0; i < st.trees; i++) {
      const a = rnd() * TAU, rr = st.w * (i === 0 ? 0.15 : 0.35 + rnd() * 0.3);
      const x = st.x + Math.cos(a) * rr, z = st.z + Math.sin(a) * rr, s = 0.9 + rnd() * 0.7;
      const pine = rnd() < 0.65;
      col.setHSL(pine ? 0.37 + rnd() * 0.05 : 0.30 + rnd() * 0.06, 0.45, 0.25 + rnd() * 0.06);
      add(pine ? lists.pine : lists.leaf, x, st.top + 0.2, z, s, col.getHex());
    }
  }
  // одинокие сосны на нижнем уступе
  scatter(14, W.PIT + 4, W.HOLE - 4, (x, y, z, ny) => {
    if (ny < 0.9 || y > -40 || !free(x, z, 3)) return false;
    col.setHSL(0.40 + rnd() * 0.05, 0.4, 0.22 + rnd() * 0.05);
    add(lists.pine, x, y - 0.1, z, 0.8 + rnd() * 0.7, col.getHex());
    taken.push({ x, z, r: 2 }); colliders.push({ x, z, r: 0.35 });
    return true;
  });
  // кристаллы: глубина
  scatter(40, W.PIT + 1, W.R - 4, (x, y, z, ny) => {
    if (y > -10 || ny < 0.5 || !free(x, z, 1)) return false;
    col.setHSL(y < -70 ? 0.83 + rnd() * 0.06 : 0.5 + rnd() * 0.05, 0.75, 0.66);
    add(lists.crystal, x, y - 0.05, z, 0.6 + rnd() * 1.1, col.getHex(), rnd() * TAU, (rnd() - 0.5) * 0.5);
    return true;
  });
  // мелкие светящиеся грибочки
  scatter(110, W.PIT + 1, W.R - 4, (x, y, z, ny) => {
    if (y > -9 || ny < 0.9) return false;
    col.setHSL(y < -66 ? 0.8 : 0.48 + rnd() * 0.08, 0.7, 0.68);
    add(lists.small, x, y, z, 0.7 + rnd() * 1.4, col.getHex());
    return true;
  });

  const geos = {
    leaf: leafTree(), pine: pineTree(), shroom: giantShroom(),
    rock: rockGeo(), crystal: crystalGeo(), small: smallShroom(), bush: bushGeo(),
  };
  for (const key in lists) {
    const L = lists[key];
    const im = new THREE.InstancedMesh(geos[key], material, L.length);
    L.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(t.tilt, t.rot, t.tilt * 0.6);
      dummy.scale.setScalar(t.s);
      if (key === 'rock') {
        if (t.sy) dummy.scale.set(t.s, t.s * t.sy, t.s * t.sz);
        else dummy.scale.set(t.s, t.s * (0.7 + (i % 5) * 0.1), t.s * (0.8 + (i % 3) * 0.15));
      }
      dummy.updateMatrix();
      if (t.top !== undefined) {
        // камень с заданной высотой верха: меряем готовую модель и ставим её верх ровно на top
        let hi = -1e9;
        const P = geos.rock.attributes.position;
        for (let v = 0; v < P.count; v++) hi = Math.max(hi, _v.fromBufferAttribute(P, v).applyMatrix4(dummy.matrix).y);
        dummy.position.y += t.top - hi;
        dummy.updateMatrix();
      }
      if (key === 'rock') rockSolid(geos.rock, dummy.matrix, t);
      im.setMatrixAt(i, dummy.matrix);
      im.setColorAt(i, col.setHex(t.color));
    });
    im.instanceMatrix.needsUpdate = true;
    // деревья можно рубить: запоминаем, где какое стоит и какой у него ствол-препятствие
    if (key === 'leaf' || key === 'pine') L.forEach((t, i) => trees.push({ mesh: im, i, x: t.x, y: t.y, z: t.z, s: t.s, rot: t.rot,
      col: colliders.find((c) => c.x === t.x && c.z === t.z) || null }));
    im.frustumCulled = false; // один вызов на вид; вершин немного
    im.matrixAutoUpdate = false;
    scene.add(im);
  }
  return { colliders, blobs, spawn, trees };
}

// Валун становится твёрдым: верх его настоящей модели запекается в карту высот
const _v = new THREE.Vector3();
function rockSolid(geo, m, t) {
  if (t.s < 0.3) return;
  const P = geo.attributes.position, tris = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    _v.fromBufferAttribute(P, i).applyMatrix4(m);
    tris[i * 3] = _v.x; tris[i * 3 + 1] = _v.y; tris[i * 3 + 2] = _v.z;
  }
  addMeshTop(tris, Math.min(0.3, t.s * 0.15), { soft: t.s < 1.0, hang: !!t.hang });
}

// ---------- трава и цветы: «ковёр», который ездит за игроком ----------
// Травинки живут в квадрате со стороной S и заворачиваются по модулю вокруг
// игрока, поэтому их число не зависит от размера мира. Высоту берут из текстуры.
const GRASS_VS = /* glsl */ `
  uniform sampler2D uHmap; uniform vec3 uCenter, uPlayer; uniform float uS;
  attribute vec4 aOff;
  varying vec3 vW; varying vec3 vC; varying float vSh;
  void main(){
    vec2 base = aOff.xy + uS * floor((uCenter.xz - aOff.xy)/uS + 0.5);
    vec2 hm = texture2D(uHmap, base/(2.0*uExt)+0.5).rg;
    float dist = distance(base, uCenter.xz);
    float fade = smoothstep(uS*0.5, uS*0.30, dist);
    float e = max(abs(base.x), abs(base.y));
    float k = hm.g * fade * step(e, uExt-1.0);
    // травинки там, где травы нет, и за кадром не считаем вовсе — это большая часть ковра
    vec4 cb = projectionMatrix * viewMatrix * vec4(base.x, hm.r + 0.5, base.y, 1.0);
    float lim = cb.w * 1.15 + 1.5;
    if (k < 0.03 || cb.w < -1.5 || abs(cb.x) > lim || abs(cb.y) > lim) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      vW = vec3(0.0); vC = vec3(0.0); vSh = 0.0;
      return;
    }
    float a = aOff.z * 6.2831;
    vec2 dir = vec2(cos(a), sin(a));
    float y = position.y;
    #ifdef FLOWER
      k *= step(0.5, k) * smoothstep(60.0, 40.0, -hm.r);
      float hgt = (0.42 + 0.3*aOff.w) * k;
      vec3 p = vec3(base.x, hm.r, base.y) + vec3(position.x*dir.x - position.z*dir.y, 0.0, position.x*dir.y + position.z*dir.x) * k;
      p.y += y * hgt;
    #else
      float hgt = (0.45 + 0.55*aOff.w) * k * (0.75 + 0.5*vnoise(base*0.12));
      vec3 p = vec3(base.x + position.x*dir.x, hm.r, base.y + position.x*dir.y);
      p.y += y * hgt;
    #endif
    // ветер: медленные волны по полю + мелкая дрожь
    float w = sin(uTime*1.4 + base.x*0.16 + base.y*0.11) * 0.5 + sin(uTime*2.6 + base.x*0.7 - base.y*0.5) * 0.18;
    vec2 bend = vec2(0.8, 0.45) * (w*0.26 + 0.1);
    // трава раздвигается под ногами
    vec2 dp = base - uPlayer.xz;
    float dl = length(dp);
    bend += (dp / max(dl, 0.01)) * smoothstep(1.3, 0.2, dl) * step(abs(hm.r - uPlayer.y), 1.5) * 0.9;
    p.xz += bend * y * y * hgt;
    p.y -= dot(bend, bend) * y * hgt * 0.35;
    vW = p;
    vec3 g = grassCol(vec3(base.x, hm.r, base.y));
    #ifdef FLOWER
      vC = mix(g*0.8, color, step(0.62, y));
    #else
      vC = g * mix(0.80, 1.28, y) + vec3(0.07,0.06,-0.02)*y*y;
    #endif
    vSh = shadowAt(base);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const GRASS_FS = /* glsl */ `
  varying vec3 vW; varying vec3 vC; varying float vSh;
  void main(){
    vec3 c = shade(vC, vec3(0.0,1.0,0.0), vSh);
    gl_FragColor = vec4(applyFog(c, vW), 1.0);
  }`;

export function buildGrass(scene, count) {
  const S = 64;
  const rnd = mulberry32(SEED + 99);
  const out = {};

  // травинка: 5 вершин, 3 треугольника
  {
    const w = 0.075;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w, 0, 0, w, 0, 0, -w * 0.62, 0.5, 0, w * 0.62, 0.5, 0, 0, 1, 0]), 3));
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    const off = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      off[i * 4] = rnd() * S; off[i * 4 + 1] = rnd() * S; off[i * 4 + 2] = rnd(); off[i * 4 + 3] = rnd();
    }
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    g.instanceCount = count;
    const m = new THREE.Mesh(g, mat({ uniforms: { uS: { value: S } }, vertexShader: GRASS_VS, fragmentShader: GRASS_FS, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    scene.add(m);
    out.grass = g;
  }
  // цветы: стебель + головка-ромбик
  {
    const fc = Math.floor(count / 15);
    const g = new THREE.InstancedBufferGeometry();
    const s = 0.012, r = 0.085;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -s, 0, 0, s, 0, 0, 0, 0.8, 0,
      -r, 0.86, 0, r, 0.86, 0, 0, 1.0, 0, 0, 0.72, 0,
      0, 0.86, -r, 0, 0.86, r,
    ]), 3));
    g.setIndex([0, 1, 2, 3, 4, 5, 3, 6, 4, 7, 8, 5, 7, 6, 8]);
    const off = new Float32Array(fc * 4), colr = new Float32Array(fc * 3);
    const pal = [0xff5a4d, 0xffd84a, 0xffffff, 0xff8fc0, 0x8fb4ff, 0xff7a2e];
    const c = new THREE.Color();
    for (let i = 0; i < fc; i++) {
      // цветы растут пятнами-полянками
      const cx = rnd() * S, cy = rnd() * S;
      off[i * 4] = cx; off[i * 4 + 1] = cy; off[i * 4 + 2] = rnd(); off[i * 4 + 3] = rnd();
      c.setHex(pal[(fbm(cx * 0.09, cy * 0.09, 1) * 3 + 3 + rnd() * 1.2) % pal.length | 0]);
      colr[i * 3] = c.r; colr[i * 3 + 1] = c.g; colr[i * 3 + 2] = c.b;
    }
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    g.setAttribute('color', new THREE.InstancedBufferAttribute(colr, 3));
    g.instanceCount = fc;
    const m = new THREE.Mesh(g, mat({
      uniforms: { uS: { value: S } }, defines: { FLOWER: 1 }, vertexColors: true,
      vertexShader: GRASS_VS, fragmentShader: GRASS_FS, side: THREE.DoubleSide,
    }));
    m.frustumCulled = false;
    scene.add(m);
    out.flowers = g;
  }
  out.setDensity = (k) => {
    out.grass.instanceCount = Math.floor(count * k);
  };
  return out;
}
