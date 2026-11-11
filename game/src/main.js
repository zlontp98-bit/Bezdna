import * as THREE from '../vendor/three.min.js';
import { U, setStyle } from './shaders.js';
setStyle('day');
import { buildCamp } from './camp.js';
import { W, buildTerrain, bakeShadows, heightAt } from './terrain.js';
import { buildFlora, buildGrass } from './flora.js';
import { buildSky, buildClouds, buildMist, buildMotes, buildStreams } from './atmosphere.js';
import { Player, SKIN_COLORS } from './player.js';
import { Input } from './input.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const isMobile = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* без сохранения */ } },
};

let renderer, scene, camera, player, input, grass, motes, clouds;
let yaw = Math.PI / 2, pitch = 0.2, camDist = 6.5, firstPerson = false;
let running = false, fade = 0, falling = false;
const camPos = new THREE.Vector3(), target = new THREE.Vector3();

// ---- качество: держим плавность, а не разрешение ----
const Q = {
  mode: store.get('bezdna.q', 'auto'), // auto | low | high
  maxPR: 1, scale: 1, ema: 16.7, t: 0, density: 1,
};
function applyRes() {
  renderer.setPixelRatio(Q.maxPR * Q.scale);
  renderer.setSize(innerWidth, innerHeight, false);
  if (motes) motes.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 700;
}
function setQuality(mode) {
  Q.mode = mode; store.set('bezdna.q', mode);
  const dpr = Math.min(devicePixelRatio || 1, 3);
  Q.maxPR = mode === 'low' ? Math.min(dpr, 1) : mode === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.5);
  Q.scale = 1;
  Q.density = mode === 'low' ? 0.45 : 1;
  if (grass) grass.setDensity(Q.density);
  applyRes();
  document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === mode));
}
function adaptQuality(dtMs) {
  Q.ema += (dtMs - Q.ema) * 0.05;
  Q.t += dtMs;
  if (Q.mode !== 'auto' || Q.t < 1200) return;
  Q.t = 0;
  // медленно — снижаем разрешение, потом густоту травы; есть запас — возвращаем
  if (Q.ema > 21) {
    if (Q.scale > 0.6) Q.scale = Math.max(0.6, Q.scale - 0.1);
    else if (Q.density > 0.35) { Q.density -= 0.15; grass.setDensity(Q.density); }
    applyRes();
  } else if (Q.ema < 17.2) {
    if (Q.density < 1) { Q.density = Math.min(1, Q.density + 0.1); grass.setDensity(Q.density); }
    else if (Q.scale < 1) { Q.scale = Math.min(1, Q.scale + 0.05); applyRes(); }
  }
}

function build() {
  const t0 = performance.now();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance', stencil: false });
  renderer.setClearColor(0xcfe2ee);
  scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.25, 1400);

  buildTerrain(scene);
  const flora = buildFlora(scene);
  const camp = buildCamp(scene, flora.spawn);
  bakeShadows(flora.blobs.concat(camp.blobs));
  buildSky(scene);
  clouds = buildClouds(scene);
  buildStreams(scene);
  buildMist(scene);
  grass = buildGrass(scene, isMobile ? 16000 : 30000);
  motes = buildMotes(scene, 220);

  input = new Input(canvas, { stickEl: $('stick'), knobEl: $('knob'), jumpEl: $('jump'), runEl: $('run') });
  player = new Player(scene, flora.spawn, flora.colliders.concat(camp.colliders));
  // облик героя: цвет и пробная броня, выбор запоминается
  const look = { color: +store.get('bezdna.color', SKIN_COLORS[0]), armor: store.get('bezdna.armor', '0') === '1' };
  const applyLook = () => {
    player.setLook(look);
    store.set('bezdna.color', look.color); store.set('bezdna.armor', look.armor ? '1' : '0');
    document.querySelectorAll('#colors button').forEach((b) => b.classList.toggle('on', +b.dataset.c === look.color));
    $('armor').textContent = look.armor ? 'Броня: надета' : 'Броня: снята';
  };
  SKIN_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.dataset.c = c; b.style.background = '#' + c.toString(16).padStart(6, '0');
    b.addEventListener('click', () => { look.color = c; applyLook(); });
    $('colors').appendChild(b);
  });
  $('armor').addEventListener('click', () => { look.armor = !look.armor; applyLook(); });
  applyLook();
  setQuality(Q.mode);
  addEventListener('resize', onResize);
  onResize();
  console.log(`мир построен за ${Math.round(performance.now() - t0)} мс`);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  // на вертикальном экране расширяем обзор
  camera.fov = camera.aspect < 1 ? 78 : 62;
  camera.updateProjectionMatrix();
  applyRes();
}

const ZONES = [[-3, 'Луг у края'], [-1e9, 'Первое кольцо']];
let zoneName = '', zoneT = 0;
function updateHud(dt) {
  const y = player.pos.y;
  $('stam').classList.toggle('show', player.stamina < 99.5);
  $('stamFill').style.width = player.stamina + '%';
  $('stamFill').classList.toggle('low', player.stamina < 25);
  const d = Math.max(0, Math.round(-y));
  $('depth').textContent = d > 0 ? `−${d} м` : '0 м';
  $('bar').style.height = Math.min(100, (-y / 13) * 100) + '%';
  const z = ZONES.find((q) => y > q[0])[1];
  if (z !== zoneName) {
    zoneName = z; zoneT = 3.2;
    $('zone').textContent = z; $('zoneBig').textContent = z;
    $('zoneBig').classList.add('show');
  }
  if (zoneT > 0 && (zoneT -= dt) <= 0) $('zoneBig').classList.remove('show');
}

function updateCamera(dt, inp) {
  yaw -= inp.lookX; pitch += inp.lookY;
  pitch = Math.max(firstPerson ? -1.45 : -1.2, Math.min(1.45, pitch));
  const p = player.pos;
  target.set(p.x, p.y + (firstPerson ? 1.28 : 1.5), p.z);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // направление взгляда
  const fx = -Math.sin(yaw) * cp, fy = -sp, fz = -Math.cos(yaw) * cp;
  if (firstPerson) {
    camera.position.copy(target);
    camera.lookAt(target.x + fx, target.y + fy, target.z + fz);
    return;
  }
  // камера не проваливается в скалы: укорачиваем дистанцию
  let d = camDist;
  for (let i = 1; i <= 10; i++) {
    const t = (i / 10) * camDist;
    const x = target.x - fx * t, y = target.y - fy * t, z = target.z - fz * t;
    if (y < heightAt(x, z) + 0.45) { d = Math.max(0.8, t - camDist / 10); break; }
  }
  camPos.set(target.x - fx * d, target.y - fy * d, target.z - fz * d);
  const gh = heightAt(camPos.x, camPos.z) + 0.4;
  if (camPos.y < gh) camPos.y = gh;
  camera.position.lerp(camPos, Math.min(1, dt * 14));
  camera.lookAt(target);
}

let last = 0, frames = 0, fpsT = 0, debugCam = null;
function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - last);
  last = now;
  const dt = dtMs / 1000;
  if (!running) { if (renderer) renderer.render(scene, camera); return; }
  adaptQuality(dtMs);

  const inp = input.poll();
  if (!falling) player.update(dt, inp, yaw);
  // упал в колодец — следующий слой ещё не открыт, возвращаем на уступ
  if (player.pos.y < -44 && !falling) { falling = true; $('msg').classList.add('show'); }
  if (falling) {
    fade = Math.min(1, fade + dt * 1.6);
    if (fade >= 1) { player.respawn(); falling = false; setTimeout(() => $('msg').classList.remove('show'), 2600); }
  } else fade = Math.max(0, fade - dt * 1.2);
  $('fade').style.opacity = fade;

  updateCamera(dt, inp);
  if (debugCam) { camera.position.fromArray(debugCam.p); camera.lookAt(debugCam.l[0], debugCam.l[1], debugCam.l[2]); }
  player.m.root.visible = !firstPerson;

  U.uTime.value = now / 1000;
  U.uCenter.value.copy(player.pos);
  U.uPlayer.value.copy(player.pos);
  clouds.rotation.y += dt * 0.003;

  renderer.render(scene, camera);
  updateHud(dt);

  frames++; fpsT += dtMs;
  if (fpsT > 500) {
    $('fps').textContent = `${Math.round((frames * 1000) / fpsT)} FPS`;
    frames = 0; fpsT = 0;
  }
}

// ---- интерфейс ----

function start() {
  $('menu').classList.add('hide');
  $('hud').classList.add('show');
  running = true;
}
$('play').addEventListener('click', start);
$('tomenu').addEventListener('click', () => {
  running = false;
  $('panel').classList.remove('show');
  $('hud').classList.remove('show');
  $('menu').classList.remove('hide');
  $('play').textContent = 'Продолжить';
  if (document.exitPointerLock) document.exitPointerLock();
});
$('gear').addEventListener('click', () => $('panel').classList.toggle('show'));
$('view').addEventListener('click', () => {
  firstPerson = !firstPerson;
  $('view').textContent = firstPerson ? 'Вид: от первого лица' : 'Вид: от третьего лица';
});
$('showfps').addEventListener('click', () => $('fps').classList.toggle('hide'));
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
addEventListener('keydown', (e) => { if (e.code === 'KeyV') $('view').click(); });
addEventListener('wheel', (e) => { camDist = Math.max(3, Math.min(14, camDist + e.deltaY * 0.01)); }, { passive: true });

// ---- обновления внутри приложения (кнопка-коробка) ----
// В APK есть мост BezdnaApp: он скачивает свежую версию игры из репозитория.
const App = window.BezdnaApp;
if (App) {
  const btn = $('upd'), txt = $('updText');
  btn.hidden = false;
  $('ver').hidden = false;
  $('ver').textContent = 'версия ' + (App.version() || '?').slice(0, 7);
  window.onBezdnaUpdate = (state, text) => {
    btn.classList.toggle('busy', state === 'checking' || state === 'downloading');
    btn.classList.toggle('new', state === 'available');
    if (state === 'available') txt.textContent = 'Есть обновление';
    else if (state === 'offline') txt.textContent = 'Обновить';
    else if (state === 'uptodate' && !text) txt.textContent = 'Обновить';
    else txt.textContent = text;
    if (state === 'uptodate' && text) setTimeout(() => { txt.textContent = 'Обновить'; }, 2500);
  };
  btn.addEventListener('click', () => App.update());
  App.check();
}

// сначала показываем экран загрузки, потом строим мир
requestAnimationFrame(() => setTimeout(() => {
  try {
    build();
    // камера на заставке: смотрим через луг на провал
    const s = player.pos;
    camera.position.set(s.x + 12, s.y + 4.2, s.z - 4);
    camera.lookAt(s.x - 30, s.y - 4, s.z + 22);
    player.update(0.016, { mx: 0, my: 0, jump: false, sprint: false }, yaw);
    $('play').disabled = false;
    $('play').textContent = 'Играть';
    $('loading').classList.add('hide');
    if (location.hash === '#play') start();
    window.__game = { player, camera, setView: (y, p) => { yaw = y; pitch = p; }, setCam: (c) => { debugCam = c; }, Q, renderer };
  } catch (err) {
    console.error(err);
    $('loading').textContent = 'Не удалось запустить 3D-графику на этом устройстве: ' + err.message;
  }
  requestAnimationFrame(frame);
}, 30));
