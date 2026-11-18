import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat } from './shaders.js';
import { LAKE, heightAt, waterAt, nearTunnelMouth } from './terrain.js';
import { STONEAPI } from './descent.js';
import { fieldTop as solidTop, groundAt, ceiling, addMeshTop } from './solids.js';
import { STREAMS } from './waterfall.js';
import { SWING } from './player.js';
import { objId, RULES } from './world.js';
const NO_TRIS = new Float32Array(0); // верх отдельно не передаём: всё тело — в full

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
export function planDeep(boulders = []) {
  const rnd = mulberry32(SEED + 75);
  const out = { crystal: [], bigcrystal: [], shroom: [], big: [] }, rocks = [], colliders = [];
  const used = new Map();
  const freeAt = (x, z, r) => {
    for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
      const l = used.get((Math.floor(x / 3) + a) + ',' + (Math.floor(z / 3) + b));
      if (l) for (const q of l) if (Math.hypot(q[0] - x, q[1] - z) < q[2] + r) return false;
    }
    return true;
  };
  // валуны под кирку: на них и внутри них ничего не ставим — иначе разбил камень, а гриб висит в воздухе
  for (const b of boulders) { const k = Math.floor(b.x / 3) + ',' + Math.floor(b.z / 3); (used.get(k) || used.set(k, []).get(k)).push([b.x, b.z, b.s * 1.15]); }
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
        const o = { x, y, z, s, rot: rnd() * TAU, tilt: (rnd() - 0.5) * 0.25, hue: rnd(), kk: depthK(y) };
        // фиолетовых грибов меньше, чем синих: около четверти (у озера чуть больше)
        if (kind === 'shroom') o.purple = o.hue < 0.2 + o.kk * 0.12;
        (kind === 'rock' ? rocks : out[kind]).push(o);
        n--;
      }
    }
  }
  // большие грибы — у озера: на нижних глыбах и на берегу
  const bigN = 14;
  for (let tries = 0; tries < 3000 && out.big.length < bigN; tries++) {
    const a = rnd() * TAU, d = LAKE.r + 1 + rnd() * 24, x = Math.cos(a) * d, z = Math.sin(a) * d;
    const s = 0.8 + rnd() * 0.6, r = 2.0 * s;
    if (!freeAt(x, z, r + 1.2) || nearTunnelMouth(x, z, r)) continue;
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
// Кристаллы синие. Грибы: в основном бирюзово-синие, около четверти маленьких — фиолетовые
// (на них можно наступить: давятся в лужу жижи). Большие грибы только синие. Руда: тёплые янтарные искры среди холодного камня.
const _c = new THREE.Color();
function tint(kind, o) {
  const k = o.kk, j = o.hue;
  if (kind === 'crystal' || kind === 'bigcrystal') return _c.setHSL(0.57 + j * 0.07, 0.9, 0.5 + k * 0.03);   // синий кристалл
  if (kind === 'shroom') return o.purple ? _c.setHSL(0.76 + j * 0.25, 0.8, 0.5) : _c.setHSL(0.47 + j * 0.08, 0.8, 0.5);
  if (kind === 'big') return _c.setHSL(0.5 + j * 0.07, 0.75, 0.48);   // большие — только синие
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
    const solid = addMeshTop(NO_TRIS, Math.min(0.3, t.s * 0.15), { soft: t.s < 1.0, full: tris });   // тело целиком: без бесконечного низа (см. flora.js rockSolid)
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
      o.squash = !!ev.squash;
      if (o.squash) {
        // лужа — сразу и для всех; а замедление и брызги на экране — только тому, кто наступил
        this.puddles.add(o.x, o.y, o.z, 1.15 + 0.45 * o.s);
        if (ev.by === world.me) { this.stuckT = STUCK; splat(); }
      }
      this.gone(o, ev.at, true);
    });
    this.puddles = new Puddles(scene);
    this.inGoo = false; this.stuckT = 0;
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
  // сплющить: высота sy, ширина sxz (от полного размера)
  flat(o, sy, sxz) {
    o.m.decompose(_p, _q, _s);
    _s.x *= sxz; _s.z *= sxz; _s.y *= sy;
    _m.compose(_p, _q, _s);
    o.mesh.setMatrixAt(o.i, _m); o.mesh.instanceMatrix.needsUpdate = true;
    if (o.hi !== undefined) { this.halo.setMatrixAt(o.hi, ZERO); this.halo.instanceMatrix.needsUpdate = true; }
  }
  // Свет в общий шейдер (U.uGlowP/uGlowC): n ближайших к точке светящихся кристаллов и грибов.
  // Вес плавно падает к границе выбора — когда кристалл входит в число ближайших или выходит, свет не «щёлкает».
  lights(px, py, pz, P, C, n, t, B = null) {
    const L = this._gl || (this._gl = []), cand = this._cand || (this._cand = []);
    if (!L.length) for (const o of this.byId.values()) {
      const big = o.kind === 'big', bc = o.kind === 'bigcrystal', cr = o.kind === 'crystal' || bc;
      if (o.purple) continue;
      L.push({ o, y: o.y + DEEP_KINDS[o.kind].h * o.s * (big ? 0.7 : 0.45), r: big ? 6.5 * o.s : bc ? 4.2 * o.s : cr ? 2.8 * o.s : 1.6 * o.s,
        k: big ? 0.55 : bc ? 0.9 : cr ? 0.6 : 0.35, ph: o.hue * 40, col: big ? [0.25, 0.75, 0.85] : cr ? [0.3, 0.6, 1.0] : [0.3, 0.85, 0.85] });
    }
    if (this.extraLights) {   // фонари и прочие огоньки (scale.js): тот же отбор по расстоянию
      for (const e of this.extraLights) L.push({ o: { x: e.x, z: e.z, state: 'idle' }, y: e.y, r: e.r, k: e.k, ph: e.x * 3.1, col: e.col });
      this.extraLights = null;
    }
    cand.length = 0;
    for (const g of L) {
      if (g.o.state === 'gone' || g.o.state === 'break') continue;
      const dx = g.o.x - px, dy = g.y - py, dz = g.o.z - pz, d = Math.sqrt(dx * dx + dy * dy + dz * dz) - g.r;
      if (d < 40) { g.d = d; cand.push(g); }
    }
    cand.sort((a, b) => a.d - b.d);
    const edge = cand.length > n ? cand[n].d : 40;
    // сфера вокруг всех выбранных огоньков (с их радиусами): шейдер за её пределами свет не считает
    let bx = 0, by = 0, bz = 0, m = Math.min(n, cand.length);
    for (let i = 0; i < m; i++) { bx += cand[i].o.x; by += cand[i].y; bz += cand[i].o.z; }
    if (m) { bx /= m; by /= m; bz /= m; }
    let br = 0;
    for (let i = 0; i < m; i++) br = Math.max(br, Math.hypot(cand[i].o.x - bx, cand[i].y - by, cand[i].o.z - bz) + cand[i].r);
    if (B) B.set(bx, m ? by : -1e4, bz, br);
    for (let i = 0; i < n; i++) {
      const g = cand[i];
      if (!g) { P[i].set(0, -1e4, 0, 1); C[i].setRGB(0, 0, 0); continue; }
      const fade = Math.min(1, Math.max(0, (edge - g.d) / 6)) * Math.min(1, Math.max(0, (40 - g.d) / 10));
      const pulse = 0.85 + 0.15 * Math.sin(t * 1.3 + g.ph);
      const k = g.k * fade * pulse;
      P[i].set(g.o.x, g.y, g.o.z, g.r);
      C[i].setRGB(g.col[0] * k, g.col[1] * k, g.col[2] * k);
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
  stomp() {
    const p = this.player.pos, cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const l = this.cells.get((cx + a) + ',' + (cz + c));
      if (l) for (const o of l) {
        if (!o.purple || o.stomped || (o.state !== 'idle' && o.state !== 'shake')) continue;
        if (Math.hypot(o.x - p.x, o.z - p.z) < 0.3 * o.s + 0.3 && p.y - o.y > -0.3 && p.y - o.y < 0.7) {
          o.stomped = true;
          this.world.send({ type: 'harvest', id: o.id, kind: o.kind, squash: true });
        }
      }
    }
  }
  // значок кнопки действия: чем это добывается
  get icon() { const t = this.target && this.need(this.target); return t === 'pickaxe' ? '⛏️' : t === 'axe' ? '🪓' : '✋'; }
  // want — кнопка зажата, press — только что нажата
  update(dt, want, press) {
    const pl = this.player;
    // фиолетовый гриб под ногой давится; в луже жижи ноги вязнут
    if (pl.grounded && !pl.climbing && !pl.swimming) this.stomp();
    this.stuckT = Math.max(0, this.stuckT - dt);
    const goo = this.puddles.update(dt, pl) || this.stuckT > 0;
    pl.slow = goo ? 0.4 : 1;
    if (goo && !this.inGoo && !this.gooTold) { this.gooTold = true; this.toast('Фиолетовая жижа — ноги вязнут'); }
    this.inGoo = goo;
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
      } else if (b.state === 'break' && b.squash) {
        // раздавлен: сплющивается, растекается — и на его месте лужа жижи
        const k = Math.min(1, b.t / 0.22);
        this.flat(b, 1 - 0.92 * k, 1 + 0.6 * k);
        if (k === 1) { b.state = 'gone'; b.stomped = false; b.squash = false; this.place(b, 0); }
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

// ---------- брызги жижи на экране ----------
// Наступил на фиолетовый гриб — экран забрызган по краям; ровно STUCK секунд ноги вязнут,
// брызги тают к концу этого времени.
const STUCK = 3;
let _splat = null;
function splat() {
  if (typeof document === 'undefined') return;
  if (!_splat) {
    _splat = document.createElement('div');
    _splat.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;';
    // сразу за картинкой игры: кнопки остаются поверх брызг
    const cv = document.getElementById('game');
    if (cv) cv.after(_splat); else document.body.appendChild(_splat);
  }
  // кляксы: у краёв крупные, ближе к центру мелкие капли
  const g = [];
  for (let i = 0; i < 14; i++) {
    const side = i % 4, t = Math.random() * 100, d = Math.random() * 18;
    const [x, y] = side === 0 ? [t, d] : side === 1 ? [100 - d, t] : side === 2 ? [t, 100 - d] : [d, t];
    const r = 9 + Math.random() * 16;
    g.push(`radial-gradient(circle at ${x}% ${y}%, rgba(110,25,160,0.8) 0, rgba(140,45,195,0.7) ${r * 0.8}vmin, rgba(140,45,195,0) ${r}vmin)`);
  }
  for (let i = 0; i < 10; i++) {
    const x = 15 + Math.random() * 70, y = 15 + Math.random() * 70, r = 1.2 + Math.random() * 2.5;
    g.push(`radial-gradient(circle at ${x}% ${y}%, rgba(170,70,220,0.75) 0, rgba(170,70,220,0.65) ${r * 0.8}vmin, rgba(170,70,220,0) ${r}vmin)`);
  }
  _splat.style.background = g.join(',');
  _splat.style.transition = 'none'; _splat.style.opacity = '1';
  void _splat.offsetWidth;
  _splat.style.transition = `opacity ${STUCK - 0.6}s ease-in 0.6s`; _splat.style.opacity = '0';
}

// ---------- лужи фиолетовой жижи ----------
// Остаются от раздавленных фиолетовых грибов: ~45 с, потом высыхают. Пока в луже — герой идёт медленно.
// Лужа ложится по камню (вершины опущены на поверхность), за краем глыбы — прозрачна.
// Луж немного и они маленькие: отдельная сетка на лужу, ~50 вершин.
const PUD_LIFE = 45, PUD_MAX = 8, PUD_RINGS = 3, PUD_SEG = 16;
let _pudMat = null;
function puddleMaterial() {
  if (_pudMat) return _pudMat;
  _pudMat = mat({
    uniforms: { uA: { value: 1 } },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute vec3 aQ;   // x — доля радиуса, y — угол, z — 0, если тут нет камня
      varying vec3 vW; varying vec3 vQ;
      void main(){ vQ = aQ; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uA;
      varying vec3 vW; varying vec3 vQ;
      void main(){
        // рваный край: радиус лужи колеблется по углу
        float edge = 0.84 + 0.08 * sin(vQ.y * 3.0 + 1.3) + 0.06 * sin(vQ.y * 5.0 + 4.1) + 0.03 * sin(vQ.y * 11.0);
        float r = vQ.x / edge;
        if (r > 1.0 || vQ.z < 0.5) discard;
        float n = vnoise(vW.xz * 3.0 + vec2(uTime * 0.15, -uTime * 0.11));
        vec3 c = mix(vec3(0.16, 0.03, 0.24), vec3(0.38, 0.1, 0.52), n);
        // пузырьки и светящийся ободок
        float b = vnoise(vW.xz * 9.0 + vec2(0.0, uTime * 0.4));
        c += vec3(0.6, 0.35, 0.85) * smoothstep(0.84, 0.92, b) * 0.4;
        c += vec3(0.7, 0.3, 1.0) * smoothstep(0.7, 1.0, r) * 0.35;
        vec3 v = normalize(cameraPosition - vW);
        c += vec3(0.9, 0.8, 1.0) * pow(1.0 - max(v.y, 0.0), 4.0) * 0.25;   // мокрый блеск
        c = applyFog(c * 0.9, vW) + vec3(0.2, 0.04, 0.32) * 0.2;
        gl_FragColor = vec4(c, uA * 0.88 * smoothstep(1.0, 0.85, r));
      }`,
  });
  return _pudMat;
}
class Puddles {
  constructor(scene) { this.scene = scene; this.list = []; }
  add(x, y, z, rad) {
    if (this.list.length >= PUD_MAX) this.drop(this.list[0]);
    const P = [], Q = [], I = [];
    const vert = (t, a) => {
      const px = x + Math.cos(a) * t * rad, pz = z + Math.sin(a) * t * rad;
      const g = groundAt(px, pz, y + 0.6);
      const ok = Math.abs(g - y) < 0.45;
      P.push(px - x, (ok ? g : y) - y + 0.03, pz - z); Q.push(t, a, ok ? 1 : 0);
    };
    vert(0, 0);
    for (let i = 1; i <= PUD_RINGS; i++) for (let j = 0; j < PUD_SEG; j++) vert(i / PUD_RINGS, (j / PUD_SEG) * Math.PI * 2);
    for (let j = 0; j < PUD_SEG; j++) I.push(0, 1 + (j + 1) % PUD_SEG, 1 + j);
    for (let i = 1; i < PUD_RINGS; i++) for (let j = 0; j < PUD_SEG; j++) {
      const a = 1 + (i - 1) * PUD_SEG + j, b = 1 + (i - 1) * PUD_SEG + (j + 1) % PUD_SEG;
      I.push(a, b, a + PUD_SEG, b, b + PUD_SEG, a + PUD_SEG);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('aQ', new THREE.Float32BufferAttribute(Q, 3));
    g.setIndex(I);
    const m = puddleMaterial().clone();
    Object.assign(m.uniforms, puddleMaterial().uniforms, { uA: { value: 0 } });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z); mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.list.push({ x, y, z, rad, t: 0, mesh });
  }
  drop(p) { this.scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); this.list.splice(this.list.indexOf(p), 1); }
  // возвращает true, если герой стоит в луже
  update(dt, pl) {
    let inside = false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t += dt;
      // растекается за полсекунды, в конце высыхает
      const grow = Math.min(1, p.t / 0.2), fade = Math.min(1, (PUD_LIFE - p.t) / 4);
      if (fade <= 0) { this.drop(p); continue; }
      const k = grow * (2 - grow);
      p.mesh.scale.set(k, 1, k);
      p.mesh.material.uniforms.uA.value = Math.min(grow * 2, 1) * fade;
      if (pl.grounded && fade > 0.3 && Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z) < p.rad * 0.95 && Math.abs(pl.pos.y - p.y) < 0.6) inside = true;
    }
    return inside;
  }
}
