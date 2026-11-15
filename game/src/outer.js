import * as THREE from '../vendor/three.min.js';
import { fbm, smoothstep } from './noise.js';
import { W, ringEdge, setOuterHeight, rockMat, heightAt } from './terrain.js';
import { chunkMesh } from './chunks.js';

// Большой мир за горным кольцом. Не хранится и не строится заранее: высота в любой точке —
// функция от координат и семени (fbm), а видимая земля строится квадратами-чанками вокруг игрока,
// как в Minecraft. Ушёл — чанк выгружается, вернулся — строится заново точно таким же.
// Поэтому мир может быть сколь угодно большим, а нагрузка зависит только от того, что рядом.
// Для сервера это значит: всем игрокам передаётся только семя и изменения (постройки и т. п.).

const CH = 128;                 // сторона чанка, м
const LOAD = 420;               // до какого расстояния чанки есть
const LODS = [[170, 2], [290, 4], [1e9, 8]]; // [дальше чем — шаг сетки, м]
const BLEND = 160;              // за столько метров от кольца горы переходят в большой мир
const SKIRT = 8;                // «юбка» по краю чанка: прячет щели между чанками разной подробности

// ---- рельеф большого мира ----
// Равнины с холмами (место под дома), гряды гор, широкие пологие долины. Всё из одного семени.
function farHeight(x, z) {
  // крупные «области»: где горы, где равнины
  const reg = fbm(x * 0.0018 + 11, z * 0.0018 - 7, 3);
  const mtn = smoothstep(0.08, 0.45, reg);
  const plain = smoothstep(0.0, -0.3, reg);           // широкие ровные места под поселения
  let h = 6 + fbm(x * 0.0045, z * 0.0045, 3) * 10;
  h += fbm(x * 0.016 + 5, z * 0.016, 3) * 5 * (1 - plain * 0.8);
  if (mtn > 0) {
    const r1 = 1 - Math.abs(fbm(x * 0.006 + 40, z * 0.006, 3));
    const r2 = 1 - Math.abs(fbm(x * 0.02 - 7, z * 0.02 + 2, 3));
    h += mtn * mtn * (r1 * r1 * (90 + r2 * 40) + r2 * r2 * 15);
  }
  return h - plain * 3;
}

// высота у кольца: сшиваем с краем гор, дальше — большой мир
function rawOuter(x, z) {
  const r = Math.hypot(x, z);
  // внутри кольца — своя земля; узлы чанка там чуть ниже неё, чтобы не торчали поверх
  if (r < W.OUTER) return heightAt(x, z) - 1.5;
  const k = smoothstep(W.OUTER, W.OUTER + BLEND, r);
  const f = farHeight(x, z);
  if (k >= 1) return f;
  const e = ringEdge(Math.atan2(z, x));
  // у кольца горы не обрываются, а сползают в мир: к краю добавляем их же высоту, уменьшая
  return e + (f - e) * k;
}

// Узлы сетки 2 м (самый подробный уровень) — общий источник и для картинки, и для физики:
// ноги стоят ровно на нарисованных треугольниках. Значения кэшируются.
const G = 2, cache = new Map();
function node(i, j) {
  const k = i * 73856093 ^ j * 19349663;
  let v = cache.get(k);
  if (v === undefined) {
    if (cache.size > 300000) cache.clear();
    v = rawOuter(i * G, j * G);
    cache.set(k, v);
  }
  return v;
}
// высота в точке — те же два треугольника на клетку (диагональ из угла i,j в i+1,j+1), что и в меше
export function outerHeight(x, z) {
  const fx = x / G, fz = z / G, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = node(i, j), d = node(i + 1, j + 1);
  return u > v ? a + (node(i + 1, j) - a) * u + (d - node(i + 1, j)) * v : a + (node(i, j + 1) - a) * v + (d - node(i, j + 1)) * u;
}
setOuterHeight(outerHeight);

// ---- чанки ----
const chunks = new Map();
let scene = null;

function build(cx, cz, step) {
  const n = CH / step, x0 = cx * CH, z0 = cz * CH, s = step / G, i0 = x0 / G, j0 = z0 / G;
  const V = n + 1, H = new Float32Array(V * V);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) H[j * V + i] = node(i0 + i * s, j0 + j * s);
  const hx = (i, j) => H[j * V + i];
  const verts = V * V + 4 * V, pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), idx = [];
  // точки внутри кольца уводим чуть вниз: там своя (полярная) земля, она должна быть сверху
  let p = 0;
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const x = x0 + i * step, z = z0 + j * step;
    pos[p] = x; pos[p + 1] = hx(i, j); pos[p + 2] = z;
    const l = hx(Math.max(0, i - 1), j), r = hx(Math.min(n, i + 1), j), d = hx(i, Math.max(0, j - 1)), u = hx(i, Math.min(n, j + 1));
    const ex = (r - l) / (step * (Math.min(n, i + 1) - Math.max(0, i - 1))), ez = (u - d) / (step * (Math.min(n, j + 1) - Math.max(0, j - 1)));
    const nl = Math.hypot(ex, 1, ez);
    nor[p] = -ex / nl; nor[p + 1] = 1 / nl; nor[p + 2] = -ez / nl;
    p += 3;
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx.push(a, d, b, a, c, d);           // диагональ a–d, как в outerHeight
  }
  // юбка: по краю — полоса вниз
  const edge = [];
  for (let i = 0; i < V; i++) edge.push(i);                       // низ (j=0)
  for (let j = 0; j < V; j++) edge.push(j * V + n);               // право
  for (let i = n; i >= 0; i--) edge.push(n * V + i);              // верх
  for (let j = n; j >= 0; j--) edge.push(j * V);                  // лево
  let q = V * V;
  const sk = [];
  for (const e of edge) {
    pos[q * 3] = pos[e * 3]; pos[q * 3 + 1] = pos[e * 3 + 1] - SKIRT; pos[q * 3 + 2] = pos[e * 3 + 2];
    nor[q * 3] = nor[e * 3]; nor[q * 3 + 1] = nor[e * 3 + 1]; nor[q * 3 + 2] = nor[e * 3 + 2];
    sk.push(q++);
  }
  for (let k = 0; k + 1 < edge.length; k++) idx.push(edge[k], edge[k + 1], sk[k + 1], edge[k], sk[k + 1], sk[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, q * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, q * 3), 3));
  g.setAttribute('aB', new THREE.BufferAttribute(new Float32Array(q * 2), 2));
  g.setIndex(idx);
  return chunkMesh(g, rockMat);
}

const lodFor = (d) => { for (const [lim, st] of LODS) if (d < lim) return st; return 8; };
const insideRing = (cx, cz) => {
  // чанк целиком внутри кольца (самая дальняя от центра точка ближе края) — там своя земля
  const fx = Math.max(Math.abs(cx * CH), Math.abs(cx * CH + CH)), fz = Math.max(Math.abs(cz * CH), Math.abs(cz * CH + CH));
  return fx * fx + fz * fz < (W.OUTER - 4) ** 2;
};

export function initOuter(sc) { scene = sc; }

// Раз в кадр: какие чанки нужны (по расстоянию до игрока) и какой подробности. Строим не больше
// одного за кадр, начиная с ближайших — без рывков. Старый чанк держим, пока не готов новый.
export function updateOuter(px, pz) {
  if (!scene) return;
  const want = [];
  const c0x = Math.floor(px / CH), c0z = Math.floor(pz / CH), R = Math.ceil(LOAD / CH) + 1;
  for (let cz = c0z - R; cz <= c0z + R; cz++) for (let cx = c0x - R; cx <= c0x + R; cx++) {
    const nx = Math.max(cx * CH, Math.min(px, cx * CH + CH)), nz = Math.max(cz * CH, Math.min(pz, cz * CH + CH));
    const d = Math.hypot(nx - px, nz - pz);
    if (d > LOAD || insideRing(cx, cz)) continue;
    want.push({ key: cx + ',' + cz, cx, cz, d, step: lodFor(d) });
  }
  want.sort((a, b) => a.d - b.d);
  const keep = new Set(want.map((w) => w.key));
  for (const [k, c] of chunks) if (!keep.has(k)) { scene.remove(c.mesh); c.mesh.geometry.dispose(); chunks.delete(k); }
  for (const w of want) {
    const c = chunks.get(w.key);
    if (c && c.step === w.step) continue;
    const mesh = build(w.cx, w.cz, w.step);
    scene.add(mesh);
    if (c) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
    chunks.set(w.key, { mesh, step: w.step });
    break;                                    // один чанк за кадр
  }
}
export const outerStats = () => ({ chunks: chunks.size, cache: cache.size });
