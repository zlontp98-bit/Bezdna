import { terrainAt } from './terrain.js';

// Твёрдые объекты поверх ландшафта: столбы, плиты, арки.
// На них можно стоять и запрыгивать, под арками — проходить.
const CELL = 6;
export const COL_WALL = 40; // насколько «выше ног» считается тело колонны
const grid = new Map();
export let hitSolid = false; // последняя точка опирается на объект, а не на землю
export let ceiling = 1e9;    // низ ближайшего объекта над головой
export let lastSolid = null; // объект, на котором стоит последняя точка (для наклона)

// есть ли на этом месте твёрдая постройка (плита, столб, арка): растения на неё не ставим
export function blockedByStone(x, z, rad) {
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return false;
  for (const s of list) {
    if (s.field) continue; // валуны и острова — отдельные модели, их растения уже обходят
    if (Math.hypot(x - s.x, z - s.z) < s.rad + rad) return true;
  }
  return false;
}

function insert(s, rad) {
  s.rad = rad;
  for (let cx = Math.floor((s.x - rad) / CELL); cx <= Math.floor((s.x + rad) / CELL); cx++)
    for (let cz = Math.floor((s.z - rad) / CELL); cz <= Math.floor((s.z + rad) / CELL); cz++) {
      const k = cx + ',' + cz;
      (grid.get(k) || grid.set(k, []).get(k)).push(s);
    }
}
// убрать объект из сетки совсем (редактор глыб: пересобранная глыба заменяет старую)
export function removeSolid(s) {
  s.off = true;
  const rad = s.rad;
  for (let cx = Math.floor((s.x - rad) / CELL); cx <= Math.floor((s.x + rad) / CELL); cx++)
    for (let cz = Math.floor((s.z - rad) / CELL); cz <= Math.floor((s.z + rad) / CELL); cz++) {
      const l = grid.get(cx + ',' + cz), i = l ? l.indexOf(s) : -1;
      if (i >= 0) l.splice(i, 1);
    }
}
export function addCyl(x, z, r, top, bottom = -1e9, climb = false, soft = false) {
  insert({ x, z, r, top, bottom, box: false, climb, soft }, r);
}
// Колонна с меняющимся по высоте радиусом и осью (острова, столбы): одна запись вместо стопки цилиндров —
// иначе на каждую точку опоры приходились десятки проверок. fn(y) → {x, z, r}; тело — от bottom до bodyTop,
// выше него — шапка (отдельная карта высот), ниже — ничего.
// shape(x, z, y) → внутри ли тела (точная форма модели с рёбрами); без неё — круг fn(y)
export function addColumn(fn, rmax, x, z, capTop, bodyTop, bottom, soft = false, shape = null) {
  insert({ x, z, r: rmax, col: fn, shape, top: capTop, bodyTop, bottom, box: false, climb: true, soft }, rmax);
}
function colIn(s, x, z, y) {
  if (s.shape) return s.shape(x, z, y);
  const c = s.col(y);
  return (x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r;
}
// Верх произвольной модели (валун, островок): треугольники в мире растеризуются
// в маленькую карту высот, поэтому опора совпадает с картинкой по построению.
// tris — плоский массив x,y,z по три вершины на треугольник.
// soft — мелочь, которую камера не считает преградой (перелетает, а не упирается);
// hang — модель висит (камень, торчащий из стены): под ней можно пройти
// slope — верх наклонный: по нему можно скользить (нормаль берётся из карты высот плиты);
// under — высота низа плиты: ниже неё проходят под ней (для висящих в воздухе плит)
// full — все треугольники модели (верх, бока, низ). Если даны, опора строится по всему телу:
// в каждой клетке верх = самая высокая точка модели, низ = самая низкая. Так выпуклые бока
// твёрдые там, где их видно, а под скруглённым низом можно пройти — без невидимых стен.
export function addMeshTop(tris, cell = 0.25, { soft = false, hang = false, slope = false, under, climb = false, roof = false, full = null } = {}) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9;
  for (let i = 0; i < tris.length; i += 3) {
    x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]);
    z0 = Math.min(z0, tris[i + 2]); z1 = Math.max(z1, tris[i + 2]);
    y0 = Math.min(y0, tris[i + 1]);
  }
  if (full) for (let i = 0; i < full.length; i += 3) {
    x0 = Math.min(x0, full[i]); x1 = Math.max(x1, full[i]);
    z0 = Math.min(z0, full[i + 2]); z1 = Math.max(z1, full[i + 2]);
    y0 = Math.min(y0, full[i + 1]);
  }
  const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
  const f = new Float32Array(nx * nz).fill(-1e9);
  const bf = full ? new Float32Array(nx * nz).fill(1e9) : null;
  rasterTris(tris, f, null, x0, z0, nx, nz, cell);
  if (full) rasterTris(full, f, bf, x0, z0, nx, nz, cell);
  const cxm = (x0 + x1) / 2, czm = (z0 + z1) / 2;
  const s = { x: cxm, z: czm, field: f, bf, x0, z0, nx, nz, cell, top: -1e9, bottom: under !== undefined ? under : hang || full ? y0 : -1e9, soft, off: false, slope, climb, roof };
  insert(s, Math.hypot(x1 - x0, z1 - z0) / 2 + cell);
  return s; // off = true — объекта сейчас нет (разбитый валун)
}
// треугольники → карта верха f (максимум) и, если дана, карта низа bf (минимум)
function rasterTris(tris, f, bf, x0, z0, nx, nz, cell) {
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-7) continue; // ребром к нам — это бок, не верх
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * cell;
        const u = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / det;
        const v = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / det;
        if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
        const y = ay + (by - ay) * u + (cy - ay) * v;
        const k = j * nx + i;
        if (y > f[k]) f[k] = y;
        if (bf && y < bf[k]) bf[k] = y;
      }
    }
  }
}
// низ модели в точке: по карте низа (если есть), иначе общий низ
function bottomAt(s, x, z) {
  const bf = s.bf;
  if (!bf) return s.bottom;
  const fx = (x - s.x0) / s.cell, fz = (z - s.z0) / s.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= s.nx - 1 || j >= s.nz - 1) return s.bottom;
  const k = j * s.nx + i;
  const a = bf[k], b = bf[k + 1], c = bf[k + s.nx], d = bf[k + s.nx + 1];
  // на краю берём самый низкий из известных углов — край твёрдый на всю высоту
  if (a > 1e8 || b > 1e8 || c > 1e8 || d > 1e8) {
    const tx = fx - i, tz = fz - j, m = tz < 0.5 ? (tx < 0.5 ? a : b) : (tx < 0.5 ? c : d);
    return m > 1e8 ? s.bottom : m;
  }
  const tx = fx - i, tz = fz - j;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
function fieldAt(s, x, z) {
  const fx = (x - s.x0) / s.cell, fz = (z - s.z0) / s.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= s.nx - 1 || j >= s.nz - 1) return -1e9;
  const f = s.field, k = j * s.nx + i;
  const a = f[k], b = f[k + 1], c = f[k + s.nx], d = f[k + s.nx + 1];
  // на самом краю (часть углов вне модели) берём ближайший угол: край опоры совпадает с краем
  // модели с точностью до полклетки (раньше брали любой угол — опора торчала на целую клетку наружу)
  if (a < -1e8 || b < -1e8 || c < -1e8 || d < -1e8) {
    const tx = fx - i, tz = fz - j;
    return tz < 0.5 ? (tx < 0.5 ? a : b) : (tx < 0.5 ? c : d);
  }
  const tx = fx - i, tz = fz - j;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export function addBox(x, z, hx, hz, rot, top, bottom = -1e9) {
  const s = { x, z, hx, hz, c: Math.cos(rot), s: Math.sin(rot), top, bottom, box: true };
  insert(s, Math.hypot(hx, hz));
  return s;
}

// Высота опоры под точкой для героя, чьи ноги на высоте y
export function groundAt(x, z, y, forCamera = false) {
  let h = terrainAt(x, z, y);   // в туннеле под скалой — его пол
  hitSolid = false; ceiling = 1e9; lastSolid = null;
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return h;
  for (const s of list) {
    if (s.off || (forCamera && s.soft)) continue;
    if (s.col) { // тело колонны: внутри — стена (опора на 2.5 м выше ног), шапку даёт её карта высот
      if (y >= s.bodyTop || y + 1.3 < s.bottom) continue;
      if (!colIn(s, x, z, Math.max(y, s.bottom))) continue;
      // внутри тела — отвесная стена «до неба»: на неё нельзя ни шагнуть, ни вылезти. Раньше тут было
      // +2.5 м, и герой, попав ногами в тело столба, «поднимался» по 2.5 м за шаг — бросок на десятки метров
      if (y + COL_WALL > h) { h = y + COL_WALL; hitSolid = true; lastSolid = s; }
      continue;
    }
    const dx = x - s.x, dz = z - s.z;
    let top = s.top;
    if (s.field) {
      top = fieldAt(s, x, z);
      if (top < -1e8) continue;
    } else if (s.box) {
      if (Math.abs(dx * s.c - dz * s.s) > s.hx || Math.abs(dx * s.s + dz * s.c) > s.hz) continue;
    } else if (dx * dx + dz * dz > s.r * s.r) continue;
    if (forCamera && s.roof && y + 1.3 < top) continue; // крыши (арки, тоннели) камера не считает: иначе под ними она «сходит с ума»
    const bot = s.bf ? bottomAt(s, x, z) : s.bottom;
    if (y + 1.3 < bot) { if (bot < ceiling) ceiling = bot; continue; } // проходим под ним
    // на уровне тела висящая плита — стена: отдаём её верх, и шаг/прыжок внутрь не пройдёт,
    // пока ноги не окажутся почти у верха (см. Player.tryMove)
    if (top > h) { h = top; hitSolid = true; lastSolid = s; }
  }
  return h;
}

// верх объекта в точке (−1e9 — точка вне его): для карт высот и для цилиндров
export const fieldTop = (s, x, z, y) => {
  if (s.field) return fieldAt(s, x, z);
  if (s.box) return -1e9;
  if (s.col) return colIn(s, x, z, y ?? s.bodyTop - 1) ? s.top : -1e9;
  return (x - s.x) ** 2 + (z - s.z) ** 2 <= s.r * s.r ? s.top : -1e9;
};
// Лазание по бокам скал (climb: true): есть ли в точке (x, y, z) сама скала — а не только её верх?
export function rockAt(x, z, y) {
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return null;
  for (const s of list) {
    if (s.off || !s.climb) continue;
    const t = fieldTop(s, x, z, y);
    if (t > -1e8 && y < t && y > (s.bf ? bottomAt(s, x, z) : s.bottom)) return s;
  }
  return null;
}
// Стены шахт (ниже −186 м): это не глыбы, а сама порода (terrainAt). Для лазания считаем её «скалой»:
// камень там, где пол ближайшей пустоты выше точки. Верх грани — пол следующей пустоты над точкой.
export const MINE_ROCK = { mine: true, climb: true, bottom: -1e9, y: 0 };
const mineRockIn = (x, z, y) => y < -186 && x * x + z * z > 4900 && terrainAt(x, z, y) > y + 0.6;
// то же, что rockAt, но со стенами шахт — только для лазания
export function climbRockAt(x, z, y) {
  const s = rockAt(x, z, y);
  if (s) return s;
  if (mineRockIn(x, z, y)) { MINE_ROCK.y = y; return MINE_ROCK; }
  return null;
}
export function climbTop(s, x, z) {
  if (!s.mine) return fieldTop(s, x, z);
  for (let yy = s.y; yy < s.y + 40; yy += 0.25) { const t = terrainAt(x, z, yy); if (t <= yy + 0.6) return t; }
  return 1e9;   // стена до самого свода — вылезти наверх некуда
}
// Нормаль грани скалы (наружу) в точке на высоте y: по тому, с каких сторон вокруг есть камень
export function rockNormal(x, z, y, out, rad = 0.55, at = rockAt) {
  let sx = 0, sz = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    if (at(x + c * rad, z + sn * rad, y)) { sx -= c; sz -= sn; }
  }
  const l = Math.hypot(sx, sz);
  if (l < 0.2) return false;
  out.x = sx / l; out.z = sz / l;
  return true;
}
// Грань скалы впереди по направлению (dx, dz): ближайшая точка камня на высоте y в пределах 1.1 м
const _rn = { x: 0, z: 0 };
export function rockFace(x, z, y, dx, dz, out, at = rockAt, top = fieldTop) {
  for (let d = 0; d <= 1.1; d += 0.1) {
    const s = at(x + dx * d, z + dz * d, y);
    if (!s) continue;
    const bd = Math.max(0, d - 0.08), bx = x + dx * bd, bz = z + dz * bd;
    if (!rockNormal(bx, bz, y, _rn, 0.55, at)) { _rn.x = -dx; _rn.z = -dz; }
    out.s = s; out.bx = bx; out.bz = bz; out.nx = _rn.x; out.nz = _rn.z;
    out.top = Math.max(top(s, bx - _rn.x * 0.4, bz - _rn.z * 0.4), top(s, bx + dx * 0.4, bz + dz * 0.4));
    return true;
  }
  return false;
}

// Стоим на наклонной плите?
export function solidSloped() { return hitSolid && !!lastSolid && !!lastSolid.slope; }
// Нормаль наклонной плиты в точке. У края плиты берём одностороннюю разность, а не «плоско»:
// иначе у нижнего края жёлоба скольжение обрывалось бы за долю метра до полёта.
export function solidNormal(x, z, out, e = 0.3) {
  const s = lastSolid;
  if (!s || !s.slope) return false;
  const c = fieldAt(s, x, z);
  if (c < -1e8) return false;
  const a = fieldAt(s, x - e, z), b = fieldAt(s, x + e, z), d = fieldAt(s, x, z - e), f = fieldAt(s, x, z + e);
  const gx = a > -1e8 && b > -1e8 ? (b - a) / (2 * e) : b > -1e8 ? (b - c) / e : a > -1e8 ? (c - a) / e : 0;
  const gz = d > -1e8 && f > -1e8 ? (f - d) / (2 * e) : f > -1e8 ? (f - c) / e : d > -1e8 ? (c - d) / e : 0;
  out.set(-gx, 1, -gz).normalize();
  return true;
}

// Твёрдые постройки (плиты, столбы, арки) вокруг точки с их высотами — для проверки, не мешают ли они
// чему-то построенному на другой высоте. Плиты-карты высот (камни, острова) не включены.
export function solidsNear(x, z, rad) {
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)), out = [];
  if (!list) return out;
  for (const s of list) {
    if (s.field) continue;
    if (Math.hypot(x - s.x, z - s.z) < s.rad + rad) out.push({ top: s.top, bottom: s.bottom, x: s.x, z: s.z });
  }
  return out;
}

// Занята ли точка (x, y, z) камнем: рельефом или твёрдым объектом (по его настоящему телу).
// Для камеры: она ищет ближайшую к герою точку луча, где начинается камень.
// soft (мелочь) не считается; pad — запас над землёй, м.
// soft = true — считать и мелкие камни (для камеры: иначе валун у камеры закрывал героя)
export function solidAt(x, y, z, pad = 0, soft = false) {
  if (y < terrainAt(x, z, y) + pad) return true;
  return !!solidObjectAt(x, y, z, pad, soft);
}

// Как solidAt, но возвращает сам объект. Рельеф проверяется отдельно.
export function solidObjectAt(x, y, z, pad = 0, soft = false, accept = null) {
  const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  if (!list) return null;
  for (const s of list) {
    if (s.off || (s.soft && !s.col && !soft) || (accept && !accept(s))) continue;
    if (s.col) {
      if (y >= s.bottom && y <= s.bodyTop && colIn(s, x, z, y)) return s;
      continue;
    }
    let top = s.top;
    const dx = x - s.x, dz = z - s.z;
    if (s.field) { top = fieldAt(s, x, z); if (top < -1e8) continue; }
    else if (s.box) { if (Math.abs(dx * s.c - dz * s.s) > s.hx || Math.abs(dx * s.s + dz * s.c) > s.hz) continue; }
    else if (dx * dx + dz * dz > s.r * s.r) continue;
    if (y > top + pad) continue;
    const bot = s.bf ? bottomAt(s, x, z) : s.bottom;
    if (y >= bot - pad) return s;
  }
  return null;
}
