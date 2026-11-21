import * as THREE from '../vendor/three.min.js';
import { part, T } from './flora.js';

// Уровень 2 дома: большой зал гильдии. Дом-сруб уступает место залу на том же месте, входом к костру.
// Снаружи: каменный цоколь, фахверк (светлая штукатурка в тёмных балках), большая красная двускатная
// крыша фронтоном вперёд, крытое крыльцо со ступенями, навесы по бокам, сторожевая башня сзади справа,
// красные знамёна со скрещёнными мечами, фонари.
// Внутри — зал в два этажа: стойка, за ней стоит Борода, шкафы с книгами и склянками, доска заданий
// на левой стене, ковёр, люстра со свечами, столы с лавками, лестница справа на галерею второго этажа
// (галерея идёт вдоль задней и левой стены, с перилами).
// Всё — три модели (стены и зал / крыша и улица / леса): три вызова отрисовки, свет — только свечение.
//
// Координаты: x — вправо от входа, z — к входу (вперёд), y — от пола зала. Начало — центр старого дома.

export const G = {
  HX: 8, Z0: -12, Z1: 0, WT: 0.35, WH: 7.2,   // полуширина зала, задняя и передняя стены, толщина, высота стен
  PZ: 2.6,                                     // крыльцо: от передней стены до z = PZ
  BY: 3.6,                                     // пол галереи второго этажа
  GZ: -9.2, GX: -5.6,                          // край задней и левой галереи
  SX0: 6.3, SX1: 7.65, SZ0: -1.2, STEPS: 9,    // лестница вдоль правой стены, от SZ0 назад
  TX: 9.9, TZ: -10.2, TW: 3.6, TH: 14,         // башня
  RISE: 4.2,                                   // высота конька над стенами
};
// площадка, которую занимает зал вместе с башней, навесами и знамёнами (для деревьев и травы)
export const LOT = { x0: -12.5, x1: 12.5, z0: -13.2, z1: 4.4 };
// где стоит Борода и где доска заданий
export const SPOT = { npc: [0, -9.3], board: [-7.3, -4.6] };

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

export function buildGuild() {
  const { HX, Z0, Z1, WT, WH, PZ, BY, GZ, GX, SX0, SX1, SZ0, STEPS, TX, TZ, TW, TH, RISE } = G;
  const base = [], top = [], scaf = [], solids = [];
  // цвета
  const plaster = 0xf0d9ae, plasterIn = 0xd8b07c, beam = 0x5a3822, beamD = 0x47291a, wood = 0x7a4f30, plank = 0x9a6a42,
    floorC = 0x8a5a36, stone = 0x8f8c88, stoneD = 0x77746f, roofC = 0x9e3a30, roofD = 0x7f2c25, ceil = 0x5c3a24,
    red = 0xa3252b, redD = 0x7d1d22, cream = 0xeadfc4, gold = 0xd9a441, glowC = 0xffd27a, iron = 0x3a3433, paper = 0xf1e6c8;
  const B = (arr, w, h, d, c, x, y, z, o = {}) => arr.push(part(box(w, h, d), c, { ...o, m: T(x, y, z, 1, 1, 1, o.ry || 0, o.rz || 0) }));
  const S = (x0, x1, z0, z1, topY, bottom) => solids.push([(x0 + x1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(z1 - z0) / 2, topY, bottom]);
  const W = HX * 2, D = Z1 - Z0, cz = (Z0 + Z1) / 2;

  // ================= основание: цоколь, пол, крыльцо, ступени =================
  B(base, W + 0.5, 2.0, D + 0.5, stone, 0, -1.05, cz, { stone: 1 });
  B(base, W, 0.1, D, floorC, 0, -0.05, cz);
  for (let i = 1; i < 16; i++) B(base, 0.04, 0.02, D - 0.2, beamD, -HX + i, 0.005, cz); // щели между досками пола
  B(base, W + 0.5, 2.0, PZ, stone, 0, -1.05, PZ / 2, { stone: 1 });
  B(base, W + 0.2, 0.12, PZ - 0.1, plank, 0, -0.06, PZ / 2);
  S(-HX - 0.25, HX + 0.25, Z0 - 0.25, PZ, 0);
  // ступени к костру: три широкие
  for (let i = 0; i < 3; i++) {
    const y = -0.28 * (i + 1), z = PZ + 0.35 + i * 0.4;
    B(base, 4.4 + i * 0.4, 0.28, 0.4, i % 2 ? stoneD : stone, 0, y + 0.14 - 0.14, z, { stone: 1 });
    B(base, 4.4 + i * 0.4, 1.6, 0.4, stone, 0, y - 0.8 - 0.14, z, { stone: 1 });
    S(-2.2 - i * 0.2, 2.2 + i * 0.2, z - 0.2, z + 0.2, y);
  }

  // ================= стены: фахверк =================
  const wall = (x0, x1, z0, z1, y0, y1) => {
    const w = Math.max(Math.abs(x1 - x0), WT), d = Math.max(Math.abs(z1 - z0), WT);
    B(base, w, y1 - y0, d, plaster, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    S(Math.min(x0, x1) - (w === WT ? WT / 2 : 0), Math.max(x0, x1) + (w === WT ? WT / 2 : 0), Math.min(z0, z1) - (d === WT ? WT / 2 : 0), Math.max(z0, z1) + (d === WT ? WT / 2 : 0), y1, y0 > 0.1 ? y0 : undefined);
  };
  const OW = 2.7, OH = 3.9; // проём входа: полуширина и высота
  wall(-HX, HX, Z0 + WT / 2, Z0 + WT / 2, 0, WH);                 // задняя
  wall(-HX + WT / 2, -HX + WT / 2, Z0, Z1, 0, WH);                // левая
  wall(HX - WT / 2, HX - WT / 2, Z0, Z1, 0, WH);                  // правая
  wall(-HX, -OW, Z1 - WT / 2, Z1 - WT / 2, 0, WH);                // передняя слева от входа
  wall(OW, HX, Z1 - WT / 2, Z1 - WT / 2, 0, WH);                  // справа
  wall(-OW, OW, Z1 - WT / 2, Z1 - WT / 2, OH, WH);                // над входом
  // каменный низ стен и балки фахверка — с обеих сторон стены
  const faces = [ // [ось вдоль стены, положение, нормаль наружу, от, до]
    ['x', Z0, -1, -HX, HX], ['z', -HX, -1, Z0, Z1], ['z', HX, 1, Z0, Z1], ['x', Z1, 1, -HX, -OW], ['x', Z1, 1, OW, HX],
  ];
  for (const [ax, at, nrm, a0, a1] of faces) {
    for (const side of [1, -1]) {
      const off = at + nrm * (side > 0 ? 0.03 : -(WT + 0.03)) + (side > 0 ? 0 : 0) , len = a1 - a0, mid = (a0 + a1) / 2;
      const put = (along, y, l, h, c, th = 0.14) => ax === 'x' ? B(base, l, h, th, c, along, y, off) : B(base, th, h, l, c, off, y, along);
      if (side > 0) put(mid, 0.4, len + 0.1, 0.8, stoneD, 0.16);          // снаружи — каменный низ
      for (const y of [0.85, BY, WH - 0.12]) put(mid, y, len, 0.22, side > 0 ? beam : beamD, 0.1);
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) put(a0 + (i * len) / n, (0.85 + WH) / 2, 0.22, WH - 0.85, side > 0 ? beam : beamD, 0.16);
      // косые раскосы снаружи на первом этаже, через пролёт
      if (side > 0) for (let i = 0; i < n; i += 2) {
        const al = a0 + ((i + 0.5) * len) / n, ang = Math.atan2(len / n, BY - 0.85);
        if (ax === 'x') B(base, 0.14, Math.hypot(len / n, BY - 0.85), 0.12, beam, al, (0.85 + BY) / 2, off, { rz: ang * (i % 4 ? 1 : -1) });
        else B(base, 0.12, Math.hypot(len / n, BY - 0.85), 0.14, beam, off, (0.85 + BY) / 2, al, { ry: Math.PI / 2, rz: ang * (i % 4 ? 1 : -1) });
      }
    }
  }
  // внутри стены теплее и темнее: тонкая обшивка поверх штукатурки на первом этаже
  B(base, W - 2 * WT - 0.02, 0.85, 0.05, wood, 0, 0.42, Z0 + WT + 0.03);
  B(base, 0.05, 0.85, D - 2 * WT, wood, -HX + WT + 0.03, 0.42, cz);
  B(base, 0.05, 0.85, D - 2 * WT, wood, HX - WT - 0.03, 0.42, cz);
  // тёплая штукатурка изнутри (снаружи стены светлые)
  B(base, W - 2 * WT - 0.02, WH - 0.85, 0.03, plasterIn, 0, (0.85 + WH) / 2, Z0 + WT + 0.035);
  for (const sx of [-1, 1]) B(base, 0.03, WH - 0.85, D - 2 * WT, plasterIn, sx * (HX - WT - 0.035), (0.85 + WH) / 2, cz);
  for (const [x0, x1, y0] of [[-HX + WT, -OW, 0.85], [OW, HX - WT, 0.85], [-OW, OW, OH]]) B(base, x1 - x0, WH - y0, 0.03, plasterIn, (x0 + x1) / 2, (y0 + WH) / 2, Z1 - WT - 0.035);
  // наличник и дверные столбы входа
  for (const sx of [-1, 1]) B(base, 0.4, OH, WT + 0.2, beam, sx * OW, OH / 2, Z1 - WT / 2);
  B(base, OW * 2 + 0.6, 0.4, WT + 0.2, beam, 0, OH, Z1 - WT / 2);

  // окна: тёплое стекло в раме с переплётом, видно с обеих сторон
  const win = (ax, at, along, y, w, h, arch) => {
    const t = WT + 0.12;
    const put = (a, yy, ww, hh, c, th, o = {}) => ax === 'x' ? B(base, ww, hh, th, c, a, yy, at, o) : B(base, th, hh, ww, c, at, yy, a, o);
    put(along, y, w + 0.3, h + 0.3, beam, t + 0.3);
    put(along, y, w, h, glowC, t + 0.36, { glow: 0.85 });
    put(along, y, 0.07, h, beamD, t + 0.44); put(along, y + h * 0.15, w, 0.07, beamD, t + 0.44);
    if (arch) {
      const g = new THREE.CylinderGeometry(w / 2 + 0.15, w / 2 + 0.15, t + 0.3, 12, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
      const g2 = new THREE.CylinderGeometry(w / 2, w / 2, t + 0.36, 12, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
      if (ax === 'z') { g.rotateY(Math.PI / 2); g2.rotateY(Math.PI / 2); }
      const p = ax === 'x' ? [along, y + h / 2, at] : [at, y + h / 2, along];
      base.push(part(g, beam, { m: T(...p) }), part(g2, glowC, { glow: 0.85, m: T(...p) }));
    }
  };
  for (const z of [-3.2, -6.6]) { win('z', -HX + WT / 2, z, 1.9, 1.0, 1.3, true); win('z', HX - WT / 2, z, 1.9, 1.0, 1.3, true); }
  for (const z of [-2.2, -5.2, -8.2, -10.6]) { win('z', -HX + WT / 2, z, 5.3, 0.9, 1.2, true); win('z', HX - WT / 2, z, 5.3, 0.9, 1.2, true); }
  for (const x of [-4.4, 4.4]) win('x', Z0 + WT / 2, x, 5.3, 1.1, 1.4, true);
  for (const x of [-5.4, 5.4]) win('x', Z1 - WT / 2, x, 1.9, 1.2, 1.3, false);
  for (const x of [-4.8, 0, 4.8]) win('x', Z1 - WT / 2, x, 5.3, 0.9, 1.2, true);

  // ================= галерея второго этажа и лестница =================
  const gal = (x0, x1, z0, z1) => {
    B(base, x1 - x0, 0.26, z1 - z0, plank, (x0 + x1) / 2, BY - 0.13, (z0 + z1) / 2);
    S(x0, x1, z0, z1, BY, BY - 0.3);
  };
  gal(-HX + WT, HX - WT, Z0 + WT, GZ);           // вдоль задней стены
  gal(-HX + WT, GX, GZ, -1.0);                   // вдоль левой стены
  // балки под галереей
  for (let x = -HX + 1.5; x < HX; x += 1.6) B(base, 0.16, 0.22, GZ - Z0 - WT, beamD, x, BY - 0.37, (Z0 + WT + GZ) / 2);
  for (let z = GZ + 1.2; z < -1; z += 1.6) B(base, GX + HX - WT, 0.22, 0.16, beamD, (-HX + WT + GX) / 2, BY - 0.37, z);
  // столбы-опоры галереи с подкосами
  const post = (x, z) => {
    B(base, 0.34, BY, 0.34, beam, x, BY / 2 - 0.1, z);
    S(x - 0.17, x + 0.17, z - 0.17, z + 0.17, BY);
  };
  for (const x of [GX, -3.4, 3.4, SX0 - 0.6]) post(x, GZ);
  for (const z of [-1.2, -4.0, -6.6]) post(GX, z);
  // перила галереи: поручень, балясины; по краю — твёрдая преграда
  const rail = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(x1 - x0, z1 - z0);
    B(base, 0.12, 0.12, len, beam, (x0 + x1) / 2, BY + 1.0, (z0 + z1) / 2, { ry });
    B(base, 0.08, 0.08, len, beam, (x0 + x1) / 2, BY + 0.15, (z0 + z1) / 2, { ry });
    const n = Math.round(len / 0.45);
    for (let i = 0; i <= n; i++) B(base, 0.07, 0.85, 0.07, beamD, x0 + ((x1 - x0) * i) / n, BY + 0.57, z0 + ((z1 - z0) * i) / n);
    S(Math.min(x0, x1) - 0.06, Math.max(x0, x1) + 0.06, Math.min(z0, z1) - 0.06, Math.max(z0, z1) + 0.06, BY + 1.05, BY);
  };
  rail(GX, GZ, SX0 - 0.05, GZ);                  // задняя галерея: от угла до лестницы
  rail(GX, GZ, GX, -1.0);                        // левая галерея
  rail(-HX + WT, -1.0, GX, -1.0);                // торец левой галереи
  // лестница вдоль правой стены: 9 ступеней по 0.4 м, сплошной сруб под ними
  const run = (SZ0 - GZ) / STEPS;
  for (let i = 1; i <= STEPS; i++) {
    const y = BY * i / STEPS, z = SZ0 - (i - 0.5) * run;
    B(base, SX1 - SX0, y, run + 0.02, wood, (SX0 + SX1) / 2, y / 2, z);
    B(base, SX1 - SX0 + 0.06, 0.08, run + 0.04, plank, (SX0 + SX1) / 2, y - 0.04, z);
    S(SX0, SX1, z - run / 2, z + run / 2, y);
    // перила с открытой стороны: столбик на каждой второй ступени и твёрдая преграда
    if (i % 2) B(base, 0.08, 1.0, 0.08, beamD, SX0 - 0.04, y + 0.5, z);
    S(SX0 - 0.12, SX0 - 0.02, z - run / 2, z + run / 2, y + 1.0, y);
  }
  // наклонный поручень лестницы
  {
    const len = Math.hypot(SZ0 - GZ, BY), g = box(0.12, 0.12, len).rotateX(Math.atan2(BY, SZ0 - GZ));
    base.push(part(g, beam, { m: T(SX0 - 0.04, BY / 2 + 1.0, (SZ0 + GZ) / 2) }));
  }

  // ================= обстановка зала =================
  // стойка: длинная, с тёмной столешницей и красным полотном с мечами
  const CZ = -8.2;
  B(base, 6.4, 1.05, 0.8, wood, 0, 0.525, CZ);
  B(base, 6.7, 0.1, 1.0, beamD, 0, 1.1, CZ);
  for (const x of [-2.4, -0.8, 0.8, 2.4]) B(base, 1.3, 0.75, 0.04, plank, x, 0.5, CZ + 0.42);
  B(base, 1.3, 0.9, 0.03, red, -2.4, 0.7, CZ + 0.45); B(base, 1.3, 0.06, 0.035, gold, -2.4, 1.13, CZ + 0.46);
  B(base, 1.3, 0.9, 0.03, red, 2.4, 0.7, CZ + 0.45); B(base, 1.3, 0.06, 0.035, gold, 2.4, 1.13, CZ + 0.46);
  S(-3.25, 3.25, CZ - 0.5, CZ + 0.5, 1.15);
  // помост за стойкой: Борода стоит чуть выше и виден по пояс
  B(base, 6.4, 0.3, Z0 + WT + 0.55 - (CZ - 0.4) < 0 ? (CZ - 0.4) - (Z0 + WT + 0.55) : 0.1, plank, 0, 0.15, ((CZ - 0.4) + (Z0 + WT + 0.55)) / 2);
  S(-3.2, 3.2, Z0 + WT + 0.55, CZ - 0.4, 0.3);
  // на стойке: книга, свеча, кружки, весы
  B(base, 0.45, 0.08, 0.32, redD, -1.2, 1.19, CZ, { ry: 0.3 });
  B(base, 0.08, 0.22, 0.08, cream, 1.4, 1.26, CZ); B(base, 0.05, 0.1, 0.05, glowC, 1.4, 1.42, CZ, { glow: 1 });
  for (const x of [-2.6, -2.35]) top.push(part(new THREE.CylinderGeometry(0.08, 0.07, 0.18, 7), plank, { m: T(x, 1.24, CZ + 0.1) }));
  // шкафы за стойкой: полки с книгами и склянками
  const shelf = (x, w) => {
    B(base, w, 2.6, 0.5, beamD, x, 1.3, Z0 + WT + 0.27);
    const cols = [0x8c2f2a, 0x2f5a7a, 0x3f6a3a, 0xb08a3a, 0x5a3a6a, 0x7a4a2a];
    for (let r = 0; r < 4; r++) {
      const y = 0.25 + r * 0.6;
      B(base, w - 0.16, 0.05, 0.42, wood, x, y, Z0 + WT + 0.3);
      let bx = x - w / 2 + 0.16, k = r * 3 + Math.round(x * 7);
      while (bx < x + w / 2 - 0.25) {
        const bw = 0.1 + ((k * 37) % 5) * 0.025, bh = 0.32 + ((k * 13) % 4) * 0.04;
        if ((k * 7) % 6 === 0) top.push(part(new THREE.CylinderGeometry(0.07, 0.09, 0.26, 6), 0x5f8f7a, { m: T(bx + 0.08, y + 0.16, Z0 + WT + 0.33) }));
        else B(base, bw, bh, 0.3, cols[k % cols.length], bx + bw / 2, y + 0.025 + bh / 2, Z0 + WT + 0.33);
        bx += bw + 0.02; k++;
      }
    }
    S(x - w / 2, x + w / 2, Z0 + WT, Z0 + WT + 0.55, 2.6);
  };
  shelf(-2.4, 2.0); shelf(2.4, 2.0); shelf(-6.2, 1.6);
  // герб между шкафами: щит со скрещёнными мечами
  B(base, 1.1, 1.3, 0.08, red, 0, 2.2, Z0 + WT + 0.2); B(base, 1.2, 0.08, 0.14, gold, 0, 2.86, Z0 + WT + 0.2);
  for (const sd of [-1, 1]) B(base, 0.08, 1.1, 0.12 + (sd > 0 ? 0.02 : 0), cream, 0, 2.2, Z0 + WT + 0.22, { rz: sd * 0.7 });
  // доска заданий на левой стене под галереей: пробковое поле, листки, карта
  const [bx0, bz0] = SPOT.board, bxw = -HX + WT + 0.2;
  B(base, 0.1, 1.5, 2.6, beam, bxw, 1.75, bz0); B(base, 0.06, 1.3, 2.4, 0xb98a5a, bxw + 0.05, 1.75, bz0);
  B(base, 0.08, 0.12, 2.0, gold, bxw + 0.07, 2.6, bz0, { glow: 0.3 });
  const notes = [[-0.85, 2.0, 0.32, 0.42, 0.06], [-0.4, 1.55, 0.3, 0.36, -0.05], [0.1, 2.0, 0.34, 0.3, 0.03], [0.55, 1.6, 0.28, 0.38, -0.08], [0.9, 2.05, 0.24, 0.3, 0.1], [-0.9, 1.4, 0.26, 0.3, 0.02]];
  for (const [dz, y, w, h, r] of notes) B(base, 0.02, h, w, paper, bxw + 0.09, y, bz0 + dz, { rz: r });
  B(base, 0.02, 0.6, 0.85, 0xd8c79a, bxw + 0.09, 1.55, bz0 + 0.15);
  // ковёр с мечами посреди зала
  B(base, 6.2, 0.03, 4.2, red, 0, 0.015, -4.4); B(base, 5.7, 0.05, 3.7, redD, 0, 0.025, -4.4); B(base, 5.3, 0.07, 3.3, red, 0, 0.035, -4.4);
  for (const sd of [-1, 1]) B(base, 0.16, 0.1 + (sd > 0 ? 0.02 : 0), 3.0, cream, 0, 0.05, -4.4, { ry: sd * 0.75 });
  // столы и лавки справа от входа
  const table = (x, z) => {
    B(base, 2.6, 0.1, 0.95, plank, x, 0.8, z);
    for (const [dx, dz] of [[-1.1, -0.35], [1.1, -0.35], [-1.1, 0.35], [1.1, 0.35]]) B(base, 0.1, 0.75, 0.1, beamD, x + dx, 0.38, z + dz);
    for (const sd of [-1, 1]) { B(base, 2.4, 0.08, 0.32, wood, x, 0.45, z + sd * 0.75); for (const dx of [-1, 1]) B(base, 0.08, 0.42, 0.25, beamD, x + dx, 0.21, z + sd * 0.75); }
    B(base, 0.07, 0.2, 0.07, cream, x + 0.5, 0.95, z); B(base, 0.04, 0.08, 0.04, glowC, x + 0.5, 1.09, z, { glow: 1 });
    S(x - 1.3, x + 1.3, z - 0.48, z + 0.48, 0.85);
    S(x - 1.2, x + 1.2, z + 0.59, z + 0.91, 0.49); S(x - 1.2, x + 1.2, z - 0.91, z - 0.59, 0.49);
  };
  table(3.9, -2.6); table(3.9, -5.6);
  // бочки и ящики
  const barrel = (arr, x, z, y = 0) => { arr.push(part(new THREE.CylinderGeometry(0.42, 0.38, 1.0, 10), 0x7b5a3c, { m: T(x, y + 0.5, z) }), part(new THREE.CylinderGeometry(0.44, 0.44, 0.07, 10), iron, { m: T(x, y + 0.75, z) }), part(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 10), iron, { m: T(x, y + 0.25, z) })); };
  const crate = (arr, x, z, s, y = 0, ry = 0) => { B(arr, s, s, s, 0xa06c44, x, y + s / 2, z, { ry }); B(arr, s + 0.03, 0.08, s + 0.03, beamD, x, y + s - 0.04, z, { ry }); };
  barrel(base, -6.9, -1.0); barrel(base, -6.0, -0.9); crate(base, -7.1, -8.6, 0.8, 0, 0.2); crate(base, -6.9, -8.4, 0.55, 0.8, 0.6);
  barrel(base, 4.2, Z0 + 1.0); crate(base, 5.2, Z0 + 0.9, 0.7, 0, 0.3);
  S(-7.4, -5.6, -1.45, -0.45, 1.0); S(-7.6, -6.5, -9.1, -8.0, 1.35); S(3.7, 5.7, Z0 + 0.4, Z0 + 1.5, 1.0);
  // на галерее: пара столов, ящики, бочка
  B(base, 2.0, 0.1, 0.8, plank, -3.0, BY + 0.8, Z0 + 1.2); B(base, 2.0, 0.1, 0.8, plank, 1.8, BY + 0.8, Z0 + 1.2);
  for (const x of [-3.9, -2.1, 0.9, 2.7]) B(base, 0.1, 0.78, 0.6, beamD, x, BY + 0.4, Z0 + 1.2);
  S(-4.0, -2.0, Z0 + 0.8, Z0 + 1.6, BY + 0.85); S(0.8, 2.8, Z0 + 0.8, Z0 + 1.6, BY + 0.85);
  crate(base, -6.8, -3.0, 0.8, BY); barrel(base, -6.8, -6.0, BY); S(-7.25, -6.35, -3.45, -2.55, BY + 0.8); S(-7.25, -6.35, -6.45, -5.55, BY + 1.0);
  // знамёна: большое на задней стене над галереей, малые — на перилах галереи
  const banner = (arr, x, y, z, w, h, ry = 0, d = 0.05) => {
    const fw = (dx, dy, ww, hh, c, dd, o = {}) => B(arr, ww, hh, dd, c, x + Math.cos(ry) * dx, y + dy, z - Math.sin(ry) * dx, { ry, ...o });
    fw(0, 0, w, h, red, d); fw(0, h / 2 + 0.06, w + 0.2, 0.1, beamD, d + 0.08);
    fw(0, 0, w - 0.12, 0.05, gold, d + 0.02, {}); fw(0, -h / 2 + 0.12, w - 0.12, 0.05, gold, d + 0.02);
    for (const sd of [-1, 1]) arr.push(part(box(0.09 * w, h * 0.55, d + (sd > 0 ? 0.06 : 0.09)), cream, { m: T(x, y + h * 0.04, z, 1, 1, 1, ry, sd * 0.66) }));
    arr.push(part(new THREE.ConeGeometry(w / 2, 0.45, 3).rotateX(Math.PI).scale(1, 1, 0.15), red, { m: T(x, y - h / 2 - 0.2, z, 1, 1, 1, ry) }));
  };
  banner(base, 0, 5.4, Z0 + WT + 0.22, 1.9, 2.6);
  for (const z of [-3.0, -6.0]) banner(base, GX + 0.12, BY - 0.9, z, 0.9, 1.4, Math.PI / 2, 0.04);
  banner(base, -1.7, BY - 0.85, GZ + 0.12, 0.9, 1.3); banner(base, 1.7, BY - 0.85, GZ + 0.12, 0.9, 1.3);
  // люстра: железное кольцо, свечи, цепи до балки
  {
    const lx = 0, ly = 5.4, lz = -4.6, R = 1.35;
    base.push(part(new THREE.TorusGeometry(R, 0.07, 6, 20).rotateX(Math.PI / 2), iron, { m: T(lx, ly, lz) }));
    base.push(part(new THREE.TorusGeometry(R * 0.55, 0.05, 6, 14).rotateX(Math.PI / 2), iron, { m: T(lx, ly + 0.05, lz) }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, x = lx + Math.cos(a) * R, z = lz + Math.sin(a) * R;
      B(base, 0.09, 0.26, 0.09, cream, x, ly + 0.17, z);
      base.push(part(new THREE.ConeGeometry(0.06, 0.18, 5), glowC, { glow: 1, m: T(x, ly + 0.38, z) }));
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4, l = Math.hypot(R, WH - 0.4 - ly - 0.6);
      const h = WH - 0.4 - ly - 0.6, dir = new THREE.Vector3(-Math.cos(a) * R, h, -Math.sin(a) * R).normalize();
      const g = box(0.04, l, 0.04).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      base.push(part(g, iron, { m: T(lx + Math.cos(a) * R / 2, ly + h / 2, lz + Math.sin(a) * R / 2) }));
    }
    B(base, 0.05, 1.0, 0.05, iron, lx, WH - 0.9, lz);
  }
  // настенные фонари внутри
  const sconce = (arr, x, y, z, nx, nz) => {
    B(arr, 0.08, 0.08, 0.35, beamD, x + nx * 0.17, y + 0.25, z + nz * 0.17, { ry: Math.atan2(nx, nz) });
    B(arr, 0.24, 0.3, 0.24, glowC, x + nx * 0.32, y, z + nz * 0.32, { glow: 1 });
    B(arr, 0.3, 0.06, 0.3, iron, x + nx * 0.32, y + 0.18, z + nz * 0.32);
  };
  for (const z of [-1.8, -8.6]) sconce(base, -HX + WT, 2.3, z, 1, 0);
  for (const z of [-1.0, -4.2, -7.4]) sconce(base, HX - WT, 2.6, z, -1, 0);
  for (const x of [-4.2, 4.2]) sconce(base, x, 2.2, Z0 + WT, 0, 1);
  for (const z of [-3.6, -7.6]) sconce(base, -HX + WT, BY + 1.9, z, 1, 0);
  // фермы под крышей: затяжка, бабка, подкосы
  for (const z of [Z0 + 0.4, -8.4, -4.6, -0.8]) {
    B(base, W - 0.3, 0.34, 0.3, beamD, 0, WH - 0.2, z);
    B(base, 0.3, RISE - 0.3, 0.3, beamD, 0, WH + (RISE - 0.3) / 2, z);
    const bx = HX * 0.5, by = RISE * 0.5 - 0.3, L = Math.hypot(bx, by);
    for (const sd of [-1, 1]) B(base, 0.22, L, 0.22, beamD, sd * bx / 2, WH + 0.3 + by / 2, z, { rz: -sd * Math.atan2(bx, by) });
  }

  // ================= крыша =================
  const ang = Math.atan2(RISE, HX), ov = 0.9, L = Math.hypot(HX, RISE) + ov, rz0 = Z0 - 0.7, rz1 = PZ + 0.5, rl = rz1 - rz0, rzc = (rz0 + rz1) / 2;
  for (const sd of [-1, 1]) {
    // скат от конька (0, WH+RISE) до свеса; u — вдоль ската, v — по нормали
    const ux = sd * Math.cos(ang), uy = -Math.sin(ang), vx = sd * Math.sin(ang), vy = Math.cos(ang);
    const mx = sd * (HX + ov * Math.cos(ang)) / 2, my = (WH + RISE + WH - ov * Math.sin(ang)) / 2;
    const at = (u, v) => [mx + ux * u + vx * v, my + uy * u + vy * v];
    const rz = -sd * ang;
    let [x, y] = at(0, 0.15); top.push(part(box(L, 0.3, rl), roofC, { m: T(x, y, rzc, 1, 1, 1, 0, rz) }));
    [x, y] = at(0, -0.05); top.push(part(box(L - 0.4, 0.1, rl - 0.2), ceil, { m: T(x, y, rzc, 1, 1, 1, 0, rz) }));
    for (let k = 0; k < 12; k++) { [x, y] = at(-L / 2 + (k + 0.6) * L / 12, 0.33); top.push(part(box(0.16, 0.1, rl + 0.04), roofD, { m: T(x, y, rzc, 1, 1, 1, 0, rz) })); }
  }
  top.push(part(box(0.55, 0.45, rl + 0.1), roofD, { m: T(0, WH + RISE + 0.3, rzc) }));   // конёк
  // фронтоны: передний над крыльцом (с балками и знаменем) и задний; внутренний — над передней стеной
  const gable = (z, d, c) => {
    const sh = new THREE.Shape(); sh.moveTo(-HX, 0); sh.lineTo(HX, 0); sh.lineTo(0, RISE); sh.closePath();
    top.push(part(new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false }).translate(0, WH, z - d / 2), c));
  };
  gable(PZ, 0.3, plaster); gable(Z0 + WT / 2, WT, plaster); gable(Z1 - WT / 2, WT, plaster);
  for (const sd of [-1, 1]) top.push(part(box(0.26, Math.hypot(HX, RISE) + 0.2, 0.34), beam, { m: T(sd * HX / 2, WH + RISE / 2, PZ + 0.05, 1, 1, 1, 0, sd * (Math.PI / 2 - ang)) }));
  top.push(part(box(0.26, RISE, 0.34), beam, { m: T(0, WH + RISE / 2, PZ + 0.05) }));
  for (const sd of [-1, 1]) top.push(part(box(0.2, RISE * 0.62, 0.32), beam, { m: T(sd * HX * 0.42, WH + RISE * 0.3, PZ + 0.05) }));
  // крыльцо: высокие столбы, затяжка на высоте стен, нижняя балка, подкосы, перила
  for (const x of [-HX, -OW - 0.2, OW + 0.2, HX]) {
    B(top, 0.42, WH, 0.42, beam, x, WH / 2, PZ - 0.1); S(x - 0.21, x + 0.21, PZ - 0.31, PZ + 0.11, WH);
  }
  B(top, W + 0.5, 0.4, 0.46, beam, 0, WH - 0.1, PZ - 0.1);
  B(top, W, 0.3, 0.36, beam, 0, OH + 0.4, PZ - 0.1);
  for (const x of [-HX, -OW - 0.2, OW + 0.2, HX]) for (const sd of [-1, 1]) if (Math.abs(x + sd * 0.8) < HX + 0.1) B(top, 0.16, 1.3, 0.2, beam, x + sd * 0.45, OH - 0.1, PZ - 0.1, { rz: -sd * 0.75 });
  for (const [x0, x1] of [[-HX, -OW - 0.2], [OW + 0.2, HX]]) {
    B(top, x1 - x0, 0.12, 0.14, beam, (x0 + x1) / 2, 1.0, PZ - 0.1); B(top, x1 - x0, 0.08, 0.1, beam, (x0 + x1) / 2, 0.15, PZ - 0.1);
    const n = Math.round((x1 - x0) / 0.4);
    for (let i = 1; i < n; i++) B(top, 0.07, 0.85, 0.07, beamD, x0 + ((x1 - x0) * i) / n, 0.57, PZ - 0.1);
    S(x0, x1, PZ - 0.2, PZ, 1.05);
  }
  // знамя на фронтоне и фонари у входа
  banner(top, 0, WH + 1.3, PZ + 0.36, 1.4, 2.3);
  for (const x of [-OW - 0.2, OW + 0.2]) sconce(top, x, 3.0, PZ + 0.11, 0, 1);
  sconce(top, -HX, 3.0, PZ + 0.11, 0, 1); sconce(top, HX, 3.0, PZ + 0.11, 0, 1);
  // дымоход
  B(top, 1.0, 3.0, 1.0, stone, -4.2, WH + RISE * 0.5 + 1.7, -8.0, { stone: 1 }); B(top, 1.2, 0.2, 1.2, stoneD, -4.2, WH + RISE * 0.5 + 3.25, -8.0, { stone: 1 });

  // ================= боковые навесы =================
  for (const sd of [-1, 1]) {
    const x0 = sd * HX, x1 = sd * (HX + 3.4), z0 = -1.4, z1 = sd < 0 ? -9.4 : -7.6, hIn = 4.4, hOut = 3.0;
    for (const z of [z0, (z0 + z1) / 2, z1]) { B(top, 0.26, hOut + 2, 0.26, beam, x1, (hOut - 2) / 2, z); S(Math.min(x1 - 0.13, x1 + 0.13), Math.max(x1 - 0.13, x1 + 0.13), z - 0.13, z + 0.13, hOut); }
    B(top, 0.26, 0.26, Math.abs(z1 - z0) + 0.3, beam, x1, hOut, (z0 + z1) / 2);
    const len = Math.hypot(x1 - x0, hIn - hOut) + 0.6, an = Math.atan2(hIn - hOut, Math.abs(x1 - x0));
    const lz = Math.abs(z1 - z0) + 0.9, mx = (x0 + x1) / 2 + sd * 0.25, my = (hIn + hOut) / 2 + 0.25 - 0.25 * Math.tan(an);
    top.push(part(box(len, 0.2, lz), roofC, { m: T(mx, my, (z0 + z1) / 2, 1, 1, 1, 0, -sd * an) }));
    for (let k = 0; k < 5; k++) { const u = (k - 2) * len / 5.5; top.push(part(box(0.14, 0.08, lz + 0.02), roofD, { m: T(mx + sd * u * Math.cos(an), my + 0.13 - u * Math.sin(an), (z0 + z1) / 2, 1, 1, 1, 0, -sd * an) })); }
    // под навесом: бочки, ящики, у левого — стойка с оружием
    barrel(top, x1 - sd * 0.8, z0 - 1.0, -0.6 * 0); crate(top, x1 - sd * 1.1, z1 + 1.0, 0.8, 0, 0.3); crate(top, x1 - sd * 0.9, z1 + 1.1, 0.5, 0.8, 0.8);
    S(Math.min(x1 - sd * 1.25, x1 - sd * 0.35), Math.max(x1 - sd * 1.25, x1 - sd * 0.35), z0 - 1.45, z0 - 0.55, 1.0);
    S(Math.min(x1 - sd * 1.55, x1 - sd * 0.65), Math.max(x1 - sd * 1.55, x1 - sd * 0.65), z1 + 0.55, z1 + 1.45, 1.3);
    if (sd < 0) {
      const rx = x0 - 0.5, rz = (z0 + z1) / 2 - 0.4;
      B(top, 0.12, 0.12, 2.6, beamD, rx, 1.5, rz); B(top, 0.12, 0.12, 2.6, beamD, rx, 0.5, rz);
      for (let i = 0; i < 6; i++) B(top, 0.06, 1.7, 0.06, i % 3 ? wood : 0xb9c2cb, rx - 0.05, 1.0, rz - 1.1 + i * 0.44, { rz: (i - 2.5) * 0.03 });
      S(rx - 0.15, rx + 0.15, rz - 1.3, rz + 1.3, 1.6);
    }
  }

  // ================= башня =================
  B(base, TW + 0.5, 4.0, TW + 0.5, stone, TX, 0.5, TZ, { stone: 1 });
  B(base, TW, TH - 2.5, TW, plaster, TX, 2.5 + (TH - 2.5) / 2, TZ);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B(base, 0.34, TH - 2.4, 0.34, beam, TX + sx * TW / 2, 2.4 + (TH - 2.4) / 2, TZ + sz * TW / 2);
  for (const y of [2.5, 5.6, 8.7, 11.8]) B(base, TW + 0.12, 0.24, TW + 0.12, beam, TX, y, TZ);
  for (const y of [6.8, 10.0]) { B(base, 0.7, 0.9, 0.1, glowC, TX, y, TZ + TW / 2 + 0.03, { glow: 0.85 }); B(base, 0.1, 0.9, 0.7, glowC, TX + TW / 2 + 0.03, y, TZ, { glow: 0.85 }); }
  S(TX - TW / 2 - 0.25, TX + TW / 2 + 0.25, TZ - TW / 2 - 0.25, TZ + TW / 2 + 0.25, TH);
  // смотровая площадка, перила, шатёр
  B(top, TW + 1.2, 0.25, TW + 1.2, plank, TX, TH, TZ);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B(top, 0.2, 2.4, 0.2, beam, TX + sx * (TW / 2 + 0.45), TH + 1.2, TZ + sz * (TW / 2 + 0.45));
  for (const sd of [-1, 1]) { B(top, TW + 1.1, 0.12, 0.12, beam, TX, TH + 1.0, TZ + sd * (TW / 2 + 0.45)); B(top, 0.12, 0.12, TW + 1.1, beam, TX + sd * (TW / 2 + 0.45), TH + 1.0, TZ); }
  top.push(part(new THREE.ConeGeometry(TW * 0.98, 3.0, 4).rotateY(Math.PI / 4), roofC, { m: T(TX, TH + 3.9, TZ) }));
  B(top, 0.12, 1.4, 0.12, iron, TX, TH + 5.9, TZ);
  banner(top, TX, 7.2, TZ + TW / 2 + 0.2, 1.3, 2.4);

  // ================= двор: знамёна на столбах с фонарями =================
  for (const sd of [-1, 1]) {
    const x = sd * 5.0, z = PZ + 1.4;
    B(top, 0.24, 7.0, 0.24, beam, x, 1.5, z); B(top, 1.5, 0.18, 0.18, beam, x - sd * 0.55, 4.8, z);
    banner(top, x - sd * 0.75, 3.6, z + 0.05, 1.0, 2.0);
    B(top, 0.06, 0.4, 0.06, iron, x + sd * 0.0, 4.5, z + 0.3); B(top, 0.28, 0.36, 0.28, glowC, x, 4.15, z + 0.3, { glow: 1 }); B(top, 0.34, 0.06, 0.34, iron, x, 4.36, z + 0.3);
    S(x - 0.15, x + 0.15, z - 0.15, z + 0.15, 5.0);
  }

  // ================= леса на время стройки =================
  for (const [x, z, h] of [[-HX - 0.6, Z0 - 0.6, 8], [HX + 0.6, Z0 - 0.6, 8], [-HX - 0.6, PZ + 0.5, 8], [HX + 0.6, PZ + 0.5, 8], [0, PZ + 0.5, 8], [-HX - 0.6, -5, 8], [HX + 0.6, -5, 8], [TX + TW / 2 + 0.7, TZ - TW / 2 - 0.7, 14.5], [TX + TW / 2 + 0.7, TZ + TW / 2 + 0.7, 14.5]])
    scaf.push(part(box(0.14, h, 0.14), beamD, { m: T(x, h / 2 - 0.5, z) }));
  for (const y of [1.8, 3.6, 5.4, 7.2]) {
    scaf.push(part(box(W + 1.3, 0.1, 0.1), beamD, { m: T(0, y, PZ + 0.5) }), part(box(W + 1.3, 0.1, 0.1), beamD, { m: T(0, y, Z0 - 0.6) }));
    for (const sd of [-1, 1]) scaf.push(part(box(0.1, 0.1, D + PZ + 1.2), beamD, { m: T(sd * (HX + 0.6), y, (Z0 + PZ) / 2) }));
    scaf.push(part(box(W + 1.4, 0.06, 0.6), plank, { m: T(0, y + 0.08, PZ + 0.5) }));
  }
  for (const y of [9, 11, 13]) scaf.push(part(box(0.1, 0.1, TW + 1.4), beamD, { m: T(TX + TW / 2 + 0.7, y, TZ) }));
  for (let i = 0; i < 4; i++) scaf.push(part(new THREE.CylinderGeometry(0.17, 0.17, 2.4, 6), plank, { m: T(-HX - 1.6, 0.1 + (i === 3 ? 0.3 : 0), 0.8 + (i === 3 ? 0.2 : i * 0.38), 1, 1, 1, 0.2, Math.PI / 2) }));

  return { base, top, scaf, solids };
}
