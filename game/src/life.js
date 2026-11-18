import * as THREE from '../vendor/three.min.js';
import { mat, LITE, GLOW_N } from './shaders.js';
import { mulberry32, SEED } from './noise.js';

// Живой мир у кристаллов, грибов и фонарей. Всё считается в вершинном шейдере вокруг тех же
// ближайших огоньков, что светят на камень (U.uGlowP / uGlowC): на процессоре ничего не обновляется,
// частицы сами следуют за камерой.

// ---------- споры и искры ----------
// Споры медленно поднимаются от огонька, покачиваясь, и тают; искры мерцают у самого кристалла.
export function buildSpores(scene) {
  const rnd = mulberry32(SEED + 8123);
  const N = LITE ? 160 : 320;
  const pos = new Float32Array(N * 3), a = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rnd() - 0.5) * 2; pos[i * 3 + 1] = rnd(); pos[i * 3 + 2] = (rnd() - 0.5) * 2;
    // x — к какому огоньку, y — фаза, z — 1 искра / 0 спора, w — случайное
    a[i * 4] = i % GLOW_N; a[i * 4 + 1] = rnd(); a[i * 4 + 2] = rnd() < 0.35 ? 1 : 0; a[i * 4 + 3] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aA', new THREE.BufferAttribute(a, 4));
  const m = mat({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aA;
      varying vec3 vC; varying float vA; varying float vS;
      void main(){
        int li = int(aA.x + 0.5);
        vec4 L = uGlowP[0]; vec3 C = uGlowC[0];
        for (int i = 1; i < GLOW_N; i++) if (i == li) { L = uGlowP[i]; C = uGlowC[i]; }
        float spark = aA.z, r = L.w;
        float t = fract(uTime * mix(0.06, 0.35, spark) * (0.7 + aA.w * 0.6) + aA.y);
        vec3 p;
        if (spark > 0.5) {
          // искра: рядом с огоньком, на месте, вспыхивает и гаснет
          p = L.xyz + position * vec3(0.35, 0.6, 0.35) * r * 0.35 + vec3(0.0, position.y * 0.2, 0.0);
          vA = pow(sin(t * 3.1416), 6.0);
        } else {
          // спора: поднимается на 2–4 м, дрейфует по кругу
          float h = t * (2.0 + aA.w * 2.0);
          p = L.xyz + vec3(position.x * r * 0.4, h, position.z * r * 0.4);
          p.x += sin(uTime * 0.7 + aA.y * 40.0 + h) * 0.35 * h * 0.4;
          p.z += cos(uTime * 0.6 + aA.w * 30.0 + h) * 0.35 * h * 0.4;
          vA = smoothstep(0.0, 0.15, t) * smoothstep(1.0, 0.6, t) * 0.8;
        }
        float lum = max(C.r, max(C.g, C.b));
        vC = C / max(lum, 1e-3);
        vA *= smoothstep(0.02, 0.15, lum);              // у погасшего огонька нет и частиц
        vS = spark;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = uPx * mix(5.0, 7.0, spark) * 6.0 / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA; varying float vS;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        float k = smoothstep(0.5, 0.05, d);
        // искра — четырёхлучевая звёздочка
        float star = max(smoothstep(0.08, 0.0, abs(q.x)) , smoothstep(0.08, 0.0, abs(q.y))) * smoothstep(0.5, 0.1, d);
        k = mix(k, max(k * 0.5, star), vS);
        gl_FragColor = vec4(mix(vC, vec3(1.0), 0.45) * vA * k, 1.0);
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
// Светящиеся мотыльки кружат у огоньков: два крылышка-треугольника на каждого, машут крыльями.
// Одна запечённая модель (без инстансинга — для мелочи он на телефоне дороже).
export function buildMoths(scene) {
  const rnd = mulberry32(SEED + 8731);
  const N = LITE ? 10 : 18;
  const P = [], A = [], B = [];
  for (let i = 0; i < N; i++) {
    const li = i % GLOW_N, ph = rnd(), rad = 0.8 + rnd() * 1.4, sp = 0.6 + rnd() * 0.8, hue = rnd();
    // крыло: корень (0,0,0), передний и задний край; side −1/1
    for (const side of [-1, 1]) {
      for (const v of [[0, 0, 0], [side * 0.11, 0.0, 0.06], [side * 0.09, 0.0, -0.07]]) {
        P.push(v[0], v[1], v[2]); A.push(li, ph, rad, sp); B.push(side, hue, 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 3));
  const m = mat({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aA; attribute vec3 aB;
      varying vec3 vC; varying float vA;
      void main(){
        int li = int(aA.x + 0.5);
        vec4 L = uGlowP[0]; vec3 C = uGlowC[0];
        for (int i = 1; i < GLOW_N; i++) if (i == li) { L = uGlowP[i]; C = uGlowC[i]; }
        float t = uTime * aA.w + aA.y * 6.28;
        // полёт: петля вокруг огонька с подъёмами и нырками
        vec3 c = L.xyz + vec3(cos(t) * aA.z, 0.4 + sin(t * 1.7) * 0.35 + sin(t * 0.6) * 0.2, sin(t * 1.3) * aA.z);
        vec3 fwd = normalize(vec3(-sin(t) * aA.z, cos(t * 1.7) * 0.6, cos(t * 1.3) * aA.z * 1.3));
        vec3 rt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
        vec3 up = cross(rt, fwd);
        // взмах крыла: поворот вокруг оси тела
        float fl = sin(uTime * 22.0 + aA.y * 50.0) * 0.9;
        vec3 lp = position;
        float s = aB.x;
        vec3 wing = rt * (abs(lp.x) * cos(fl)) * s + up * (abs(lp.x) * sin(fl)) + fwd * lp.z;
        vec3 p = c + wing;
        float lum = max(C.r, max(C.g, C.b));
        vA = smoothstep(0.03, 0.2, lum);
        vC = mix(vec3(0.75, 0.95, 1.0), vec3(1.0, 0.85, 0.55), step(0.6, aB.y));
        if (vA < 0.01) p = vec3(0.0, -1e5, 0.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA;
      void main(){ gl_FragColor = vec4(vC * (0.9 + 0.3 * vA), 1.0); }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return mesh;
}
