import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat } from './shaders.js';
import { LAKE, heightAt, waterAt } from './terrain.js';
import { STONEAPI } from './descent.js';
import { fieldTop as solidTop, groundAt, ceiling, addMeshTop } from './solids.js';
import { STREAMS } from './waterfall.js';
import { SWING } from './player.js';
import { objId, RULES } from './world.js';

// Глубина: светящиеся кристаллы, грибы и рудные камни на глыбах поля.
// Начинаются с −75 м и чем глубже, тем их больше; у озера растут большие грибы.
// Всё добывается, как дерево и камень: кирка — кристаллы и руда, топор — большие грибы,
// маленькие грибы собираются рукой. Серые камни — обычные валуны (mine.js). Последний удар — просьба к миру ('harvest'), ответ — 'harvested'.
//
// Для телефона: каждый вид — один InstancedMesh (один вызов отрисовки), дальше 55 м от камеры
// экземпляры сворачиваются в вершинном шейдере. Свечение добавляется ПОСЛЕ тумана и света фонарика
// и не выгорает в белое: яркость упирается в потолок с сохранением оттенка.

const TAU = Math.PI * 2;
const TOP = -75;                     // отсюда вниз
const BOTTOM = LAKE.level;           // у озера плотность максимальная
const FAR = 55;                      // дальше — не рисуем
const CELL = 8;

// ---------- модели ----------
// Части: kind (0 камень, 1 светящаяся крапинка руды, 2 кристалл, 3 ножка, 4 шляпка, 5 пластинки, 6 пятна),
// glow — сила свечения, h — высота точки внутри части 0..1 (для градиентов).
function piece(geo, color, kind, glow, m) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.computeBoundingBox();
  const y0 = g.boundingBox.min.y, y1 = g.boundingBox.max.y;
  const P = g.attributes.position, n = P.count;
  const d = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    d[i * 3] = kind; d[i * 3 + 1] = glow; d[i * 3 + 2] = (P.getY(i) - y0) / Math.max(1e-4, y1 - y0);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  if (m) g.applyMatrix4(m);
  g.computeVertexNormals(); // гранёные нормали: у кристаллов видны грани
  g.setAttribute('aD', new THREE.BufferAttribute(d, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function join(parts) {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const [name, k] of [['position', 3], ['normal', 3], ['color', 3], ['aD', 3]]) {
    const a = new Float32Array(n * k);
    let o = 0;
    for (const p of parts) { a.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(a, k));
  }
  return out;
}
const M = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1, sy = s) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, sy, s));
const V2 = (x, y) => new THREE.Vector2(x, y);

// кристалл: шестигранная призма с острой вершиной
function shard(r, h) { return new THREE.LatheGeometry([V2(r * 0.9, -0.05), V2(r, h * 0.72), V2(0, h)], 6); }
function crystalGeo() {
  const parts = [piece(shard(0.17, 1.15), 0xffffff, 2, 1, M(0, 0, 0, 0.05, 0.3, -0.06))];
  const side = [[0.62, 0.2, 0.55, 0.11], [0.48, 2.3, 0.65, 0.1], [0.38, 4.3, 0.6, 0.085]];
  for (const [h, a, t, r] of side) parts.push(piece(shard(r, h), 0xe6e6e6, 2, 1, M(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12, Math.sin(a) * t, 0, -Math.cos(a) * t)));
  // каменное «гнездо», из которого растёт друза
  const base = new THREE.IcosahedronGeometry(0.26, 0);
  parts.push(piece(base, 0x3b3f4c, 0, 0, M(0, -0.04, 0, 0, 0.4, 0, 1, 0.45)));
  return join(parts);
}
// снизу вверх: так грани лате смотрят наружу
function capProfile(r, h) { return [V2(r * 0.9, -h * 0.08), V2(r * 1.02, h * 0.1), V2(r * 0.72, h * 0.75), V2(0, h)]; }
function stemGeo(r, h) { return new THREE.LatheGeometry([V2(r * 1.4, 0), V2(r * 0.85, h * 0.5), V2(r, h)], 5); }
function smallShroomGeo() {
  const parts = [];
  for (const [x, z, s, lean] of [[0, 0, 1, 0.08], [0.2, 0.1, 0.62, 0.38]]) {
    const h = 0.34 * s, r = 0.17 * s, m = M(x, 0, z, lean * 0.6, 0, lean);
    parts.push(piece(stemGeo(0.035 * s, h), 0xd8e2e6, 3, 0, m.clone().multiply(M(0, 0, 0))));
    parts.push(piece(new THREE.LatheGeometry(capProfile(r, r * 0.75), 7), 0xffffff, 4, 1, m.clone().multiply(M(0, h - 0.01, 0))));
    parts.push(piece(new THREE.CircleGeometry(r * 0.92, 7), 0xffffff, 5, 1, m.clone().multiply(M(0, h - 0.015, 0, Math.PI / 2))));
  }
  return join(parts);
}
function bigShroomGeo() {
  const parts = [], H = 3.0, R = 1.9;
  parts.push(piece(new THREE.LatheGeometry([V2(0.55, 0), V2(0.34, 0.4), V2(0.24, 1.6), V2(0.27, H)], 8), 0xdfe6ea, 3, 0, M(0, 0, 0, 0, 0, 0.05)));
  // кольцо-«юбка» на ножке
  parts.push(piece(new THREE.LatheGeometry([V2(0.42, -0.12), V2(0.48, 0), V2(0.26, 0.2)], 8), 0xffffff, 5, 0.7, M(0.07, H * 0.62, 0)));
  parts.push(piece(new THREE.LatheGeometry(capProfile(R, 1.15), 12), 0xffffff, 4, 1, M(0.15, H - 0.05, 0)));
  parts.push(piece(new THREE.CircleGeometry(R * 0.93, 12), 0xffffff, 5, 1, M(0.15, H - 0.08, 0, Math.PI / 2)));
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4 + 0.3, rr = i < 3 ? 0.45 + i * 0.12 : 0.85 + (i % 3) * 0.3, cy = 1.15 * (1 - (rr / R) ** 2 * 0.72);
    parts.push(piece(new THREE.SphereGeometry(0.2 + (i % 3) * 0.06, 5, 3), 0xffffff, 6, 1, M(0.15 + Math.cos(a) * rr, H - 0.02 + cy, Math.sin(a) * rr, 0, 0, 0, 1, 0.5)));
  }
  return join(parts);
}

// ---------- материал ----------
let _mat;
function deepMaterial() {
  if (_mat) return _mat;
  _mat = mat({
    uniforms: { uFar: { value: FAR } },
    vertexColors: true,
    vertexShader: /* glsl */ `
      uniform float uFar;
      attribute vec3 aD;
      varying vec3 vW; varying vec3 vN; varying vec3 vC; varying vec3 vT; varying vec3 vD; varying vec3 vL; varying float vSh;
      void main(){
        mat4 mm = modelMatrix * instanceMatrix;
        vec3 o = mm[3].xyz;
        float od = distance(o, cameraPosition);
        // далеко — не рисуем (одна проверка на вершину вместо отдельных кусков сетки)
        if (od > uFar) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
        vec4 wp = mm * vec4(position * smoothstep(uFar, uFar - 8.0, od), 1.0);
        // грибы чуть покачиваются
        float sw = step(2.5, aD.x) * position.y * 0.012;
        wp.x += sin(uTime * 1.1 + o.x) * sw; wp.z += cos(uTime * 0.9 + o.z) * sw;
        vW = wp.xyz; vN = normalize(mat3(mm) * normal); vC = color; vD = aD; vL = position;
        vT = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vT = instanceColor;
        #endif
        vSh = shadowAt3(o + vec3(0.0, 1.0, 0.0));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying vec3 vC; varying vec3 vT; varying vec3 vD; varying vec3 vL; varying float vSh;
      void main(){
        float cd = distance(vW, cameraPosition);
        // вплотную к камере тает «в сеточку», как остальные растения
        if (cd < 1.1) {
          float dth = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (dth > smoothstep(0.35, 1.1, cd)) discard;
        }
        vec3 n = normalize(vN), v = normalize(cameraPosition - vW);
        float k = vD.x, g = vD.y, h = vD.z;
        float fres = pow(1.0 - abs(dot(n, v)), 2.0);
        float pulse = 0.82 + 0.18 * sin(uTime * 1.3 + vW.x * 0.6 + vW.z * 0.45 + vW.y * 0.3);
        vec3 alb, em = vec3(0.0);
        if (k < 0.5) {            // камень: пятна и прожилки
          float t = vnoise(vL.xz * 4.0 + vL.y * 3.0) * 0.6 + vnoise(vL.zy * 9.0 + vL.x) * 0.4;
          alb = vC * (0.7 + 0.55 * t);
          float vein = smoothstep(0.05, 0.0, abs(vnoise(vL.xy * 5.0 + vL.z * 3.0) - 0.5));
          em = vT * vein * 0.35 * pulse;       // по руде бегут светящиеся жилки
        } else if (k < 1.5) {     // крапинки руды
          alb = vT * 0.4;
          em = vT * (0.75 + 0.6 * fres) * pulse;
        } else if (k < 2.5) {     // кристалл: тёмное основание, светящаяся вершина, грани и искры
          float band = vnoise(vec2(vL.y * 7.0, (vL.x + vL.z) * 5.0));
          alb = vT * 0.22 * vC;
          em = vT * vC * (0.18 + 1.05 * h * h) * (0.75 + 0.5 * band);
          em += mix(vT, vec3(1.0), 0.3) * fres * 0.45;
          float sp = vnoise(vW.xz * 11.0 + vW.y * 9.0 + uTime * 0.7);
          em += mix(vT, vec3(1.0), 0.5) * smoothstep(0.86, 0.97, sp) * 0.9;
          em *= pulse;
        } else if (k < 3.5) {     // ножка гриба: бледная, к шляпке светится
          alb = mix(vC, vT, 0.25) * (0.5 + 0.2 * vnoise(vL.xy * 14.0));
          em = vT * (0.03 + 0.3 * h * h * h) + vT * fres * 0.12;
        } else if (k < 4.5) {     // шляпка: насыщенный цвет, светлее к краю, светящийся ободок
          float t = vnoise(vL.xz * 7.0) * 0.6 + vnoise(vL.xz * 19.0) * 0.4;
          alb = vT * (0.35 + 0.45 * t);
          // темнее к макушке, ярче к краю шляпки: так видно форму
          em = vT * (0.08 + 0.35 * fres + 0.75 * smoothstep(0.4, 0.05, h) + 0.15 * t) * g * pulse;
        } else if (k < 5.5) {     // пластинки под шляпкой: светятся сильнее всего
          float rib = 0.55 + 0.45 * sin(atan(vL.z, vL.x) * 26.0);
          alb = vT * 0.4;
          em = mix(vT, vec3(0.6, 1.0, 0.95), 0.25) * (0.45 + 0.75 * rib) * g * pulse;
        } else {                  // пятна на шляпке
          alb = vT;
          em = mix(vT, vec3(0.75, 1.0, 0.95), 0.55) * 1.2 * pulse;
        }
        vec3 c = shade(alb, n, vSh);
        c = applyFog(c, vW);
        // своё свечение — поверх тумана, но вдали гаснет вместе с ним
        c += em * exp(-cd * 0.014);
        // потолок яркости с сохранением цвета: никакого белого пятна
        float mx = max(max(c.r, c.g), c.b);
        if (mx > 0.95) c *= 0.95 / mx;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return _mat;
}
// мягкий ореол вокруг светящегося: плоскость, всегда смотрит в камеру, складывается со светом
let _halo;
function haloMaterial() {
  if (_halo) return _halo;
  _halo = mat({
    uniforms: { uFar: { value: FAR } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uFar;
      varying vec2 vUv; varying vec3 vT; varying float vA;
      void main(){
        mat4 mm = modelMatrix * instanceMatrix;
        vec3 o = mm[3].xyz;
        float s = length(mm[0].xyz), d = distance(o, cameraPosition);
        if (d > uFar || s < 1e-3) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
        vec4 mv = viewMatrix * vec4(o, 1.0);
        mv.xy += position.xy * s;
        mv.z += s * 0.35;  // чуть к камере, чтобы ореол не резался о свой камень
        vUv = uv; vT = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vT = instanceColor;
        #endif
        vA = smoothstep(1.2, 4.0, d) * smoothstep(uFar, uFar - 12.0, d) * (0.85 + 0.15 * sin(uTime * 1.3 + o.x * 0.6 + o.z * 0.45 + o.y * 0.3));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vT; varying float vA;
      void main(){
        float r = length(vUv - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.0, 1.0, r));
        a *= a;
        gl_FragColor = vec4(vT * a * vA * 0.42, 1.0);
      }`,
  });
  return _halo;
}

// ---------- расстановка ----------
// Виды: что даёт, чем добывать, размер для поиска цели.
export const DEEP_KINDS = {
  // из кристаллов выпадает не сам кристалл, а кристальная пыль
  crystal: { item: 'dust', icon: '💎', name: 'Синий кристалл', reach: 0.55, h: 1.2 },
  bigcrystal: { item: 'dust', icon: '💎', name: 'Синий кристалл', reach: 0.5, h: 1.2 },
  shroom: { item: 'shroom', icon: '🍄', name: 'Гриб', reach: 0.4, h: 0.45 },
  rock: { reach: 0.8, h: 1.0 },   // обычные серые камни (их добывает mine.js, как на дне шахты)
  big: { item: 'shroom', icon: '🍄', name: 'Гриб', reach: 0.6, h: 4.2 },
};

// воду проверяем по всем рядам ручьёв (и спокойным тоже): на русло ничего не ставим
let WGRID = null;
function waterGrid() {
  if (WGRID) return WGRID;
  WGRID = new Map();
  for (const st of STREAMS) for (const r of st.rows) {
    for (let u = -1; u <= 1.001; u += 0.25) {
      const x = r.c[0] + r.sd[0] * u * r.half, z = r.c[2] + r.sd[1] * u * r.half;
      const key = Math.floor(x / 4) + ',' + Math.floor(z / 4);
      (WGRID.get(key) || WGRID.set(key, []).get(key)).push([x, r.c[1], z]);
    }
  }
  return WGRID;
}
function wet(x, y, z, rad) {
  if (waterAt(x, z) > y - 0.3) return true;
  const G = waterGrid(), R = rad + 1.2;
  for (let gx = Math.floor((x - R) / 4); gx <= Math.floor((x + R) / 4); gx++)
    for (let gz = Math.floor((z - R) / 4); gz <= Math.floor((z + R) / 4); gz++) {
      const l = G.get(gx + ',' + gz);
      if (l) for (const p of l) if (Math.abs(p[1] - y) < 4 && Math.hypot(p[0] - x, p[2] - z) < R) return true;
    }
  return false;
}

// Где что стоит. Делается один раз при загрузке, по глыбам текущей карты (своей или встроенной).
export function planDeep() {
  const rnd = mulberry32(SEED + 75);
  const out = { crystal: [], bigcrystal: [], shroom: [], big: [] }, rocks = [], colliders = [];
  const used = new Map();
  const freeAt = (x, z, r) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = used.get((Math.floor(x / 3) + a) + ',' + (Math.floor(z / 3) + b));
      if (l) for (const q of l) if (Math.hypot(q[0] - x, q[1] - z) < q[2] + r) return false;
    }
    return true;
  };
  const take = (x, z, r) => { const k = Math.floor(x / 3) + ',' + Math.floor(z / 3); (used.get(k) || used.set(k, []).get(k)).push([x, z, r]); };
  const depthK = (y) => Math.min(1, Math.max(0, (TOP - y) / (TOP - BOTTOM)));
  // верх глыбы в точке, если тут ровно, сухо и ничего не нависает
  const spotOn = (solid, x, z, r, h) => {
    const t = solidTop(solid, x, z);
    if (t < -1e8 || t > TOP || t < LAKE.level + 0.4) return null;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4, q = solidTop(solid, x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (q < -1e8 || Math.abs(q - t) > 0.28 + r * 0.15) return null;
    }
    const gnd = groundAt(x, z, t + 0.05);
    if (gnd > t + 0.12 || ceiling < t + h + 0.4) return null;   // другая глыба сверху или внутри
    if (wet(x, t, z, r)) return null;
    return t;
  };
  for (const st of STONEAPI.all()) {
    const sp = st.spec, solid = st.solid;
    if (!solid || sp.y > TOP + 2) continue;
    const kk = depthK(sp.y), area = Math.PI * sp.A * sp.B, R = Math.max(sp.A, sp.B);
    // ожидаемое число на глыбе: на −75 — редкость, у озера — в разы больше
    const want = {
      crystal: area * (0.003 + 0.012 * kk),
      shroom: area * (0.004 + 0.015 * kk),
      bigcrystal: area * (0.0008 + 0.004 * kk),
      rock: area * (0.003 + 0.006 * kk),
    };
    for (const kind of ['rock', 'bigcrystal', 'crystal', 'shroom']) {
      let n = Math.floor(want[kind]) + (rnd() < want[kind] % 1 ? 1 : 0);
      const K = DEEP_KINDS[kind];
      for (let tries = 0; tries < n * 8 && n > 0; tries++) {
        const a = rnd() * TAU, d = Math.sqrt(rnd()) * R * 0.92, x = sp.x + Math.cos(a) * d, z = sp.z + Math.sin(a) * d;
        const s = kind === 'crystal' ? 0.6 + rnd() * 0.7 + kk * 0.35 : kind === 'bigcrystal' ? 1.9 + rnd() * 0.9 : kind === 'shroom' ? 0.75 + rnd() * 0.6
          : rnd() < 0.4 ? 1.1 + rnd() * 0.8 : 0.45 + rnd() * 0.4;   // камни: большие и маленькие
        if (!freeAt(x, z, K.reach * s + 0.5)) continue;
        const y = spotOn(solid, x, z, K.reach * s, K.h * s);
        if (y === null) continue;
        take(x, z, K.reach * s + 0.3);
        (kind === 'rock' ? rocks : out[kind]).push({ x, y, z, s, rot: rnd() * TAU, tilt: (rnd() - 0.5) * 0.25, hue: rnd(), kk: depthK(y) });
        n--;
      }
    }
  }
  // большие грибы — у озера: на нижних глыбах и на берегу
  const bigN = 14;
  for (let tries = 0; tries < 3000 && out.big.length < bigN; tries++) {
    const a = rnd() * TAU, d = LAKE.r + 1 + rnd() * 24, x = Math.cos(a) * d, z = Math.sin(a) * d;
    const s = 0.8 + rnd() * 0.6, r = 2.0 * s;
    if (!freeAt(x, z, r + 1.2)) continue;
    const g = groundAt(x, z, LAKE.level + 30);
    if (g > LAKE.level + 14 || g < LAKE.level + 0.5 || ceiling < g + 4.4 * s) continue;
    // ровно под шляпкой и ножкой, сухо
    let ok = true;
    for (let i = 0; i < 6 && ok; i++) { const b = i * TAU / 6; if (Math.abs(groundAt(x + Math.cos(b) * 0.7, z + Math.sin(b) * 0.7, g + 0.5) - g) > 0.5) ok = false; }
    if (!ok || wet(x, g, z, r)) continue;
    take(x, z, r);
    out.big.push({ x, y: g - 0.05, z, s, rot: rnd() * TAU, tilt: (rnd() - 0.5) * 0.12, hue: rnd(), kk: 1 });
    colliders.push({ x, z, r: 0.32 * s, y0: g - 0.5, y1: g + 3.2 * s });
  }
  for (const o of out.bigcrystal) colliders.push({ x: o.x, z: o.z, r: 0.22 * o.s, y0: o.y - 0.4, y1: o.y + 1.1 * o.s });
  return { lists: out, rocks, colliders };
}

// ---------- цвета ----------
// Кристаллы: на −75 бирюзовые, глубже — сине-фиолетовые и малиновые. Грибы: бирюза и голубой,
// у озера — сиреневые. Руда: тёплые янтарные искры среди холодного камня.
const _c = new THREE.Color();
function tint(kind, o) {
  const k = o.kk, j = o.hue;
  if (kind === 'crystal' || kind === 'bigcrystal') return _c.setHSL(0.57 + j * 0.07, 0.9, 0.5 + k * 0.03);   // синий кристалл
  if (kind === 'shroom') return _c.setHSL(j < 0.25 + k * 0.4 ? 0.76 + j * 0.06 : 0.47 + j * 0.06, 0.8, 0.5);
  if (kind === 'big') return _c.setHSL(j < 0.6 ? 0.72 + j * 0.08 : 0.5 + j * 0.05, 0.75, 0.48);
  return _c.setHSL(j < 0.6 ? 0.09 + j * 0.03 : 0.5, 0.9, 0.52);
}

// ---------- серые камни ----------
// Такие же камни, как на дне шахты (модель и материал из flora.js): большие и маленькие.
// Отдаём их в общий список валунов — кирка разбивает их тем же кодом (mine.js), что и остальные.
export function deepRocks(scene, plan, rockGeo, propMaterial) {
  const L = plan.rocks, out = [];
  if (!L.length) return out;
  const im = new THREE.InstancedMesh(rockGeo, propMaterial, L.length), dummy = new THREE.Object3D(), c = new THREE.Color(), v = new THREE.Vector3();
  const P = rockGeo.attributes.position;
  L.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.15 * t.s, t.z);
    dummy.rotation.set(t.tilt, t.rot, t.tilt * 0.6);
    dummy.scale.set(t.s, t.s * (0.62 + t.hue * 0.3), t.s * (0.85 + t.kk * 0.25));
    dummy.updateMatrix();
    const g = 0.42 + t.hue * 0.16;
    im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, c.setRGB(g * 0.72, g * 0.78, g * 0.92));
    const tris = new Float32Array(P.count * 3);
    for (let k = 0; k < P.count; k++) { v.fromBufferAttribute(P, k).applyMatrix4(dummy.matrix); tris[k * 3] = v.x; tris[k * 3 + 1] = v.y; tris[k * 3 + 2] = v.z; }
    const solid = addMeshTop(tris, Math.min(0.3, t.s * 0.15), { soft: t.s < 1.0 });
    out.push({ mesh: im, i, x: t.x, y: t.y, z: t.z, s: t.s, m: dummy.matrix.clone(), solid });
  });
  im.frustumCulled = false; im.matrixAutoUpdate = false;
  scene.add(im);
  return out;
}

// ---------- добыча ----------
const BREAK = 0.35, GROW = 1.4, FLY = 0.7;
export class Deep {
  constructor(scene, plan, player, inv, world, toast) {
    this.player = player; this.inv = inv; this.world = world; this.toast = toast;
    this.target = null; this.cd = 0; this.busy = []; this.pending = null; this.flying = [];
    this.cells = new Map(); this.byId = new Map();
    this.colliders = plan.colliders;
    const cg = crystalGeo(), geos = { crystal: cg, bigcrystal: cg, shroom: smallShroomGeo(), big: bigShroomGeo() };
    const material = deepMaterial();
    this.meshes = {}; this.fly = {};
    const halos = [];
    for (const kind in geos) {
      const L = plan.lists[kind];
      if (!L.length) continue;
      const im = new THREE.InstancedMesh(geos[kind], material, L.length);
      L.forEach((o, i) => {
        o.kind = kind; o.mesh = im; o.i = i; o.id = objId(kind === 'big' ? 'bigshroom' : kind, o.x, o.z);
        o.m = M(o.x, o.y, o.z, o.tilt, o.rot, o.tilt * 0.7, o.s);
        o.col = tint(kind, o).clone();
        o.state = 'idle'; o.t = 0; o.hp = RULES.deep[kind].hits;
        o.col3 = plan.colliders.find((c) => c.x === o.x && c.z === o.z) || null;
        im.setMatrixAt(i, o.m); im.setColorAt(i, o.col);
        this.byId.set(o.id, o);
        const k = Math.floor(o.x / CELL) + ',' + Math.floor(o.z / CELL);
        (this.cells.get(k) || this.cells.set(k, []).get(k)).push(o);
        halos.push(o);
      });
      im.frustumCulled = false; im.matrixAutoUpdate = false;
      scene.add(im);
      this.meshes[kind] = im;
      // то, что летит в руки после добычи: те же модели, маленькие
      const f = new THREE.InstancedMesh(geos[kind], material, 6);
      for (let i = 0; i < 6; i++) { f.setMatrixAt(i, ZERO); f.setColorAt(i, L[0].col); }
      f.frustumCulled = false; f.matrixAutoUpdate = false; f.visible = false;
      scene.add(f);
      this.fly[kind] = f;
    }
    // ореолы: кристаллы, грибы
    this.halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMaterial(), Math.max(1, halos.length));
    halos.forEach((o, i) => {
      o.hi = i;
      o.hm = new THREE.Matrix4().makeTranslation(o.x, o.y + DEEP_KINDS[o.kind].h * o.s * (o.kind === 'big' ? 0.72 : 0.5), o.z)
        .multiply(new THREE.Matrix4().makeScale(...Array(3).fill(o.kind === 'big' ? 7.5 * o.s : o.kind === 'crystal' || o.kind === 'bigcrystal' ? 2.6 * o.s : 1.4 * o.s)));
      this.halo.setMatrixAt(i, o.hm); this.halo.setColorAt(i, o.col);
    });
    this.halo.frustumCulled = false; this.halo.matrixAutoUpdate = false; this.halo.renderOrder = 5;
    scene.add(this.halo);
    this.count = Object.fromEntries(Object.keys(plan.lists).map((k) => [k, plan.lists[k].length]));

    const snap = world.snapshot();
    for (const id in snap.dug || {}) { const o = this.byId.get(id); if (o) this.gone(o, snap.dug[id], false); }
    world.on((ev) => {
      if (ev.type !== 'harvested') return;
      const o = this.byId.get(ev.id);
      if (!o) return;
      if (ev.by === world.me) o.reward = ev.reward;
      this.gone(o, ev.at, true);
    });
  }
  gone(o, at, animate) {
    o.at = at; if (o.col3) o.col3.off = true;
    o.state = animate ? 'break' : 'gone'; o.t = 0;
    if (!animate) this.place(o, 0);
    if (!this.busy.includes(o)) this.busy.push(o);
  }
  place(o, k, sx = 0, sz = 0) {
    _m.copy(o.m);
    if (k !== 1) { _m.decompose(_p, _q, _s); _s.multiplyScalar(Math.max(1e-4, k)); _m.compose(_p, _q, _s); }
    _m.elements[12] += sx; _m.elements[14] += sz;
    o.mesh.setMatrixAt(o.i, _m); o.mesh.instanceMatrix.needsUpdate = true;
    if (o.hi !== undefined) {
      _m.copy(o.hm); _m.decompose(_p, _q, _s); _s.multiplyScalar(Math.max(0, k)); _m.compose(_p, _q, _s);
      this.halo.setMatrixAt(o.hi, _m); this.halo.instanceMatrix.needsUpdate = true;
    }
  }
  need(o) { return RULES.deep[o.kind].tool; }
  find() {
    const p = this.player.pos, cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    let best = null, bd = 1.1;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const l = this.cells.get((cx + a) + ',' + (cz + c));
      if (l) for (const o of l) {
        if (o.state !== 'idle' && o.state !== 'shake') continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z) - DEEP_KINDS[o.kind].reach * o.s;
        if (d < bd && p.y - o.y > -1.6 && p.y - o.y < 2.2) { bd = d; best = o; }
      }
    }
    return best;
  }
  // значок кнопки действия: чем это добывается
  get icon() { const t = this.target && this.need(this.target); return t === 'pickaxe' ? '⛏️' : t === 'axe' ? '🪓' : '✋'; }
  // want — кнопка зажата, press — только что нажата
  update(dt, want, press) {
    const pl = this.player;
    this.target = pl.grounded && !pl.climbing && !pl.swimming ? this.find() : null;
    this.cd -= dt;
    if (this.pending && (this.pending.at -= dt) <= 0) {
      const o = this.pending.o; this.pending = null;
      if (o.state === 'idle' || o.state === 'shake') {
        o.state = 'shake'; o.t = 0;
        if (!this.busy.includes(o)) this.busy.push(o);
        if (--o.hp <= 0) { o.hp = RULES.deep[o.kind].hits; this.world.send({ type: 'harvest', id: o.id, kind: o.kind }); }
      }
    }
    const o = this.target;
    if (o && (want || press)) {
      const tool = this.need(o);
      if (!tool) { if (press) this.world.send({ type: 'harvest', id: o.id, kind: o.kind }); }
      else if (pl.held !== tool) { if (press) this.toast(tool === 'pickaxe' ? 'Нужна кирка ⛏️' : 'Нужен топор 🪓'); }
      else if (this.cd <= 0) {
        pl.facing = Math.atan2(o.x - pl.pos.x, o.z - pl.pos.z);
        pl.swingT = SWING; this.cd = SWING;
        this.pending = { o, at: SWING * 0.42 };
      }
    }
    const now = this.world.now();
    for (let n = this.busy.length - 1; n >= 0; n--) {
      const b = this.busy[n];
      b.t += dt;
      if (b.state === 'shake') {
        const k = Math.max(0, 1 - b.t / 0.25);
        this.place(b, 1 - 0.05 * k, Math.sin(b.t * 70) * 0.05 * k, Math.cos(b.t * 55) * 0.04 * k);
        if (k === 0) { b.state = 'idle'; this.place(b, 1); this.busy.splice(n, 1); }
      } else if (b.state === 'break') {
        const k = Math.min(1, b.t / BREAK);
        this.place(b, 1 - k * k);
        if (k === 1) { b.state = 'gone'; this.place(b, 0); this.drop(b); }
      } else if (b.state === 'gone') {
        if (now - b.at > RULES.deep[b.kind].respawnMs(b.id) && Math.hypot(b.x - pl.pos.x, b.z - pl.pos.z) > 2.5) { b.state = 'grow'; b.t = 0; }
      } else if (b.state === 'grow') {
        const k = Math.min(1, b.t / GROW), e = 1 - (1 - k) ** 3;
        this.place(b, e);
        if (k === 1) { b.state = 'idle'; b.hp = RULES.deep[b.kind].hits; if (b.col3) b.col3.off = false; this.place(b, 1); this.busy.splice(n, 1); }
      }
    }
    if (this.flying.length || this.shown) this.animFly(dt);
  }
  drop(o) {
    const r = o.reward; o.reward = null;
    if (!r) return; // добывал не я
    const K = DEEP_KINDS[o.kind], n = r[K.item] || 0, left = this.inv.add(K.item, n);
    const it = K.item === 'dust' ? '💠 Кристальная пыль' : '🍄 Гриб';
    this.toast(left === 0 ? `+${n} ${it}` : left < n ? `+${n - left} ${it.split(' ')[0]} — инвентарь полон` : 'Инвентарь полон');
    const f = this.fly[o.kind];
    for (let i = 0; i < Math.min(n, K.item === 'dust' ? 6 : 3); i++) {
      const a = i * 2.1 + o.x;
      f.setColorAt(i, o.col); f.instanceColor.needsUpdate = true;
      this.flying.push({ f, i, t: -i * 0.07, x: o.x, y: o.y + 0.2, z: o.z, vx: Math.cos(a) * 1.1, vz: Math.sin(a) * 1.1, rot: a, s: o.kind === 'big' ? 0.16 : o.kind === 'bigcrystal' ? 0.12 : 0.22 });   // кристалл — летят мелкие осколки-пылинки
    }
  }
  animFly(dt) {
    const pl = this.player, ty = pl.pos.y + 0.8;
    for (const k in this.fly) { const f = this.fly[k]; for (let i = 0; i < f.count; i++) f.setMatrixAt(i, ZERO); }
    for (const f of this.flying) {
      f.t += dt;
      const k = Math.max(0, f.t) / FLY, pop = Math.min(1, k / 0.5), home = Math.max(0, (k - 0.5) / 0.5) ** 2;
      const x = f.x + f.vx * pop, z = f.z + f.vz * pop, y = f.y + Math.sin(pop * Math.PI * 0.5) * 1.0;
      _e.set(k * 5, f.rot, k * 3);
      _m.compose(_p.set(x + (pl.pos.x - x) * home, y + (ty - y) * home, z + (pl.pos.z - z) * home), _q.setFromEuler(_e), _s.setScalar(f.t < 0 ? 1e-4 : f.s * (1 - home * 0.6)));
      f.f.setMatrixAt(f.i, _m);
    }
    this.flying = this.flying.filter((f) => f.t < FLY);
    this.shown = this.flying.length > 0;
    for (const k in this.fly) { const f = this.fly[k]; f.instanceMatrix.needsUpdate = true; f.visible = this.flying.some((q) => q.f === f); }
  }
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
