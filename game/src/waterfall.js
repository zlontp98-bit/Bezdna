import * as THREE from '../vendor/three.min.js';
import { mulberry32, SEED } from './noise.js';
import { mat } from './shaders.js';
import { SRC, POOLS, LAKE, poolDist, heightAt } from './terrain.js';
// озеро на дне шахты рисуется той же гладью, что и чаши под водопадами
const lakePool = { x: LAKE.x, z: LAKE.z, level: LAKE.level, rad: LAKE.r + 1.2, src: false };
import { smoothstep } from './noise.js';
import { groundAt } from './solids.js';

// Водопады: пелена воды с кромки по параболе, у подножия — брызги и водяная пыль.
// Список перепадов строит buildStreams; здесь только картинка.
const G = 9.8;

export function buildWaterfalls(scene, falls) {
  const sheetMat = mat({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aUv; attribute vec3 aOut;
      varying vec3 vW; varying vec4 vUv; varying vec3 vN; varying float vHb;
      void main(){
        vW = position; vUv = aUv; vHb = aOut.z;
        vN = normalize(vec3(aOut.x, 0.35, aOut.y));
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec4 vUv; varying vec3 vN; varying float vHb;
      void main(){
        float u = vUv.x, q = vUv.y, L = vUv.z, d = vUv.w;
        // q растёт как корень из пройденной высоты: при равномерной прокрутке струи ускоряются
        float f = q * 3.2 - uTime * (1.5 + L * 0.35);
        float n1 = vnoise(vec2(u * 6.0 + L * 11.0, f));
        float n2 = vnoise(vec2(u * 16.0 + L * 3.0, f * 2.3 + 1.7));
        float streak = n1 * 0.65 + n2 * 0.35;
        // у кромки — та же бирюза, что в ручье, ниже — белая пена ручья
        float aer = smoothstep(0.0, 0.18, d);
        vec3 water = mix(vec3(0.20, 0.50, 0.54), vec3(0.36, 0.68, 0.70), n1);
        vec3 foam = mix(vec3(0.72, 0.80, 0.82), vec3(0.94, 0.98, 1.0), smoothstep(0.35, 0.72, streak));
        vec3 c = mix(water, foam, aer);
        c = shade(c, vN, 0.75 + 0.25 * shadowAt(vW.xz)) * mix(0.9, 1.0, L);
        // у самой воды струя разбивается в белую пену (vHb — высота над гладью чаши)
        c = mix(c, vec3(0.90, 0.94, 0.96), smoothstep(6.0, 0.0, vHb) * 0.55);
        float edge = abs(u) + (n2 - 0.5) * 0.4 * (0.25 + d);
        float a = smoothstep(1.0, 0.72, edge);
        // разрывы в пелене, через них видна мокрая скала
        a *= mix(0.95, 0.45 + 0.6 * smoothstep(0.25, 0.65, streak), aer);
        // пелена доходит до самой воды и входит в неё — без просвета между струёй и чашей
        a = mix(a, max(a, 0.85 * smoothstep(1.0, 0.8, abs(u))), smoothstep(3.0, 0.0, vHb));
        a *= mix(1.0, 0.75, L) * smoothstep(-0.35, 0.1, vHb);
        gl_FragColor = vec4(applyFog(c, vW), clamp(a, 0.0, 1.0));
      }`,
  });

  const mistMat = mat({
    transparent: true, depthWrite: false,
    uniforms: { uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uPx; attribute vec4 aS; attribute vec2 aDir;
      varying float vA; varying float vSeed;
      void main(){
        // клуб пыли: поднимается, расползается от струи и тает
        float t = fract(uTime * (0.07 + aS.w * 0.05) + aS.z);
        vec3 p = position + vec3(aDir.x, 0.0, aDir.y) * t * (2.5 + aS.w * 3.0);
        p.y += t * (2.0 + aS.w * 4.0) * aS.x * 0.15;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.5);
        float size = aS.x * (0.55 + t * 0.9);
        vA = sin(t * 3.1416) * aS.y * smoothstep(1.5, 7.0, dist);
        vSeed = aS.z * 17.0;
        gl_PointSize = min(uPx * 583.0 * size / dist, 900.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying float vSeed;
      void main(){
        vec2 pc = gl_PointCoord - 0.5;
        float r = length(pc);
        float n = vnoise(pc * 3.0 + vSeed);
        float a = vA * smoothstep(0.5, 0.05, r + (n - 0.5) * 0.18);
        gl_FragColor = vec4(grade(mix(uFogCol, vec3(0.96, 0.98, 1.0), 0.65)), a);
      }`,
  });

  const rnd = mulberry32(SEED + 131);
  for (const f of falls) {
    const cx = Math.cos(f.th), cz = Math.sin(f.th), px = -cz, pz = cx;
    const outX = -cx, outZ = -cz; // от стены к центру провала
    const H = f.y0 - f.y1, T = Math.sqrt((2 * H) / G), VH = f.open ? 4.2 : f.src ? SRC.VH : 1.6;
    // точка на пелене: o — насколько вода отошла от кромки к центру, l — поперёк
    const P = (o, l) => [cx * (f.lipR - o) + px * l, cz * (f.lipR - o) + pz * l];
    const halfAt = (d) => f.half + Math.min(2.5, H * 0.06) * d;
    // пелена не должна уходить в скалу: если стена выпирает, отодвигаем её ряд вперёд
    const clear = (o, y, hw) => {
      for (let u = -1; u <= 1.001; u += 0.25) {
        const [x, z] = P(o, u * hw);
        if (heightAt(x, z) > y - 0.4) return false;
      }
      return true;
    };
    const COLSN = 11;
    // ряд пелены: центр c, вектор поперёк струи sd (по горизонтали), нормаль nr, доля пути d, высота над гладью hb
    let rows;
    if (f.open) rows = flowPath(f, cx, cz, H, VH);
    else {
      const ROWS = Math.min(56, Math.max(18, Math.round(H * 1.1)));
      rows = [];
      let oPrev = 0;
      for (let i = 0; i < ROWS; i++) {
        const tt = (i / (ROWS - 1)) * T, y = f.y0 - 0.5 * G * tt * tt, d = (f.y0 - y) / H;
        let o = Math.max(VH * tt, oPrev);
        // у самой воды берега не в счёт: струя падает в чашу, а не обходит её края
        if (i > 0 && y > f.y1 + 2.5) for (let k = 0; k < 50 && !clear(o, y, halfAt(d)); k++) o += 0.2;
        oPrev = o;
        const [x, z] = P(o, 0);
        rows.push({ c: [x, y, z], sd: [px, pz], nr: [outX, 0, outZ], d, q: Math.sqrt(f.y0 - y + 0.3), hb: y - f.y1 });
      }
      // последний ряд уходит под гладь чаши: линия входа в воду ровная, без щели
      const b = rows[rows.length - 1];
      rows.push({ ...b, c: [b.c[0], f.y1 - 0.4, b.c[2]], d: 1, q: Math.sqrt(f.y0 - f.y1 + 0.7), hb: -0.4 });
    }
    const NR = rows.length, end = rows[NR - 1];
    const pos = [], uv = [], dir = [], idx = [];
    for (const L of [0, 1]) {
      const base = pos.length / 3;
      for (const { c, sd, nr, d, q, hb } of rows) {
        const half = halfAt(d) + L * 0.3;
        const nl = Math.hypot(nr[0], nr[2]) || 1;
        for (let j = 0; j < COLSN; j++) {
          const u = -1 + (2 * j) / (COLSN - 1);
          // посередине струя выгнута вперёд, задний слой ближе к скале
          const oo = (1 - u * u) * (0.3 + 0.4 * d) * (L ? 1 : 0.5) - (L ? 0 : 0.25);
          pos.push(c[0] + sd[0] * u * half + nr[0] * oo, c[1] + nr[1] * oo, c[2] + sd[1] * u * half + nr[2] * oo);
          uv.push(u, q, L, d);
          dir.push(nr[0] / nl, nr[2] / nl, hb);
        }
      }
      for (let i = 0; i < NR - 1; i++)
        for (let j = 0; j < COLSN - 1; j++) {
          const v = base + i * COLSN + j;
          idx.push(v, v + COLSN, v + 1, v + 1, v + COLSN, v + COLSN + 1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 4));
    g.setAttribute('aOut', new THREE.Float32BufferAttribute(dir, 3));
    g.setIndex(idx);
    const sheet = new THREE.Mesh(g, sheetMat);
    sheet.frustumCulled = false;
    sheet.renderOrder = 4;
    scene.add(sheet);
    // куда бьёт струя: чаша под ней рисует здесь кипящую пену и расходящиеся круги
    {
      const hx = end.c[0], hz = end.c[2];
      for (const p of [...POOLS, lakePool]) if (poolDist(p, hx, hz) < 1) p.splash = { x: hx, z: hz, rad: halfAt(1) * 0.55 + Math.min(1.2, H * 0.02) };
    }

    // ---- водяная пыль у подножия: чем выше водопад, тем её больше ----
    const big = Math.min(1, H / 45), N = Math.round(10 + 22 * big), hw = halfAt(1);
    const eo = Math.hypot(end.nr[0], end.nr[2]) || 1, ex = end.nr[0] / eo, ez = end.nr[2] / eo;
    const mp = new Float32Array(N * 3), aS = new Float32Array(N * 4), md = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = (rnd() - 0.5) * 2.5, l = (rnd() - 0.5) * 2 * hw;
      const x = end.c[0] + ex * a + end.sd[0] * l, z = end.c[2] + ez * a + end.sd[1] * l;
      mp[i * 3] = x; mp[i * 3 + 1] = f.y1 + 0.3 + rnd() * 1.5 * big; mp[i * 3 + 2] = z;
      aS[i * 4] = (2 + rnd() * 3) * (0.6 + 1.4 * big); aS[i * 4 + 1] = 0.1 + rnd() * 0.14;
      aS[i * 4 + 2] = rnd(); aS[i * 4 + 3] = rnd();
      const sp = (rnd() - 0.5) * 1.6;
      md[i * 2] = ex * 0.8 - ez * sp; md[i * 2 + 1] = ez * 0.8 + ex * sp;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aS', new THREE.BufferAttribute(aS, 4));
    mg.setAttribute('aDir', new THREE.BufferAttribute(md, 2));
    const mist = new THREE.Points(mg, mistMat);
    mist.frustumCulled = false;
    mist.renderOrder = 9;
    scene.add(mist);
  }
  buildPools(scene);
  return mistMat;
}

// ---- чаши под водопадами: отдельная водная гладь по форме бассейна ----
// Лента ручья внутри чаши гаснет (atmosphere.js), так что вода тут — одна поверхность:
// глубина по дну, пена и круги от места удара струи, тонкая кромка пены у берега.
function buildPools(scene) {
  const m = mat({
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec4 aP;
      varying vec3 vW; varying vec4 vP;
      void main(){
        vW = position; vP = aP;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFoamR;
      varying vec3 vW; varying vec4 vP;
      void main(){
        // vP: xy — смещение от места удара струи, z — глубина, w — прозрачность у берега
        float r = length(vP.xy), depth = vP.z, F = uFoamR;
        vec2 dirv = vP.xy / max(r, 0.01);
        float n1 = vnoise(vW.xz * 0.45 + vec2(uTime * 0.13, -uTime * 0.10));
        float n2 = vnoise(vW.xz * 1.5 - vec2(uTime * 0.22, uTime * 0.17) + 7.0);
        float dk = smoothstep(0.1, 1.6, depth);
        vec3 shallow = mix(vec3(0.20, 0.50, 0.54), vec3(0.36, 0.68, 0.70), n1);
        vec3 deepC = mix(vec3(0.04, 0.17, 0.22), vec3(0.07, 0.26, 0.30), n1);
        vec3 c = mix(shallow, deepC, dk);
        // нарисованная вода: переливы и солнечные блики, чуть дрейфуют; вдали усредняются сами
        vec3 wt = waterTex(vW.xz, 0.06);   // та же вода и то же течение, что у ручья: стык не виден
        float wl = dot(wt, vec3(0.30,0.59,0.11));
        c = mix(c, c * (0.6 + 1.15*wl) + (wt - c)*0.2, 0.85);
        // под струёй вода кипит, дальше пена расходится рваными кольцами
        float boil = smoothstep(F * 1.25, F * 0.45, r);
        float ring = vnoise(dirv * 3.0 + vec2(r * 0.8 - uTime * 1.5) + n1 * 1.5);
        float rings = smoothstep(0.52, 0.85, ring) * smoothstep(F * 3.2, F * 0.9, r);
        float shore = smoothstep(0.30, 0.04, depth) * smoothstep(0.35, 0.75, n2);
        float foam = step(0.01, F) * (boil * (0.65 + 0.5 * n2) + rings * 0.6) + shore * 0.55 + smoothstep(0.8, 0.93, n2) * 0.10 * (1.0 - dk * 0.7);
        foam = clamp(foam, 0.0, 1.0);
        c = mix(c, vec3(0.94, 0.98, 1.0), foam);
        vec3 vd = normalize(cameraPosition - vW);
        float calm = 1.0 - foam;
        float fres = pow(1.0 - max(vd.y, 0.0), 3.0) * calm;
        c = mix(c, mix(uFogCol, uZenith, 0.35) * 1.1, fres * 0.4);
        float sh = shadowAt(vW.xz);
        c = shade(c, vec3(0.0, 1.0, 0.0), 0.6 + 0.4 * sh);
        // рябь: круги от струи качают блик
        float wv = sin(r * 2.4 - uTime * 3.2) * smoothstep(F * 4.0, F, r) * step(0.01, F);
        vec3 nw = normalize(vec3((n1 - 0.5) * 0.35 + dirv.x * wv * 0.12, 1.0, (n2 - 0.5) * 0.35 + dirv.y * wv * 0.12));
        float spec = pow(max(dot(reflect(-vd, nw), uSun), 0.0), 48.0) * calm * sh;
        c += uSunCol * spec * 1.4;
        float a = mix(0.9, 1.0, max(dk, foam)) * vP.w;
        gl_FragColor = vec4(applyFog(c, vW), a);
      }`,
  });
  const NRG = 12, SEG = 48;
  for (const p of [...POOLS, lakePool]) {
    // точка чаши: t — доля радиуса, ph — угол; у истока чаша вытянута вниз по течению
    const pt = (t, ph) => {
      const c = Math.cos(ph), s = Math.sin(ph);
      if (!p.src) return [p.x + c * t * p.rad, p.z + s * t * p.rad];
      // оси чаши: dx,dz — вниз по течению
      const al = -c * t * SRC.POOL / (c > 0 ? 0.55 : 1.3), l = s * t * SRC.POOL;
      return [p.x - p.dx * al - p.dz * l, p.z - p.dz * al + p.dx * l];
    };
    const hit = p.splash || { x: p.x, z: p.z, rad: 0 };
    const pos = [], aP = [], idx = [];
    for (let i = 0; i <= NRG; i++) {
      const t = (i / NRG) ** 0.8;
      for (let j = 0; j < SEG; j++) {
        const [x, z] = i === 0 ? [pt(0, 0)[0], pt(0, 0)[1]] : pt(t, (j / SEG) * Math.PI * 2);
        pos.push(x, p.level, z);
        aP.push(x - hit.x, z - hit.z, Math.max(0, p.level - heightAt(x, z)), smoothstep(1.0, 0.8, poolDist(p, x, z)));
      }
    }
    for (let i = 0; i < NRG; i++)
      for (let j = 0; j < SEG; j++) {
        const a = i * SEG + j, b = i * SEG + (j + 1) % SEG, c = a + SEG, d = b + SEG;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aP', new THREE.Float32BufferAttribute(aP, 4));
    g.setIndex(idx);
    const pm = m.clone();
    Object.assign(pm.uniforms, m.uniforms); // общие uTime, свет и туман — те же объекты
    pm.uniforms.uFoamR = { value: hit.rad };
    pm.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, pm);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }
}

// ---- водопад в шахту: путь воды с кромки до озера ----
// Вода падает по параболе; встретив глыбу или уступ, растекается по её верху, стекает вниз по склону
// (к озеру), срывается с края и падает дальше — так до самой глади. Упёрлась в стену — скользит по ней вниз.
export function flowPath(f, cx, cz, H, VH) {
  const DT = 0.025, WALL = 0.8, LIFT = 0.25;
  let x = cx * f.lipR, z = cz * f.lipR, y = f.y0;
  let hx = -cx, hz = -cz, hs = VH, vy = 0, air = true; // направление и скорость по горизонтали
  const pts = [[x, y, z]];
  let arc = 0, lastX = x, lastY = y, lastZ = z;
  const sup = (px, pz, py) => groundAt(px, pz, py);
  const toLake = (px, pz) => { const l = Math.hypot(px - LAKE.x, pz - LAKE.z) || 1; return [(LAKE.x - px) / l, (LAKE.z - pz) / l]; };
  const inLake = (px, pz) => Math.hypot(px - LAKE.x, pz - LAKE.z) < LAKE.r - 1;
  for (let it = 0; it < 40000 && y > LAKE.level; it++) {
    if (air) {
      vy -= G * DT;
      let nx = x + hx * hs * DT, nz = z + hz * hs * DT, ny = y + vy * DT;
      let g = sup(nx, nz, ny);
      if (g - ny > WALL) { // стена или бок глыбы: горизонтальная скорость гаснет, вода скользит вниз
        hs *= 0.3; nx = x; nz = z; g = sup(nx, nz, ny);
        if (g - ny > WALL) { y = Math.max(y, g); air = false; continue; }
      }
      x = nx; z = nz; y = ny;
      if (g >= y - 0.05 && !(inLake(x, z) && g < LAKE.level)) { y = g; air = false; vy = 0; hs = Math.max(hs, 1.5); }
    } else {
      // по верху: выбираем направление, где ниже и ближе к озеру, без резких поворотов
      const [lx, lz] = toLake(x, z);
      let best = null;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a), st = 0.45;
        const g = sup(x + dx * st, z + dz * st, y + 0.3);
        if (g > y + 0.3) continue; // в гору или в стену
        const sc = (y - g) * 1.2 + 0.35 * (dx * lx + dz * lz) + 0.5 * (dx * hx + dz * hz);
        if (!best || sc > best.sc) best = { sc, dx, dz, g };
      }
      if (!best) { hx = lx; hz = lz; hs = 1.5; air = true; y += 0.3; continue; } // в ямке: перелить через край
      hx = best.dx; hz = best.dz;
      const step = 3.2 * DT * 4;
      const nx = x + hx * step, nz = z + hz * step, g = sup(nx, nz, y + 0.3);
      x = nx; z = nz;
      if (g < y - 0.6 || (inLake(x, z) && g < LAKE.level)) { air = true; vy = 0; hs = 2.6; } // край: срывается вниз
      else y = g;
    }
    const dd = Math.hypot(x - lastX, y - lastY, z - lastZ);
    if (dd > 0.9) { arc += dd; pts.push([x, y, z]); lastX = x; lastY = y; lastZ = z; }
  }
  if (y > LAKE.level) console.warn('waterfall: путь не дошёл до озера', x, y, z);
  pts.push([x, Math.min(y, LAKE.level) - 0.4, z]);
  // сгладить ломаную (на воздухе она и так плавная, на камнях — ступеньки сетки)
  for (let pass = 0; pass < 2; pass++)
    for (let i = 1; i < pts.length - 1; i++)
      for (let c = 0; c < 3; c++) pts[i][c] = pts[i][c] * 0.5 + (pts[i - 1][c] + pts[i + 1][c]) * 0.25;
  // ряды пелены
  const rows = [];
  let sx = -cz, sz = cx, len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], c = pts[i];
    if (i) len += Math.hypot(c[0] - pts[i - 1][0], c[1] - pts[i - 1][1], c[2] - pts[i - 1][2]);
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const th = Math.hypot(tx, tz), tl = Math.hypot(tx, ty, tz) || 1;
    if (th > 0.15 * tl) { sx = -tz / th; sz = tx / th; } // поперёк — по горизонтали к ходу струи
    tx /= tl; ty /= tl; tz /= tl;
    // нормаль пелены: sd × t, где sd = (sx, 0, sz)
    const nx = -sz * ty, ny = sz * tx - sx * tz, nz = sx * ty;
    const nl = Math.hypot(nx, ny, nz) || 1;
    // пусть нормаль смотрит от скалы: вверх, если струя лежит на камне, и к озеру, если падает
    let sgn = ny < -0.01 ? -1 : 1;
    if (Math.abs(ny) < 0.3) { const [lx, lz] = toLake(c[0], c[2]); sgn = nx * lx + nz * lz < 0 ? -1 : 1; }
    rows.push({ c, sd: [sx, sz], nr: [nx / nl * sgn, ny / nl * sgn, nz / nl * sgn], d: Math.min(1, (f.y0 - c[1]) / H), q: Math.sqrt(len + 0.3), hb: c[1] - LAKE.level });
  }
  return rows;
}
