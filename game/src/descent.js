import * as THREE from '../vendor/three.min.js';
import { W, heightAt, pitR, rockMat } from './terrain.js';
import { addMeshTop, solidsNear } from './solids.js';
import { STACKS, PILLARS } from './stacks.js';
import { mulberry32, SEED } from './noise.js';
import { part, merge, T, propMaterial } from './flora.js';

// Спуск в бездну: отдельный участок, построенный поверх шахты, не трогая остальную карту.
//
// Вдоль стенки шахты двумя с лишним витками идёт «маршрут» из каменных плит, торчащих из скалы:
//   посадочные площадки (ровные), пологие рампы, ЖЁЛОБА (крутые плиты 54–60°: герой скользит,
//   разгоняется и слетает с края — летит до следующей площадки), разрывы для прыжка и цепочки
//   маленьких камней. Плиты настоящие твёрдые: на них можно стоять, скользить, под ними можно
//   упасть мимо — и тогда ты на следующем витке, ниже, или на дне у озера.
//
// Маршрут строится по семени (одинаков у всех игроков) в два шага:
//   1) план в координатах (s — длина дуги вдоль стенки, u — вглубь шахты от стенки, y — высота);
//   2) отображение плана на мир: выбирается угол входа и направление витка так, чтобы маршрут
//      не пересекался со столбами, островами и мостовыми опорами.
// Проходимость каждого перехода проверяется ботом на настоящей физике героя (descent_test в dev).

const TAU = Math.PI * 2;
const RS = 47;        // радиус осевой линии маршрута, м
const EMBED = 1.4;    // линия u = 0 лежит на столько глубже стенки: плиты «вросли» в скалу
export const DESCENT = { pieces: [], links: [], entry: null, dir: 1, entryY: 0, ready: false };

// Полёт после жёлоба: расстояние от нижнего края жёлоба до начала следующей площадки
// по падению Δ (м): gap = base + k * sqrt(Δ). Подобрано замерами физики (см. descent_test).
export const FLIGHT = { base: -0.5, k: 1.25, launch: 2.0 }; // launch — на сколько дальше площадка у «длинного» жёлоба

const rwAt = (th) => pitR(Math.cos(th) * W.PIT, Math.sin(th) * W.PIT);

// ---------- 1. план ----------
function makePlan(rnd, depth) {
  const P = [], links = [];
  let S = 0, Y = 0;
  const add = (kind, gap, len, u1, sy, su, thick, drop = 0) => {
    // gap == 0 — стыкуется с предыдущей плитой (перехлёст 0.4 м), иначе — отдельная плита через разрыв
    const s0 = S + gap;
    const y0 = gap === 0 ? Y : Y - drop;
    const piece = { kind, s0, s1: s0 + len, u1, y0, sy, su, T: thick, join0: gap === 0 };
    P.push(piece);
    S = piece.s1; Y = y0 + sy * len;
    return P.length - 1;
  };
  const land = (gap = 0, drop = 0) => add('land', gap, 7 + rnd() * 3, 5.8 + rnd() * 1.6, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.08, 3 + rnd() * 3, drop);
  let cur = land();
  while (Y > -depth) {
    const r = rnd(), from = cur;
    if (r < 0.28) {            // пологая рампа
      const sl = 0.33 + rnd() * 0.17;
      add('ramp', 0, 9 + rnd() * 4, 5.2 + rnd() * 1.4, -sl, 0, 3.5);
      cur = land();
      links.push({ kind: 'ramp', from, to: cur });
    } else if (r < 0.62) {     // жёлоб: скольжение и полёт; у части жёлобов площадка дальше — нужно прыгнуть в конце скольжения
      const tan = 1.38 + rnd() * 0.35, d = 3 + rnd() * 2.5, longJump = rnd() < 0.3;
      const ch = add('chute', 0, 4.2 + rnd() * 1.0, 4.6 + rnd() * 1.0, -tan, 0, 4.5);
      cur = land(FLIGHT.base + FLIGHT.k * Math.sqrt(d) + (longJump ? FLIGHT.launch : 0), d);
      links.push({ kind: longJump ? 'launch' : 'chute', from, to: cur, chute: ch, drop: d });
    } else if (r < 0.90) {     // прыжок через разрыв
      cur = land(2.3 + rnd() * 1.0, 0.6 + rnd() * 2.6);
      links.push({ kind: 'jump', from, to: cur });
    } else {                   // цепочка маленьких камней (реже: каждый камень — отдельная плита)
      const n = 2 + (rnd() < 0.4 ? 1 : 0);
      let prev = from;
      for (let i = 0; i < n; i++) {
        const st = add('stone', 2.2 + rnd() * 0.6, 2.8 + rnd() * 0.8, 3.8 + rnd() * 1.0, (rnd() - 0.5) * 0.04, 0, 3, 0.4 + rnd() * 1.0);
        links.push({ kind: 'stones', from: prev, to: st }); prev = st;
      }
      cur = land(2.2 + rnd() * 0.6, 0.4 + rnd() * 1.0);
      links.push({ kind: 'stones', from: prev, to: cur });
    }
  }
  for (let i = 0; i < P.length; i++) P[i].join1 = !!(P[i + 1] && P[i + 1].join0); // конец стыкуется со следующей плитой
  return { pieces: P, links, length: S };
}

// ---------- 2. отображение на мир ----------
const toWorld = (s, u, th0, dir) => {
  const th = th0 + dir * s / RS, r = rwAt(th) + EMBED - u;
  return [Math.cos(th) * r, Math.sin(th) * r];
};

function obstacles() {
  // всё, что стоит в шахте столбом и могло бы пересечься с плитами
  const list = [];
  // [x, z, радиус, верх, низ]: тела островов (130 м) и столбов (70 м) ограничены по высоте
  for (const st of STACKS) if (Math.hypot(st.x, st.z) > 20) list.push([st.x, st.z, st.w * 1.25 + 1.2, st.top + 6, st.top - 140]);
  for (const p of PILLARS) list.push([p.x, p.z, p.w * 1.1 + 1.0, p.top + 3, p.top - 80]);
  return list;
}

function conflicts(plan, th0, dir, obs, entryY) {
  let n = 0;
  for (const pc of plan.pieces) {
    // считаем только видимую часть плиты (u ≥ 1.6 — за стенкой шахты она внутри породы)
    for (let s = pc.s0; s <= pc.s1 + 0.01; s += 2.0) for (const u of [1.6, pc.u1 * 0.5 + 0.8, pc.u1]) {
      const [x, z] = toWorld(s, u, th0, dir);
      // постройки руин мешают, только если они на той же высоте (настил на −13 м не мешает плите на −100)
      const y = entryY + pc.y0 + pc.sy * (s - pc.s0);
      let bad = solidsNear(x, z, 1.0).some((b) => b.top > y - 9 && (b.bottom < -1e8 ? heightAt(b.x, b.z) : b.bottom) < y + 6);
      for (let i = 0; i < obs.length && !bad; i++) { const o = obs[i]; if (y < o[3] + 4 && y > o[4] - 4 && (x - o[0]) ** 2 + (z - o[1]) ** 2 < o[2] * o[2]) bad = true; }
      if (bad) { n++; break; }
    }
  }
  return n;
}

// ---------- геометрия плиты ----------
function slabGeometry(pc, th0, dir, entryY, rnd, out) {
  // у плиты, за которой стыкуется следующая, край чуть выдвинут вперёд (0.35 м): ровно над стыком, без щели
  const { s0, u1 } = pc, s1 = pc.s1 + (pc.join1 ? 0.35 : 0), uw = -0.8;
  // У стыкующихся плит концы прямые (иначе между срезанными углами остаётся клин, куда проваливаешься);
  // у свободных краёв углы срезаны и неровные — как у отколотого камня
  const e1 = pc.join1 ? 0 : (rnd() - 0.3) * 0.6, c1 = pc.join1 ? 0 : 0.5 + rnd() * 0.6;
  const e0 = pc.join0 ? 0 : (rnd() - 0.3) * 0.6, c0 = pc.join0 ? 0 : 0.5 + rnd() * 0.6;
  const ring = [[s0, uw], [s1, uw], [s1 + e1, u1 * 0.55], [s1 - c1, u1], [s0 + c0, u1], [s0 - e0, u1 * 0.55]];
  const cs = (s0 + s1) / 2, cu = u1 * 0.5;
  const yTop = (s, u, j = 0) => entryY + pc.y0 + pc.sy * (s - pc.s0) + pc.su * u + j;
  const W3 = (s, u, y) => { const [x, z] = toWorld(s, u, th0, dir); return new THREE.Vector3(x, y, z); };
  const top = ring.map(([s, u]) => W3(s, u, yTop(s, u, (rnd() - 0.5) * 0.14)));
  const cen = W3(cs, cu, yTop(cs, cu, 0.08));
  const bot = ring.map(([s, u], k) => W3(cs + (s - cs) * 0.5, cu + (u - cu) * 0.5, top[k].y - pc.T * (0.7 + rnd() * 0.6)));
  const apexY = Math.min(...bot.map((b) => b.y)) - 2.4;
  const apex = W3(cs, cu, apexY);
  const center = new THREE.Vector3((cen.x + apex.x) / 2, (cen.y + apexY) / 2, (cen.z + apex.z) / 2);
  const tri = (a, b, c, hint) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(hint) < 0) { const t = b; b = c; c = t; }
    out.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const UP = new THREE.Vector3(0, 1, 0), DN = new THREE.Vector3(0, -1, 0);
  const topTris = [];
  for (let k = 0; k < ring.length; k++) {
    const k1 = (k + 1) % ring.length;
    tri(cen, top[k], top[k1], UP);
    topTris.push(cen.x, cen.y, cen.z, top[k].x, top[k].y, top[k].z, top[k1].x, top[k1].y, top[k1].z);
    // бок
    const mid = new THREE.Vector3().addVectors(top[k], top[k1]).multiplyScalar(0.5).sub(center).setY(0);
    tri(top[k], top[k1], bot[k1], mid); tri(top[k], bot[k1], bot[k], mid);
    // низ — клин
    tri(bot[k], bot[k1], apex, DN);
  }
  return { topTris, bottom: apexY, cen };
}

export function buildDescent(scene) {
  const rnd = mulberry32(SEED + 9001);
  const floorY = -(W.LOW + W.DEEP);
  const plan = makePlan(rnd, -(floorY + 16) - W.LOW);      // от нижнего уступа (≈ −48) до ~16 м над дном
  const obs = obstacles();
  // угол входа: ближе к концу карниза-спуска (6.2 рад), где герой выходит на нижний уступ,
  // без пересечений; направление витка — в сторону с меньшим числом столкновений
  let best = null;
  for (let a = 0; a < TAU; a += 0.08) {
    const rw = rwAt(a), ex = Math.cos(a) * (rw + 3.0), ez = Math.sin(a) * (rw + 3.0), h = heightAt(ex, ez);
    if (h > -45.5 || h < -51 || solidsNear(ex, ez, 1.5).length) continue;       // вход — на ровном нижнем уступе
    for (const dir of [1, -1]) {
      const c = conflicts(plan, a, dir, obs, h);
      const d = Math.abs(Math.atan2(Math.sin(a - 6.2), Math.cos(a - 6.2)));
      const score = c * 100 + d;
      if (!best || score < best.score) best = { a, dir, c, score };
    }
  }
  if (!best) return DESCENT;
  const th0 = best.a, dir = best.dir;
  // высота входа: верх нижнего уступа у стенки
  let entryY = -1e9;
  for (let s = 0; s <= plan.pieces[0].s1; s += 1.5) for (const u of [-0.5, 1.0, 2.2]) { const [x, z] = toWorld(s, u, th0, dir); entryY = Math.max(entryY, heightAt(x, z)); }
  entryY += 0.04;
  Object.assign(DESCENT, { entry: th0, dir, entryY, conflicts: best.c, plan });
  // для разработки: с чем именно пересекаются плиты (пусто — маршрут чистый)
  DESCENT.why = {};
  for (const pc of plan.pieces) for (let ss = pc.s0; ss <= pc.s1 + 0.01; ss += 2.0) for (const u of [1.6, pc.u1 * 0.5 + 0.8, pc.u1]) {
    const [x, z] = toWorld(ss, u, th0, dir), y = entryY + pc.y0 + pc.sy * (ss - pc.s0);
    for (const o of obs) if (y < o[3] + 4 && y > o[4] - 4 && (x - o[0]) ** 2 + (z - o[1]) ** 2 < o[2] * o[2]) { const k = `obs(${Math.round(o[0])},${Math.round(o[1])},r${Math.round(o[2])}) piece@${Math.round(y)}`; DESCENT.why[k] = 1; }
    for (const b of solidsNear(x, z, 1.0)) if (b.top > y - 9 && (b.bottom < -1e8 ? heightAt(b.x, b.z) : b.bottom) < y + 6) DESCENT.why[`box top ${Math.round(b.top)} piece@${Math.round(y)} at ${Math.round(x)},${Math.round(z)}`] = 1;
  }

  const out = { pos: [] };
  const geo = { mesh: null };
  const info = [];
  const r2 = mulberry32(SEED + 9002);
  for (const pc of plan.pieces) {
    const g = slabGeometry(pc, th0, dir, entryY, r2, out);
    addMeshTop(new Float32Array(g.topTris), 0.3, { slope: true, under: g.bottom });
    const sm = (pc.s0 + pc.s1) / 2, um = pc.u1 * 0.5;
    const [cx, cz] = toWorld(sm, um, th0, dir);
    info.push({
      kind: pc.kind, cx, cz, cy: entryY + pc.y0 + pc.sy * (sm - pc.s0) + pc.su * um,
      a: toWorld(pc.s0 + 0.6, um, th0, dir), b: toWorld(pc.s1 - 0.6, um, th0, dir),
      ya: entryY + pc.y0 + pc.sy * 0.6 + pc.su * um, yb: entryY + pc.y0 + pc.sy * (pc.s1 - pc.s0 - 0.6) + pc.su * um,
      len: pc.s1 - pc.s0, u1: pc.u1,
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(new Float32Array(out.pos.length / 3 * 2), 2));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, rockMat);
  mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
  scene.add(mesh);

  // светящиеся кристаллы на площадках: ориентир в темноте и красота (одним вызовом отрисовки)
  const cry = [];
  const oct = new THREE.OctahedronGeometry(1, 0), col = new THREE.Color();
  const r3 = mulberry32(SEED + 9003);
  info.forEach((p, i) => {
    if (p.kind !== 'land' || r3() < 0.25) return;
    const n = 1 + (r3() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const s = plan.pieces[i].s0 + 1 + r3() * (p.len - 2), u = plan.pieces[i].u1 - 0.6 - r3() * 1.4;
      const [x, z] = toWorld(s, u, th0, dir), y = entryY + plan.pieces[i].y0 + plan.pieces[i].sy * (s - plan.pieces[i].s0) + plan.pieces[i].su * u;
      const h = 0.7 + r3() * 1.1;
      col.setHSL(0.55 + r3() * 0.25, 0.7, 0.66);
      cry.push(part(oct, col.getHex(), { glow: 0.85, m: T(x, y + h * 0.7, z, 0.28 * h, h, 0.28 * h, r3() * 6) }));
    }
  });
  if (cry.length) {
    const cm = new THREE.Mesh(merge(cry), propMaterial());
    cm.frustumCulled = false; cm.matrixAutoUpdate = false;
    scene.add(cm);
  }
  DESCENT.pieces = info; DESCENT.links = plan.links; DESCENT.ready = true;
  return DESCENT;
}
