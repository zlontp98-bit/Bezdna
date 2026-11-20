// Звук игры: всё синтезируется на лету через Web Audio — ни одного звукового файла.
// Фон (ветер наверху, гул пещеры и капли внизу, шум водопада по расстоянию) и короткие
// звуки (шаги, прыжок, приземление, вода, удары инструментом, добыча, медузы).
// На телефоне звук можно включить только после касания экрана: контекст создаём
// по первому нажатию (unlockSound). Когда игра свёрнута, звук ставим на паузу.
import { STREAMS } from './waterfall.js';
import { heightAt, waterAt } from './terrain.js';

let ctx = null, master = null, dry = null, wet = null, noise = null, verb = null;
let on = true, store = null;
let amb = null;          // петли фона: ветер, вода, гул
let fallPts = null, runPts = null;
const S = { phaseStep: 0, swimStep: 0, wasGround: true, wasSwim: false, airMin: 0, airT: 0, swing: 0, climbX: 0, climbZ: 0, climbY: 0, dripT: 2, waterT: 0, depth: 0, played: {} };
export const soundState = S; // для отладки: сколько каких звуков сыграно

const now = () => ctx.currentTime;
const rnd = (a, b) => a + Math.random() * (b - a);

export function initSound(st) {
  store = st;
  on = store.get('bezdna.snd', '1') !== '0';
  // первое касание/клавиша — разрешение браузера на звук
  const go = () => { unlockSound(); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, go, { capture: true, passive: true });
  addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else if (on) ctx.resume();
  });
}
export const soundOn = () => on;
export function setSoundOn(v) {
  on = !!v; if (store) store.set('bezdna.snd', on ? '1' : '0');
  if (!ctx) { if (on) unlockSound(); return; }
  master.gain.setTargetAtTime(on ? 0.9 : 0, now(), 0.05);
  if (on) ctx.resume();
  else setTimeout(() => { if (!on && ctx) ctx.suspend(); }, 200);
}

export function unlockSound() {
  if (ctx) { if (on && ctx.state !== 'running' && !document.hidden) ctx.resume(); return; }
  if (!on) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { return; }
  master = ctx.createGain(); master.gain.value = 0.9;
  // мягкий ограничитель: несколько ударов разом не «хрипят»
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);
  dry = ctx.createGain(); dry.connect(master);
  // эхо пещеры: короткий синтезированный отклик, громче в глубине
  verb = ctx.createConvolver(); verb.buffer = impulse(2.2);
  wet = ctx.createGain(); wet.gain.value = 0.15;
  wet.connect(verb).connect(master);
  noise = noiseBuf(2);
  buildAmbient();
  if (ctx.state !== 'running') ctx.resume();
}

function noiseBuf(sec) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function impulse(sec) {
  const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) { const t = i / n; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 80 ? i / 80 : 1); }
  }
  return b;
}

// ---- фон ----
function loopNoise() { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.loopStart = 0; s.start(0, Math.random() * 1.5); return s; }
function chain(...n) { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; }
function filt(type, f, q = 0.7) { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; }
function gain(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
function panner() { return ctx.createStereoPanner ? ctx.createStereoPanner() : gain(1); }

function buildAmbient() {
  amb = {};
  // ветер над лугом: шум сквозь полосовой фильтр, частота и сила медленно гуляют
  amb.windF = filt('bandpass', 500, 0.6); amb.wind = gain(0);
  chain(loopNoise(), amb.windF, amb.wind, dry);
  // водопад: низкий рёв + шипение брызг; стерео — с той стороны, где вода
  amb.fallPan = panner(); amb.fall = gain(0);
  const roar = filt('lowpass', 700, 0.5), hiss = filt('bandpass', 2600, 0.5), hissG = gain(0.35);
  const src = loopNoise();
  chain(src, roar, amb.fall); chain(src, hiss, hissG, amb.fall);
  chain(amb.fall, amb.fallPan, dry);
  amb.fallWet = gain(0); amb.fall.connect(amb.fallWet).connect(wet);
  // ручей: журчание — узкая полоса, её частота всё время скачет
  amb.runF = filt('bandpass', 1400, 4); amb.runPan = panner(); amb.run = gain(0);
  chain(loopNoise(), amb.runF, amb.run, amb.runPan, dry);
  // гул глубины: два низких тона и тёмный шум
  amb.drone = gain(0);
  const lp = filt('lowpass', 260, 0.7);
  for (const [f, v] of [[55, 0.5], [82.6, 0.3], [110.3, 0.12]]) { const o = ctx.createOscillator(); o.frequency.value = f; o.detune.value = rnd(-8, 8); const g = gain(v); o.connect(g).connect(lp); o.start(); }
  const dn = gain(0.9); chain(loopNoise(), filt('lowpass', 160, 0.5), dn, lp);
  chain(lp, amb.drone, dry);
}

function prepWater() {
  fallPts = []; runPts = [];
  for (const st of STREAMS) for (const r of st.rows) {
    const p = [r.c[0], r.c[1], r.c[2]];
    if (r.kind === 'fall' && !r.slide) fallPts.push(p); else runPts.push(p);
  }
}
const _near = { d: 1e9, x: 0, y: 0, z: 0 };
function nearest(list, x, y, z) {
  let bd = 1e18, b = null;
  for (let i = 0; i < list.length; i += 2) { const p = list[i], dx = p[0] - x, dy = (p[1] - y) * 0.8, dz = p[2] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; b = p; } }
  _near.d = Math.sqrt(bd); if (b) { _near.x = b[0]; _near.y = b[1]; _near.z = b[2]; }
  return _near;
}
// −1 слева … 1 справа относительно взгляда камеры
function panOf(cam, x, z) {
  const dx = x - cam.position.x, dz = z - cam.position.z, l = Math.hypot(dx, dz);
  if (l < 1) return 0;
  const e = cam.matrixWorld.elements; // правый вектор камеры — первый столбец
  return Math.max(-0.85, Math.min(0.85, (dx * e[0] + dz * e[2]) / l));
}
function setG(node, v, tc = 0.3) { node.gain.setTargetAtTime(v, now(), tc); }

// ---- короткие звуки ----
// шумовой всплеск: тип фильтра, частота, длительность, громкость, куда (сухо/с эхом)
function burst(type, f, dur, vol, { q = 1, f2 = 0, attack = 0.004, rev = 0.25, at = 0 } = {}) {
  const t = now() + at, s = ctx.createBufferSource(); s.buffer = noise;
  const x = filt(type, f, q), g = gain(0);
  if (f2) x.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  chain(s, x, g); g.connect(dry);
  if (rev) { const w = gain(rev); g.connect(w).connect(wet); }
  s.start(t, Math.random() * Math.max(0, 1.9 - dur), dur + 0.05);
}
function tone(f, dur, vol, { type = 'sine', f2 = 0, attack = 0.003, rev = 0.3, at = 0 } = {}) {
  const t = now() + at, o = ctx.createOscillator(), g = gain(0);
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(g).connect(dry);
  if (rev) { const w = gain(rev); g.connect(w).connect(wet); }
  o.start(t); o.stop(t + dur + 0.05);
}

const SFX = {
  step_grass: (v) => { burst('bandpass', rnd(2200, 3400), 0.09, 0.22 * v, { q: 0.8, rev: 0.05 }); burst('lowpass', 300, 0.06, 0.18 * v, { rev: 0 }); },
  step_stone: (v) => { burst('bandpass', rnd(900, 1400), 0.05, 0.3 * v, { q: 1.4, rev: 0.4 }); burst('lowpass', rnd(160, 220), 0.07, 0.35 * v, { rev: 0.2 }); },
  step_water: (v) => { burst('bandpass', rnd(700, 1100), 0.18, 0.3 * v, { q: 0.9, f2: 2200, attack: 0.02, rev: 0.2 }); },
  swim: (v) => { burst('bandpass', rnd(500, 800), 0.35, 0.22 * v, { q: 0.7, f2: 1600, attack: 0.08, rev: 0.25 }); },
  splash: (v) => { burst('lowpass', 900, 0.5, 0.55 * v, { f2: 300, rev: 0.4 }); burst('bandpass', 2400, 0.7, 0.3 * v, { q: 0.6, attack: 0.03, rev: 0.4 }); },
  jump: (v) => { burst('bandpass', 700, 0.16, 0.16 * v, { q: 0.6, f2: 1500, attack: 0.03, rev: 0.05 }); },
  land: (v) => { burst('lowpass', 240, 0.16, 0.6 * v, { f2: 80, rev: 0.35 }); burst('bandpass', 1800, 0.08, 0.15 * v, { q: 0.7, rev: 0.1 }); },
  climb: (v) => { burst('bandpass', rnd(1500, 2600), 0.12, 0.13 * v, { q: 1.2, attack: 0.03, rev: 0.2 }); },
  swing: (v) => { burst('bandpass', 500, 0.22, 0.14 * v, { q: 1.5, f2: 1900, attack: 0.07, rev: 0 }); },
  chop: (v) => { tone(rnd(180, 210), 0.14, 0.45 * v, { type: 'triangle', f2: 110, rev: 0.4 }); burst('bandpass', 1300, 0.08, 0.4 * v, { q: 1.5, rev: 0.3 }); },
  treeFall: (v) => { burst('lowpass', 500, 1.3, 0.3 * v, { f2: 120, attack: 0.5, rev: 0.4 }); burst('lowpass', 200, 0.5, 0.7 * v, { at: 1.1, f2: 60, rev: 0.5 }); },
  mine: (v) => { tone(rnd(1700, 2100), 0.18, 0.18 * v, { type: 'square', f2: 1200, rev: 0.5 }); burst('highpass', 2500, 0.06, 0.4 * v, { rev: 0.5 }); burst('lowpass', 250, 0.1, 0.4 * v, { rev: 0.3 }); },
  rockBreak: (v) => { burst('lowpass', 700, 0.6, 0.6 * v, { f2: 100, rev: 0.6 }); for (let i = 0; i < 4; i++) burst('bandpass', rnd(1200, 3000), 0.05, 0.25 * v, { q: 2, at: 0.06 + i * rnd(0.05, 0.1), rev: 0.5 }); },
  crystal: (v) => { const f = rnd(1300, 1700); tone(f, 0.9, 0.16 * v, { rev: 0.9 }); tone(f * 1.5, 0.7, 0.09 * v, { rev: 0.9, at: 0.01 }); tone(f * 2.01, 0.5, 0.06 * v, { rev: 0.9 }); burst('highpass', 4000, 0.05, 0.25 * v, { rev: 0.6 }); },
  crystalBreak: (v) => { for (let i = 0; i < 6; i++) tone(rnd(1600, 3600), rnd(0.4, 0.9), 0.08 * v, { rev: 1, at: i * 0.045 }); burst('highpass', 3000, 0.25, 0.3 * v, { rev: 0.8 }); },
  shroom: (v) => { burst('lowpass', 600, 0.12, 0.5 * v, { q: 3, f2: 200, rev: 0.3 }); tone(rnd(130, 170), 0.12, 0.25 * v, { f2: 80, rev: 0.2 }); },
  jelly: (v) => { tone(rnd(240, 300), 0.22, 0.35 * v, { f2: 120, rev: 0.4 }); burst('lowpass', 900, 0.18, 0.4 * v, { q: 4, f2: 250, rev: 0.4 }); },
  jellyDie: (v) => { tone(420, 0.7, 0.25 * v, { f2: 90, rev: 0.6 }); burst('lowpass', 1200, 0.6, 0.35 * v, { q: 3, f2: 150, rev: 0.6 }); },
  pick: (v) => { tone(rnd(620, 700), 0.09, 0.17 * v, { type: 'triangle', f2: 900, rev: 0.15 }); },
  get: (v) => { tone(880, 0.12, 0.1 * v, { type: 'triangle', rev: 0.3 }); tone(1320, 0.18, 0.08 * v, { type: 'triangle', at: 0.07, rev: 0.3 }); },
  chest: (v) => { burst('lowpass', 400, 0.35, 0.4 * v, { q: 5, f2: 900, attack: 0.05, rev: 0.4 }); [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.4, 0.09 * v, { type: 'triangle', at: 0.25 + i * 0.08, rev: 0.6 })); },
  drip: (v) => { const f = rnd(1400, 2600); tone(f, 0.12, 0.14 * v, { f2: f * 0.55, rev: 1.6 }); },
};

// Короткий звук по имени. Без разрешения браузера или при выключенном звуке — тишина.
export function sfx(name, vol = 1) {
  if (!ctx || !on || ctx.state !== 'running') return;
  const f = SFX[name];
  if (f) { f(vol); S.played[name] = (S.played[name] || 0) + 1; }
}

// Раз в кадр: фон по месту героя и звуки движения по изменению его состояния.
export function updateSound(dt, pl, cam, running) {
  if (!ctx || !on || ctx.state !== 'running' || !pl) return;
  if (!fallPts) prepWater();
  const p = pl.pos, y = p.y;
  // насколько мы «в пещере»: 0 — на лугу, 1 — в глубине шахты и в туннелях
  const depth = Math.max(0, Math.min(1, (-y - 10) / 45));
  S.depth += (depth - S.depth) * Math.min(1, dt * 2);
  const k = S.depth, tt = now();

  // фон обновляем реже: 5 раз в секунду
  if ((S.waterT -= dt) <= 0) {
    S.waterT = 0.2;
    const gust = 0.5 + 0.5 * Math.sin(tt * 0.23) * Math.sin(tt * 0.071 + 1);
    setG(amb.wind, (1 - k) * (0.05 + 0.09 * gust) * (y > 14 ? 1.6 : 1), 0.8);
    amb.windF.frequency.setTargetAtTime(380 + 420 * gust, tt, 1);
    const f = nearest(fallPts, p.x, y, p.z), fv = Math.min(0.75, 9 / (f.d + 6)) * (f.d < 140 ? 1 : 0);
    setG(amb.fall, fv * fv * 1.4, 0.4); setG(amb.fallWet, 0.3 * k, 0.5);
    if (amb.fallPan.pan) amb.fallPan.pan.setTargetAtTime(panOf(cam, f.x, f.z) * Math.min(1, f.d / 8), tt, 0.2);
    const r = nearest(runPts, p.x, y, p.z), rv = Math.max(0, 1 - r.d / 28);
    setG(amb.run, rv * rv * 0.5, 0.4);
    if (amb.runPan.pan) amb.runPan.pan.setTargetAtTime(panOf(cam, r.x, r.z) * Math.min(1, r.d / 5), tt, 0.2);
    amb.runF.frequency.setTargetAtTime(rnd(900, 2400), tt, 0.05);
    setG(amb.drone, k * 0.22, 1);
    wet.gain.setTargetAtTime(0.12 + 0.5 * k, tt, 0.5);
  }
  // капли в глубине — по одной, в случайные моменты
  if (k > 0.3 && (S.dripT -= dt) <= 0) { S.dripT = rnd(0.8, 4.5) / k; sfx('drip', rnd(0.4, 1) * k); }
  if (!running) return;

  // шаги: два шага на период анимации ног
  const ground = pl.grounded && !pl.swimming && !pl.climbing;
  const ph = Math.floor(pl.phase / Math.PI);
  if (ph !== S.phaseStep) {
    S.phaseStep = ph;
    if (ground && pl.speed > 0.7) {
      const v = Math.min(1, 0.45 + pl.speed / 9);
      const wetFoot = waterAt(p.x, p.z) > y - 0.35;
      const stone = !wetFoot && (y < -14 || y > 14 || y > heightAt(p.x, p.z) + 0.25);
      sfx(wetFoot ? 'step_water' : stone ? 'step_stone' : 'step_grass', v);
    }
  }
  // плаванье: гребок на каждый взмах рук
  if (pl.swimming) {
    const sp = Math.floor(pl.swimT * (6 + pl.speed * 1.5) / Math.PI);
    if (sp !== S.swimStep) { S.swimStep = sp; if (pl.speed > 0.3) sfx('swim', 0.8); }
  }
  if (pl.swimming && !S.wasSwim) sfx('splash', Math.min(1, 0.4 + Math.max(0, -S.airMin) / 10));
  // прыжок и приземление
  if (!pl.grounded && !pl.swimming && !pl.climbing) { S.airT += dt; S.airMin = Math.min(S.airMin, pl.vel.y); }
  if (S.wasGround && !pl.grounded && !pl.swimming && !pl.climbing && pl.vel.y > 3) sfx('jump', 1);
  if (!S.wasGround && pl.grounded) {
    if (S.airT > 0.25 && S.airMin < -3) sfx('land', Math.min(1, 0.35 + -S.airMin / 14));
  }
  if (pl.grounded || pl.swimming || pl.climbing) { S.airT = 0; S.airMin = 0; }
  S.wasGround = pl.grounded; S.wasSwim = pl.swimming;
  // лазанье: шорох рук по камню каждые ~35 см
  if (pl.climbing) {
    const d = Math.hypot(p.x - S.climbX, y - S.climbY, p.z - S.climbZ);
    if (d > 0.35) { S.climbX = p.x; S.climbY = y; S.climbZ = p.z; sfx('climb', 1); }
  } else { S.climbX = p.x; S.climbY = y; S.climbZ = p.z; }
  // взмах инструментом
  if (pl.swingT > S.swing + 0.05) sfx('swing', pl.held ? 1 : 0.7);
  S.swing = pl.swingT;
}
