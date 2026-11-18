import * as THREE from '../vendor/three.min.js';
import { mat, LITE } from './shaders.js';
import { mulberry32, SEED } from './noise.js';

// Живой мир у кристаллов и грибов. Каждая частица и мотылёк привязаны к своему месту (запечено в модель),
// движение — в вершинном шейдере: на процессоре ничего не обновляется и ничего не перескакивает.

// ---------- споры и искры ----------
// Каждая частица привязана к своему кристаллу или грибу (место запечено в модель), поэтому ничего
// не перескакивает, когда камера движется. Вдали частицы плавно тают. Споры поднимаются от грибов,
// искры мерцают у кристаллов. Всё — в вершинном шейдере.
const DEEP_H = { crystal: 0.5, bigcrystal: 1.1, shroom: 0.35, big: 3.0 };
export function buildSpores(scene, plan) {
  const rnd = mulberry32(SEED + 8123);
  const L = plan.lists, src = [];
  for (const k of ['big', 'bigcrystal']) for (const o of L[k]) src.push([k, o]);
  for (const k of ['crystal', 'shroom']) for (const o of L[k]) if (!o.purple && o.y < -120 && rnd() < 0.35) src.push([k, o]);
  const MAXA = LITE ? 60 : 110;
  for (let i = src.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [src[i], src[j]] = [src[j], src[i]]; }
  src.length = Math.min(src.length, MAXA);
  const pos = [], a = [], c = [];
  for (const [k, o] of src) {
    const cr = k === 'crystal' || k === 'bigcrystal', big = k === 'big' || k === 'bigcrystal';
    const n = big ? 4 : 2, y = o.y + DEEP_H[k] * o.s * (k === 'big' ? 0.75 : 0.6), r = big ? 1.2 * o.s : 0.5 * o.s;
    for (let i = 0; i < n; i++) {
      pos.push(o.x + (rnd() - 0.5) * r * 2, y, o.z + (rnd() - 0.5) * r * 2);
      a.push(rnd(), cr ? 1 : 0, rnd(), r);
      if (cr) c.push(0.55, 0.8, 1.0); else c.push(0.55, 1.0, 0.95);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(a, 4));
  g.setAttribute('aC', new THREE.Float32BufferAttribute(c, 3));
  const m = mat({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aA; attribute vec3 aC;
      varying vec3 vC; varying float vA; varying float vS;
      void main(){
        float spark = aA.y;
        float t = fract(uTime * mix(0.05, 0.18, spark) * (0.8 + aA.z * 0.4) + aA.x);
        vec3 p = position;
        if (spark > 0.5) {
          // искра: на месте у кристалла, медленно вспыхивает и гаснет
          p.y += aA.z * 0.6;
          vA = pow(sin(t * 3.1416), 4.0);
        } else {
          // спора: плавно поднимается на 2–3 м и тает
          float h = t * (2.0 + aA.z);
          p.y += h;
          p.x += sin(uTime * 0.35 + aA.x * 40.0) * 0.25 * h;
          p.z += cos(uTime * 0.3 + aA.z * 30.0) * 0.25 * h;
          vA = smoothstep(0.0, 0.2, t) * smoothstep(1.0, 0.55, t) * 0.7;
        }
        float cd = distance(p, cameraPosition);
        vA *= smoothstep(34.0, 22.0, cd);          // вдали плавно тают, а не исчезают разом
        vC = aC; vS = spark;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = vA < 0.004 ? 0.0 : uPx * mix(4.5, 6.5, spark) * 6.0 / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA; varying float vS;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        float k = smoothstep(0.5, 0.05, d);
        float star = max(smoothstep(0.08, 0.0, abs(q.x)), smoothstep(0.08, 0.0, abs(q.y))) * smoothstep(0.5, 0.1, d);
        k = mix(k, max(k * 0.5, star), vS);
        gl_FragColor = vec4(mix(vC, vec3(1.0), 0.35) * vA * k, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  scene.add(pts);
  m.userData.pts = pts;
  return m;
}

// ---------- мотыльки ----------
// Немного светящихся мотыльков — только на дне, у больших грибов у озера. Каждая стайка привязана
// к своему грибу (место запечено), летает плавно и медленно; вдали тает.
// Одна запечённая модель (без инстансинга — для мелочи он на телефоне дороже).
export function buildMoths(scene, plan) {
  const rnd = mulberry32(SEED + 8731);
  const anchors = plan.lists.big.slice();
  for (let i = anchors.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [anchors[i], anchors[j]] = [anchors[j], anchors[i]]; }
  anchors.length = Math.min(anchors.length, LITE ? 5 : 8);
  const P = [], A = [], B = [], C = [];
  for (const o of anchors) {
    const cx = o.x, cy = o.y + 3.6 * o.s, cz = o.z, n = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const ph = rnd(), rad = 1.0 + rnd() * 1.2, sp = 0.35 + rnd() * 0.3, hue = rnd();
      for (const side of [-1, 1]) {
        for (const v of [[0, 0, 0], [side * 0.11, 0.0, 0.06], [side * 0.09, 0.0, -0.07]]) {
          P.push(v[0], v[1], v[2]); A.push(ph, rad, sp, side); B.push(hue, 0, 0); C.push(cx, cy, cz);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 3));
  g.setAttribute('aO', new THREE.Float32BufferAttribute(C, 3));
  const m = mat({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aA; attribute vec3 aB; attribute vec3 aO;
      varying vec3 vC;
      void main(){
        float t = uTime * aA.z + aA.x * 6.28, R = aA.y;
        // плавная петля вокруг шляпки: медленно, с мягкими подъёмами
        vec3 c = aO + vec3(cos(t) * R, sin(t * 0.7) * 0.4 + sin(t * 0.31) * 0.25, sin(t) * R * 0.8);
        vec3 fwd = normalize(vec3(-sin(t) * R, cos(t * 0.7) * 0.28, cos(t) * R * 0.8));
        vec3 rt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
        vec3 up = cross(rt, fwd);
        float fl = sin(uTime * 14.0 + aA.x * 50.0) * 0.8;
        vec3 lp = position;
        vec3 p = c + rt * (abs(lp.x) * cos(fl)) * aA.w + up * (abs(lp.x) * sin(fl)) + fwd * lp.z;
        float far = smoothstep(30.0, 40.0, distance(c, cameraPosition));
        p = mix(p, c, far);                       // вдали крылья сходятся в точку — мотылёк тает
        vC = mix(vec3(0.75, 0.95, 1.0), vec3(1.0, 0.85, 0.55), step(0.6, aB.x));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main(){ gl_FragColor = vec4(vC, 1.0); }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return mesh;
}
