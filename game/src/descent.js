import * as THREE from '../vendor/three.min.js';
import { W, heightAt, pitR, rockMat } from './terrain.js';
import { addMeshTop, solidsNear, groundAt } from './solids.js';
import { STACKS, PILLARS } from './stacks.js';
import { mulberry32, SEED } from './noise.js';
import { part, merge, T, propMaterial } from './flora.js';

// Спуск в бездну — отдельный участок поверх шахты (остальную карту не трогает).
//
// Скальные массивы, приросшие к стене шахты, идут витками вниз до озера: широкие неровные поверхности
// разного наклона, проходы между скалами и под каменными арками, уступы для карабканья, трещины
// с естественными мостами, прыжки, обрывы и крутые скользкие склоны. Массив — это несколько
// толстых асимметричных «глыб» (лопастей), которые перекрываются друг с другом: сверху у каждой
// своя неровная поверхность (на ней стоят и по ней скользят), снизу — тяжёлое тело, нависающее над пропастью.
//
// Два маршрута начинаются на противоположных сторонах шахты. Всё строится по семени (одинаково у всех);
// проходимость каждого куска проверяется ботом на настоящей физике героя (dev-скрипт ntest).

const TAU = Math.PI * 2;
const RS = 54;                      // радиус, по которому считается длина дуги маршрута
const LANE = 4.0;                   // «дорожка» героя: расстояние от стенки, м
const FLOOR = -(W.LOW + W.DEEP);    // дно шахты
export const DESCENT = { spines: [], lobes: [], links: [], stats: {}, ready: false };
export const DBG = {};

const rwAt = (th) => pitR(Math.cos(th) * W.PIT, Math.sin(th) * W.PIT);
const toWorld = (s, u, sp) => {
  const th = sp.th0 + sp.dir * s / RS, c = Math.cos(th), sn = Math.sin(th);
  let r = rwAt(th) - u;
  for (let k = 0; k < 2; k++) r = pitR(c * r, sn * r) - u;          // радиус стенки в самой точке, а не на окружности
  return [c * r, sn * r];
};
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

// ---------- 1. план маршрута в координатах (s — вдоль стены, u — от стены вглубь шахты, y — высота) ----------
function makeSpine(rnd, ringY) {
  const lobes = [], links = [];
  let S = 0, Y = ringY, tm = 0, last = '', cs = 0;   // cs — наклон поверхности у конца пройденного куска
  const lobe = (o) => { lobes.push({ T: 5 + rnd() * 4, n: 3 + rnd() * 1.4, bump: 0.32, arch: 0, gu: 0, gs: 0, tm, ...o }); return lobes[lobes.length - 1]; };
  const link = (kind, wps) => links.push({ kind, wps, tm });
  const wide = (L, gs, extra = {}) => { const l = lobe({ s0: S - 3, s1: S + L + 3, u0: -2.5, u1: 8.5 + rnd() * 2.5, sRef: S, yRef: Y, gs, gs0: cs, ...extra }); cs = gs; return l; };

  // вход: ровная площадка вровень с нижним уступом
  lobe({ s0: -3, s1: 11, u0: -2.5, u1: 9.5, sRef: 0, yRef: ringY - 0.05, gs: 0, bump: 0.1, T: 6 });
  link('entry', [[-4.5, -3.5, ringY], [10, LANE, ringY - 0.05]]);
  S = 10; Y = ringY - 0.05;

  const TEMPL = [
    ['wide', 38], ['passage', 14], ['climb', 12], ['jump', 11], ['bridge', 11], ['drop', 8], ['slide', 8],
  ];
  const tot = TEMPL.reduce((a, t) => a + t[1], 0);
  const need = ['climb', 'passage', 'slide', 'bridge', 'climb', 'passage', 'jump', 'drop'];
  for (let guard = 0; guard < 90 && Y > FLOOR + 14; guard++) {
    tm++;
    let q = rnd() * tot, kind = 'wide';
    for (const [k, w] of TEMPL) { q -= w; if (q <= 0) { kind = k; break; } }
    if (need.length && last === 'wide' && rnd() < 0.55) kind = need.shift();
    if (kind === last && kind !== 'wide') kind = 'wide';
    if (kind === 'climb' && Y + 8 > ringY - 6) { need.unshift('climb'); kind = 'wide'; }
    if (kind === 'climb' && Y + 8 > ringY - 6) kind = 'wide';
    last = kind;
    if (kind === 'wide') {
      const L = 16 + rnd() * 18, gs = -(0.1 + rnd() * 0.24);
      wide(L, gs);
      const Y1 = Y + gs * L;
      link('wide', [[S, LANE, Y], [S + L * 0.5, LANE + (rnd() - 0.5) * 2, Y + gs * L * 0.5], [S + L, LANE, Y1]]);
      S += L; Y = Y1;
    } else if (kind === 'passage') {
      // проход между стеной и высокой скалой, иногда под каменной аркой
      const L = 10 + rnd() * 5, gs = (rnd() - 0.5) * 0.08, lane = 2.9;
      wide(L, gs, { u1: 9 });
      lobe({ s0: S + 0.9, s1: S + L - 0.9, u0: 4.7, u1: 10.5, sRef: S, yRef: Y + 4.2 + rnd() * 1.2, gs, gs0: gs, T: 10, n: 3.2, bump: 0.35 });
      const arch = rnd() < 0.5;
      if (arch) lobe({ s0: S + L * 0.35, s1: S + L * 0.35 + 2.6 + rnd(), u0: -2.5, u1: 7.0, sRef: S, yRef: Y + 4.1, gs, gs0: gs, T: 2.2, n: 4, bump: 0.1 });
      const Y1 = Y + gs * L;
      link(arch ? 'arch' : 'passage', [[S, lane, Y], [S + L * 0.5, lane, Y + gs * L * 0.5], [S + L, lane, Y1]]);
      S += L; Y = Y1;
    } else if (kind === 'climb') {
      // выступы на стене: поднимаемся на 5–8 м на высокий массив
      const H = 4.8 + rnd() * 3.4, k = Math.max(3, Math.ceil(H / 1.45) - 1), st = H / (k + 1);
      const wps = [[S, LANE, Y]];
      let sc = S + 1.0, uPrev = LANE;
      for (let i = 0; i < k; i++) {
        const a = 1.4 + rnd() * 0.7, b = 1.3 + rnd() * 0.7;
        sc += (i === 0 ? 2.5 : 0.7 + a) + rnd() * 0.5;
        const u = Math.max(2.4, Math.min(6, uPrev + (rnd() - 0.5) * 2.2)), y = Y + (i + 1) * st + (rnd() - 0.5) * 0.2;
        lobe({ s0: sc - a, s1: sc + a, u0: u - b, u1: u + b, sRef: sc, yRef: y, gs: 0, T: 2.6, n: 2.6, bump: 0.1 });
        wps.push([sc, u, y]); uPrev = u; sc += a;
      }
      S = sc + 1.0; Y += H; cs = 0;
      const L = 12 + rnd() * 6;
      wide(L, -(0.05 + rnd() * 0.12));
      wps.push([S + 1.5, LANE, Y]);
      link('climb', wps);
      const gs = lobes[lobes.length - 1].gs; S += L; Y += gs * L;
    } else if (kind === 'jump' || kind === 'drop') {
      const gap = kind === 'jump' ? 2.6 + rnd() * 0.8 : 1.6 + rnd() * 1.0, drop = kind === 'jump' ? 0.3 + rnd() * 2.4 : 4 + rnd() * 3.5;
      const s0 = S + 3 + gap, Y1 = Y - drop, L = 12 + rnd() * 8, gs = -(0.05 + rnd() * 0.15);
      lobe({ s0, s1: s0 + L + 3, u0: -2.5, u1: 8.5 + rnd() * 2.5, sRef: s0, yRef: Y1, gs, gs0: gs });
      cs = gs;
      link(kind, [[S - 3.5, LANE, Y + 0.0], [s0 + 3, LANE, Y1 + gs * 3]]);
      S = s0 + L; Y = Y1 + gs * L;
    } else if (kind === 'bridge') {
      // трещина: естественный мост — узкая арка-перемычка
      const G = 11 + rnd() * 4, Y1 = Y - rnd() * 1.2, gs = (Y1 - Y) / G;
      lobe({ s0: S - 2.5, s1: S + G + 2.5, u0: LANE - 1.7, u1: LANE + 1.7, sRef: S, yRef: Y, gs, gs0: cs, T: 2.4, n: 3.6, bump: 0.08, arch: 0.7 });
      cs = gs;
      const L = 14 + rnd() * 8, g2 = -(0.08 + rnd() * 0.15);
      S += G; Y = Y1;
      wide(L, g2);
      link('bridge', [[S - G - 2.5, LANE, Y - gs * G], [S + 2.5, LANE, Y + g2 * 2.5]]);
      S += L; Y += g2 * L;
    } else if (kind === 'slide') {
      // крутой скользкий склон и пологий выкат внизу
      const gs = -(1.12 + rnd() * 0.18), Ls = 7.5, Y2 = Y + gs * Ls;
      lobe({ s0: S - 1, s1: S + Ls + 0.5, u0: -2.5, u1: 9.5, sRef: S, yRef: Y, gs, gs0: cs, T: 6, bump: 0.18 });
      const S2 = S + Ls, L = 16;
      lobe({ s0: S2 - 3, s1: S2 + L + 3, u0: -2.5, u1: 9.5, sRef: S2, yRef: Y2, gs: -0.03, gs0: gs });
      cs = -0.03;
      link('slide', [[S - 0.5, LANE, Y], [S2 + 5, LANE, Y2 - 0.15]]);
      S = S2 + L; Y = Y2 - 0.03 * L;
    }
  }
  return { lobes, links, S, Y };
}

// ---------- 2. геометрия лопасти ----------
const topY = (l, s, u, bw = 1) => {
  let y = l.yRef + (s < l.sRef && l.gs0 !== undefined ? l.gs0 : l.gs) * (s - l.sRef) + l.gu * (u - l.uc);
  const ph = l.ph;
  y += bw * l.bump * (0.5 * Math.sin(s * 0.55 + ph[0]) * Math.cos(u * 0.7 + ph[1]) + 0.35 * Math.sin(s * 1.3 + u * 1.1 + ph[2]));
  if (l.arch) { const t = (s - l.sc) / l.a; y += l.arch * Math.max(0, 1 - t * t); }
  return y;
};

function lobeMesh(l, sp, out, rnd) {
  const SEG = l.T < 3 ? 10 : 14, sc = (l.s0 + l.s1) / 2, uc = (l.u0 + l.u1) / 2, a = (l.s1 - l.s0) / 2, b = (l.u1 - l.u0) / 2;
  l.sc = sc; l.uc = uc; l.a = a; l.b = b; l.ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
  const h1 = 0.1 + rnd() * 0.12, h2 = 0.08 + rnd() * 0.1, h3 = 0.05 + rnd() * 0.08, p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
  const mAt = (ang) => 0.97 + h1 * Math.sin(ang * 2 + p1) + h2 * Math.sin(ang * 3 + p2) + h3 * Math.sin(ang * 5 + p3);
  const wpt = (s, u, y) => {
    let [x, z] = toWorld(s, u, sp);
    const r = Math.hypot(x, z), rw = pitR(x, z);
    if (r > rw - 0.3) { const f = (rw + 1.8) / r; x *= f; z *= f; }      // у стенки — вдавлена в породу
    return [x, y, z];
  };
  const pts = (k, dy, sh, ri) => {
    const arr = [];
    for (let i = 0; i < SEG; i++) {
      const ang = (i / SEG) * TAU, m = mAt(ang) * (0.93 + 0.14 * hash(l.ph[0] + i, ri * 5.3));
      const e = 2 / l.n, ds = a * k * sh * (1 + (m - 1) * 0.12) * spow(Math.cos(ang), e), du = b * k * sh * m * spow(Math.sin(ang), e);
      const s = sc + ds, u = uc + du;
      let y = topY(l, s, u, 1 - 0.85 * k * k);
      if (dy === 0 && k > 0.9) y -= 0.1;                                   // скруглённый край
      arr.push({ s, u, y: y - dy });
    }
    return arr;
  };
  // вершины: центр, три кольца сверху, четыре кольца тела
  const cen = { s: sc, u: uc, y: topY(l, sc, uc) };
  const top = [pts(0.38, 0, 1, 1), pts(0.7, 0, 1, 2), pts(1, 0, 1, 3)];
  const body = [[0.18 * l.T, 1.05], [0.55 * l.T, 0.84], [l.T, 0.5]].map(([d, sh], ri) => {
    const arr = pts(1, d, sh, 10 + ri);
    return arr.map((p) => ({ ...p, y: p.y - (hash(p.s, ri) - 0.5) * 0.5 }));
  });
  const apexP = { s: sc, u: uc, y: Math.min(...body[2].map((p) => p.y)) - l.T * 0.45 };
  const W3 = (p) => wpt(p.s, p.u, p.y);
  const UP = [0, 1, 0], DN = [0, -1, 0];
  const tri = (A, B, C, hint) => {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { const t = B; B = C; C = t; }
    out.pos.push(...A, ...B, ...C);
  };
  const topTris = [];
  const tt = (A, B, C) => { tri(A, B, C, UP); topTris.push(...A, ...B, ...C); };
  const C0 = W3(cen);
  const T0 = top.map((r) => r.map(W3)), B0 = body.map((r) => r.map(W3)), AP = W3(apexP);
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    tt(C0, T0[0][i], T0[0][j]);
    for (let r = 0; r < 2; r++) { tt(T0[r][i], T0[r + 1][i], T0[r + 1][j]); tt(T0[r][i], T0[r + 1][j], T0[r][j]); }
    // бока и нависающее тело
    const rings = [T0[2], ...B0];
    for (let r = 0; r + 1 < rings.length; r++) {
      const mid = [(rings[r][i][0] + rings[r][j][0]) / 2 - C0[0], 0, (rings[r][i][2] + rings[r][j][2]) / 2 - C0[2]];
      tri(rings[r][i], rings[r][j], rings[r + 1][j], mid); tri(rings[r][i], rings[r + 1][j], rings[r + 1][i], mid);
    }
    tri(B0[2][i], B0[2][j], AP, DN);
  }
  // край виден над пропастью только если не вдавлен в стенку: для столкновений нужен весь верх
  const minTop = Math.min(...T0[2].map((p) => p[1]));
  const solid = addMeshTop(new Float32Array(topTris), 0.3, { slope: true, under: minTop - l.T * 0.8 });
  l.solid = solid;
  // габариты для проверок пересечений
  let rad = 0; for (const p of T0[2]) rad = Math.max(rad, Math.hypot(p[0] - C0[0], p[2] - C0[2]));
  l.cx = C0[0]; l.cz = C0[2]; l.rad = rad; l.yTop = Math.max(...T0[2].map((p) => p[1])) + 1; l.yBot = AP[1];
  l.ring = T0[2];
}

// ---------- 3. проверки ----------
function obstacles() {
  const list = [];
  for (const st of STACKS) list.push([st.x, st.z, st.w * 1.25 + 1.2, st.top + 6, st.top - (st.big ? 340 : 140)]);
  for (const p of PILLARS) list.push([p.x, p.z, p.w * 1.1 + 1.0, p.top + 3, p.top - 26]);
  return list;
}

// прикидка пересечений без построения мешей: считаем по габаритам лопастей
function roughBounds(lobes, sp) {
  return lobes.map((l) => {
    const sc = (l.s0 + l.s1) / 2, uc = (l.u0 + l.u1) / 2, a = (l.s1 - l.s0) / 2, b = (l.u1 - l.u0) / 2;
    const [cx, cz] = toWorld(sc, Math.max(uc, 3), sp);
    const yMid = l.yRef + l.gs * (sc - l.sRef);
    return { cx, cz, rad: Math.max(a, 2) * 1.0, uVis: Math.max(l.u1 - 1.6, 0), yTop: yMid + Math.abs(l.gs) * a + 1.5, yBot: yMid - Math.abs(l.gs) * a - l.T * 1.4, l, sp, sc, uc, a, b };
  });
}

function samples(b) {
  if (b.smp) return b.smp;
  const l = b.l, out = [];
  for (let s = l.s0; s <= l.s1; s += 3) for (const u of [0.5, 3, 5.5, Math.max(l.u1 - 1, 1)]) {
    const [x, z] = toWorld(s, u, b.sp);
    out.push([x, z, l.yRef + l.gs * (s - l.sRef)]);
  }
  return (b.smp = out);
}

function conflictCount(spines, obs) {
  let n = 0;
  const all = [];
  spines.forEach((sp, si) => roughBounds(sp.plan.lobes, sp).forEach((b) => all.push({ ...b, si })));
  for (const b of all) {
    const l = b.l;
    // образцы по лопасти: вдоль s, на нескольких u
    for (let s = l.s0 + 1; s <= l.s1 - 1 && n < 1e6; s += 3) for (const u of [1.8, (l.u1 + 1.8) / 2, l.u1 - 0.8]) {
      if (u < 1.6) continue;
      const [x, z] = toWorld(s, u, b.sp);
      const y = l.yRef + l.gs * (s - l.sRef);
      let bad = false;
      for (let i = 0; i < obs.length && !bad; i++) { const o = obs[i]; if (y < o[3] + 3 && y - l.T * 1.4 > o[4] - 3 && (x - o[0]) ** 2 + (z - o[1]) ** 2 < o[2] * o[2]) bad = true; }
      if (!bad) bad = solidsNear(x, z, 1.5).some((q) => q.top > y - 10 && (q.bottom < -1e8 ? heightAt(q.x, q.z) : q.bottom) < y + 6);
      if (bad) { n++; DBG.obs = (DBG.obs || 0) + 1; break; }
    }
  }
  // между маршрутами и между витками одного маршрута
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const A = all[i], B = all[j];
    if (A.si === B.si && Math.abs(A.l.tm - B.l.tm) <= 1) continue;
    if (Math.hypot(A.cx - B.cx, A.cz - B.cz) < A.rad + B.rad + 4 && A.yBot < B.yTop && B.yBot < A.yTop) {
      const SA = samples(A), SB = samples(B);
      let hit = false;
      for (const p of SA) { for (const q of SB) if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < 20 && p[2] + 0.5 > q[2] - B.l.T && q[2] + 0.5 > p[2] - A.l.T) { hit = true; break; } if (hit) break; }
      if (hit) { n++; DBG.pair = (DBG.pair || 0) + 1; }
    }
  }
  return n;
}

export function buildDescent(scene) {
  const obs = obstacles();
  // входы: ровные места нижнего уступа
  const ringAt = (th) => {
    const rw = rwAt(th), c = Math.cos(th), s = Math.sin(th), y = heightAt(c * (rw + 4), s * (rw + 4));
    const flat = [2.5, 4, 6].every((d) => Math.abs(heightAt(c * (rw + d), s * (rw + d)) - y) < 1.2);
    return flat && !solidsNear(c * (rw + 3.5), s * (rw + 3.5), 3).length ? y : null;
  };
  // кандидатов — по кругу углов и семенам; берём лучший по числу пересечений (dev: window.__descPick — n-й по счёту)
  const cands = [];
  for (let k = 0; k < 8; k++) {
    for (let a = 0; a < TAU; a += 0.35) {
      const yA = ringAt(a), bAng = a + Math.PI + (hash(k, 3) - 0.5) * 0.6, yB = ringAt(bAng);
      if (yA === null || yB === null) continue;
      const dir = hash(k, 7) < 0.5 ? 1 : -1;
      const rnd = mulberry32(SEED + 9001 + k * 977 + Math.floor(a * 10));
      const spines = [{ th0: a, dir, plan: makeSpine(rnd, yA) }, { th0: bAng, dir, plan: makeSpine(rnd, yB) }];
      const c = conflictCount(spines, obs);
      cands.push({ spines, c, k, a, score: c * 100 - spines.reduce((q, s2) => q + s2.plan.lobes.length, 0) * 0.2 });
    }
  }
  cands.sort((p, q) => p.score - q.score);
  // Строим кандидата по-настоящему и проверяем пути героя: нигде над дорожкой не должно быть чужой скалы
  // (острова, столбы, другие витки). Не прошёл — гасим его плиты и берём следующего.
  const pick = (typeof window !== 'undefined' && window.__descPick) || 0;
  let best = null, out = null, tried = 0;
  const blocked = (cand) => {
    let bad = 0;
    cand.spines.forEach((sp) => {
      for (const lk of sp.plan.links) {
        if (!['wide', 'passage', 'arch', 'bridge', 'entry'].includes(lk.kind)) continue;
        for (let q = 0; q + 1 < lk.wps.length; q++) {
          const A = lk.wps[q], B = lk.wps[q + 1], d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
          for (let t = 0; t <= d; t += 1.0) {
            const f = t / d, [x, z] = toWorld(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, sp), y = A[2] + (B[2] - A[2]) * f;
            const g = groundAt(x, z, y + 0.4);
            if (g > y + 1.1) { bad++; (DBG.bk = DBG.bk || []).push(lk.kind + ':' + (g - y).toFixed(1) + '@' + Math.round(y) + ' xz=' + Math.round(x) + ',' + Math.round(z) + ' r=' + Math.round(Math.hypot(x, z)) + ' ' + JSON.stringify(solidsNear(x, z, 2).map((q) => [q.top | 0, q.bottom | 0])) + ' h=' + heightAt(x, z).toFixed(0)); break; }
          }
        }
      }
    });
    return bad;
  };
  for (let ci = pick; ci < cands.length && ci < pick + 40; ci++) {
    const cand = cands[ci];
    tried++;
    const rnd = mulberry32(SEED + 9002), o = { pos: [] };
    cand.spines.forEach((sp, si) => { for (const l of sp.plan.lobes) { l.si = si; lobeMesh(l, sp, o, rnd); } });
    const bad = blocked(cand);
    if (bad === 0 || ci === pick + 39) { best = cand; out = o; best.bad = bad; break; }
    for (const sp of cand.spines) for (const l of sp.plan.lobes) l.solid.off = true;
  }
  if (!best) return DESCENT;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(out.pos.length / 3 * 2), 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, rockMat);
  mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
  scene.add(mesh);

  // кристаллы на широких глыбах: ориентир в темноте
  const cry = [], oct = new THREE.OctahedronGeometry(1, 0), col = new THREE.Color(), r3 = mulberry32(SEED + 9003);
  best.spines.forEach((sp) => {
    for (const l of sp.plan.lobes) {
      if (l.T < 4 || r3() < 0.5) continue;
      const c = 1 + (r3() < 0.4 ? 1 : 0);
      for (let k = 0; k < c; k++) {
        const s = l.s0 + 2 + r3() * (l.s1 - l.s0 - 4), u = Math.max(l.u1 - 1.4 - r3() * 2, 2.5);
        const [x, z] = toWorld(s, u, sp), y = topY(l, s, u), h = 0.7 + r3() * 1.2;
        col.setHSL(0.52 + r3() * 0.28, 0.7, 0.66);
        cry.push(part(oct, col.getHex(), { glow: 0.85, m: T(x, y + h * 0.7, z, 0.28 * h, h, 0.28 * h, r3() * 6) }));
      }
    }
  });
  if (cry.length) {
    const cm = new THREE.Mesh(merge(cry), propMaterial());
    cm.frustumCulled = false; cm.matrixAutoUpdate = false;
    scene.add(cm);
  }
  // звенья для проверки ботом: пути героя в мировых координатах
  const links = [];
  best.spines.forEach((sp, si) => {
    for (const lk of sp.plan.links) {
      links.push({ si, kind: lk.kind, tm: lk.tm, wps: lk.wps.map(([s, u, y]) => { const [x, z] = toWorld(s, u, sp); return [x, y, z]; }) });
    }
  });
  Object.assign(DESCENT, { spines: best.spines.map((s) => ({ th0: s.th0, dir: s.dir, n: s.plan.lobes.length, endY: s.plan.Y })), links, ready: true,
    stats: { conflicts: best.c, blocked: best.bad, tried, seed: best.k, lobes: best.spines.reduce((q, s) => q + s.plan.lobes.length, 0), links: links.length, tris: out.pos.length / 9 } });
  return DESCENT;
}
