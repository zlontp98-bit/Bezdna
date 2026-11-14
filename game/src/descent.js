import * as THREE from '../vendor/three.min.js';
import { W, heightAt, pitR, rockMat } from './terrain.js';
import { addMeshTop, solidsNear, groundAt, lastSolid, rockAt } from './solids.js';
import { STACKS, PILLARS, CHAINS, colAt, isHanging } from './stacks.js';
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
const PICKED = [1, 11, 20];               // [маршрутов, семя, сдвиг угла] — раскладка, найденная перебором (dev: window.__descScan)

const rwAt = (th) => pitR(Math.cos(th) * W.PIT, Math.sin(th) * W.PIT);
const toWorld = (s, u, sp) => {
  if (sp.cart) return [s, u];                                        // «каньон» в середине шахты строится прямо в координатах мира
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
  const wide = (L, gs, extra = {}) => {
    const l = lobe({ s0: S - 3, s1: S + L + 3, u0: -2.5, u1: 9 + rnd() * 3.5, sRef: S, yRef: Y, gs, gs0: cs, bump: 0.3 + rnd() * 0.5, ...extra });
    const cs1 = cs; cs = gs;
    // завал: россыпь валунов по поверхности — обходить или перелезать
    if (!extra.noRubble && L > 18 && rnd() < 0.4) {
      const n = 4 + Math.floor(rnd() * 5), placed = [];
      for (let k = 0; k < n; k++) {
        const sc = S + 3 + rnd() * (L - 6), u = 2.6 + rnd() * 5.2, a = 0.8 + rnd() * 0.8, b = 0.8 + rnd() * 0.8;
        if (placed.some((q) => Math.hypot(q[0] - sc, q[1] - u) < q[2] + a + 1.1)) continue;
        placed.push([sc, u, a]);
        lobe({ s0: sc - a, s1: sc + a, u0: u - b, u1: u + b, sRef: sc, yRef: Y + gs * (sc - S) + 0.5 + rnd() * 1.1, gs: 0, gs0: 0, T: 1.8, n: 2.3, bump: 0.08, rubble: true });
      }
    }
    return l;
  };
  const yAt = (s0, gs0) => Y + gs0 * (s0 - S);
  // повёрнутая лопасть-отрезок от точки (sA, uA) к (sB, uB): узкий гребень с наклоном вдоль себя
  const seg = (sA, uA, yA, sB, uB, yB, half, o = {}) => {
    const ds = sB - sA, du = uB - uA, len = Math.hypot(ds, du), rot = Math.atan2(du, ds), A = len / 2 + (o.ext ?? 1.0);
    const cs2 = (sA + sB) / 2, cu = (uA + uB) / 2, es = Math.abs(A * Math.cos(rot)) + Math.abs(half * Math.sin(rot)), eu = Math.abs(A * Math.sin(rot)) + Math.abs(half * Math.cos(rot));
    return lobe({ rot, cs: cs2, cu, A, B: half, s0: cs2 - es, s1: cs2 + es, u0: cu - eu, u1: cu + eu, sRef: sA, uRef: uA, dS: Math.cos(rot), dU: Math.sin(rot), yRef: yA, gs: (yB - yA) / len, gs0: o.gs0 ?? (yB - yA) / len, T: o.T ?? 3.5, n: 2.6, bump: 0.12, ...o });
  };

  // вход: ровная площадка вровень с нижним уступом
  lobe({ s0: -3, s1: 11, u0: -2.5, u1: 9.5, sRef: 0, yRef: ringY - 0.05, gs: 0, bump: 0.1, T: 6 });
  link('entry', [[-4.5, -3.5, ringY], [10, LANE, ringY - 0.05]]);
  S = 10; Y = ringY - 0.05;

  const TEMPL = [
    ['wide', 20], ['passage', 5], ['tunnel', 6], ['climb', 5], ['wall', 14], ['cliff', 14], ['snake', 11], ['jump', 6], ['bridge', 7], ['drop', 4], ['slide', 6], ['stones', 8], ['fork', 9], ['dome', 7], ['traverse', 7],
  ];
  const tot = TEMPL.reduce((a, t) => a + t[1], 0);
  const need = ['wall', 'snake', 'cliff', 'traverse', 'fork', 'dome', 'wall', 'tunnel', 'snake', 'stones', 'cliff', 'wall', 'fork', 'traverse', 'climb', 'dome', 'slide', 'snake', 'cliff', 'stones', 'tunnel', 'bridge', 'wall', 'fork', 'cliff', 'jump', 'drop'];
  for (let guard = 0; guard < 90 && Y > FLOOR + 14; guard++) {
    tm++;
    let q = rnd() * tot, kind = 'wide';
    for (const [k, w] of TEMPL) { q -= w; if (q <= 0) { kind = k; break; } }
    if (need.length && last === 'wide' && rnd() < 0.55) kind = need.shift();
    if (kind === last && kind !== 'wide') kind = 'wide';
    if (kind === 'plateau' && last !== 'wall' && last !== 'cliff') kind = 'wide';
    if ((kind === 'climb' || kind === 'wall' || kind === 'traverse') && Y + 12 > ringY - 6) { need.unshift(kind); kind = 'wide'; }
    if (kind === 'wall' && last === 'climb') kind = 'wide';
    if ((last === 'wall' || last === 'cliff') && rnd() < 0.45) kind = 'plateau';
    last = kind;
    const cs0 = cs;
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
      if (arch) lobe({ s0: S + L * 0.35, s1: S + L * 0.35 + 2.6 + rnd(), u0: -2.5, u1: 7.0, sRef: S, yRef: Y + 4.1, gs, gs0: gs, T: 2.2, n: 4, bump: 0.1, flat: true });
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
    } else if (kind === 'wall') {
      // отвесная стена 6–14 м: лезть вверх; у высоких — на полпути уступ-полка, где можно перевести дух
      const H = rnd() < 0.35 ? 3 + rnd() * 2 : 6 + rnd() * 8, Tm = H + 2.5, ledge = H > 9, s0 = S + (ledge ? 4.4 : 2.0), Lm = 12 + rnd() * 8, gs = -(0.05 + rnd() * 0.12);
      lobe({ s0, s1: s0 + Lm + 3, u0: -2.5, u1: 8.5 + rnd() * 3, sRef: s0, yRef: Y + H, gs, gs0: 0, T: Tm, bump: 0.25 });
      if (ledge) {
        const H1 = H * (0.42 + rnd() * 0.16);
        lobe({ s0: S + 2.0, s1: s0 + 0.6, u0: -2.5, u1: 6.5 + rnd() * 2, sRef: S + 2, yRef: Y + H1, gs: 0, gs0: 0, T: H1 + 2.5, n: 3.4, bump: 0.08 });
      }
      cs = gs;
      link('wall', [[S - 3, LANE, Y - cs0 * 3], [S + 1.2, LANE, Y], [s0 + 3, LANE, Y + H + gs * 3]]);
      S = s0 + Lm; Y = Y + H + gs * Lm;
    } else if (kind === 'cliff') {
      // обрыв 11–17 м: вниз — только слезть по отвесной грани (повиснуть на кромке кнопкой «Хват»)
      const H = 11 + rnd() * 6, Lt = 8 + rnd() * 4, Tt = H + 3;
      lobe({ s0: S - 3, s1: S + Lt, u0: -2.5, u1: 8.5 + rnd() * 2.5, sRef: S, yRef: Y, gs: 0, gs0: cs, T: Tt, bump: 0.2 });
      const s2 = S + Lt - 2.5, Y2 = Y - H, gs2 = -(0.06 + rnd() * 0.12), L2 = 16 + rnd() * 6;
      lobe({ s0: s2, s1: s2 + L2 + 3, u0: -2.5, u1: 8.5 + rnd() * 2.5, sRef: s2, yRef: Y2, gs: gs2, gs0: gs2 });
      cs = gs2;
      link('cliff', [[S - 3, LANE, Y - cs0 * 3], [S + Lt - 1.6, LANE, Y], [s2 + 5, LANE, Y2 + gs2 * 5]]);
      S = s2 + L2; Y = Y2 + gs2 * L2;
    } else if (kind === 'snake') {
      // каменная змейка: узкий извилистый гребень уходит от стены над пропастью и возвращается
      const n = 6 + Math.floor(rnd() * 4), amp = 4.5 + rnd() * 4.5, P = [];
      let yy = Y + cs0 * 1.5, gsPrev = cs0;
      for (let k = 0; k <= n; k++) {
        const t = k / n, sk = S + 1.5 + k * (3.6 + rnd() * 1.2);
        const uk = LANE + amp * Math.sin(Math.PI * t) + (k > 0 && k < n ? (rnd() - 0.5) * 1.6 : 0);
        if (k > 0) yy += -(0.2 + rnd() * 0.9) + (rnd() < 0.2 ? 1.0 : 0);   // в основном вниз, иногда чуть вверх
        P.push([sk, uk, yy]);
      }
      for (let k = 0; k < n; k++) {
        const [a1, b1, c1] = P[k], [a2, b2, c2] = P[k + 1];
        const l = seg(a1, b1, c1, a2, b2, c2, 1.25 + rnd() * 0.45, { gs0: gsPrev, T: 3 + rnd() * 2.5 });
        gsPrev = l.gs;
      }
      const end = P[n];
      S = end[0]; Y = end[2]; cs = gsPrev;
      const L = 12 + rnd() * 6, gsN = -(0.06 + rnd() * 0.12);
      wide(L, gsN);
      link('snake', [[P[0][0] - 4, LANE, Y - (end[2] - P[0][2]) - cs0 * 4], ...P.map((p) => [p[0], p[1], p[2]]), [S + 3, LANE, Y + gsN * 3]]);
      S += L; Y += gsN * L;
    } else if (kind === 'tunnel') {
      // тоннель: проход вдоль стены под каменной крышей, сбоку — высокая скала
      const L = 12 + rnd() * 6, gs = -(0.03 + rnd() * 0.08), lane = 2.9;
      wide(L, gs, { u1: 9, noRubble: true });
      lobe({ s0: S + 0.6, s1: S + L - 0.6, u0: 4.7, u1: 10.5, sRef: S, yRef: Y + 4.6 + rnd() * 1.2, gs, gs0: gs, T: 10, n: 3.2, bump: 0.35 });
      const nr = 2 + Math.floor(rnd() * 2), rl = (L - 3) / nr;
      for (let k = 0; k < nr; k++) {
        const a0 = S + 1.5 + k * rl;
        lobe({ s0: a0 - 0.3, s1: a0 + rl + 0.3, u0: -2.5, u1: 7.4, sRef: S, yRef: Y + 4.9 + rnd() * 0.5, gs, gs0: gs, T: 2.1, n: 4, bump: 0.2, flat: true });
      }
      const Y1 = Y + gs * L;
      link('tunnel', [[S, lane, Y], [S + L * 0.5, lane, Y + gs * L * 0.5], [S + L, lane, Y1]]);
      S += L; Y = Y1;
    } else if (kind === 'plateau') {
      // большая площадка-передышка между подъёмами: широкая, почти ровная, с уступами-террасами
      const L = 24 + rnd() * 12, gs = -(0.02 + rnd() * 0.05);
      wide(L, gs, { u1: 12 + rnd() * 2.5, bump: 0.45 });
      const nt = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < nt; k++) {
        const sc = S + 5 + rnd() * (L - 10), u = 8 + rnd() * 3, a = 2.5 + rnd() * 2.5, b = 1.6 + rnd() * 1.4;
        lobe({ s0: sc - a, s1: sc + a, u0: u - b, u1: u + b, sRef: sc, yRef: Y + gs * (sc - S) + 1.1 + rnd() * 0.6, gs: 0, gs0: 0, T: 2.5, n: 2.8, bump: 0.15, rubble: true });
      }
      link('plateau', [[S, LANE, Y], [S + L * 0.5, LANE + 1.5, Y + gs * L * 0.5], [S + L, LANE, Y + gs * L]]);
      S += L; Y += gs * L;
    } else if (kind === 'stones') {
      // россыпь маленьких камней над пропастью: прыжки с камня на камень
      const n = 5 + Math.floor(rnd() * 3), wps = [[S - 3, LANE, Y - cs0 * 3]];
      let sc = S + 3, yy = Y, uPrev = LANE, aPrev = 0;
      for (let i = 0; i < n; i++) {
        const a = 1.0 + rnd() * 0.6, b = 1.0 + rnd() * 0.6;
        sc += aPrev + a + (i === 0 ? 1.7 + rnd() * 0.7 : 1.5 + rnd() * 1.0);
        const u = Math.max(2.8, Math.min(6.8, uPrev + (rnd() - 0.5) * 3.4));
        yy += (rnd() - 0.55) * 0.9;
        lobe({ s0: sc - a, s1: sc + a, u0: u - b, u1: u + b, sRef: sc, yRef: yy, gs: 0, gs0: 0, T: 2.2, n: 2.4, bump: 0.05, stone: true });
        wps.push([sc, u, yy]); uPrev = u; aPrev = a;
      }
      S = sc + aPrev + 2.0 + 3; Y = yy - 0.3; cs = 0;
      const L = 14 + rnd() * 8, gsN = -(0.08 + rnd() * 0.16);
      wide(L, gsN);
      wps.push([S + 2.5, LANE, Y + gsN * 2.5]);
      link('stones', wps);
      S += L; Y += gsN * L;
    } else if (kind === 'spur') {
      // боковой мостик: от дорожки вбок, в шахту, на толстую площадку-остров; остров выше моста — на него лезут
      // с борта (хват). С острова второй мостик наискось вперёд-вниз, обратно к дорожке (петля), или тупик.
      const L = 22 + rnd() * 8, gs = -(0.04 + rnd() * 0.1), dead = rnd() < 0.35;
      wide(L, gs, { noRubble: true });
      const sA = S + 5 + rnd() * 3, uIs = 14 + rnd() * 4, yA = Y + gs * (sA - S), rI = 3.6 + rnd() * 1.4, up = 2.3 + rnd() * 0.6;
      const uEdge = 9.2;
      seg(sA, uEdge - 1.0, yA + gs * 0, sA + (rnd() - 0.5) * 3, uIs - rI + 0.6, yA + 0.2, 1.1, { T: 2.6, gs0: 0 });
      const sI = sA + (rnd() - 0.5) * 3;
      lobe({ s0: sI - rI, s1: sI + rI, u0: uIs - rI, u1: uIs + rI, sRef: sI, yRef: yA + 0.2 + up, gs: 0, gs0: 0, T: 5 + rnd() * 3, n: 2.6, bump: 0.2, island: true });
      const wps = [[S - 3, LANE, Y - cs0 * 3], [sA, LANE, yA], [sA, uEdge - 0.5, yA], [sI, uIs - rI - 0.3, yA + 0.2], [sI, uIs, yA + 0.2 + up]];
      if (dead) link('dead', wps);
      else {
        const sB = Math.min(S + L - 3, sI + 9 + rnd() * 5), yB = Y + gs * (sB - S);
        seg(sI + rI * 0.7, uIs - rI * 0.5, yA + 0.2 + up, sB, uEdge - 1.2, yB, 1.1, { T: 2.6, gs0: 0 });
        wps.push([sI + rI * 0.7, uIs - rI * 0.5, yA + 0.2 + up], [sB, uEdge - 1.2, yB], [sB, LANE, yB]);
        link('spur', wps);
      }
      link('wide', [[S - 3, LANE, Y - cs0 * 3], [S + L * 0.5, LANE, Y + gs * L * 0.5], [S + L, LANE, Y + gs * L]]);
      S += L; Y += gs * L;
    } else if (kind === 'dome') {
      // купол: большой округлый валун поперёк дорожки — по нему идут вверх и вниз; крутой купол скользкий
      const L = 11 + rnd() * 4, gs = -(0.03 + rnd() * 0.06), h = 2.0 + rnd() * 1.3;
      wide(L, gs, { noRubble: true, dome: h, bump: 0.15, u1: 9 });
      link('dome', [[S - 3, LANE, Y - cs0 * 3], [S + L * 0.5, LANE, Y + gs * L * 0.5 + h * (1 - (LANE - 3.25) ** 2 / 34)], [S + L, LANE, Y + gs * L]]);
      S += L; Y += gs * L;
    } else if (kind === 'traverse') {
      // траверс: в дорожке разрыв шире прыжка, рядом высокая скала — хватаешься за её грань и
      // перебираешься боком, вися на руках
      const G = 4.2 + rnd() * 0.8, L1 = 7 + rnd() * 3, L2 = 12 + rnd() * 6, gs = -(0.02 + rnd() * 0.05);
      wide(L1, gs, { noRubble: true, u1: 8.5 });
      const sG = S + L1, yG = Y + gs * L1;
      lobe({ s0: sG - 4, s1: sG + G + 4, u0: 5.0, u1: 11, sRef: sG, yRef: yG + 6, gs: 0, gs0: 0, T: 14, n: 3.4, bump: 0.1 });
      lobe({ s0: sG + G, s1: sG + G + L2 + 3, u0: -2.5, u1: 8.5, sRef: sG + G, yRef: yG - 0.2, gs, gs0: gs, bump: 0.3 });
      link('traverse', [[S + 1, LANE, Y + gs], [sG - 0.8, 4.2, yG], [sG + G * 0.5, 4.2, yG - 0.1], [sG + G + 0.8, 4.2, yG - 0.2], [sG + G + 3, LANE, yG - 0.2 + gs * 3]]);
      cs = gs;
      S = sG + G + L2; Y = yG - 0.2 + gs * L2;
    } else if (kind === 'fork') {
      // развилка: внизу широкая глыба, а над ней — «верхняя дорога»: на башню (лезть), по камням, и обратно вниз
      // (или тупик с кристаллами). Две дороги расходятся и сходятся; по верхней — паркур и лазание.
      const dead = rnd() < 0.4, Lf = 26 + rnd() * 10, gs = -(0.06 + rnd() * 0.14), H = 6.5 + rnd() * 2.5;
      const Sm = S, Ym = Y, mainY = (s2) => Ym + gs * (s2 - Sm);
      const startWp = [S - 3, LANE, Y - cs0 * 3];
      wide(Lf, gs, { noRubble: true });
      const tower = (sc, yTop) => lobe({ s0: sc - 2.0, s1: sc + 2.0, u0: 5.2, u1: 8.6, sRef: sc, yRef: yTop, gs: 0, gs0: 0, T: H + 3, n: 2.4, bump: 0.05, tower: true });
      const sA = Sm + 5.5;
      tower(sA, mainY(sA) + H);
      const wps = [startWp, [sA - 1, LANE, mainY(sA - 1)], [sA, 6.9, mainY(sA) + H]];
      let sc = sA + 2.0, uPrev = 6.9, aPrev = 0;
      const sEnd = Sm + Lf - 6;
      for (let guard = 0; guard < 8; guard++) {
        const a = 1.0 + rnd() * 0.5, b = 1.0 + rnd() * 0.4, nextC = sc + aPrev + a + 1.6 + rnd() * 0.9;
        if (nextC + a + 4 > sEnd) break;
        sc = nextC;
        const u = Math.max(5.0, Math.min(7.6, uPrev + (rnd() - 0.5) * 2.4)), yy = mainY(sc) + H + (rnd() - 0.5) * 0.8;
        lobe({ s0: sc - a, s1: sc + a, u0: u - b, u1: u + b, sRef: sc, yRef: yy, gs: 0, gs0: 0, T: 2.2, n: 2.4, bump: 0.05, stone: true });
        wps.push([sc, u, yy]); uPrev = u; aPrev = a;
      }
      const sB = sc + aPrev + 2.0 + 2.2 + rnd() * 0.5;
      if (dead) {
        lobe({ s0: sB - 2.6, s1: sB + 2.6, u0: 4.8, u1: 9.4, sRef: sB, yRef: mainY(sB) + H, gs: 0, gs0: 0, T: 3, n: 2.8, bump: 0.1, view: true });
        wps.push([sB, 7.0, mainY(sB) + H]);
        link('dead', wps);
      } else {
        tower(sB, mainY(sB) + H);
        wps.push([sB, 6.9, mainY(sB) + H], [sB, LANE, mainY(sB)]);
        link('fork', wps);
      }
      // главная дорога внизу — по глыбе
      link('wide', [[S - 3, LANE, Y - cs0 * 3], [S + Lf * 0.5, LANE, mainY(S + Lf * 0.5)], [S + Lf, LANE, mainY(S + Lf)]]);
      S += Lf; Y = mainY(S);
    } else if (kind === 'jump' || kind === 'drop') {
      const gap = kind === 'jump' ? 2.6 + rnd() * 0.8 : 1.6 + rnd() * 1.0, drop = kind === 'jump' ? 0.3 + rnd() * 2.4 : 4 + rnd() * 3.5;
      const s0 = S + 3 + gap, Y1 = Y - drop, L = 12 + rnd() * 8, gs = -(0.05 + rnd() * 0.15);
      lobe({ s0, s1: s0 + L + 3, u0: -2.5, u1: 8.5 + rnd() * 2.5, sRef: s0, yRef: Y1, gs, gs0: gs });
      cs = gs;
      link(kind, [[S - 3.5, LANE, Y - cs0 * 3.5], [s0 + 3, LANE, Y1 + gs * 3]]);
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
  // наклон вдоль оси лопасти (у повёрнутых — вдоль их направления), до точки отсчёта — свой наклон gs0
  const t = (s - l.sRef) * (l.dS ?? 1) + (u - (l.uRef ?? 0)) * (l.dU ?? 0);
  let y = l.yRef + (t < 0 && l.gs0 !== undefined ? l.gs0 : l.gs) * t + l.gu * (u - l.uc);
  const ph = l.ph;
  y += bw * l.bump * (0.5 * Math.sin(s * 0.55 + ph[0]) * Math.cos(u * 0.7 + ph[1]) + 0.35 * Math.sin(s * 1.3 + u * 1.1 + ph[2]));
  if (l.arch) { const t = (s - l.sc) / l.a; y += l.arch * Math.max(0, 1 - t * t); }
  if (l.dome) { const ts = (s - l.sc) / l.a, tu = (u - l.uc) / l.b; y += l.dome * Math.max(0, 1 - ts * ts - tu * tu); }
  return y;
};

function lobeMesh(l, sp, out, rnd) {
  const SEG = l.seg || (l.T < 3 ? 10 : 14), rot = l.rot || 0, cr = Math.cos(rot), sr = Math.sin(rot);
  const sc = l.rot !== undefined ? l.cs : (l.s0 + l.s1) / 2, uc = l.rot !== undefined ? l.cu : (l.u0 + l.u1) / 2;
  const a = l.rot !== undefined ? l.A : (l.s1 - l.s0) / 2, b = l.rot !== undefined ? l.B : (l.u1 - l.u0) / 2;
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
      const s = sc + ds * cr - du * sr, u = uc + ds * sr + du * cr;
      let y = topY(l, s, u, 1 - 0.85 * k * k);
      if (dy === 0 && k > 0.9) y -= 0.1;                                   // скруглённый край
      arr.push({ s, u, y: y - dy });
    }
    return arr;
  };
  // вершины: центр, три кольца сверху, четыре кольца тела
  const cen = { s: sc, u: uc, y: topY(l, sc, uc) };
  const top = [pts(0.38, 0, 1, 1), pts(0.7, 0, 1, 2), pts(1, 0, 1, 3)];
  const body = [[0.18 * l.T, 1.0], [0.55 * l.T, 0.98], [0.92 * l.T, 0.93]].map(([d, sh], ri) => {
    const arr = pts(1, d, sh, 10 + ri);
    return arr.map((p) => ({ ...p, y: p.y - (hash(p.s, ri) - 0.5) * 0.5 }));
  });
  const apexP = { s: sc, u: uc, y: Math.min(...body[2].map((p) => p.y)) - (l.flat ? 0.3 : l.T * 0.08) };   // T — полная глубина тела
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
  const solid = addMeshTop(new Float32Array(topTris), 0.3, { slope: true, climb: true, under: AP[1] + 0.05, roof: !!l.flat });   // низ тела — настоящий низ: под ним проходим, а не упираемся в невидимое
  l.solid = solid; solid.rub = !!l.rubble;
  // габариты для проверок пересечений
  let rad = 0; for (const p of T0[2]) rad = Math.max(rad, Math.hypot(p[0] - C0[0], p[2] - C0[2]));
  l.cx = C0[0]; l.cz = C0[2]; l.rad = rad; l.yTop = Math.max(...T0[2].map((p) => p[1])) + 1; l.yBot = AP[1];
  l.ring = T0[2];
}

// ---------- 3. проверки ----------
function obstacles() {
  const list = [];
  // шапки островов и столбов; тела колонн ниже — отдельные цилиндры, их видит solidsNear
  for (const st of STACKS) list.push([st.x, st.z, st.w * 1.25 + 1.2, st.top + 6, st.top - 8]);
  for (const p of PILLARS) list.push([p.x, p.z, p.w * 1.1 + 1.0, p.top + 3, p.top - 8]);
  return list;
}

// прикидка пересечений без построения мешей: считаем по габаритам лопастей
function roughBounds(lobes, sp) {
  return lobes.map((l) => {
    const sc = (l.s0 + l.s1) / 2, uc = (l.u0 + l.u1) / 2, a = (l.s1 - l.s0) / 2, b = (l.u1 - l.u0) / 2;
    const [cx, cz] = toWorld(sc, Math.max(uc, 3), sp);
    const yMid = l.yRef + l.gs * (sc - l.sRef);
    return { cx, cz, rad: Math.max(a, 2) * 1.0, uVis: Math.max(l.u1 - 1.6, 0), yTop: yMid + Math.abs(l.gs) * a + 1.5, yBot: yMid - Math.abs(l.gs) * a - l.T - 1, l, sp, sc, uc, a, b };
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

// ---------- «Каньон»: спуск через середину шахты ----------
// Острова и столбы стоят колоннами до дна. На колоннах — каменные уступы; между уступами соседних
// колонн — цепочки площадок на столбах и естественные мосты; от дороги вдоль стены к колоннам
// островов перекинуты длинные мосты. Вниз по колонне — с уступа на уступ (они идут винтом) или по её грани.
function buildCanyon(best, out, rnd) {
  const sp = { cart: true, th0: 0, dir: 1 }, links = [], glow = [], stats = { ledges: 0, pole: 0, bridges: 0, wall: 0, runs: 0, fill: 0 };
  const base = (o) => ({ T: 3, n: 2.6, bump: 0.1, arch: 0, gu: 0, gs: 0, gs0: 0, tm: 0, ...o });
  const put = (l) => { lobeMesh(l, sp, out, rnd); return l; };
  const circ = (x, z, a, y, o = {}) => base({ s0: x - a, s1: x + a, u0: z - a, u1: z + a, sRef: x, yRef: y, ...o });
  const ell = (x, z, ang, A, B, y, o = {}) => {
    const es = Math.abs(A * Math.cos(ang)) + Math.abs(B * Math.sin(ang)), eu = Math.abs(A * Math.sin(ang)) + Math.abs(B * Math.cos(ang));
    return base({ rot: ang, cs: x, cu: z, A, B, s0: x - es, s1: x + es, u0: z - eu, u1: z + eu, sRef: x, uRef: z, dS: Math.cos(ang), dU: Math.sin(ang), yRef: y, ...o });
  };
  const segL = (xA, zA, yA, xB, zB, yB, half, o = {}) => {
    const ds = xB - xA, du = zB - zA, len = Math.hypot(ds, du), ang = Math.atan2(du, ds);
    const l = ell((xA + xB) / 2, (zA + zB) / 2, ang, len / 2 + 0.9, half, yA, { T: 1.8, n: 3.2, bump: 0.06, seg: 8, ...o });
    l.sRef = xA; l.uRef = zA; l.gs = l.gs0 = (yB - yA) / len;
    return l;
  };
  // место свободно: нет чужих скал (глыб, шапок островов) ни на уровне тела, ни над головой, ни прямо под уступом
  const free = (x, z, rad, y, T) => {
    if (heightAt(x, z) > y - 1) return false;
    for (let k = 0; k < 17; k++) {
      const a = k * 0.785, rr = k === 0 ? 0 : k <= 8 ? rad : rad * 0.5, px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      for (const yy of [y + 0.3, y + 1.4, y + 2.5, y - T * 0.5, y - T - 0.8, y - T - 2.6]) { const r = rockAt(px, pz, yy); if (r && r.field) return false; }
    }
    return true;
  };
  // уступ на колонне острова: полукруглая полка, вросшая в колонну, выступает в сторону ang
  const ledgeAt = (st, y, ang) => {
    const c = colAt(st, y), A = 2.3 + rnd() * 0.6, B = 2.6 + rnd() * 0.8, dx = Math.cos(ang), dz = Math.sin(ang);
    const x = c.x + dx * (c.r + A * 0.45), z = c.z + dz * (c.r + A * 0.45);
    const T = 2.6 + rnd() * 1.6;
    if (!free(x + dx * A * 0.4, z + dz * A * 0.4, Math.max(A, B) * 0.9, y, T * 1.1)) return null;
    return { st, y, ang, x, z, A, B, T, ex: c.x + dx * (c.r + A * 1.35), ez: c.z + dz * (c.r + A * 1.35), mx: c.x + dx * (c.r + A * 0.8), mz: c.z + dz * (c.r + A * 0.8) };
  };
  const buildLedge = (L) => {
    put(ell(L.x, L.z, L.ang, L.A, L.B, L.y, { T: L.T, n: 2.5, bump: 0.12, seg: 10 }));
    (L.st._ledges || (L.st._ledges = [])).push(L);
    stats.ledges++;
    if (rnd() < 0.4) glow.push([L.mx + (rnd() - 0.5), L.y, L.mz + (rnd() - 0.5)]);
    return L;
  };
  for (const st of STACKS) st._ledges = [];

  // 1) мосты от дороги вдоль стены к колоннам островов
  const wsp = best.spines[0];
  for (const lk of wsp.plan.links) {
    if (lk.kind !== 'wide' && lk.kind !== 'plateau') continue;
    for (const w of lk.wps) {
    let E = null;
    for (let u = w[1]; u <= 17; u += 0.4) { const [x, z] = toWorld(w[0], u, wsp), g = groundAt(x, z, w[2] + 0.6); if (Math.abs(g - w[2]) < 1.6) E = [x, z, g, u]; else if (E) break; }
    if (!E) continue;
    let bst = null, bd = 1e9;
    for (const st of STACKS) { const c = colAt(st, E[2]); const d = Math.hypot(E[0] - c.x, E[1] - c.z) - c.r; if (d < bd && E[2] < st.top - 8) { bd = d; bst = st; } }
    if (!bst || bd < 6 || bd > 24 || bst._ledges.some((q) => Math.abs(q.y - E[2]) < 7)) continue;
    const c = colAt(bst, E[2]), ang = Math.atan2(E[1] - c.z, E[0] - c.x), L = ledgeAt(bst, E[2] - 0.2 - rnd() * 0.6, ang);
    if (!L) continue;
    const [ax, az] = toWorld(w[0], E[3] - 1.3, wsp), ya = groundAt(ax, az, E[2] + 0.6);
    let ok = true;
    for (const f of [0.3, 0.5, 0.7]) ok = ok && free(ax + (L.ex - ax) * f, az + (L.ez - az) * f, 1.3, ya + (L.y - ya) * f, 2.2);
    if (!ok) continue;
    buildLedge(L);
    put(segL(ax, az, ya, L.mx, L.mz, L.y, 1.15 + rnd() * 0.3, { T: 2.2 }));
    stats.wall++; stats.bridges++;
    const [lx, lz] = toWorld(w[0], w[1], wsp);
    links.push({ kind: 'xbridge', wps: [[lx, w[2], lz], [ax, ya, az], [L.mx, L.y, L.mz]] });
    }
  }

  // 2) цепочки площадок на столбах между островами, на нескольких уровнях; уровни чередуют направление
  CHAINS.forEach((chain, ci) => {
    const poles0 = chain.slice(1, -1).filter((p) => !isHanging(p));
    if (poles0.length < 2) return;
    let lvl = 0;
    for (let y0 = -34 - rnd() * 14; y0 > FLOOR + 12; y0 -= 26 + rnd() * 10, lvl++) {
      const rev = (lvl + ci) % 2 === 1, poles = rev ? poles0.slice().reverse() : poles0, side = rnd() < 0.5 ? 1 : -1;
      const A = rev ? chain.B : chain.A, B = rev ? chain.A : chain.B, dl = 0.3 + rnd() * 0.45;
      let nodes = null;
      for (let attempt = 0; attempt < 4 && !nodes; attempt++) {
        const yb = y0 - attempt * 3.2, arr = [];
        let good = true;
        for (let k = 0; k < poles.length && good; k++) {
          const y = yb - (k + 1) * dl + (rnd() - 0.5) * 0.15, c = colAt(poles[k], y), nb = poles[Math.min(poles.length - 1, k + 1)], pv = poles[Math.max(0, k - 1)];
          let tx = nb.x - pv.x, tz = nb.z - pv.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          const a = 1.45 + rnd() * 0.4, x = c.x - tz * side * (c.r + 1.0), z = c.z + tx * side * (c.r + 1.0);
          good = free(x, z, a, y, 1.8);
          arr.push({ x, z, y, a });
        }
        if (good) nodes = arr;
      }
      if (!nodes) continue;
      const wps = [];
      const end = (st, toward, y) => {
        if (!st || st.ring || st.pillar) return null;
        const c = colAt(st, y), L = ledgeAt(st, y, Math.atan2(toward.z - c.z, toward.x - c.x));
        return L ? buildLedge(L) : null;
      };
      const LA = end(A, nodes[0], nodes[0].y + dl + 0.1), LB = end(B, nodes[nodes.length - 1], nodes[nodes.length - 1].y - dl);
      for (const n of nodes) { put(circ(n.x, n.z, n.a, n.y, { T: 1.6, n: 2.3, bump: 0.05, seg: 8 })); stats.pole++; }
      const span = (x1, z1, y1, r1, x2, z2, y2, r2) => {
        const d = Math.hypot(x2 - x1, z2 - z1), g = d - r1 - r2;
        if (g < 2.3) return;
        const ux = (x2 - x1) / d, uz = (z2 - z1) / d;
        put(segL(x1 + ux * (r1 - 0.5), z1 + uz * (r1 - 0.5), y1, x2 - ux * (r2 - 0.5), z2 - uz * (r2 - 0.5), y2, 0.75 + rnd() * 0.2, { T: 1.4 }));
        stats.bridges++;
      };
      if (LA) { wps.push([LA.mx, LA.y, LA.mz]); span(LA.mx, LA.mz, LA.y, LA.A * 0.55, nodes[0].x, nodes[0].z, nodes[0].y, nodes[0].a); }
      nodes.forEach((n, k) => { wps.push([n.x, n.y, n.z]); const m = nodes[k + 1]; if (m) span(n.x, n.z, n.y, n.a, m.x, m.z, m.y, m.a); });
      const ln = nodes[nodes.length - 1];
      if (LB) { span(ln.x, ln.z, ln.y, ln.a, LB.mx, LB.mz, LB.y, LB.A * 0.55); wps.push([LB.mx, LB.y, LB.mz]); }
      links.push({ kind: 'run', wps });
      stats.runs++;
    }
  });

  // 3) винтовые уступы на колоннах островов: чтобы с любого уступа было куда спуститься ниже
  STACKS.forEach((st, si) => {
    const dirn = si % 2 ? 1 : -1;
    const list = st._ledges.slice().sort((a, b) => b.y - a.y);
    let prev = { y: st.top, ang: rnd() * TAU, top: true }, qi = 0;
    for (let guard = 0; guard < 60; guard++) {
      while (qi < list.length && list[qi].y > prev.y - 3) qi++;
      const next = list[qi], floorY = heightAt(st.x, st.z) + 2.5, ny = next ? next.y : floorY;
      if (prev.y - ny <= 8.5) { if (!next) break; prev = next; qi++; continue; }
      const y = prev.y - (5.2 + rnd() * 1.6), c = colAt(st, y), Rc = c.r + 1.2;
      const dA = 2 * Math.asin(Math.min(0.95, 3.6 / Rc));
      let L = null;
      for (let t = 0; t < 7 && !L; t++) L = ledgeAt(st, y - t * 0.3, prev.ang + dirn * (dA + t * 0.45));
      if (!L) { prev = { y: y - 1, ang: prev.ang + 1 }; continue; }
      buildLedge(L); stats.fill++;
      if (!prev.top && prev.mx !== undefined) links.push({ kind: 'drop', wps: [[prev.mx, prev.y, prev.mz], [prev.ex, prev.y, prev.ez], [L.ex, L.y, L.ez], [L.mx, L.y, L.mz]] });
      prev = L;
    }
  });
  return { links, glow, stats };
}

export function buildDescent(scene) {
  const t0 = Date.now();
  const obs = obstacles();
  // входы: ровные места нижнего уступа
  const ringAt = (th) => {
    const rw = rwAt(th), c = Math.cos(th), s = Math.sin(th), y = heightAt(c * (rw + 4), s * (rw + 4));
    const flat = [2.5, 4, 6].every((d) => Math.abs(heightAt(c * (rw + d), s * (rw + d)) - y) < 1.2);
    return flat && !solidsNear(c * (rw + 3.5), s * (rw + 3.5), 3).length ? y : null;
  };
  // Кандидат раскладки: число маршрутов, семя, сдвиг угла. Строим по-настоящему и проверяем пути героя:
  // нигде на дорожке не должно быть чужой скалы (острова, столбы, другие витки и маршруты).
  const owner = new Map();
  const blocked = (cand) => {
    let bad = 0;
    cand.spines.forEach((sp, si) => {
      for (const lk of sp.plan.links) {
        // на всём пути (ноги, торс, голова) не должно быть чужой скалы — другого витка или маршрута
        {
          let foreign = false;
          for (let q = 0; q + 1 < lk.wps.length && !foreign; q++) {
            const A = lk.wps[q], B = lk.wps[q + 1], n = Math.max(1, Math.ceil(Math.abs(B[0] - A[0])));
            for (let k = 0; k <= n && !foreign; k++) {
              const f = k / n, [x, z] = toWorld(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, sp), y = A[2] + (B[2] - A[2]) * f;
              for (const dy of [0.3, 1.0, 1.8]) {
                const rk = rockAt(x, z, y + dy), ow = rk && owner.get(rk);
                if (rk && !rk.rub && ow && (ow.si !== si || Math.abs(ow.tm - lk.tm) > 1)) { foreign = ow.si + ':' + ow.tm; break; }
              }
            }
          }
          if (foreign) { bad++; (DBG.bk = DBG.bk || []).push('sp' + si + ' ' + lk.kind + ':' + lk.tm + ' foreign ' + foreign); continue; }
        }
        if (!['wide', 'passage', 'arch', 'bridge', 'entry'].includes(lk.kind)) {
          // у остальных (лазание, камни…) путь не по прямой: смотрим только концы
          for (const w of [lk.wps[0], lk.wps[lk.wps.length - 1]]) {
            const [x, z] = toWorld(w[0], w[1], sp);
            if (groundAt(x, z, w[2] + 0.4) > w[2] + 2.3) { bad++; break; }
            if (w === lk.wps[0]) { const rk = rockAt(x, z, w[2] + 0.9); if (rk && !rk.rub) { bad++; break; } }
          }
          continue;
        }
        let gPrev = null;
        for (let q = 0; q + 1 < lk.wps.length; q++) {
          const A = lk.wps[q], B = lk.wps[q + 1], d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
          for (let t = 0; t <= d; t += 1.0) {
            const f = t / d, [x, z] = toWorld(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, sp), y = A[2] + (B[2] - A[2]) * f;
            const g = groundAt(x, z, y + 0.4);
            // ступенька выше 0.9 м на дорожке (стык двух глыб на разной высоте) — упрёшься в стену
            if (gPrev !== null && g - gPrev > 1.6 && !(lastSolid && lastSolid.rub)) { bad++; (DBG.bk = DBG.bk || []).push(lk.kind + ':' + lk.tm + ' step@' + Math.round(y)); break; }
            gPrev = g;
            if (g > y + 2.3) { bad++; { let who = '?'; cand.spines.forEach((sp2, si2) => sp2.plan.lobes.forEach((l2) => { if (l2.solid === lastSolid) who = 'sp' + si2 + ' tm' + l2.tm + ' T' + l2.T.toFixed(0) + ' y' + l2.yRef.toFixed(0); })); (DBG.bk = DBG.bk || []).push(lk.kind + ':' + lk.tm + ' ' + (g - y).toFixed(1) + '@' + Math.round(y) + ' by ' + who); } break; }
          }
        }
      }
    });
    return bad;
  };
  const mkCand = (NSP, k, ai) => {
    const a = ai * 0.3, angs = Array.from({ length: NSP }, (_, i) => a + (i * TAU) / NSP + (i ? (hash(k, 3 + i) - 0.5) * 0.5 : 0)), ys = angs.map(ringAt);
    if (ys.some((y) => y === null)) return null;
    const dir = hash(k, 7) < 0.5 ? 1 : -1, rnd = mulberry32(SEED + 9001 + k * 977 + ai * 31);
    return { NSP, k, ai, spines: angs.map((th0, i) => ({ th0, dir, plan: makeSpine(rnd, ys[i]) })) };
  };
  const tryCand = (cand) => {
    const rnd = mulberry32(SEED + 9002), o = { pos: [] };
    owner.clear();
    cand.spines.forEach((sp, si) => { for (const l of sp.plan.lobes) { l.si = si; lobeMesh(l, sp, o, rnd); owner.set(l.solid, { si, tm: l.tm }); } });
    cand.bad = blocked(cand); cand.out = o;
    return cand;
  };
  const off = (cand) => { for (const sp of cand.spines) for (const l of sp.plan.lobes) l.solid.off = true; };
  // dev: перебор раскладок (window.__descScan) — какие проходят проверку; удачную запоминаем в PICKED
  if (typeof window !== 'undefined' && window.__descScan) {
    const res = [];
    for (const NSP of (window.__descNsp ? [window.__descNsp] : [1])) for (let k = 0; k < 14; k++) for (let ai = 0; ai < Math.ceil(TAU / NSP / 0.3); ai++) {
      const c = mkCand(NSP, k, ai); if (!c) continue;
      tryCand(c); res.push([NSP, k, ai, c.bad, c.spines.reduce((q, s2) => q + s2.plan.lobes.length, 0)]); off(c);
    }
    window.__descScanResult = res;
    return DESCENT;
  }
  let best = null, out = null, tried = 0;
  const tryList = [];
  const PK = (typeof window !== 'undefined' && window.__descPicked) || PICKED;
  if (PK) tryList.push(PK);
  for (const NSP of [1]) for (let k = 0; k < 6; k++) for (let ai = 0; ai < Math.ceil(TAU / NSP / 0.3); ai++) tryList.push([NSP, k, ai]);
  for (const [NSP, k, ai] of tryList.slice(0, PK ? 80 : 120)) {
    const c = mkCand(NSP, k, ai); if (!c) continue;
    tried++;
    tryCand(c);
    if (c.bad === 0) { best = c; out = c.out; best.k = k; best.c = 0; break; }
    off(c);
  }
  if (!best) return DESCENT;
  const cany = buildCanyon(best, out, mulberry32(SEED + 9004));
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
      if (l.T < 4 || l.rot !== undefined || l.flat || r3() < 0.5) continue;
      const c = 1 + (r3() < 0.4 ? 1 : 0);
      for (let k = 0; k < c; k++) {
        const s = l.s0 + 2 + r3() * (l.s1 - l.s0 - 4), u = Math.max(l.u1 - 1.4 - r3() * 2, 2.5);
        const [x, z] = toWorld(s, u, sp), y = topY(l, s, u), h = 0.7 + r3() * 1.2;
        col.setHSL(0.52 + r3() * 0.28, 0.7, 0.66);
        cry.push(part(oct, col.getHex(), { glow: 0.85, m: T(x, y + h * 0.7, z, 0.28 * h, h, 0.28 * h, r3() * 6) }));
      }
    }
  });
  for (const [x, y, z] of cany.glow) { const h = 0.6 + r3() * 0.9; col.setHSL(0.5 + r3() * 0.3, 0.7, 0.66); cry.push(part(oct, col.getHex(), { glow: 0.85, m: T(x, y + h * 0.7, z, 0.26 * h, h, 0.26 * h, r3() * 6) })); }
  if (cry.length) {
    const cm = new THREE.Mesh(merge(cry), propMaterial());
    cm.frustumCulled = false; cm.matrixAutoUpdate = false;
    scene.add(cm);
  }
  // звенья для проверки ботом: пути героя в мировых координатах
  const links = [];
  best.spines.forEach((sp, si) => {
    for (const lk of sp.plan.links) {
      // точки пути — вдоль дорожки (она повторяет изгибы стены), а не по хорде между концами
      const dense = [];
      lk.wps.forEach((a, i) => {
        const b = lk.wps[i + 1];
        if (!b) { dense.push(a); return; }
        const n = Math.max(1, Math.ceil(Math.abs(b[0] - a[0]) / 3));
        for (let k = 0; k < n; k++) { const f = k / n; dense.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]); }
      });
      links.push({ si, kind: lk.kind, tm: lk.tm, wps: dense.map(([s2, u, y]) => { const [x, z] = toWorld(s2, u, sp); return [x, y, z]; }) });
    }
  });
  for (const lk of cany.links) links.push({ si: 9, kind: lk.kind, tm: 0, wps: lk.wps });
  DESCENT.canyon = cany.stats;
  DESCENT.lobes = best.spines.flatMap((sp) => sp.plan.lobes.map((l) => ({ si: l.si, tm: l.tm, cx: l.cx, cz: l.cz, rad: l.rad, yTop: l.yTop, yBot: l.yBot, T: l.T, rubble: !!l.rubble, tower: !!l.tower, solid: l.solid })));
  Object.assign(DESCENT, { spines: best.spines.map((s) => ({ th0: s.th0, dir: s.dir, n: s.plan.lobes.length, endY: s.plan.Y })), links, ready: true,
    stats: { ms: Date.now() - t0, conflicts: 0, blocked: best.bad, tried, nsp: best.NSP, seed: best.k, lobes: best.spines.reduce((q, s) => q + s.plan.lobes.length, 0), links: links.length, tris: out.pos.length / 9 } });
  return DESCENT;
}
