import * as THREE from '../vendor/three.min.js';
import { mat, LITE } from './shaders.js';
import { STONEAPI } from './descent.js';
import { rockAt, groundAt } from './solids.js';
import { waterNear } from './waterfall.js';
import { mulberry32, SEED } from './noise.js';

// Лианы и корни, свисающие с краёв глыб в шахте. Чисто украшение: без коллизий, сквозь них проходишь.
// Всё — одна модель (один вызов отрисовки), непрозрачная (без сортировки и смешивания — телефону дёшево).
// Каждая лиана «стекает» с верха глыбы через край и висит вдоль бока, не заходя в камень;
// внизу качается сильнее, чем у края (качание — в шейдере, без пересчёта на процессоре).
// Часть лиан кончается светящейся почкой — она светится сама, как кристаллы.
const SEG = 0.4;             // длина звена, м

export function buildVines(scene) {
  const rnd = mulberry32(SEED + 913);
  const P = [], N = [], C = [], S = [];
  const col = new THREE.Color();
  const tri = (a, b, c, n, cl, sw, glow) => {
    for (const v of [a, b, c]) { P.push(v[0], v[1], v[2]); N.push(n[0], n[1], n[2]); C.push(cl.r, cl.g, cl.b); S.push(v[3], sw, glow); }
  };
  // радиус бока глыбы в направлении (ux, uz) на высоте y: где кончается камень, если идти от центра
  const edgeR = (cx, cz, ux, uz, y, r0, r1) => {
    let last = -1;
    for (let r = r0; r <= r1; r += 0.12) { if (rockAt(cx + ux * r, cz + uz * r, y)) last = r; else if (last >= 0) break; }
    return last;
  };
  const stones = STONEAPI.all().filter((s) => s.spec.y < -70);
  // Бюджет на телефон: лиан не больше MAXV (примерно 60 треугольников каждая). Лучше густые «занавеси»
  // на части глыб, чем редкие нитки на всех: так и красивее, и издалека читается.
  const MAXV = LITE ? 380 : 700;
  for (let i = stones.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [stones[i], stones[j]] = [stones[j], stones[i]]; }
  let vines = 0;
  for (const st of stones) {
    if (vines >= MAXV) break;
    if (rnd() < 0.4) continue;
    const sp = st.spec, R = Math.max(sp.A, sp.B);
    const nC = 1 + Math.floor(rnd() * 3);
    for (let c = 0; c < nC; c++) {
      const a0 = rnd() * Math.PI * 2, nv = 3 + Math.floor(rnd() * 5), root = rnd() < 0.15;
      for (let v = 0; v < nv; v++) {
        const a = a0 + (v - nv / 2) * (0.42 / R) + (rnd() - 0.5) * 0.06, ux = Math.cos(a), uz = Math.sin(a);
        const top = sp.y;
        const rTop = edgeR(sp.x, sp.z, ux, uz, top - 0.2, 0, R * 1.6);
        if (rTop < 0.5) continue;
        // верх: чуть заходя на площадку
        const pts = [[sp.x + ux * (rTop - 0.25), top + 0.03, sp.z + uz * (rTop - 0.25)]];
        let rv = rTop + 0.1;
        const L = root ? 1.2 + rnd() * 2.6 : 1.6 + rnd() * 2.5 + rnd() * rnd() * 5.0;
        let ok = true;
        for (let k = 1; k * SEG <= L; k++) {
          const y = top - 0.08 - k * SEG;
          const re = edgeR(sp.x, sp.z, ux, uz, y, Math.max(0, rv - 1.2), rv + 2.5);
          if (re > 0) rv = Math.max(rv, re + 0.1);
          const x = sp.x + ux * rv, z = sp.z + uz * rv;
          if (groundAt(x, z, y + 0.2) > y - 0.15 || rockAt(x, z, y)) break;   // упёрлись в пол или в соседний камень
          if (waterNear(x, y, z, 0.8, 1.5)) { ok = false; break; }            // в водопад не свешиваемся
          pts.push([x, y, z]);
        }
        if (!ok || pts.length < 4) continue;
        vines++;
        const g = rnd(), deep = Math.min(1, Math.max(0, (-top - 90) / 80));
        if (root) col.setRGB(0.30 + g * 0.08, 0.22 + g * 0.05, 0.16);
        else col.setRGB(0.22 + g * 0.16, 0.46 + g * 0.2 - deep * 0.04, 0.17 + g * 0.08 + deep * 0.08);
        const stemC = root ? col : col.clone().multiplyScalar(0.7);
        const w = root ? 0.07 + rnd() * 0.05 : 0.035;
        const ph = rnd() * 6.28;
        // стебель: лента, развёрнутая боком к стене (видна снаружи)
        for (let k = 0; k + 1 < pts.length; k++) {
          const p0 = pts[k], p1 = pts[k + 1], h0 = k * SEG, h1 = (k + 1) * SEG;
          const tx = -uz * w, tz = ux * w;
          const A = [p0[0] - tx, p0[1], p0[2] - tz, h0], B = [p0[0] + tx, p0[1], p0[2] + tz, h0];
          const Cc = [p1[0] - tx, p1[1], p1[2] - tz, h1], D = [p1[0] + tx, p1[1], p1[2] + tz, h1];
          const n = [ux, 0.2, uz];
          tri(A, Cc, B, n, stemC, ph, 0); tri(B, Cc, D, n, stemC, ph, 0);
        }
        if (!root) {
          // листья: ромбики по бокам стебля, вразнобой
          for (let kk = 2; kk < pts.length * 2; kk++) {
            const k = kk >> 1;
            if (rnd() < 0.12) continue;
            const p = pts[k], h = k * SEG, side = kk % 2 ? 1 : -1, s = 0.17 + rnd() * 0.12;
            const lc = col.clone().multiplyScalar(0.75 + rnd() * 0.6);
            const sx = -uz * side, sz = ux * side;                     // вбок
            const ox = ux * 0.05, oz = uz * 0.05;                      // чуть от стены
            const dy = (kk % 2) * SEG * 0.5;
            const b0 = [p[0] + ox, p[1] - dy, p[2] + oz, h];
            const tip = [p[0] + sx * s * 2.0 + ux * s * 0.5 + ox, p[1] - dy - s * 1.1, p[2] + sz * s * 2.0 + uz * s * 0.5 + oz, h + 0.05];
            const l = [p[0] + sx * s * 1.1 + ux * s * 0.8 + ox, p[1] - dy + s * 0.3, p[2] + sz * s * 1.1 + uz * s * 0.8 + oz, h];
            const r = [p[0] + sx * s * 1.1 - ux * s * 0.1 + ox, p[1] - dy - s * 0.8, p[2] + sz * s * 1.1 - uz * s * 0.1 + oz, h];
            const n = [ux, 0.45, uz];
            tri(b0, l, tip, n, lc, ph, 0); tri(b0, tip, r, n, lc, ph, 0);
          }
          // светящаяся почка на конце
          if (rnd() < 0.22) {
            const p = pts[pts.length - 1], h = (pts.length - 1) * SEG, s = 0.07 + rnd() * 0.05;
            const gc = new THREE.Color().setHSL(0.5 + rnd() * 0.08, 0.85, 0.6);
            const o = [[s, 0, 0], [-s, 0, 0], [0, 0, s], [0, 0, -s]], up = [p[0], p[1] + s * 1.2, p[2], h], dn = [p[0], p[1] - s * 1.6, p[2], h];
            for (let i = 0; i < 4; i++) {
              const q0 = o[i], q1 = o[[2, 3, 1, 0][i]];
              const a1 = [p[0] + q0[0], p[1], p[2] + q0[2], h], a2 = [p[0] + q1[0], p[1], p[2] + q1[2], h];
              tri(up, a1, a2, [0, 1, 0], gc, ph, 1); tri(dn, a2, a1, [0, -1, 0], gc, ph, 1);
            }
          }
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(S, 3));
  const m = mat({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute vec3 aS;
      varying vec3 vC; varying vec3 vW; varying vec3 vN; varying float vG;
      void main(){
        vec3 p = position;
        // качание: у края почти нет, к низу сильнее; лёгкий «ветер» из глубины
        float h = aS.x, k = h * h * 0.02 + h * 0.012;
        float t = uTime * 0.9 + aS.y + p.y * 0.35;
        p.x += sin(t) * k; p.z += cos(t * 0.83 + 1.3) * k;
        vC = color; vN = normal; vG = aS.z; vW = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying vec3 vW; varying vec3 vN; varying float vG;
      void main(){
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        vec3 c = shade(vC * 0.8, n, 0.6);
        c = applyFog(c, vW);
        // почка светится сама, мягко пульсирует
        c = mix(c, vC * (1.1 + 0.25 * sin(uTime * 2.0 + vW.y * 3.0)), vG);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  return { mesh, vines, tris: P.length / 9, stones: stones.length };
}
