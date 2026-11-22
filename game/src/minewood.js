import * as THREE from '../vendor/three.min.js';
import { mat } from './shaders.js';

// Дерево шахт с нарисованной текстурой (assets/mine_wood.jpg — собрана из листа текстур Андрюхи:
// доски настила, брусья, столбы с железными оковками, ящик, бочка, рваное знамя).
// Каждый брус — коробка с UV: волокно идёт вдоль длинной стороны, кусок картинки берётся
// случайный, поэтому соседние доски не повторяются. Верёвка — тот же материал, витки рисует шейдер.
// Всё складывается в один буфер на кусок 40 м (как остальная обстановка), один вызов отрисовки на кусок.

const AW = 1024;
// прямоугольник в атласе (пиксели, y вниз) → [u0, v0, du, dv]; картинка грузится с flipY
const R = (x0, y0, x1, y1) => [x0 / AW, 1 - y1 / AW, (x1 - x0) / AW, (y1 - y0) / AW];
export const WR = {
  plank: [R(12, 13, 270, 57), R(12, 63, 270, 114), R(12, 123, 270, 184), R(12, 193, 270, 255), R(12, 264, 270, 336)],   // волокно по u
  beam: [R(296, 16, 378, 327), R(385, 16, 453, 327), R(460, 16, 525, 327), R(532, 16, 597, 327)],                       // волокно по v
  band: R(623, 20, 686, 332),     // столб с двумя оковками (волокно по v)
  post: R(713, 16, 816, 332),     // столб с одной оковкой
  crate: R(831, 9, 971, 158),
  barrel: R(833, 173, 957, 355),
  banner: R(21, 379, 141, 632),
};
const ALONG_V = new Set([...WR.beam, WR.band, WR.post, WR.barrel]);

let _tex = null, _mat = null;
function woodTex() {
  if (_tex) return _tex;
  _tex = new THREE.DataTexture(new Uint8Array([88, 44, 34, 255]), 1, 1, THREE.RGBAFormat);
  _tex.needsUpdate = true;
  const im = new Image();
  im.onload = () => {
    const t = new THREE.Texture(im);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
    _tex.image = im; _tex.dispose();
    if (_mat) _mat.uniforms.uWood.value = t;
  };
  im.src = './assets/mine_wood.jpg';
  return _tex;
}

export function woodMaterial() {
  if (_mat) return _mat;
  _mat = mat({
    uniforms: { uWood: { value: woodTex() } },
    vertexShader: /* glsl */ `
      attribute vec3 aT; attribute vec2 aK;
      varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vT; varying float vK; varying float vSh;
      void main(){
        vec3 p = position;
        // знамя колышется: тем сильнее, чем ниже от древка
        if (aK.x > 2.5) p += normal * sin(uTime*1.6 + p.x*0.7 + p.z*0.5 + p.y*1.3) * 0.12 * aK.y;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
        vUv = uv; vT = aT; vK = aK.x;
        vSh = shadowAt3(wp.xyz + vec3(0.0, 1.0, 0.0));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uWood;
      varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec3 vT; varying float vK; varying float vSh;
      void main(){
        vec3 n = normalize(vN);
        vec3 alb;
        if (vK > 1.5 && vK < 2.5) {
          // верёвка: косые витки, светлые гребни и тёмные бороздки
          float tw = fract(vUv.x * 9.0 + vUv.y * 1.0);
          alb = vT * (0.62 + 0.5 * smoothstep(0.0, 0.45, tw) * smoothstep(1.0, 0.55, tw));
        } else {
          vec4 t = texture2D(uWood, vUv);
          if (vK > 2.5 && t.r - t.b < 0.075) discard;   // знамя: фон листа — прозрачный (рваный край)
          alb = t.rgb * vT;
        }
        vec3 c = shade(alb, n, vSh);
        gl_FragColor = vec4(applyFog(c, vW), 1.0);
      }`,
  });
  return _mat;
}

// буфер одного куска
export class WoodBuf {
  constructor() { this.p = []; this.n = []; this.u = []; this.t = []; this.k = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, nx, ny, nz, u, v, t, k0, k1) { this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, v); this.t.push(t[0], t[1], t[2]); this.k.push(k0, k1); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(this.t, 3));
    g.setAttribute('aK', new THREE.Float32BufferAttribute(this.k, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _nm = new THREE.Matrix3();
// ось нормали, знак, две оси грани (по кругу x→y→z: так обход лицевой стороны — против часовой)
const FACES = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]].map(([ax, sg]) => [ax, sg, (ax + 1) % 3, (ax + 2) % 3]);
// коробка: центр, размеры, поворот (как flora T: Euler(0, ry, rz)), кусок атласа, оттенок, вид (0 — дерево, 2 — верёвка)
// rnd — случайное окно в картинке; full — растянуть картинку на всю грань (ящик)
export function woodBox(B, x, y, z, sx, sy, sz, ry, rz, rect, tint, rnd, { kind = 0, full = false } = {}) {
  _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, ry, rz)), _s.set(1, 1, 1));
  _nm.setFromMatrix4(_m);
  const S = [sx, sy, sz], e = _m.elements;
  const along = ALONG_V.has(rect);
  const L = Math.max(sx, sy, sz), longAx = S.indexOf(L);
  const c = [0, 0, 0], nv = new THREE.Vector3();
  for (const [ax, sg, a, b] of FACES) {
    // грань: оси a и b; волокно — вдоль длинной оси бруса, если она в этой грани, иначе вдоль большей стороны
    let g = a, cr = b;
    if (longAx === b || (longAx !== a && S[b] > S[a])) { g = b; cr = a; }
    const lg = S[g], lc = S[cr];
    // сколько картинки по волокну: сохраняем пропорцию, но не больше всей картинки
    const [u0, v0, du, dv] = rect;
    const gLen = along ? dv : du, cLen = along ? du : dv;
    let w = full ? 1 : Math.min(1, (lg / Math.max(lc, 0.02)) * (cLen / gLen));
    if (kind === 2) w = 1;
    const off = full ? 0 : rnd() * (1 - w);
    nv.set(0, 0, 0).setComponent(ax, sg).applyMatrix3(_nm).normalize();
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    // порядок обхода: чтобы лицевая сторона смотрела наружу
    const flip = sg < 0;
    for (let qi = 0; qi < 6; qi++) {
      const [qa, qb] = quad[flip ? [0, 2, 1, 3, 5, 4][qi] : qi];
      c[ax] = sg * 0.5 * S[ax]; c[a] = qa * 0.5 * S[a]; c[b] = qb * 0.5 * S[b];
      const px = e[0] * c[0] + e[4] * c[1] + e[8] * c[2] + e[12], py = e[1] * c[0] + e[5] * c[1] + e[9] * c[2] + e[13], pz = e[2] * c[0] + e[6] * c[1] + e[10] * c[2] + e[14];
      const tg = (g === a ? qa : qb) * 0.5 + 0.5, tc = (g === a ? qb : qa) * 0.5 + 0.5;
      let u, v;
      if (kind === 2) { u = (g === a ? qa : qb) * 0.5 * lg; v = tc; }   // верёвка: u — метры вдоль
      else if (along) { u = u0 + tc * du; v = v0 + (off + tg * w) * dv; }
      else { u = u0 + (off + tg * w) * du; v = v0 + tc * dv; }
      B.vert(px, py, pz, nv.x, nv.y, nv.z, u, v, tint, kind, 0);
    }
  }
}

// цилиндр (бочка): развёртка картинки по кругу
export function woodBarrel(B, x, y, z, r0, r1, h, tint, seg = 10) {
  const [u0, v0, du, dv] = WR.barrel;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    // бочка пузатая: три пояса по высоте
    const rows = [[0, r0 * 0.9], [0.5, r1], [1, r0 * 0.9]];
    for (let j = 0; j < 2; j++) {
      const [t0, ra] = rows[j], [t1, rb] = rows[j + 1];
      const P = (a, t, r) => [x + Math.cos(a) * r, y + t * h, z + Math.sin(a) * r];
      const pa = P(a0, t0, ra), pb = P(a1, t0, ra), pc = P(a1, t1, rb), pd = P(a0, t1, rb);
      const na = [Math.cos(a0), 0, Math.sin(a0)], nb = [Math.cos(a1), 0, Math.sin(a1)];
      const ua = u0 + (i % 3) / 3 * du, ub = u0 + ((i % 3) + 1) / 3 * du, va = v0 + t0 * dv, vb = v0 + t1 * dv;
      const tri = [[pa, na, ua, va], [pc, nb, ub, vb], [pb, nb, ub, va], [pa, na, ua, va], [pd, na, ua, vb], [pc, nb, ub, vb]];
      for (const [p, n, u, v] of tri) B.vert(p[0], p[1], p[2], n[0], n[1], n[2], u, v, tint, 0, 0);
    }
  }
  // крышка: кусок доски
  const [pu, pv, pdu, pdv] = WR.plank[2];
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, r = r0 * 0.9;
    const pts = [[0, 0], [Math.cos(a1) * r, Math.sin(a1) * r], [Math.cos(a0) * r, Math.sin(a0) * r]];
    for (const [px, pz] of pts) B.vert(x + px, y + h, z + pz, 0, 1, 0, pu + (px / r * 0.5 + 0.5) * pdu * 0.3, pv + (pz / r * 0.5 + 0.5) * pdv, tint, 0, 0);
  }
}

// знамя: полотно из картинки (рваный край прозрачный), висит с древка, колышется
export function woodBanner(B, x, y, z, ux, uz, w, h, tint = [1.25, 1.0, 1.0]) {
  const [u0, v0, du, dv] = WR.banner, nx = -uz, nz = ux, cols = 3, rows = 4;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const q = (a, b) => [x + ux * (a - 0.5) * w, y - b * h, z + uz * (a - 0.5) * w, u0 + a * du, v0 + (1 - b) * dv, b];
    const A = q(i / cols, j / rows), Bq = q((i + 1) / cols, j / rows), C = q((i + 1) / cols, (j + 1) / rows), D = q(i / cols, (j + 1) / rows);
    for (const p of [A, C, Bq, A, D, C]) B.vert(p[0], p[1], p[2], nx, 0, nz, p[3], p[4], tint, 3, p[5]);
    for (const p of [A, Bq, C, A, C, D]) B.vert(p[0], p[1], p[2], -nx, 0, -nz, p[3], p[4], tint, 3, -p[5]);   // изнанка (нормаль и качание с обратным знаком — колышется вместе)
  }
}
