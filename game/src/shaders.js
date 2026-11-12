import * as THREE from '../vendor/three.min.js';

// Цвета задаём сразу «как на экране», без пересчёта — так дешевле и предсказуемее
THREE.ColorManagement.enabled = false;

// Общие для всех материалов значения: свет, туман, время.
// Один объект на всё — меняем в одном месте, обновляется везде.
export const U = {
  uSun: { value: new THREE.Vector3(0.62, 0.40, 0.42).normalize() },
  uSunCol: { value: new THREE.Color(0.64, 0.55, 0.40) },
  uAmbHi: { value: new THREE.Color(0.40, 0.48, 0.62) },
  uAmbLo: { value: new THREE.Color(0.25, 0.24, 0.31) },
  uFogCol: { value: new THREE.Color(0.80, 0.88, 0.93) },
  uAbyssA: { value: new THREE.Color(0.33, 0.45, 0.53) },
  uAbyssB: { value: new THREE.Color(0.08, 0.10, 0.20) },
  uFogDen: { value: 0.0021 },
  uTime: { value: 0 },
  uSat: { value: 1 },
  uZenith: { value: new THREE.Color(0.22, 0.47, 0.86) },
  uShadow: { value: null },
  uHmap: { value: null },
  uExt: { value: 232 },
  uCenter: { value: new THREE.Vector3() },
  uPlayer: { value: new THREE.Vector3() },
};

export const COMMON = /* glsl */ `
uniform vec3 uSun, uSunCol, uAmbHi, uAmbLo, uFogCol, uAbyssA, uAbyssB;
uniform float uFogDen, uTime, uExt, uSat;
uniform vec3 uZenith;
uniform sampler2D uShadow;

// общая цветокоррекция стиля
vec3 grade(vec3 c){ return mix(vec3(dot(c, vec3(0.3,0.59,0.11))), c, uSat); }
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y);
}
// Запечённые тени (скалы + кроны деревьев), одна выборка из текстуры
float shadowAt(vec2 xz){
  float s = texture2D(uShadow, xz/(2.0*uExt)+0.5).r;
  float e = max(abs(xz.x), abs(xz.y));
  return mix(s, 1.0, smoothstep(uExt-18.0, uExt-2.0, e));
}
// Мягкий «мультяшный» свет: тёплое солнце, холодная тень
vec3 shade(vec3 alb, vec3 n, float sh){
  float lit = smoothstep(-0.05, 0.5, dot(n, uSun)) * sh;
  vec3 amb = mix(uAmbLo, uAmbHi, n.y*0.5+0.5);
  return alb * (amb + uSunCol * lit);
}
// Дымка: вдали — цвет неба, в глубине провала — бирюзовый и фиолетовый туман
vec3 applyFog(vec3 c, vec3 w){
  float d = distance(w, cameraPosition);
  // чем глубже, тем темнее: свет сверху туда почти не доходит
  c *= mix(1.0, 0.62, smoothstep(-12.0, -60.0, w.y));
  float deep = smoothstep(-18.0, -70.0, w.y);
  float f = 1.0 - exp(-d * (uFogDen + deep*0.012));
  // и чем ниже под ногами, тем гуще туман сам по себе
  f = max(f, smoothstep(-55.0, -120.0, w.y));
  vec3 fc = mix(uFogCol, uAbyssA, deep);
  fc = mix(fc, uAbyssB, smoothstep(-60.0, -150.0, w.y));
  return grade(mix(c, fc, clamp(f, 0.0, 1.0)));
}
// Цвет травы: наверху сочная зелень, глубже — бирюза, ещё глубже — сиреневый мох
vec3 grassCol(vec3 w){
  float t = vnoise(w.xz*0.06)*0.65 + vnoise(w.xz*0.27)*0.35;
  vec3 g = mix(vec3(0.16,0.33,0.16), vec3(0.36,0.50,0.21), t);
  float d = -w.y;
  g = mix(g, mix(vec3(0.12,0.38,0.32), vec3(0.26,0.56,0.46), t), smoothstep(8.0, 45.0, d));
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
  day: { name: 'Вечерняя дымка', sun: [0.80, 0.60, 0.40], hi: [0.30, 0.36, 0.50], lo: [0.21, 0.20, 0.27],
    fog: [0.55, 0.59, 0.68], zen: [0.16, 0.25, 0.45], den: 0.0062, sat: 0.92 },
};
export function setStyle(key) {
  const s = STYLES[key] || STYLES.day;
  U.uSunCol.value.fromArray(s.sun); U.uAmbHi.value.fromArray(s.hi); U.uAmbLo.value.fromArray(s.lo);
  U.uFogCol.value.fromArray(s.fog); U.uZenith.value.fromArray(s.zen);
  U.uFogDen.value = s.den; U.uSat.value = s.sat;
}
