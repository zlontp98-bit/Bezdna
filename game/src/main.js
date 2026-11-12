import * as THREE from '../vendor/three.min.js';
import { U, setStyle } from './shaders.js';
setStyle('day');
import { buildCamp } from './camp.js';
import { W, SOURCES, buildTerrain, bakeShadows, heightAt } from './terrain.js';
import { buildFlora, buildGrass } from './flora.js';
import { buildSky, buildClouds, buildMist, buildMotes, buildStreams, buildShafts } from './atmosphere.js';
import { buildRuins } from './ruins.js';
import { buildStacks } from './stacks.js';
import { buildWaterfalls } from './waterfall.js';
import { Player, SKIN_COLORS } from './player.js';
import { Input } from './input.js';
import { Inventory, bindInventoryUI } from './inventory.js';
import { groundAt } from './solids.js';
import { Woodcutter } from './chop.js';
import { World } from './world.js';
import { Settlement } from './npc.js';
import { Pickups } from './pickups.js';
import { Crafting } from './craft.js';
import { Miner } from './mine.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const isMobile = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* без сохранения */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* нечего стирать */ } },
};

let renderer, scene, camera, player, input, grass, motes, clouds, inv, falls, wood, world, town, picks, craft, mine;
let yaw = Math.PI / 2, pitch = 0.2, camDist = 6.5, camCur = 6.5, camLift = 0, firstPerson = false;
let running = false, fade = 0, falling = false;
const camPos = new THREE.Vector3(), target = new THREE.Vector3();

// ---- качество: держим плавность, а не разрешение ----
const Q = {
  mode: store.get('bezdna.q', 'auto'), // auto | low | high
  maxPR: 1, scale: 1, t: 0, n: 0, density: 1,
  ceil: 1, good: 0, upT: -1e9, clock: 0,
};
function applyRes() {
  renderer.setPixelRatio(Q.maxPR * Q.scale);
  renderer.setSize(innerWidth, innerHeight, false);
  if (motes) motes.uniforms.uPx.value = falls.uniforms.uPx.value = player.halo.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 700;
}
function setQuality(mode) {
  Q.mode = mode; store.set('bezdna.q', mode);
  const dpr = Math.min(devicePixelRatio || 1, 3);
  Q.maxPR = mode === 'low' ? Math.min(dpr, 1) : mode === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.5);
  Q.scale = 1; Q.ceil = 1; Q.good = 0;
  Q.density = mode === 'low' ? 0.45 : 1;
  if (grass) grass.setDensity(Q.density);
  applyRes();
  document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === mode));
}
// Цель — ровные 60 кадров. Судим по среднему за секунду, а не по отдельным кадрам:
// одна заминка (сборка мусора, подгрузка) не должна срезать качество.
// Не тянем стабильно — снижаем разрешение, потом густоту травы. Поднимаем осторожно:
// только после 6 с запаса, а уровень, который уже «не потянул», запоминаем и больше не трогаем.
function adaptQuality(dtMs) {
  Q.t += dtMs; Q.n++; Q.clock += dtMs;
  if (Q.t < 1000) return;
  const avg = Q.t / Q.n;
  Q.t = 0; Q.n = 0;
  if (Q.mode !== 'auto') return;
  if (avg > 19) {
    Q.good = 0;
    if (Q.clock - Q.upT < 6000) Q.ceil = Math.max(0.55, Q.scale - 0.05); // только что подняли — зря
    if (Q.scale > 0.56) { Q.scale = Math.max(0.55, Q.scale - 0.1); applyRes(); }
    else if (Q.density > 0.35) { Q.density -= 0.15; grass.setDensity(Q.density); }
  } else if (avg < 17.4) {
    Q.good += 1000;
    if (Q.good < 6000) return;
    Q.good = 0;
    if (Q.density < 1) { Q.density = Math.min(1, Q.density + 0.15); grass.setDensity(Q.density); }
    else if (Q.scale < Q.ceil - 0.01) { Q.scale = Math.min(Q.ceil, Q.scale + 0.05); Q.upT = Q.clock; applyRes(); }
  } else Q.good = 0;
}

// экран загрузки: подпись, полоса и проценты
function loadStep(pct, text) {
  if (text) $('loadText').textContent = text;
  $('loadFill').style.width = pct + '%';
  $('loadPct').textContent = Math.round(pct) + '%';
  // даём браузеру нарисовать полосу, прежде чем считать дальше
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

// Мир строится по шагам, между ними обновляется полоса загрузки
async function build() {
  const t0 = performance.now();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance', stencil: false });
  renderer.setClearColor(0x8c96aa);
  scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;
  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, 1400);

  await loadStep(6, 'Поднимаем горы…');
  buildTerrain(scene);
  await loadStep(42, 'Ставим островки над бездной…');
  buildStacks(scene);
  await loadStep(48, 'Сажаем лес…');
  const flora = buildFlora(scene);
  await loadStep(60, 'Разбиваем лагерь…');
  const camp = buildCamp(scene, flora.spawn);
  const ruins = buildRuins(scene);
  await loadStep(66, 'Раскладываем тени…');
  bakeShadows(flora.blobs.concat(camp.blobs, ruins));
  await loadStep(84, 'Пускаем воду…');
  buildSky(scene);
  clouds = buildClouds(scene);
  falls = buildWaterfalls(scene, buildStreams(scene));
  buildMist(scene);
  buildShafts(scene);
  await loadStep(92, 'Растим траву…');
  grass = buildGrass(scene, isMobile ? 16000 : 30000);
  motes = buildMotes(scene, 220);
  await loadStep(97, 'Будим героя…');

  input = new Input(canvas, { stickEl: $('stick'), knobEl: $('knob'), jumpEl: $('jump'), runEl: $('run'), grabEl: $('grab'), chopEl: $('chop') });
  player = new Player(scene, flora.spawn, flora.colliders.concat(camp.colliders));
  inv = new Inventory(store);
  bindInventoryUI(inv, { hotEl: $('hot'), bagEl: $('bagCells'), bagBtn: $('bagBtn'), bagPanel: $('bag'), nameEl: $('held') });
  // общий мир: всё, что игроки меняют (пока — в памяти телефона, потом — на сервере)
  world = new World(store);
  wood = new Woodcutter(scene, flora.trees, player, inv, toast, world);
  // облик героя: цвет и пробная броня, выбор запоминается
  const look = { color: +store.get('bezdna.color', SKIN_COLORS[0]) };
  if (!SKIN_COLORS.includes(look.color)) look.color = SKIN_COLORS[0];
  const applyLook = () => {
    player.setLook(look);
    store.set('bezdna.color', look.color);
    document.querySelectorAll('#colors button').forEach((b) => b.classList.toggle('on', +b.dataset.c === look.color));
  };
  SKIN_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.dataset.c = c; b.style.background = '#' + c.toString(16).padStart(6, '0');
    b.addEventListener('click', () => { look.color = c; applyLook(); });
    $('colors').appendChild(b);
  });
  applyLook();
  // житель лагеря и дом, который он строит
  craft = new Crafting(inv, world, toast);
  craft.onChange = renderCraft;
  inv.onCraft = renderCraft;
  town = new Settlement(scene, camp, player, inv, world, toast);
  town.craft = craft;
  picks = new Pickups(scene, flora.pebbles, flora.rockGeo, player, inv, world, toast);
  mine = new Miner(scene, flora.boulders, flora.rockGeo, player, inv, world, toast);
  renderCraft();
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

// интерфейс трогаем только когда значение изменилось: каждая запись в DOM — пересчёт стилей
const ui = {};
const el = (id) => ui['#' + id] || (ui['#' + id] = $(id));
function setText(id, v) { if (ui[id] !== v) { ui[id] = v; el(id).textContent = v; } }
function setCls(id, c, on) { const k = id + '.' + c; if (ui[k] !== on) { ui[k] = on; el(id).classList.toggle(c, on); } }
function setCss(id, prop, v) { const k = id + ':' + prop; if (ui[k] !== v) { ui[k] = v; el(id).style[prop] = v; } }

const ZONES = [[14, 'Смотровая площадка'], [-3, 'Луг у края'], [-16, 'Первое кольцо'], [-40, 'Карниз над бездной'], [-1e9, 'Нижний уступ']];
let zoneName = '', zoneT = 0;
function updateHud(dt) {
  const y = player.pos.y;
  setCls('grab', 'on', player.climbing);
  setCls('grab', 'ready', player.canGrab);
  // одна кнопка действия: поговорить, прочитать доску или рубить — смотря что рядом
  act = town.near ? 'talk' : town.nearBoard ? 'board' : craft.heldBlueprint() ? 'learn' : picks.target ? 'pick' : wood.target ? 'chop' : mine.target ? 'mine' : '';
  setCls('chop', 'show', !!act);
  if (act) setText('actIcon', { talk: '💬', board: '📜', learn: '📖', pick: '✋', chop: '🪓', mine: '⛏️' }[act]);
  if (talkOpen) { if (talkOpen !== act) closeTalk(); else showTalk(talkOpen); }
  setText('coinN', String(town.wallet));
  const d = Math.round(-y);
  setText('depth', d > 0 ? `−${d} м` : d < -1 ? `+${-d} м` : '0 м');
  setCss('bar', 'height', Math.round(Math.max(0, Math.min(100, (-y / 50) * 100))) + '%');
  let z = ZONES.find((q) => y > q[0])[1];
  if (y > 14 && Math.hypot(player.pos.x - W.CRAG.x, player.pos.z - W.CRAG.z) > 14) z = 'Склоны гор';
  if (Math.hypot(player.pos.x, player.pos.z) < 47 && y > -45 && player.grounded) z = Math.hypot(player.pos.x, player.pos.z) < 16 ? 'Остров в центре бездны' : 'Островки над бездной';
  if (SOURCES.some((s) => Math.hypot(player.pos.x - s.x, player.pos.z - s.z) < 30 && y > s.base - 4)) z = 'Исток ручья';
  // названия зон на экране пока не показываем; zone считается дальше для будущих заданий
  zoneName = z;
}

// разговор с жителем: текст и кнопка зависят от того, что сейчас с домом
let act = '', actHeld = false, talkOpen = '', talkSig = '';
// talkOpen: '' | 'talk' (строитель) | 'board' (доска заданий)
function showTalk(src) {
  const d = src === 'board' ? town.boardDialog() : town.dialog();
  talkOpen = src;
  setCls('talk', 'show', true);
  setText('talkName', d.name); setText('talkText', d.text);
  const pr = $('talkProg');
  if (pr.hidden !== (d.prog === undefined)) pr.hidden = d.prog === undefined;
  if (d.prog !== undefined) setCss('talkProgFill', 'width', Math.round(d.prog * 100) + '%');
  // кнопки пересобираем, только когда они поменялись (окно обновляется каждый кадр)
  const sig = '#' + d.acts.map((a) => a.label + a.can).join('|');
  if (sig !== talkSig) {
    talkSig = sig;
    const box = $('talkActs');
    box.textContent = '';
    for (const a of d.acts) {
      const b = document.createElement('button');
      b.textContent = a.label; b.disabled = !a.can;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => { a.run(); talkSig = ''; showTalk(talkOpen); });
      box.appendChild(b);
    }
  }
}
function closeTalk() { talkOpen = ''; talkSig = ''; setCls('talk', 'show', false); }
$('talkNo').addEventListener('pointerdown', (e) => e.stopPropagation());
$('talkNo').addEventListener('click', closeTalk);

// окно крафта: перерисовывается при изменении инвентаря и рецептов
let craftOpen = false;
function renderCraft() {
  if (!craft) return;
  const box = $('craftList'), rows = craft.list();
  box.textContent = '';
  if (!rows.length) { const d = document.createElement('div'); d.className = 'none'; d.textContent = 'Крафты пока не изучены. Чертежи продаёт строитель в лагере.'; box.appendChild(d); return; }
  for (const r of rows) {
    const el = document.createElement('div'); el.className = 'rc';
    el.innerHTML = `<div class="ic">${r.icon}</div><div class="body"><div class="nm">${r.name}</div><div class="nd">${r.need}</div></div>`;
    const b = document.createElement('button');
    b.textContent = r.have ? 'Есть' : 'Сделать'; b.disabled = !r.can;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', () => craft.make(r.what));
    el.appendChild(b); box.appendChild(el);
  }
}
function toggleCraft(on = !craftOpen) { craftOpen = on; setCls('craft', 'show', on); setCls('craftBtn', 'on', on); if (on) renderCraft(); }
$('craftBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
$('craftBtn').addEventListener('click', () => toggleCraft());

// короткая подпись над слотами: «+3 бревна» и т.п.
let toastT = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => $('toast').classList.remove('show'), 1800);
}

function updateCamera(dt, inp) {
  yaw -= inp.lookX; pitch += inp.lookY;
  pitch = Math.max(firstPerson ? -1.45 : -1.2, Math.min(firstPerson ? 1.45 : 1.3, pitch));
  const p = player.viewPos;
  target.set(p.x, p.y + (firstPerson ? 1.28 : 1.5), p.z);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // направление взгляда
  const fx = -Math.sin(yaw) * cp, fy = -sp, fz = -Math.cos(yaw) * cp;
  if (firstPerson) {
    camera.position.copy(target);
    camera.lookAt(target.x + fx, target.y + fy, target.z + fz);
    return;
  }
  // Камера на «пружинной штанге». Преграды для неё — рельеф, крупные валуны и руины;
  // грибы, кроны, кусты и мелкие камни не в счёт (вблизи камеры они просто тают, см. flora.js).
  // Низкую преграду (бугор, склон за спиной, валун) камера плавно перелетает, приподнимаясь,
  // и только перед настоящей стеной подъезжает к герою — без рывков и застреваний.
  // Луч «толстый»: кроме середины проверяем точки по бокам (половина ближней плоскости кадра).
  const rx = Math.cos(yaw) * 0.32, rz = -Math.sin(yaw) * 0.32;
  // насколько точка ниже допустимого (≤ 0 — свободна)
  const need = (x, y, z) => Math.max(groundAt(x, z, y, true) + 0.35, groundAt(x + rx, z + rz, y, true) + 0.15, groundAt(x - rx, z - rz, y, true) + 0.15) - y;
  const N = 18, KMAX = 0.7;
  let want = camDist, kWant = 0;
  for (let i = 1; i <= N; i++) {
    const t = (i / N) * camDist;
    const x = target.x - fx * t, y = target.y - fy * t, z = target.z - fz * t;
    // во сколько нужно задрать луч, чтобы пройти над преградой в этой точке
    const k = (need(x, y + camLift * t, z) + camLift * t) / t;
    if (k > KMAX) { want = Math.max(0.35, t - camDist / N - 0.15); break; }
    if (k > kWant) kWant = k;
  }
  // к герою — быстро, но не скачком; обратно — не спеша
  camCur = want < camCur ? Math.max(want, camCur - dt * 40) : Math.min(want, camCur + dt * 4);
  camLift += Math.max(-dt * 1.2, Math.min(dt * 10, kWant - camLift));
  const at = (d, k) => camPos.set(target.x - fx * d, target.y - fy * d + k * d, target.z - fz * d);
  // итоговую точку проверяем отдельно: если сглаживание не успело — сразу ставим как надо
  at(camCur, camLift);
  if (need(camPos.x, camPos.y, camPos.z) > 0) {
    camLift = Math.max(camLift, kWant);
    camCur = Math.min(camCur, want);
    for (let k = 0; k < 40 && camCur > 0.35; k++) {
      at(camCur, camLift);
      if (need(camPos.x, camPos.y, camPos.z) <= 0) break;
      camCur = Math.max(0.35, camCur - 0.1);
    }
    at(camCur, camLift);
  }
  const gh = groundAt(camPos.x, camPos.z, camPos.y, true) + 0.3;
  if (camPos.y < gh) camPos.y = gh;
  camera.position.copy(camPos);
  camera.lookAt(target);
}

// Главное меню: герой стоит перед камерой, она медленно ходит вокруг него
const IDLE = { mx: 0, my: 0, jump: false, grab: false, sprint: false };
function menuFrame(dt, t) {
  player.update(dt, IDLE, yaw);
  player.m.root.visible = true;
  const p = player.pos, wide = camera.aspect > 1;
  const a = player.facing + 0.45 + Math.sin(t * 0.25) * 0.3;
  const dist = wide ? 3.4 : 4.6;
  camPos.set(p.x + Math.sin(a) * dist, p.y + 1.25, p.z + Math.cos(a) * dist);
  camPos.y = Math.max(camPos.y, heightAt(camPos.x, camPos.z) + 0.5);
  camera.position.lerp(camPos, Math.min(1, dt * 4));
  // на широком экране герой справа от кнопок, на вертикальном — над ними
  const rx = Math.cos(a), rz = -Math.sin(a);
  if (wide) target.set(p.x - rx * 1.25, p.y + 0.85, p.z - rz * 1.25);
  else target.set(p.x, p.y - 0.35, p.z);
  camera.lookAt(target);
  U.uCenter.value.copy(p); U.uPlayer.value.copy(p);
  clouds.rotation.y += dt * 0.003;
  renderer.render(scene, camera);
}

let ready = false; // мир построен
let last = 0, frames = 0, fpsT = 0, debugCam = null;
function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - last);
  last = now;
  const dt = dtMs / 1000;
  if (!renderer) return;
  U.uTime.value = now / 1000;
  if (!running) { menuFrame(dt, now / 1000); return; }
  adaptQuality(dtMs);

  const inp = input.poll();
  player.held = inv.held ? inv.held.id : null;
  if (!falling) {
    player.update(dt, inp, yaw);
    wood.update(dt, act === 'chop' && inp.chop);
    mine.update(dt, act === 'mine' && inp.chop);
    picks.update(act === 'pick' && inp.chop && !actHeld);
    town.update(dt);
    // нажатие (не удержание) кнопки действия рядом с жителем или доской
    if (inp.chop && !actHeld) {
      if (act === 'talk' || act === 'board') { if (talkOpen) closeTalk(); else showTalk(act); }
      else if (act === 'learn') craft.learn();
    }
    actHeld = inp.chop;
  }
  // упал в колодец — следующий слой ещё не открыт, возвращаем на уступ
  if (player.pos.y < -80 && !falling) { falling = true; $('msg').classList.add('show'); }
  if (falling) {
    fade = Math.min(1, fade + dt * 1.6);
    if (fade >= 1) { player.respawn(); falling = false; setTimeout(() => $('msg').classList.remove('show'), 2600); }
  } else fade = Math.max(0, fade - dt * 1.2);
  setCss('fade', 'opacity', fade.toFixed(2));

  updateCamera(dt, inp);
  if (debugCam) { camera.position.fromArray(debugCam.p); camera.lookAt(debugCam.l[0], debugCam.l[1], debugCam.l[2]); }
  // камера прижата вплотную — героя прячем, чтобы не смотреть изнутри его головы
  player.m.root.visible = !firstPerson && (camCur > 0.7 || !!debugCam);
  player.haloPts.visible = player.m.root.visible;

  U.uCenter.value.copy(player.pos);
  U.uPlayer.value.copy(player.pos);
  clouds.rotation.y += dt * 0.003;

  renderer.render(scene, camera);
  updateHud(dt);

  frames++; fpsT += dtMs;
  if (fpsT > 500) {
    setText('fps', `${Math.round((frames * 1000) / fpsT)} FPS`);
    frames = 0; fpsT = 0;
  }
}

// ---- интерфейс ----

function start() {
  $('menu').classList.add('hide');
  $('hud').classList.add('show');
  running = true;
  yaw = player.facing + Math.PI; // камера встаёт за спину героя
}
$('play').addEventListener('click', start);
// есть ли что терять: сводка прогресса на главном экране
function hasProgress() { return inv.count('log') > 0 || town.wallet > 0 || town.state !== 'none' || craft.known.length > 0; }
function showSave() {
  const el = $('save'), parts = [];
  if (town.wallet) parts.push(`✨ ${town.wallet}`);
  if (inv.count('log')) parts.push(`🪵 ${inv.count('log')}`);
  if (town.state !== 'none') parts.push(town.state === 'built' ? '🏠 дом' : '🏗️ стройка');
  if (craft.known.length) parts.push(`📖 ${craft.known.length}`);
  el.hidden = !parts.length;
  el.innerHTML = parts.map((t) => `<span>${t}</span>`).join('');
}
// Новая игра: стираем всё, что игрок изменил в мире, и строим его заново.
// Мир строится из зерна, поэтому «чистый» — это тот же мир без следов прошлой игры
$('newgame').addEventListener('click', () => $('confirm').classList.add('show'));
$('wipeNo').addEventListener('click', () => $('confirm').classList.remove('show'));
$('wipe').addEventListener('click', () => {
  for (const k of ['bezdna.inv', 'bezdna.world', 'bezdna.axe', 'bezdna.me']) store.del(k);
  location.reload();
});
$('tomenu').addEventListener('click', () => {
  running = false;
  $('panel').classList.remove('show');
  $('hud').classList.remove('show');
  $('menu').classList.remove('hide');
  $('playText').textContent = 'Продолжить';
  showSave();
  if (document.exitPointerLock) document.exitPointerLock();
});
$('gear').addEventListener('click', () => $('panel').classList.toggle('show'));
$('view').addEventListener('click', () => {
  firstPerson = !firstPerson;
  $('view').textContent = firstPerson ? 'Вид: от первого лица' : 'Вид: от третьего лица';
});
$('showfps').addEventListener('click', () => $('fps').classList.toggle('hide'));
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
addEventListener('keydown', (e) => {
  if (e.code === 'KeyV') $('view').click();
  if (e.code === 'KeyC' && craft) toggleCraft();
  if (e.code === 'KeyI' || e.code === 'Tab') { e.preventDefault(); $('bagBtn').click(); }
  if (e.code >= 'Digit1' && e.code <= 'Digit3' && inv) inv.tap(+e.code.slice(5) - 1);
});
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
    // пока идёт проверка и скачивание — тот же экран загрузки, с бегущей полосой
    const busy = state === 'checking' || state === 'downloading';
    if (busy) {
      $('loadText').textContent = state === 'checking' ? 'Проверяем обновление…' : 'Обновление игры…';
      $('loadPct').textContent = state === 'downloading' ? text.replace('Скачиваем… ', '') : '';
    }
    if (ready || busy) { $('loading').classList.toggle('busy', busy); $('loading').classList.toggle('hide', !busy); }
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
requestAnimationFrame(() => setTimeout(async () => {
  try {
    // картинке заставки даём секунду на загрузку, чтобы не строить мир при пустом экране
    await Promise.race([new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = './assets/loading.jpg'; }), new Promise((r) => setTimeout(r, 1200))]);
    await build();
    await loadStep(100, 'Готово!');
    ready = true;
    // камера на заставке: смотрим через луг на провал
    const s = player.pos;
    camera.position.set(s.x + 6, s.y + 3, s.z - 3);
    player.facing = 1.9; // на заставке герой стоит лицом к лагерю и зрителю
    $('play').disabled = false;
    $('playText').textContent = hasProgress() ? 'Продолжить' : 'Играть';
    showSave();
    $('loading').classList.add('hide');
    if (location.hash === '#play') start();
    window.__game = { player, camera, inv, scene, wood, world, town, picks, craft, mine, setView: (y, p) => { yaw = y; pitch = p; }, setCam: (c) => { debugCam = c; }, Q, renderer };
  } catch (err) {
    console.error(err);
    $('loadText').textContent = 'Не удалось запустить 3D-графику на этом устройстве: ' + err.message;
  }
  requestAnimationFrame(frame);
}, 30));
