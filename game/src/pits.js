import { PITS, pitLocal, pitDist, pitFloor, heightAt } from './terrain.js';
import { bakeStones, STONEAPI } from './descent.js';
import { rockAt } from './solids.js';
import { mulberry32, SEED } from './noise.js';

// Ямы-спуски на дне шахты у озера (вырез в рельефе — terrain.js PITS). Всё, что видно внутри, — глыбы,
// такие же, как на поле (тот же меш, та же опора, по ним можно лазать):
//  • стена из глыб-столбов по краю ямы (верх — вровень с дном шахты, неровной кромкой);
//  • ступени: глыбы на дне ямы, по ним спускаются зигзагом от входа до самого низа;
//  • подпорки: если глыба с карты стоит над ямой, под неё ставим столб до дна — ничего не висит в воздухе.
// В редакторе этих глыб нет (это часть рельефа), раскладку игрока не меняют.

const TAU = Math.PI * 2;

// паспорт глыбы-столба: верх top, низ bot
function column(rnd, x, z, top, bot, R, extra = {}) {
  const T = Math.max(2, top - bot);
  const d1 = Math.min(1.2, T * 0.2), d2 = Math.min(3, T * 0.45), d3 = Math.min(5, T * 0.7);
  return {
    x, z, y: top, A: R * (0.85 + rnd() * 0.3), B: R * (0.85 + rnd() * 0.3), ang: rnd() * TAU,
    n: 3.0 + rnd() * 1.3, bump: 0.08 + rnd() * 0.12, dome: 0.2 + rnd() * 0.35, gs: 0, arch: 0, seg: R > 2.2 ? 16 : 12,
    T, prof: [[d1, 1.03], [d2, 0.98], [d3, 1.0], [T, 0.95]], flt: false, hs: 1, col: true,
    rv: Array.from({ length: 9 }, rnd), kind: 'pit', ...extra,
  };
}

// точки по краю ямы на отступе o от края (o > 0 — снаружи), примерно через шаг step
function rim(P, o, step) {
  const raw = [];
  for (let k = 0; k < 160; k++) {
    const a = (k / 160) * TAU, ct = Math.cos(a), cw = Math.sin(a);
    let lo = 0, hi = 20;
    for (let i = 0; i < 22; i++) {
      const m = (lo + hi) / 2, t = ct * m, w = cw * m;
      const x = P.x + P.dx * t + P.nx * w, z = P.z + P.dz * t + P.nz * w;
      if (pitDist(P, x, z) < o) lo = m; else hi = m;
    }
    raw.push([P.x + P.dx * ct * lo + P.nx * cw * lo, P.z + P.dz * ct * lo + P.nz * cw * lo]);
  }
  const out = [raw[0]];
  let acc = 0;
  for (let i = 1; i <= raw.length; i++) {
    const a = raw[i - 1], b = raw[i % raw.length];
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc >= step) { out.push(b); acc = 0; }
  }
  if (Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < step * 0.6) out.pop();
  return out;
}

// глыбы карты, убранные из ям (мосты выбирают пары с их учётом, чтобы остальные мосты остались на своих местах)
export const PIT_GONE = [];

// Шаг 1 (сразу после карты глыб, до мостов): низкие глыбы карты, стоящие центром в яме, убираем
// (в раскладке игрока — тоже, если он сохранит карту в редакторе). На краю — пусть нависают козырьком.
export function clearPits() {
  let gone = 0;
  for (const P of PITS) {
    for (const s of STONEAPI.all()) {
      const sp = s.spec, R = Math.max(sp.A, sp.B) * (sp.hs ?? 1);
      if (sp.y > -150 || sp.y - (sp.T || 3) > P.rim + 8) continue;
      if (pitDist(P, sp.x, sp.z) < Math.min(1.5, R * 0.4)) { PIT_GONE.push(s); STONEAPI.remove(s.id); gone++; }
    }
  }
  return gone;
}

// Шаг 2: стены, уступы и подпорки ям (до растений: те обходят глыбы ям).
export function buildPits(scene) {
  const rnd = mulberry32(SEED + 4471);
  const stats = [];
  for (const P of PITS) {
    const specs = [];
    const floorAt = (x, z) => pitFloor(P, Math.max(-P.L / 2, Math.min(P.L / 2, pitLocal(P, x, z)[0])));
    // 1) подпорки: высокий столб с карты, стоящий центром в яме, продлеваем вниз до дна (на краю — нависает козырьком)
    let sup = 0;
    for (const s of STONEAPI.all()) {
      const sp = s.spec, R = Math.max(sp.A, sp.B) * (sp.hs ?? 1), r0 = Math.min(sp.A, sp.B) * (sp.hs ?? 1);
      const yb = sp.y - (sp.T || 3);
      const d = pitDist(P, sp.x, sp.z);
      if (d > -0.5 || yb < floorAt(sp.x, sp.z) + 1) continue;
      // столб из-под глыбы вниз до дна: чуть уже самой глыбы, верх спрятан в её теле
      specs.push(column(rnd, sp.x, sp.z, yb + 1.5, floorAt(sp.x, sp.z) - 3, Math.max(1.2, r0 * 0.75), { dome: 0 }));
      sup++;
    }
    // 2) стена из глыб-столбов по краю
    let wall = 0;
    for (const [x, z] of rim(P, 0.9, 2.7)) {
      const ox = x - P.x, oz = z - P.z, ol = Math.hypot(ox, oz) || 1;
      const g = Math.max(heightAt(x + ox / ol * 2.5, z + oz / ol * 2.5), P.rim - 0.6);   // земля за краем ямы
      const y = g + 0.2 + rnd() * 1.1;
      specs.push(column(rnd, x, z, y, floorAt(x, z) - 4, 1.9 + rnd() * 0.7));
      wall++;
    }
    // 3) уступы-глыбы витком по стенам: от входа вниз, один оборот до дна. Каждая следующая ниже на ~2.5 м
    //    и в 2.5–3 м от прошлой — спрыгнуть или залезть обратно (уступы и стены — для лазанья)
    const path = rim(P, -2.1, 2.2);
    let i0 = 0, best = 1e9;
    path.forEach(([x, z], i) => { const t = pitLocal(P, x, z)[0]; if (t < best) { best = t; i0 = i; } });   // старт — у входа
    const N = path.length;
    for (let k = 0; k < N; k++) {
      const [x, z] = path[(i0 + k) % N];
      const top = P.rim - 1.2 - (P.depth - 3.2) * (k / (N - 1));
      specs.push(column(rnd, x, z, top, top - 2.6 - rnd() * 1.2, 1.5 + rnd() * 0.4, { dome: 0.12 + rnd() * 0.15 }));
    }
    // 4) пара камней на самом дне
    for (let k = 0; k < 3; k++) {
      const t = P.L / 2 - 2.5 - rnd() * 3, w = (rnd() - 0.5) * 4;
      const x = P.x + P.dx * t + P.nx * w, z = P.z + P.dz * t + P.nz * w, fl = floorAt(x, z);
      specs.push(column(rnd, x, z, fl + 0.6 + rnd() * 0.6, fl - 1.5, 0.8 + rnd() * 0.6));
    }
    // невидимое (внутри соседней глыбы или в породе) не рисуем: стены из столбов сильно перекрываются
    // куски по сторонам ямы и по высоте: телефон рисует ближние раньше дальних и не закрашивает одно и то же дважды
    const b = bakeStones(specs, (x, y, z) => heightAt(x, z) > y + 0.05 || !!rockAt(x, z, y), (sp) => {
      const [t, w] = pitLocal(P, sp.x, sp.z);
      return (Math.abs(t) * 0.6 > Math.abs(w) ? (t > 0 ? 0 : 1) : (w > 0 ? 2 : 3)) + (sp.y < P.rim - 15 ? 4 : 0);
    });
    for (const m of b.meshes(scene)) m.userData.pit = true;
    stats.push({ gone: PIT_GONE.length, sup, wall, stones: specs.length, tris: b.tris });
  }
  buildPits.stats = stats;
  return stats;
}
