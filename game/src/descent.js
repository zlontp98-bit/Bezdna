import * as THREE from '../vendor/three.min.js';
import { W, heightAt, pitR, rockMat } from './terrain.js';
import { addMeshTop, solidsNear } from './solids.js';
import { STACKS, PILLARS } from './stacks.js';
import { mulberry32, SEED } from './noise.js';
import { part, merge, T, propMaterial } from './flora.js';

// Спуск в бездну — отдельный участок поверх шахты (остальную карту не трогает).
//
// В шахте висит сеть каменных площадок («столбов»), как в каньонах Peak: у стен и посреди пропасти,
// на разной глубине. Площадки связаны переходами:
//   • мост  — деревянный настил (можно идти в обе стороны), почти ровный;
//   • рампа — каменная плита с подъёмом/спуском до ~25°: тоже в обе стороны;
//   • прыжок — разрыв, который перепрыгивают; вниз можно прыгнуть дальше, чем вверх.
//   • «скользкий камень» — наклонный камешек (≈55°): встать на него нельзя, скользишь и летишь к площадке ниже.
// Сеть растёт из нескольких «входов» на нижнем уступе вокруг шахты (спускаться можно с любой стороны).
// Ветки растут вглубь, но часть из них заканчивается тупиком, а часть уводит в сторону или вверх:
// чтобы спуститься, иногда нужно вернуться и найти другой путь. Лишние связи, если две площадки
// оказались в пределах прыжка, добавляются сами — получается сеть, а не одна дорога.
// Всё строится по семени (одинаково у всех игроков). Проходимость каждого перехода
// проверяется ботом на настоящей физике героя (dev-скрипт), а достижимость дна — обходом графа здесь.

const TAU = Math.PI * 2;
export const DBG = {};
const bump = (k) => { DBG[k] = (DBG[k] || 0) + 1; return false; };
export const DESCENT = { nodes: [], edges: [], roots: [], stats: {}, ready: false };

// Сколько героя «хватает» на прыжок: расстояние от края до края по разности высот dy (м).
// Вниз летим дальше (чем глубже, тем дальше), вверх — почти нет.
export const JUMP = { base: 3.3, k: 0.5, up: 0.9, minGap: 2.4 };
export const jumpReach = (dy) => (dy >= 0 ? JUMP.base - 1.0 * Math.min(1, dy / 0.9) : JUMP.base + JUMP.k * Math.sqrt(Math.min(-dy, 16)));

const FLOOR = -(W.LOW + W.DEEP);   // дно шахты
const BODY = 8;                   // насколько вглубь висит тело площадки (для проверок на пересечения)
const BOTTOM_Y = FLOOR + 18;       // ниже — «дошли», дальше прыжок на дно
const rwAt = (x, z) => pitR(x, z);
// Шахта разбита на «этажи» по DH метров. Вниз на следующий этаж можно спрыгнуть только с «ворот» —
// верхних 2.5 м этажа, а приземляешься в нижней части нового этажа: чтобы идти дальше вниз,
// надо подняться по рампам к воротам. Так спуск — не лестница, а поиск пути (и вверх, и вниз).
const TOP0 = -46.5, DH = 10;
const deckIdx = (y) => Math.floor((TOP0 - y) / DH);
const topOf = (y) => TOP0 - DH * deckIdx(y);
const isGate = (y) => topOf(y) - y < 2.5;

// всё, что стоит в шахте столбом и мешало бы площадкам: [x, z, радиус, верх, низ]
function obstacles() {
  const list = [];
  for (const st of STACKS) list.push([st.x, st.z, st.w * 1.25 + 1.2, st.top + 6, st.top - (st.big ? 340 : 140)]);
  for (const p of PILLARS) list.push([p.x, p.z, p.w * 1.1 + 1.0, p.top + 3, p.top - 80]);
  return list;
}

function grow(seed, obs, ringY) {
  const rnd = mulberry32(seed);
  const nodes = [], edges = [], segs = [];
  // расстояние от точки до отрезка в плане
  const dSeg = (x, z, a) => { const dx = a.bx - a.ax, dz = a.bz - a.az, t = Math.max(0, Math.min(1, ((x - a.ax) * dx + (z - a.az) * dz) / (dx * dx + dz * dz))); return Math.hypot(a.ax + dx * t - x, a.az + dz * t - z); };
  const okNode = (x, z, y, rr, root) => {
    const rc = Math.hypot(x, z);
    if (!root && rc + rr > rwAt(x, z) + 0.3) return bump('wall');   // не за стенкой шахты
    if (y < FLOOR + 3 || (!root && y > ringY - 0.5)) return false;
    for (const n of nodes) {
      if (Math.abs(n.y - y) < BODY + 1 && Math.hypot(n.x - x, n.z - z) < rr + n.r + 2.3) return bump('near');
    }
    for (const a of segs) if (!a.jump && y < a.ymax + 8.3 && y > a.ymin - 3 && dSeg(x, z, a) < rr + 2.0) return bump('seg');
    for (const o of obs) {
      if (y + 1 > o[4] && y - BODY < o[3] && (x - o[0]) ** 2 + (z - o[1]) ** 2 < (o[2] + rr + 0.6) ** 2) return bump('obs');
    }
    for (const b of solidsNear(x, z, rr + 1)) {
      if (b.top > y - BODY && (b.bottom < -1e8 ? heightAt(b.x, b.z) : b.bottom) < y + 8) return bump('solid');
    }
    return true;
  };
  const add = (x, z, y, r, kind, line) => { const n = { id: nodes.length, x, z, y, r, kind, L: 4 + rnd() * 3, root: line }; nodes.push(n); return n; };

  // новая площадка рядом с A: перебираем стороны по кругу (начиная со случайной, чаще — внутрь шахты)
  const place = (A, kind, dy, g, line, tries = 16) => {
    const rr = 2.7 + Math.pow(rnd(), 1.6) * 2.5, y = A.y + dy;
    const a0 = Math.atan2(-A.z, -A.x) + (rnd() - 0.5) * TAU * 0.7, dist = A.r + g + rr;
    for (let t = 0; t < tries; t++) {
      const phi = a0 + (t % 2 ? 1 : -1) * Math.ceil(t / 2) * (TAU / tries);
      const x = A.x + Math.cos(phi) * dist, z = A.z + Math.sin(phi) * dist;
      if (!okNode(x, z, y, rr, false)) continue;
      const seg = { ax: A.x, az: A.z, bx: x, bz: z, y: (A.y + y) / 2, ymin: Math.min(A.y, y), ymax: Math.max(A.y, y) };
      // на пути (прыжка или перехода) не должно быть чужих площадок на этой высоте
      if (nodes.some((n) => n !== A && n.y > seg.ymin - 3 && n.y < seg.ymax + (kind === 'jump' ? 3 : 8.3) && dSeg(n.x, n.z, seg) < n.r + 1.6)) { bump('segnode'); continue; }
      // столбы и острова не должны оказаться на пути
      const yLo = Math.min(A.y, y) - 2, yHi = Math.max(A.y, y) + 4;
      if (obs.some((o) => yHi > o[4] && yLo < o[3] && dSeg(o[0], o[1], seg) < o[2] + 1.2)) { bump('segobs'); continue; }
      // мосты, рампы и прыжки не пересекаются между собой (на близкой высоте): иначе встаёшь на чужой переход
      {
        let cross = false;
        const len = Math.hypot(x - A.x, z - A.z), q0 = kind === 'jump' ? A.r + 0.4 : A.r + 1.8, q1 = kind === 'jump' ? len - rr - 0.4 : len - 1.8;
        for (let q = q0; q <= q1 && !cross; q += 0.9) { const px = A.x + (x - A.x) * (q / len), pz = A.z + (z - A.z) * (q / len); for (const o of segs) if (Math.abs(o.y - seg.y) < 7 && dSeg(px, pz, o) < (kind === 'jump' || o.jump ? 2.0 : 1.7)) { cross = true; break; } }
        if (cross) { bump('segcross'); continue; }
        seg.jump = kind === 'jump';
        segs.push(seg);
      }
      const B = add(x, z, y, rr, kind, line);
      edges.push({ a: A.id, b: B.id, kind, bi: kind !== 'jump' || dy > -0.9, dy, gap: g });
      return B;
    }
    return null;
  };
  const step = (A, kind, dy, line) => {
    for (let k = 0; k < 8; k++) {
      let g;
      if (kind === 'bridge') g = 5.5 + rnd() * 6.5;
      else if (kind === 'ramp') g = Math.max(8, Math.abs(dy) * 3.4) + rnd() * 4;
      else g = 2.5 + rnd() * (Math.min(4.8, jumpReach(dy) - 0.25) - 2.5);
      const B = place(A, kind, dy, g, line);
      if (B) return B;
    }
    return null;
  };

  // входы: ровные места нижнего уступа вокруг шахты — площадка вровень с уступом, герой просто заходит на неё
  const NR = 5, lines = [];
  for (let i = 0; i < NR; i++) {
    for (let tries = 0; tries < 40; tries++) {
      const th = ((i + 0.15 + rnd() * 0.7) / NR) * TAU, c = Math.cos(th), sn = Math.sin(th);
      const rw = rwAt(c * W.PIT, sn * W.PIT), rr = 3.6 + rnd() * 1.6;
      const ry = heightAt(c * (rw + 4), sn * (rw + 4));
      const flat = [2.5, 4, 6].every((d) => Math.abs(heightAt(c * (rw + d), sn * (rw + d)) - ry) < 1.2);
      if (!flat || solidsNear(c * (rw + 3.5), sn * (rw + 3.5), 3).length) continue;
      const rc = rw + 1.1 - rr, x = c * rc, z = sn * rc;
      if (!okNode(x, z, ry - 0.04, rr, true)) continue;
      const n = add(x, z, ry - 0.04, rr, 'root', i);
      lines.push({ cur: n, alive: true });
      break;
    }
  }
  if (lines.length < 3) return null;

  // этаж за этажом, по очереди для каждой линии: от места приземления — путь к «воротам» (с подъёмом),
  // по дороге — тупиковые ответвления; от ворот — прыжок на следующий этаж
  for (let deck = 0; deck < 30; deck++) {
    const top = TOP0 - DH * deck;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (!L.alive || L.cur.y < BOTTOM_Y) continue;
      const n0 = nodes.length, e0 = edges.length, s0 = segs.length;
      let E = null;
      for (let attempt = 0; attempt < 8 && !E; attempt++) {
        nodes.length = n0; edges.length = e0; segs.length = s0;
        const path = [L.cur];
        let cur = L.cur;
        const gateY = top - (0.3 + rnd() * 1.5);
        let guard = 0;
        while (cur.y < gateY - 0.05 && guard++ < 8) {
          const need = gateY - cur.y;
          let B;
          if (rnd() < 0.3) B = step(cur, 'bridge', (rnd() - 0.5) * 0.8, li);          // вдоль этажа
          else if (need > 0.9) B = step(cur, 'ramp', Math.min(need, 1.6 + rnd() * 2.9), li);
          else B = step(cur, 'jump', need, li);
          if (!B) break;
          cur = B; path.push(B);
        }
        if (cur.y < gateY - 0.05) continue;
        // тупики: короткие ответвления в стороны
        for (let k = 0, nb = 1 + (rnd() < 0.6 ? 1 : 0); k < nb; k++) {
          let P = path[Math.floor(rnd() * path.length)];
          for (let m = 0, len = 1 + Math.floor(rnd() * 2); m < len; m++) {
            const kind = ['bridge', 'jump', 'ramp'][Math.floor(rnd() * 3)];
            const dy = kind === 'ramp' ? -(1.6 + rnd() * 2.5) : kind === 'jump' ? -(0.5 + rnd() * 2.5) : (rnd() - 0.5) * 0.8;
            if (P.y + dy < top - DH + 0.8) break;
            const B = step(P, kind, dy, li);
            if (!B) break;
            P = B;
          }
        }
        cur.gate = true;
        // прыжок вниз с ворот на следующий этаж: приземляемся в нижней части нового этажа
        for (let k = 0; k < 6 && !E; k++) {
          const dy = top - DH - (4 + rnd() * 3) - cur.y;
          E = place(cur, 'jump', dy, 2.6 + rnd() * 2.0, li, 16);
        }
      }
      if (!E) { nodes.length = n0; edges.length = e0; segs.length = s0; L.alive = false; continue; }
      L.cur = E;
    }
  }

  // лишние связи: любая пара площадок, которые и так достаются прыжком, — это тоже маршрут
  for (const A of nodes) for (const B of nodes) {
    if (A === B) continue;
    const dy = B.y - A.y;
    if (dy > JUMP.up || dy < -16) continue;
    const g = Math.hypot(A.x - B.x, A.z - B.z) - A.r - B.r;
    if (g < JUMP.minGap || g > jumpReach(dy) - 0.25) continue;
    const cor = { ax: A.x, az: A.z, bx: B.x, bz: B.z };
    if (nodes.some((n) => n !== A && n !== B && n.y > Math.min(A.y, B.y) - 3 && n.y < Math.max(A.y, B.y) + 3 && dSeg(n.x, n.z, cor) < n.r + 1.6)) continue;
    if (obs.some((o) => Math.max(A.y, B.y) + 4 > o[4] && Math.min(A.y, B.y) - 2 < o[3] && dSeg(o[0], o[1], cor) < o[2] + 1.2)) continue;
    if (segs.some((o) => Math.abs(o.y - (A.y + B.y) / 2) < 7 && [0.3, 0.5, 0.7].some((f) => dSeg(A.x + (B.x - A.x) * f, A.z + (B.z - A.z) * f, o) < 1.5))) continue;
    if (edges.some((e) => (e.a === A.id && e.b === B.id) || (e.a === B.id && e.b === A.id))) continue;
    edges.push({ a: A.id, b: B.id, kind: 'jump', bi: dy > -0.9, dy, gap: g, extra: true });
  }
  return { nodes, edges, roots: lines.map((l) => nodes.find((n) => n.root === nodes[l.cur.id].root && n.kind === 'root')) };
}

// какие площадки достижимы из входа: обход графа с учётом односторонних прыжков вниз
function reach(nodes, edges, from) {
  const adj = nodes.map(() => []);
  for (const e of edges) { adj[e.a].push([e.b, e.dy > 0.6 ? 1 : 0]); if (e.bi) adj[e.b].push([e.a, e.dy < -0.6 ? 1 : 0]); }
  const dist = new Array(nodes.length).fill(Infinity); dist[from] = 0;
  const q = [from];
  while (q.length) {
    const i = q.shift();
    for (const [j, up] of adj[i]) { if (dist[j] > dist[i] + 1) { dist[j] = dist[i] + 1; q.push(j); } }
  }
  return dist;
}

// «подъёмов» по пути: насколько путь вниз заставляет идти вверх (обход Дейкстры с весом шага вверх)
function upCount(nodes, edges, from) {
  const adj = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push([e.b, e.dy > 0.9 ? e.dy : 0]);
    if (e.bi) adj[e.b].push([e.a, e.dy < -0.9 ? -e.dy : 0]);
  }
  const rise = new Array(nodes.length).fill(Infinity); rise[from] = 0;
  const done = new Array(nodes.length).fill(false);
  for (;;) {
    let i = -1;
    for (let k = 0; k < nodes.length; k++) if (!done[k] && rise[k] < Infinity && (i < 0 || rise[k] < rise[i])) i = k;
    if (i < 0) break;
    done[i] = true;
    for (const [j, w] of adj[i]) if (rise[j] > rise[i] + w) rise[j] = rise[i] + w;
  }
  return rise;
}

// ---------- геометрия ----------
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

function pushTri(out, a, b, c, hint) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { const t = b; b = c; c = t; }
  out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

// Площадка: неровная вершина-многоугольник, сверху плоско, бока рёбристые, книзу сужается в «сосульку».
function platform(n, out, rnd) {
  const SEG = 10, a0 = rnd() * TAU;
  const rings = [[0, 1.0], [-1.0, 1.03], [-3.5, 0.9], [-8, 0.78], [-n.L * 0.6, 0.5]];
  const ptsAt = (dy, k, ri) => {
    const arr = [];
    for (let i = 0; i < SEG; i++) {
      const a = a0 + (i / SEG) * TAU;
      let rr = n.r * k * (0.9 + 0.2 * hash(n.id * 3.1 + i, ri * 7.7));
      let x = n.x + Math.cos(a) * rr, z = n.z + Math.sin(a) * rr;
      const rw = rwAt(x, z);
      if (Math.hypot(x, z) > rw - 0.4) { const f = (rw + 1.8) / Math.hypot(x, z); x *= f; z *= f; } // у стенки — вдавлена в породу
      arr.push([x, n.y + dy + (dy === 0 ? (hash(i, n.id) - 0.5) * 0.08 : 0), z]);
    }
    return arr;
  };
  const R = rings.map(([dy, k], ri) => ptsAt(dy, k, ri));
  const apex = [n.x, n.y - n.L - 2.5, n.z], cen = [n.x, n.y + 0.04, n.z];
  const UP = [0, 1, 0], DN = [0, -1, 0], top = [];
  for (let i = 0; i < SEG; i++) {
    const i1 = (i + 1) % SEG;
    pushTri(out, cen, R[0][i], R[0][i1], UP);
    top.push(cen[0], cen[1], cen[2], R[0][i][0], R[0][i][1], R[0][i][2], R[0][i1][0], R[0][i1][1], R[0][i1][2]);
    for (let j = 0; j + 1 < R.length; j++) {
      const mid = [(R[j][i][0] + R[j][i1][0]) / 2 - n.x, 0, (R[j][i][2] + R[j][i1][2]) / 2 - n.z];
      pushTri(out, R[j][i], R[j][i1], R[j + 1][i1], mid);
      pushTri(out, R[j][i], R[j + 1][i1], R[j + 1][i], mid);
    }
    pushTri(out, R[R.length - 1][i], R[R.length - 1][i1], apex, DN);
  }
  addMeshTop(new Float32Array(top), 0.3, { under: n.y - 7 });
}

// Переход-плита (рампа): призма от края площадки A до края B, верх — наклонный
function slab(A, B, w, out, rnd) {
  const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), ux = dx / d, uz = dz / d, px = -uz, pz = ux;
  const s0 = A.r - 0.7, s1 = d - B.r + 0.7;
  const pt = (s, o, y) => [A.x + ux * s + px * o, y, A.z + uz * s + pz * o];
  const yA = A.y, yB = B.y, T = 1.1;
  const yAt = (s) => yA + (yB - yA) * ((s - 0) / d);
  const y0 = yAt(s0) , y1 = yAt(s1);
  const t = [pt(s0, -w / 2, y0), pt(s0, w / 2, y0), pt(s1, w / 2, y1), pt(s1, -w / 2, y1)];
  const bo = [pt(s0 + 0.4, -w / 2 + 0.2, y0 - T), pt(s0 + 0.4, w / 2 - 0.2, y0 - T), pt(s1 - 0.4, w / 2 - 0.2, y1 - T), pt(s1 - 0.4, -w / 2 + 0.2, y1 - T)];
  const UP = [0, 1, 0];
  pushTri(out, t[0], t[1], t[2], UP); pushTri(out, t[0], t[2], t[3], UP);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4, mid = [(t[k][0] + t[k1][0]) / 2 - (t[0][0] + t[2][0]) / 2, 0, (t[k][2] + t[k1][2]) / 2 - (t[0][2] + t[2][2]) / 2];
    pushTri(out, t[k], t[k1], bo[k1], mid); pushTri(out, t[k], bo[k1], bo[k], mid);
  }
  pushTri(out, bo[0], bo[1], bo[2], [0, -1, 0]); pushTri(out, bo[0], bo[2], bo[3], [0, -1, 0]);
  addMeshTop(new Float32Array([...t[0], ...t[1], ...t[2], ...t[0], ...t[2], ...t[3]]), 0.25, { under: Math.min(y0, y1) - 1.2 });
}

// Деревянный мост: настил из досок, перила-верёвки, столбики с фонариками на концах
function bridge(A, B, parts, rnd) {
  const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), ux = dx / d, uz = dz / d;
  const s0 = A.r - 0.5, s1 = d - B.r + 0.5, len = s1 - s0, w = 2.2;
  const yaw = Math.atan2(ux, uz), pitch = -Math.atan2(B.y - A.y, d);
  const yAt = (s) => A.y + (B.y - A.y) * (s / d) + 0.05;
  const box = new THREE.BoxGeometry(1, 1, 1);
  const qy = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const place = (s, o, y, sx, sy, sz) => new THREE.Matrix4().compose(
    new THREE.Vector3(A.x + ux * s - uz * o, y, A.z + uz * s + ux * o), qy, new THREE.Vector3(sx, sy, sz));
  const n = Math.max(2, Math.round(len / 0.9));
  for (let i = 0; i < n; i++) {
    const s = s0 + (i + 0.5) * (len / n);
    parts.push(part(box, hash(i, A.id) < 0.5 ? 0x8a6038 : 0x76502e, { m: place(s, 0, yAt(s) - 0.08, w, 0.16, len / n - 0.07) }));
  }
  for (const o of [-1, 1]) {
    // перила: тонкая балка вдоль моста на высоте пояса
    const sm = (s0 + s1) / 2;
    parts.push(part(box, 0x5a3c22, { m: place(sm, o * (w / 2 - 0.06), yAt(sm) + 0.95, 0.07, 0.07, len) }));
    for (let k = 0; k <= Math.round(len / 4.5); k++) {
      const s = s0 + (k / Math.max(1, Math.round(len / 4.5))) * len;
      parts.push(part(box, 0x5a3c22, { m: place(s, o * (w / 2 - 0.06), yAt(s) + 0.45, 0.1, 0.95, 0.1) }));
    }
  }
  // фонарики на концах
  const lamp = new THREE.OctahedronGeometry(0.22, 0);
  for (const s of [s0 + 0.9, s1 - 0.9]) for (const o of [-1, 1]) {
    parts.push(part(lamp, 0xffd27a, { glow: 0.95, m: place(s, o * (w / 2 - 0.06), yAt(s) + 1.1, 1, 1, 1) }));
  }
  const top = [], c = [[s0, -w / 2], [s0, w / 2], [s1, w / 2], [s1, -w / 2]].map(([s, o]) => [A.x + ux * s - uz * o, yAt(s), A.z + uz * s + ux * o]);
  top.push(...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]);
  addMeshTop(new Float32Array(top), 0.25, { under: Math.min(A.y, B.y) - 1.5 });
}

export function buildDescent(scene) {
  const ringY = -44;
  const obs = obstacles();
  let best = null, tries = 0;
  for (let k = 0; k < 6; k++) {
    const g = grow(SEED + 9001 + k * 131, obs, ringY);
    tries++;
    if (!g) continue;
    // сколько входов приводят ко дну
    const bottoms = g.nodes.filter((n) => n.y < BOTTOM_Y).map((n) => n.id);
    let ok = 0, minUp = Infinity;
    for (const r of g.roots) {
      const d = reach(g.nodes, g.edges, r.id), up = upCount(g.nodes, g.edges, r.id);
      let can = false, mu = Infinity;
      for (const b of bottoms) if (d[b] < Infinity) { can = true; mu = Math.min(mu, up[b]); }
      if (can) { ok++; minUp = Math.min(minUp, mu); }
    }
    const score = ok * 100 + Math.min(g.nodes.length, 400) / 10;
    if (!best || score > best.score) best = { g, ok, minUp, score, k, bottoms: bottoms.length };
    if (ok >= 5 && g.nodes.length > 200) break;
  }
  if (!best) return DESCENT;
  const { g } = best;
  const rnd = mulberry32(SEED + 9002);
  const out = { pos: [] };
  const wood = [];
  for (const n of g.nodes) platform(n, out, rnd);
  for (const e of g.edges) {
    if (e.extra || e.kind === 'jump') continue;
    const A = g.nodes[e.a], B = g.nodes[e.b];
    if (e.kind === 'bridge') bridge(A, B, wood, rnd); else slab(A, B, 2.8, out, rnd);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(out.pos.length / 3 * 2), 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, rockMat);
  mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
  scene.add(mesh);
  if (wood.length) {
    const wm = new THREE.Mesh(merge(wood), propMaterial());
    wm.frustumCulled = false; wm.matrixAutoUpdate = false;
    scene.add(wm);
  }
  // кристаллы на площадках: ориентир в темноте
  const cry = [], oct = new THREE.OctahedronGeometry(1, 0), col = new THREE.Color(), r3 = mulberry32(SEED + 9003);
  for (const n of g.nodes) {
    if (r3() < 0.45) continue;
    for (let k = 0, c = 1 + (r3() < 0.4 ? 1 : 0); k < c; k++) {
      const a = r3() * TAU, rr = n.r * (0.45 + r3() * 0.35), h = 0.7 + r3() * 1.2;
      let x = n.x + Math.cos(a) * rr, z = n.z + Math.sin(a) * rr;
      if (Math.hypot(x, z) > rwAt(x, z) - 1.0) continue;
      col.setHSL(0.52 + r3() * 0.28, 0.7, 0.66);
      cry.push(part(oct, col.getHex(), { glow: 0.85, m: T(x, n.y + h * 0.7, z, 0.28 * h, h, 0.28 * h, r3() * 6) }));
    }
  }
  if (cry.length) {
    const cm = new THREE.Mesh(merge(cry), propMaterial());
    cm.frustumCulled = false; cm.matrixAutoUpdate = false;
    scene.add(cm);
  }
  Object.assign(DESCENT, { nodes: g.nodes, edges: g.edges, roots: g.roots.map((r) => r.id), ringY, ready: true,
    stats: { dbg: DBG, tries, seed: best.k, nodes: g.nodes.length, edges: g.edges.length, rootsToBottom: best.ok, roots: g.roots.length, minRiseToBottom: best.minUp, bottoms: best.bottoms } });
  return DESCENT;
}
