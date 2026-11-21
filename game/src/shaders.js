import * as THREE from '../vendor/three.min.js';

// Цвета задаём сразу «как на экране», без пересчёта — так дешевле и предсказуемее
THREE.ColorManagement.enabled = false;

// Общие для всех материалов значения: свет, туман, время.
// Один объект на всё — меняем в одном месте, обновляется везде.
// телефон (или #lite в адресе для проверки): упрощённые шейдеры земли и травы
export const LITE = matchMedia('(pointer: coarse)').matches || location.search.includes('lite');
export const U = {
  uSun: { value: new THREE.Vector3(0.62, 0.40, 0.42).normalize() },
  uSunCol: { value: new THREE.Color(0.64, 0.55, 0.40) },
  uAmbHi: { value: new THREE.Color(0.40, 0.48, 0.62) },
  uAmbLo: { value: new THREE.Color(0.25, 0.24, 0.31) },
  uFogCol: { value: new THREE.Color(0.80, 0.88, 0.93) },
  uAbyssA: { value: new THREE.Color(0.33, 0.45, 0.53) },
  uAbyssB: { value: new THREE.Color(0.17, 0.30, 0.38) },
  uFogDen: { value: 0.0021 },
  uTime: { value: 0 },
  uSat: { value: 1 },
  uZenith: { value: new THREE.Color(0.22, 0.47, 0.86) },
  uShadow: { value: null },
  uShadowH: { value: null },
  uWet: { value: null }, // мокрые скалы у водопадов: r — сила, g/b — от какой до какой высоты (см. waterfall.js)
  uHmap: { value: null },
  uExt: { value: 232 },
  uCenter: { value: new THREE.Vector3() },
  uPlayer: { value: new THREE.Vector3() },
  uNoise: { value: null },
  uDetail: { value: null },
  uRockWall: { value: null }, uRockPlain: { value: null }, uGround: { value: null }, uRockMtn: { value: null }, uGrass: { value: null }, uPath: { value: null },
  uLeaf: { value: null }, uBark: { value: null }, uWater: { value: null },
  uLure: { value: new THREE.Vector4(0, -1e4, 0, 0) }, // фонарик героя: где он и насколько ярко светит
  // Свет от ближайших к камере кристаллов и грибов (main.js каждые ~0.2 с выбирает самые близкие):
  // xyz — где, w — радиус света; цвет уже умножен на яркость. Настоящих источников света в сцене нет —
  // это одна формула в общем шейдере, так что на телефоне это дёшево.
  uGlowP: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -1e4, 0, 1)) },
  uGlowC: { value: Array.from({ length: 8 }, () => new THREE.Color(0, 0, 0)) },
  uGlowB: { value: new THREE.Vector4(0, -1e4, 0, 0) }, // сфера, в которой все огоньки (центр, радиус)
};
export const GLOW_N = LITE ? 4 : 8;
const LAKE_Y = -175.0; // уровень озера (terrain.js LAKE.level), для лежащего тумана

// Шум для шейдеров: заранее посчитанная гладкая шумовая текстура с мип-уровнями.
// Одна выборка вместо четырёх хешей на вызов, и вдали шум сам сглаживается — без ряби.
// 256×256 текселей, 4 текселя на ячейку, повтор через 64 ячейки.
{
  const N = 256, C = 64, S = N / C;
  let a = 0x9e3779b9;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const lat = new Float32Array(C * C);
  for (let i = 0; i < C * C; i++) lat[i] = rnd();
  const data = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const y = j / S, j0 = Math.floor(y), fy0 = y - j0, fy = fy0 * fy0 * (3 - 2 * fy0);
    const y0 = j0 % C, y1 = (j0 + 1) % C;
    for (let i = 0; i < N; i++) {
      const x = i / S, i0 = Math.floor(x), fx0 = x - i0, fx = fx0 * fx0 * (3 - 2 * fx0);
      const x0 = i0 % C, x1 = (i0 + 1) % C;
      const v0 = lat[y0 * C + x0] + (lat[y0 * C + x1] - lat[y0 * C + x0]) * fx;
      const v1 = lat[y1 * C + x0] + (lat[y1 * C + x1] - lat[y1 * C + x0]) * fx;
      data[j * N + i] = Math.round((v0 + (v1 - v0) * fy) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  U.uNoise.value = tex;
}

// Текстура деталей грунта и камня: одна маленькая (256×256) повторяющаяся картинка,
// в четырёх каналах — четыре разных рисунка, так что одна выборка даёт сразу всё:
//  R — «камушки»: 1 в середине ячейки, 0 на границе;  G — расстояние до трещины между ячейками;
//  B — мягкие пятна;  A — случайное число ячейки (у каждого камушка свой оттенок).
// Рисунок строится по ячейкам с заворотом через край, поэтому швов при повторе нет.
{
  const N = 256, C = 16, S = N / C;
  let a = 0x51ed270b;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const px = new Float32Array(C * C), py = new Float32Array(C * C), id = new Float32Array(C * C);
  for (let i = 0; i < C * C; i++) { px[i] = 0.15 + rnd() * 0.7; py[i] = 0.15 + rnd() * 0.7; id[i] = rnd(); }
  const B = 8, lat = new Float32Array(B * B), lat2 = new Float32Array(B * B * 16);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  for (let i = 0; i < lat2.length; i++) lat2[i] = rnd();
  const vn = (L, n, x, y) => {
    const i0 = Math.floor(x), j0 = Math.floor(y), fx = x - i0, fy = y - j0, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const g = (i, j) => L[((j % n + n) % n) * n + ((i % n + n) % n)];
    return (g(i0, j0) * (1 - u) + g(i0 + 1, j0) * u) * (1 - v) + (g(i0, j0 + 1) * (1 - u) + g(i0 + 1, j0 + 1) * u) * v;
  };
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / S, y = (j + 0.5) / S, cx = Math.floor(x), cy = Math.floor(y);
    let f1 = 9, f2 = 9, who = 0;
    for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const k = ((cy + b + C) % C) * C + ((cx + c + C) % C);
      const d = Math.hypot(cx + c + px[k] - x, cy + b + py[k] - y);
      if (d < f1) { f2 = f1; f1 = d; who = k; } else if (d < f2) f2 = d;
    }
    const o = (j * N + i) * 4;
    data[o] = Math.round(255 * Math.max(0, 1 - f1 * 1.5));
    data[o + 1] = Math.round(255 * Math.min(1, (f2 - f1) * 1.6));
    data[o + 2] = Math.round(255 * (vn(lat, B, x * B / C, y * B / C) * 0.65 + vn(lat2, B * 4, x * B * 4 / C, y * B * 4 / C) * 0.35));
    data[o + 3] = Math.round(255 * id[who]);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  U.uDetail.value = tex;
}

// Нарисованные текстуры скал и земли (папка assets). Пока они грузятся, вместо них —
// однотонная заглушка нужного цвета, так что кадр никогда не бывает чёрным.
// Бесшовные: накладываются плиткой; стена 1024², остальные 512² (всего ~8 МБ видеопамяти).
{
  const fb = (r, g, b) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  U.uRockWall.value = fb(158, 115, 83); U.uRockPlain.value = fb(168, 117, 87); U.uGround.value = fb(148, 111, 52); U.uRockMtn.value = fb(150, 135, 140); U.uGrass.value = fb(110, 150, 40); U.uPath.value = fb(180, 135, 80);
  U.uLeaf.value = fb(110, 160, 40); U.uBark.value = fb(140, 90, 60); U.uWater.value = fb(40, 140, 160);
}
export function loadTerrainTextures() {
  const files = { uRockWall: 'rock_wall', uRockPlain: 'rock_plain', uGround: 'ground', uRockMtn: 'rock_mtn', uGrass: 'grass', uPath: 'path', uLeaf: 'leaf', uBark: 'bark', uWater: 'water' };
  return Promise.all(Object.entries(files).map(([u, f]) => new Promise((done) => {
    const im = new Image();
    im.onload = () => {
      const t = new THREE.Texture(im);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true; t.anisotropy = 4; // под косым углом (стены, дальняя земля) картинка не мылится
      t.needsUpdate = true;
      U[u].value = t;
      done();
    };
    im.onerror = done; // не загрузилась — остаётся заглушка
    im.src = './assets/' + f + '.jpg';
  })));
}

// Лавовые поля шахт (mines.js FIELDS): центр, полуоси вдоль/поперёк, направление длинной оси, уровень лавы
export const LAVA_POOLS = [
  { x: 43.5, z: -138, a: 42, b: 14, ux: 0.915, uz: 0.404, y: -221 },
  { x: 145, z: -137, a: 18, b: 13, ux: 1, uz: 0, y: -240 },
  { x: 146, z: 106, a: 18, b: 15, ux: 1, uz: 0, y: -298 },
  { x: -163, z: -52, a: 30, b: 20, ux: 0, uz: 1, y: -211 },
];
const f1 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
const LAVA_GLSL = LAVA_POOLS.map((L, i) => `  P = vec4(${f1(L.x)}, ${f1(L.z)}, ${f1(L.a)}, ${f1(L.b)}); Q = vec3(${f1(L.ux)}, ${f1(L.uz)}, ${f1(L.y)});
  r = w.xz - P.xy; e = length(vec2(dot(r, Q.xy), dot(r, vec2(-Q.y, Q.x))) / P.zw); k = 1.0 - smoothstep(0.9, 1.25, e);
  if (k > best) { best = k; ly = Q.z; }`).join('\n');

export const COMMON = /* glsl */ `
uniform vec3 uSun, uSunCol, uAmbHi, uAmbLo, uFogCol, uAbyssA, uAbyssB;
uniform float uFogDen, uTime, uExt, uSat;
uniform vec3 uZenith;
uniform vec4 uLure;
#define GLOW_N ${GLOW_N}
uniform vec4 uGlowP[8]; uniform vec3 uGlowC[8]; uniform vec4 uGlowB;
uniform sampler2D uShadow, uShadowH, uNoise, uDetail, uLeaf, uBark, uWater, uWet;

// общая цветокоррекция стиля
vec3 grade(vec3 c){ return mix(vec3(dot(c, vec3(0.3,0.59,0.11))), c, uSat); }
// гладкий шум 0..1 с ячейкой 1×1 (см. текстуру uNoise)
float vnoise(vec2 p){ return texture2D(uNoise, p * (1.0/64.0) + 0.5/256.0).r; }
// Запечённые тени (скалы + кроны деревьев), одна выборка из текстуры
float shadowAt(vec2 xz){
  float s = texture2D(uShadow, xz/(2.0*uExt)+0.5).r;
  float e = max(abs(xz.x), abs(xz.y));
  return mix(s, 1.0, smoothstep(uExt-18.0, uExt-2.0, e));
}
// Тень для точки в пространстве. Карта uShadow — тень у самой земли; а предмет, стоящий выше
// линии загораживания (uShadowH — высота, выше которой солнце уже видно), освещён, даже если земля
// под ним в тени. Иначе острова, уступы и деревья над дном шахты были чёрными от тени дна.
float shadowAt3(vec3 w){
  float s = shadowAt(w.xz);
  float L = texture2D(uShadowH, w.xz/(2.0*uExt)+0.5).r * 320.0 - 220.0;
  return max(s, smoothstep(L + 0.3, L + 3.5, w.y));
}
// Мягкий «мультяшный» свет: тёплое солнце, холодная тень
vec3 shade(vec3 alb, vec3 n, float sh){
  float lit = smoothstep(-0.18, 0.55, dot(n, uSun)) * sh;
  vec3 amb = mix(uAmbLo, uAmbHi, n.y*0.5+0.5);
  // слабый контровой свет с противоположной стороны, чтобы теневые склоны не чернели
  float back = max(dot(n, normalize(vec3(-uSun.x, 0.3, -uSun.z))), 0.0);
  return alb * (amb + uSunCol * lit + uAmbHi * back * 0.35);
}
// Нарисованная вода: ОДИН узор для ручья и озёр. Мировые координаты, один масштаб, одно течение
// (к центру провала), поэтому на стыке ручья и озера рисунок не рвётся: оно продолжается.
// speed — скорость течения: у спокойного русла и озера одинаковая, на порогах больше.
vec3 waterTex(vec2 xz, float speed){
  vec2 fl = -normalize(xz + 1e-3);              // течёт к центру
  vec2 side = vec2(-fl.y, fl.x);
  vec2 q = vec2(dot(xz, side), dot(xz, fl)) * 0.075 - vec2(0.0, uTime * speed);
  vec3 a = texture2D(uWater, q).rgb;
  vec3 b = texture2D(uWater, q * vec2(-0.53, 0.53) + vec2(0.31, -uTime * speed * 0.55)).rgb; // второй слой чуть другим масштабом и медленнее
  return a * 0.62 + b * 0.38;
}
// Воздух шахт: тёплая тёмная дымка в ходах; в Красной пропасти (центр 150, −25, полуоси 52 × 46 — как в
// mines.js CHASM) — красный свет снизу и лежащий красный туман у дна (−322 м): плотность по высоте —
// экспонента, её интеграл вдоль луча считается точно, без шагов.
// насколько точка в лавовой пещере (0..1) и уровень лавы в ней
float lavaIn(vec3 w, out float ly){
  vec4 P; vec3 Q; vec2 r; float e, k, best = 0.0; ly = -1000.0;
${LAVA_GLSL}
  return best;
}
vec3 mineFog(vec3 c, vec3 w, float d){
  vec2 C = vec2(150.0, -25.0), R = vec2(52.0, 46.0);
  float ce = length((w.xz - C) / R);
  float inCh = 1.0 - smoothstep(0.92, 1.3, ce);
  // свет снизу: чем ближе к туману, тем краснее и ярче (стены подсвечены как от лавы)
  float red = inCh * (0.12 * smoothstep(-170.0, -240.0, w.y) + 0.9 * smoothstep(-240.0, -318.0, w.y));
  c += (c*1.6 + 0.04) * vec3(1.0, 0.22, 0.07) * red * 1.3;
  // в пропасти воздух — светящаяся красная мгла: дальнее тонет в красном, ближнее — тёмный силуэт
  float den = mix(0.042, 0.0085, inCh);
  vec3 fc = mix(vec3(0.04, 0.03, 0.034), mix(vec3(0.30, 0.06, 0.04), vec3(0.85, 0.18, 0.06), smoothstep(-200.0, -312.0, w.y)), inCh);
  // лавовая пещера: стены подсвечены снизу оранжевым, воздух — горячая дымка, над лавой марево
  float ly, inLv = lavaIn(w, ly);
  if (inLv > 0.0) {
    float hot = smoothstep(ly + 55.0, ly + 1.0, w.y);
    c += (c * 0.9 + 0.03) * vec3(1.0, 0.45, 0.12) * inLv * (0.3 + 0.8 * hot * hot);
    den = mix(den, 0.0095, inLv);
    fc = mix(fc, mix(vec3(0.12, 0.05, 0.03), vec3(0.62, 0.24, 0.07), smoothstep(ly + 45.0, ly + 2.0, w.y)), inLv);
  }
  c = mix(c, fc, 1.0 - exp(-d * den));
  if (inLv > 0.0) {
    float H = 1.6, ya = cameraPosition.y - ly, yb = w.y - ly;
    if (min(ya, yb) < 18.0) {
      float dy = yb - ya;
      float ea = exp(-max(ya, -2.0)/H), eb = exp(-max(yb, -2.0)/H);
      float I = abs(dy) > 0.05 ? (ea - eb) * H / dy : 0.5*(ea + eb);
      float m = 1.0 - exp(-0.03 * I * min(d, 160.0));
      float sw = vnoise(w.xz * 0.08 + vec2(uTime * 0.12, -uTime * 0.07));
      c = mix(c, mix(vec3(0.9, 0.32, 0.06), vec3(1.0, 0.6, 0.15), sw), clamp(m * inLv, 0.0, 0.45));
    }
  }
  if (inCh > 0.0) {
    float y0 = -322.0, H = 8.0;
    float ya = cameraPosition.y - y0, yb = w.y - y0;
    if (min(ya, yb) < 40.0) {
      float dy = yb - ya;
      float ea = exp(-max(ya, -6.0)/H), eb = exp(-max(yb, -6.0)/H);
      float I = abs(dy) > 0.05 ? (ea - eb) * H / dy : 0.5*(ea + eb);
      float m = 1.0 - exp(-0.08 * I * min(d, 220.0));
      float sw = vnoise(w.xz * 0.045 + vec2(uTime * 0.06, -uTime * 0.04)) * 0.6 + vnoise(w.xz * 0.13 - uTime * 0.09) * 0.4;
      vec3 rc = mix(vec3(0.75, 0.10, 0.04), vec3(1.0, 0.38, 0.12), sw);
      c = mix(c, rc, clamp(m * inCh, 0.0, 0.97));
    }
  }
  return c;
}
// Дымка: вдали — цвет неба, в глубине провала — бирюзовый и фиолетовый туман
vec3 applyFog(vec3 c, vec3 w){
  float d = distance(w, cameraPosition);
#ifdef WET
  // мокрые скалы рядом с водопадом: темнее и с редкими бликами (карта сверху + полоса высот)
  {
    vec4 wt = texture2D(uWet, w.xz/(2.0*uExt)+0.5);
    float y0 = wt.g * 320.0 - 220.0, y1 = wt.b * 320.0 - 220.0;
    float wet = wt.r * smoothstep(y0 - 0.5, y0 + 1.5, w.y) * smoothstep(y1 + 0.5, y1 - 1.5, w.y);
    if (wet > 0.01) {
      c *= 1.0 - 0.4 * wet;
      float gl = vnoise(w.xz * 5.0 + vec2(w.y * 3.0, -uTime * 0.8));
      c += vec3(0.55, 0.65, 0.70) * smoothstep(0.78, 0.95, gl) * wet * 0.3;
    }
  }
#endif
  // чем глубже, тем темнее: свет сверху туда почти не доходит
  c *= mix(1.0, 0.86, smoothstep(-12.0, -60.0, w.y));
  // Шахты под озером (mines.js): камера ниже −190 м и не в колодце шахты — там совсем темно,
  // светят только фонари, кристаллы, фонарик героя и красный туман пропасти
  float mineK = smoothstep(-185.0, -193.0, cameraPosition.y) * smoothstep(52.0, 64.0, length(cameraPosition.xz));
  c *= 1.0 - 0.55 * mineK;
  float deep = smoothstep(-18.0, -70.0, w.y);
  // Тёплый свет фонарика: освещает всё вокруг героя метров на семь, но не слепит.
  //  — вплотную к лампочке (сам герой, его голова) свет втрое слабее — герой виден, но не горит;
  //  — у светлых поверхностей яркость мягко упирается в потолок, а не выгорает в белое;
  //  — свет лёгкий, «живой»: чуть дышит.
  float ld = distance(w, uLure.xyz);
  float ll = uLure.w / (1.0 + ld*ld*0.09) * smoothstep(9.0, 2.5, ld) * mix(0.35, 1.0, smoothstep(0.5, 1.8, ld));
  ll *= 0.94 + 0.06*sin(uTime*7.3 + sin(uTime*2.1)*2.0);
  vec3 lit = c + (c*1.8 + 0.045) * vec3(1.0, 0.82, 0.55) * ll;
  // голубой свет кристаллов и грибов: пятна света на камне, траве и воде рядом с ними
  vec3 gl = vec3(0.0);
  // общая сфера всех огоньков: вне её (дальний план) цикл не считаем
  vec3 gb = w - uGlowB.xyz;
  if (dot(gb, gb) < uGlowB.w * uGlowB.w)
  for (int i = 0; i < GLOW_N; i++) {
    vec3 dv = w - uGlowP[i].xyz;
    float k = max(0.0, 1.0 - dot(dv, dv) / (uGlowP[i].w * uGlowP[i].w));
    gl += uGlowC[i] * (k * k);
  }
  lit += (c*2.2 + 0.035) * gl;
  // потолок только для добавленного света: то, что было светлым и без фонарика, не темнеет
  vec3 over = max(lit - max(c, vec3(0.72)), 0.0);
  c = lit - over + over / (1.0 + over*2.5);
  vec3 cMine = c;
  // высоко над лугом воздух прозрачнее — горы не тонут в дымке
  float den = uFogDen * (1.0 - 0.6*smoothstep(10.0, 70.0, w.y));
  // дно шахты (озеро): туман мягче, цвет — голубой, и немного собственного света
  float lakeK = smoothstep(-70.0, -125.0, w.y) * (1.0 - smoothstep(52.0, 95.0, length(w.xz)));
  c = c * (1.0 + lakeK*0.4) + vec3(0.015, 0.05, 0.07) * lakeK; // светлее, но не плоско: пятна света кристаллов должны читаться
  float f = 1.0 - exp(-d * (den + deep*0.012*(1.0 - lakeK*0.75)));
  // большой мир за кольцом гор грузится чанками до ~420 м — край прячем в дымке
  f = max(f, smoothstep(280.0, 405.0, d) * step(340.0, length(w.xz)));
  // и чем ниже под ногами, тем гуще туман сам по себе
  // Глубина как сплошная завеса — только если смотришь на неё сверху. Когда камера сама глубоко в шахте,
  // всё рядом видно (туман идёт по расстоянию): иначе уступы и плиты спуска исчезали бы в тумане.
  float camIn = smoothstep(-4.0, -40.0, cameraPosition.y);
  f = max(f, smoothstep(-55.0, -100.0, w.y) * (1.0 - lakeK*0.92) * (1.0 - smoothstep(-60.0, -100.0, cameraPosition.y)*0.97));
  // в глубине немного голубого света от кристаллов и воды: не чёрный провал
  float inK = smoothstep(-6.0, -36.0, w.y) * (1.0 - f) * mix(0.7, 1.0, camIn);
  // В шахте скала в тени почти чёрная: поднимаем только тёмное (до холодного «пола» яркости),
  // светлое и средние тона не трогаем — без пересвета, плавно, как рассеянный свет тумана
  float lum = dot(c, vec3(0.33));
  vec3 lifted = vec3(0.12, 0.18, 0.25) + c * 0.8; // пол яркости ниже, чем был: контраст света кристаллов и тени
  c = mix(c, max(c, lifted), inK * (1.0 - smoothstep(0.08, 0.32, lum)) * (1.0 - lakeK * 0.5));
  vec3 fc = mix(uFogCol, uAbyssA, deep);
  fc = mix(fc, uAbyssB, smoothstep(-60.0, -100.0, w.y));
  fc = mix(fc, vec3(0.05, 0.16, 0.21), lakeK * 0.8);
  c = mix(c, fc, clamp(f, 0.0, 1.0));
  // Лежащий туман над озером и в низинах дна: плотный у воды, тает к ~6 м над ней.
  // Плотность по высоте — экспонента, её интеграл вдоль луча считается точно (без шагов),
  // так что это одна формула, а не объёмный рендер.
  {
    float y0 = ${LAKE_Y.toFixed(1)}, H = 3.2;
    float lk = 1.0 - smoothstep(60.0, 90.0, length(w.xz));
    float ya = cameraPosition.y - y0, yb = w.y - y0;
    if (lk > 0.0 && min(ya, yb) < 14.0) {          // луч целиком выше 14 м над водой — тумана на нём нет
      float dy = yb - ya;
      float ea = exp(-max(ya, -2.0)/H), eb = exp(-max(yb, -2.0)/H);
      float I = abs(dy) > 0.05 ? (ea - eb) * H / dy : 0.5*(ea + eb);
      float m = 1.0 - exp(-0.07 * I * min(d, 90.0));
      // свет кристаллов подсвечивает туман рядом с ними
      vec3 mc = vec3(0.16, 0.30, 0.36) + gl * 0.5;
      c = mix(c, mc, clamp(m * lk, 0.0, 0.75));
    }
  }
  if (mineK > 0.0) c = mix(c, mineFog(cMine, w, d), mineK);
  return grade(c);
}
// Цвет травы: наверху сочная зелень, глубже — бирюза, ещё глубже — сиреневый мох
vec3 grassCol(vec3 w){
  float t = vnoise(w.xz*0.06)*0.65 + vnoise(w.xz*0.27)*0.35;
  vec3 g = mix(vec3(0.18,0.36,0.17), vec3(0.38,0.52,0.22), t);
  float d = -w.y;
  g = mix(g, mix(vec3(0.12,0.38,0.32), vec3(0.26,0.56,0.46), t), smoothstep(8.0, 45.0, d));
  // Пятна разных оттенков (метры–десятки метров): желтоватая, тёмная сочная и голубоватая трава.
  // В шахте — ещё и сине-зелёные куртины у воды и кристаллов. Одна выборка шума на всё.
  float hp = vnoise(w.xz*0.11 + 17.0);
  float dk = smoothstep(60.0, 110.0, d);
  g = mix(g, g * mix(vec3(1.25, 1.12, 0.65), vec3(0.85, 1.05, 1.25), dk), smoothstep(0.62, 0.8, hp) * 0.7);  // светлые: жёлтые наверху, голубые внизу
  g = mix(g, g * vec3(0.68, 0.82, 0.78), smoothstep(0.4, 0.22, hp) * 0.8);                               // тёмные куртины
  return g;
}
`;

export function mat(opts) {
  const { uniforms = {}, vertexShader, fragmentShader, ...rest } = opts;
  return new THREE.ShaderMaterial({
    uniforms: { ...U, ...uniforms },
    vertexShader: COMMON + vertexShader,
    fragmentShader: COMMON + fragmentShader,
    ...rest,
  });
}

// ---- стили графики: один и тот же мир, разное настроение ----
export const STYLES = {
  // выбранный стиль: цвета ясного дня + мягкая дымка туманного утра
  // поздний день: низкое тёплое солнце, холодные тени, сизая дымка
  day: { name: 'Вечерняя дымка', sun: [0.80, 0.60, 0.40], hi: [0.36, 0.42, 0.56], lo: [0.27, 0.26, 0.33],
    fog: [0.55, 0.59, 0.68], zen: [0.16, 0.25, 0.45], den: 0.0062, sat: 0.92 },
};
export function setStyle(key) {
  const s = STYLES[key] || STYLES.day;
  U.uSunCol.value.fromArray(s.sun); U.uAmbHi.value.fromArray(s.hi); U.uAmbLo.value.fromArray(s.lo);
  U.uFogCol.value.fromArray(s.fog); U.uZenith.value.fromArray(s.zen);
  U.uFogDen.value = s.den; U.uSat.value = s.sat;
}
