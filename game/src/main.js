import * as THREE from '../vendor/three.min.js';
import { U, setStyle, loadTerrainTextures, LITE, GLOW_N } from './shaders.js';
setStyle('day');
import { buildCamp } from './camp.js';
import { W, SOURCES, buildTerrain, bakeShadows, heightAt, terrainAt, rockMat, TUNNELS, tunLocal } from './terrain.js';
import { buildFlora, buildGrass, updateFloraDist, propMaterial } from './flora.js';
import { buildSky, buildClouds, buildMist, buildMotes, buildShafts } from './atmosphere.js';
import { buildRuins } from './ruins.js';
import { buildStacks, STACKS } from './stacks.js';
import { buildWater, planWater, prepareWallWaterfall } from './waterfall.js';
import { Player, SKIN_COLORS } from './player.js';
import { buildHands } from './fphands.js';
import { Input } from './input.js';
import { Inventory, bindInventoryUI } from './inventory.js';
import { groundAt, solidAt } from './solids.js';
import { Woodcutter } from './chop.js';
import { World, RULES } from './world.js';
import { Settlement } from './npc.js';
import { Pickups } from './pickups.js';
import { Crafting } from './craft.js';
import { Miner } from './mine.js';
import { Chests } from './chest.js';
import { planDeep, Deep, deepRocks } from './deep.js';
import { Jellies } from './jelly.js';
import { buildDescent, waterDebris, clearShaftDebris, clearWallStones } from './descent.js';
import { buildTunnels, TUN_LIGHTS } from './tunnels.js';
import { buildMines, MINE_LIGHTS, inDeadlyFog, inLava, hotRock } from './mines.js';
import { buildVines } from './vines.js';
import { buildLanterns, buildBridges } from './scale.js';
import { buildSpores, buildMoths } from './life.js';
import { initCreative } from './editor.js';
import { initOuter, updateOuter, outerStats } from './outer.js';
import { initSound, updateSound, setSoundOn, soundOn, sfx, soundState } from './sound.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const isMobile = matchMedia('(pointer: coarse)').matches;
const pending = new Map();
let saveT = 0;
function flushStore() {
  clearTimeout(saveT); saveT = 0;
  for (const [k, v] of pending) { try { localStorage.setItem(k, v); } catch (_) { /* без сохранения */ } }
  pending.clear();
}
addEventListener('visibilitychange', () => { if (document.hidden) flushStore(); });
addEventListener('pagehide', flushStore);
const store = {
  get(k, d) { if (pending.has(k)) return pending.get(k); try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  // Запись откладываем и объединяем: на Android запись в память — синхронная запись на диск,
  // и делать её на каждое бревно значило ловить рывки посреди игры. Пишем раз в ~1.5 с
  // и сразу — когда приложение сворачивают.
  set(k, v) { pending.set(k, v); if (!saveT) saveT = setTimeout(flushStore, 1500); },
  flush: () => flushStore(),
  del(k) { pending.delete(k); try { localStorage.removeItem(k); } catch (_) { /* нечего стирать */ } },
};

const extras = []; // украшения, которые в режиме «Низкое» выключаем (лианы, частицы, мотыльки)
let vines, lanterns, spores, deep, jelly, deepPlan, hands, renderer, scene, camera, player, input, grass, motes, clouds, inv, falls, wood, world, town, picks, berries, craft, mine, chest;
let yaw = Math.PI / 2, pitch = 0.2, camDist = 6.5, camCur = 6.5, firstPerson = false;
let running = false, fade = 0, falling = false, creative = null;
let hotT = 0, hotMsgT = 0;   // сколько держимся за раскалённый камень
const camPos = new THREE.Vector3(), target = new THREE.Vector3(), camSm = new THREE.Vector3(), _cs = new THREE.Vector3();
let camSmDt = -1, camHold = 6.5, camHoldT = 0, camLift = 0, camLiftGoal = 0, camLiftT = 0;

// ---- качество: держим плавность, а не разрешение ----
const Q = {
  mode: store.get('bezdna.q', 'auto'), // auto | low | high
  maxPR: 1, scale: 1, t: 0, n: 0, density: 1,
  ceil: 1, good: 0, upT: -1e9, clock: 0,
};
function applyRes() {
  renderer.setPixelRatio(Q.maxPR * Q.scale);
  renderer.setSize(innerWidth, innerHeight, false);
  if (spores) spores.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 700;
  if (motes) motes.uniforms.uPx.value = falls.uniforms.uPx.value = player.halo.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 700;
}
function setQuality(mode) {
  Q.mode = mode; store.set('bezdna.q', mode);
  const dpr = Math.min(devicePixelRatio || 1, 3);
  Q.maxPR = mode === 'low' ? Math.min(dpr, 1) : mode === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.5);
  Q.scale = 1; Q.ceil = 1; Q.dceil = 1; Q.good = 0;
  Q.density = mode === 'low' ? 0.45 : 1;
  if (grass) grass.setDensity(Q.density);
  // «Низкое»: без лиан, спор, мотыльков и подсветки от кристаллов — самый лёгкий кадр
  for (const o of extras) o.visible = mode !== 'low';
  if (mode === 'low') { U.uGlowB.value.set(0, -1e4, 0, 0); for (const c of U.uGlowC.value) c.setRGB(0, 0, 0); }
  applyRes();
  document.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', b.dataset.q === mode));
}
// Цель — ровные 60 кадров. Судим по среднему за секунду, а не по отдельным кадрам:
// одна заминка (сборка мусора, подгрузка) не должна срезать качество.
// Не тянем стабильно — снижаем густоту травы, потом разрешение. Поднимаем осторожно:
// только после 6 с запаса, а уровень, который уже «не потянул», запоминаем и больше не трогаем.
function lower(min) {
  Q.ceil = Math.max(0.55, Math.min(Q.ceil, Q.scale - 0.05));
  Q.scale = Math.max(min, Q.scale - 0.1); applyRes();
}
function adaptQuality(dtMs) {
  Q.t += dtMs; Q.n++; Q.clock += dtMs;
  (Q.fr || (Q.fr = [])).push(dtMs);
  if (Q.t < 1000) return;
  // медиана, а не среднее: одиночная заминка (сохранение, сборка мусора) не должна снижать
  // качество — смена разрешения сама по себе даёт рывок
  const f = Q.fr.sort((a, b) => a - b), avg = f[f.length >> 1];
  Q.t = 0; Q.n = 0; Q.fr.length = 0;
  if (Q.mode === 'low') return;
  // «Чёткая»: траву не трогаем, но если кадр стабильно не успевает — чуть снижаем разрешение,
  // не ниже, чем у «Авто» (×0.75 от двойного = полуторное). Раньше «Чёткая» не подстраивалась вовсе,
  // и в тяжёлых местах FPS падал до 30 и ниже.
  const high = Q.mode === 'high';
  if (avg > 19) {
    // снижаем, только если тяжело две секунды подряд
    if (!Q.bad) { Q.bad = true; return; }
    Q.bad = false; Q.good = 0;
    if (high) { if (Q.scale > 0.76) lower(0.75); return; }
    // сначала трава (её вершины — главная нагрузка на телефоне, и меньшее разрешение тут не спасает),
    // потом разрешение, и уже в конце — ещё немного травы
    const thin = (min, step) => { Q.dceil = Math.min(Q.dceil ?? 1, Q.density - 0.1); Q.density = Math.max(min, Q.density - step); grass.setDensity(Q.density); };
    if (Q.density > 0.6) thin(0.6, 0.2);
    else if (Q.scale > 0.66) { lower(0.65); }
    else if (Q.density > 0.35) thin(0.35, 0.15);
    else if (Q.scale > 0.56) { lower(0.55); }
  } else if (avg < 17.4) {
    Q.bad = false;
    Q.good += 1000;
    if (Q.good < 6000) return;
    Q.good = 0;
    if (Q.density < (Q.dceil ?? 1) - 0.01) { Q.density = Math.min(Q.dceil ?? 1, Q.density + 0.15); grass.setDensity(Q.density); }
    else if (Q.scale < Q.ceil - 0.01) { Q.scale = Math.min(Q.ceil, Q.scale + 0.05); Q.upT = Q.clock; applyRes(); }
  } else { Q.good = 0; Q.bad = false; }
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
  buildTerrain(scene, prepareWallWaterfall);
  await loadStep(42, 'Ставим островки над бездной…');
  buildStacks(scene);
  // руины раньше растений: тогда кусты и деревья обходят их плиты и столбы
  const ruins = buildRuins(scene);
  // спуск в бездну: плиты вдоль стенки шахты; после руин (мостовые опоры) и столбов (острова)
  buildDescent(scene);
  buildTunnels(scene);         // два больших туннеля из шахты у дна: арка в стене, ход полого вниз, глыбы по стенам
  await loadStep(44, 'Роем шахты…');
  const underFrom = scene.children.length;
  const mineSeedKey = 'bezdna.mineSeed';
  let mineSeed = store.get(mineSeedKey, null);
  if (mineSeed === null) {
    mineSeed = crypto.getRandomValues(new Uint32Array(1))[0];
    store.set(mineSeedKey, String(mineSeed));
    store.flush();
  }
  console.log('> шахты', JSON.stringify(buildMines(scene, Number(mineSeed))));   // шахты под озером: ходы от концов туннелей, ямы, Красная пропасть
  const underObjs = scene.children.slice(underFrom);
  initOuter(scene);
  // путь воды — до растений: над водопадом и на пути ручья по дну не растут деревья и грибы
  planWater({ waterDebris, clearShaftDebris, clearWallStones });
  await loadStep(48, 'Сажаем лес…');
  const flora = buildFlora(scene);
  // глубина: кристаллы, грибы и руда на глыбах ниже −75 м (по глыбам загруженной карты)
  deepPlan = planDeep(flora.boulders);
  flora.boulders.push(...deepRocks(scene, deepPlan, flora.rockGeo, propMaterial()));   // серые камни глубины — обычные валуны под кирку
  await loadStep(60, 'Разбиваем лагерь…');
  const camp = buildCamp(scene, flora.spawn);
  await loadStep(66, 'Раскладываем тени…');
  bakeShadows(flora.blobs.concat(camp.blobs, ruins));
  await loadStep(84, 'Пускаем воду…');
  buildSky(scene);
  clouds = buildClouds(scene);
  falls = buildWater(scene);
  buildMist(scene);
  buildShafts(scene);
  await loadStep(92, 'Растим траву…');
  grass = buildGrass(scene, isMobile ? 16000 : 30000, LITE);
  motes = buildMotes(scene, 220);
  vines = buildVines(scene);   // лианы и корни с краёв глыб в шахте (украшение, без коллизий)
  buildBridges(scene);        // верёвочные мостики между соседними глыбами (по ним можно ходить)
  lanterns = buildLanterns(scene);   // фонари на кронштейнах по бокам глыб (их свет — в deep.lights)
  spores = buildSpores(scene, deepPlan);  // споры у грибов и искры у кристаллов (у каждой частицы своё место)
  extras.push(vines.mesh);
  spores.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 700;
  extras.push(buildMoths(scene, deepPlan), spores.userData.pts);   // светящиеся мотыльки — только у больших грибов на дне
  for (const o of extras) o.visible = Q.mode !== 'low';
  setupZones(underObjs);
  await loadStep(97, 'Будим героя…');

  input = new Input(canvas, { stickEl: $('stick'), knobEl: $('knob'), jumpEl: $('jump'), runEl: $('run'), grabEl: $('grab'), chopEl: $('chop') });
  player = new Player(scene, flora.spawn, flora.colliders.concat(camp.colliders, deepPlan.colliders));
  hands = buildHands(); // руки от первого лица — своя сцена, рисуется поверх кадра
  creative = initCreative({ scene, camera, player, input, hud: $('hud') });
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
  picks = new Pickups(scene, 'pebble', flora.pebbles, flora.rockGeo, player, inv, world, toast);
  berries = new Pickups(scene, 'bush', flora.berryBushes, flora.berryGeo, player, inv, world, toast);
  chest = new Chests(scene, STACKS, flora.trees, player, inv, world, toast);
  mine = new Miner(scene, flora.boulders, flora.rockGeo, player, inv, world, toast);
  deep = new Deep(scene, deepPlan, player, inv, world, toast);
  deep.extraLights = [...lanterns, ...TUN_LIGHTS, ...MINE_LIGHTS];   // + фонари в туннелях
  jelly = new Jellies(scene, player, inv, world, toast);
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
  setCls('lift', 'show', player.pos.y < -40);
  setCls('grab', 'on', player.climbing);
  setCls('grab', 'ready', player.canGrab);
  // одна кнопка действия: поговорить, прочитать доску или рубить — смотря что рядом
  act = town.near ? 'talk' : town.nearBoard ? 'board' : craft.heldBlueprint() ? 'learn' : chest.target ? 'chest' : jelly.target ? 'hunt' : picks.target ? 'pick' : berries.target ? 'berry' : wood.target ? 'chop' : mine.target ? 'mine' : deep.target ? 'deep' : '';
  setCls('chop', 'show', !!act);
  if (act) setText('actIcon', act === 'deep' ? deep.icon : act === 'hunt' ? jelly.icon : { talk: '💬', board: '📜', learn: '📖', chest: '🗝️', pick: '✋', berry: '🫐', chop: '🪓', mine: '⛏️' }[act]);
  if (talkOpen) { if (talkOpen !== act) closeTalk(); else showTalk(talkOpen); }
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
  if (!craft || !craftOpen) return;
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
// «Наверх»: со дна шахты возвращаемся к лагерю (последнее безопасное место на земле)
$('lift').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
$('lift').addEventListener('click', () => { if (falling) return; player.safe.copy(player.home); falling = true; $('msg').textContent = 'Поднимаемся к лагерю…'; $('msg').classList.add('show'); });
$('craftBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
$('craftBtn').addEventListener('click', () => toggleCraft());

// короткая подпись над слотами: «+3 бревна» и т.п.
let toastT = 0;
function toast(text) {
  if (text[0] === '+') sfx('get'); // добыча попала в инвентарь
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => $('toast').classList.remove('show'), 1800);
}

// Толстый луч камеры: точка занята, если камень есть в ней или в шаре радиусом CAM_R вокруг неё
// (ближняя плоскость кадра — примерно такого размера; так край камня не «срезается» кадром).
const CAM_R = 0.3;
const _cr = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, -0.7, 0]];
const EYE_R = 0.16; // шар «глаз» от первого лица
function camBlocked(x, y, z, r = CAM_R, soft = true) {
  for (const [a, b, c] of _cr) if (solidAt(x + a * r, y + b * r, z + c * r, 0, soft)) return true;
  return false;
}
// на каком расстоянии от головы героя луч назад упирается в камень (или вся длина, если свободно).
// Один и тот же шар и для поиска, и для проверки: иначе у стены расстояние «прыгало» между двумя ответами.
// Толщина луча растёт с расстоянием от головы: у самой головы (ближняя плоскость тогда 5 см) хватает тонкого,
// иначе в узкой щели между скал шар 0.3 м не помещался нигде, и камера застревала в голове героя
const camR = (d) => Math.min(CAM_R, 0.1 + 0.12 * d);
function camHit(fx, fy, fz, len) {
  const STEP = 0.15;
  let lo = 0;
  for (let d = STEP; d <= len + 1e-6; d += STEP) {
    if (camBlocked(target.x - fx * d, target.y - fy * d, target.z - fz * d, camR(d), d > 0.9)) {
      let hi = d; // уточняем делением пополам: расстояние меняется плавно, без ступенек
      for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (camBlocked(target.x - fx * m, target.y - fy * m, target.z - fz * m, camR(m), m > 0.9)) hi = m; else lo = m; }
      return Math.max(0.05, lo - 0.05); // вплотную к стене камера у самой головы (герой тогда скрыт), но не в камне
    }
    lo = d;
  }
  return len;
}
// Точка, вокруг которой ходит камера, — голова героя. Когда герой лезет по скале, она отодвинута
// от скалы наружу, а под низким сводом — опущена; сдвиг меняется плавно, без рывков камеры.
const pivOff = new THREE.Vector3(), _pw = new THREE.Vector3();
let heroShown = true;

function fpHands(dt) { hands.update(dt, camera, player); }

function updateCamera(dt, inp) {
  hands.hide();
  yaw -= inp.lookX; pitch += inp.lookY;
  pitch = Math.max(firstPerson ? -1.45 : -1.2, Math.min(firstPerson ? 1.45 : 1.3, pitch));
  const p = player.viewPos;
  target.set(p.x, p.y + (firstPerson ? 1.28 : 1.5), p.z);
  if (!firstPerson) {
    // наружу: от скалы, по которой лезем, иначе — назад, к камере
    let nx = -Math.sin(yaw), nz = -Math.cos(yaw), off = 0;
    if (player.climbing) {
      const f = player.face, ax = f ? f.nx : player.n.x, az = f ? f.nz : player.n.z, hl = Math.hypot(ax, az);
      if (hl > 0.05) { nx = -ax / hl; nz = -az / hl; off = 0.45; }
    }
    // первое свободное место из списка: голова, ниже головы, дальше от скалы
    let ok = false;
    for (const [o, dy] of [[off, off ? -0.2 : 0], [off, -0.6], [off + 0.4, -0.3], [off + 0.4, -0.8], [0, -1.0], [off + 0.8, -0.6], [off + 1.3, -0.3], [off + 1.8, 0]]) {
      _pw.set(-nx * o, dy, -nz * o);
      if (!camBlocked(target.x + _pw.x, target.y + _pw.y, target.z + _pw.z, 0.15, false)) { ok = true; break; }
    }
    if (!ok) _pw.copy(camSmDt < 0 ? _pw.set(0, 0, 0) : pivOff); // свободного места нет — опору не дёргаем
    if (camSmDt < 0 || pivOff.distanceToSquared(_pw) > 4) pivOff.copy(_pw);
    else pivOff.lerp(_pw, 1 - Math.exp(-dt * 6));
    // сглаженная точка в камне — сразу на свободную
    if (ok && camBlocked(target.x + pivOff.x, target.y + pivOff.y, target.z + pivOff.z, 0.15, false)) pivOff.copy(_pw);
    target.add(pivOff);
  }
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // направление взгляда
  const fx = -Math.sin(yaw) * cp, fy = -sp, fz = -Math.cos(yaw) * cp;
  // Камера на «пружинной штанге». Преграды для неё — рельеф, крупные валуны и руины;
  // грибы, кроны, кусты и мелкие камни не в счёт (вблизи камеры они просто тают, см. flora.js).
  // Низкую преграду (бугор, склон за спиной, валун) камера плавно перелетает, приподнимаясь,
  // и только перед настоящей стеной подъезжает к герою — без рывков и застреваний.
  // Луч «толстый»: кроме середины проверяем точки по бокам (половина ближней плоскости кадра).
  const rx = Math.cos(yaw) * 0.32, rz = -Math.sin(yaw) * 0.32;
  // насколько точка ниже допустимого (≤ 0 — свободна)
  // Кроме высоты под камерой проверяем кольцо вокруг неё: вплотную к отвесной стене точка
  // «над землёй» (стена вверх не считается), а ближняя плоскость кадра уже внутри камня.
  // Кольцо растёт с расстоянием от героя (у самого героя, прижатого к стене, оно нулевое).
  const need = (x, y, z, t = 3) => {
    let m = Math.max(groundAt(x, z, y, true) + 0.35, groundAt(x + rx, z + rz, y, true) + 0.15, groundAt(x - rx, z - rz, y, true) + 0.15);
    const rr = Math.min(0.42, 0.14 * Math.max(0, t - 0.8));
    if (rr > 0.05) for (let a = 0; a < 6.2832; a += 0.7854) m = Math.max(m, groundAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr, y, true) + 0.06);
    return m - y;
  };
  // От первого лица камера — глаза героя. Раньше она ставилась в точку головы как есть, и у стены
  // или на скале оказывалась внутри камня: мир виден снизу и «сквозь текстуры». Теперь выводим
  // её из камня так же, как у третьего лица: сначала отодвигаем от стены, потом поднимаем над землёй.
  if (firstPerson) {
    // Глаза героя. Если голова у самой скалы (лезем, протиснулись в щель), глаза отодвигаем от неё:
    // наружу от грани, назад от взгляда, чуть ниже — первое место, где шар глаз (16 см) свободен.
    // Так взгляд не уходит внутрь камня и не видно мир «сквозь текстуры».
    let ox = -fx, oz = -fz;
    if (player.climbing) {
      const f = player.face, ax = f ? f.nx : player.n.x, az = f ? f.nz : player.n.z;
      if (Math.hypot(ax, az) > 0.05) { ox = ax; oz = az; }
    }
    const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    const base = player.climbing ? 0.2 : 0;
    let found = false;
    for (const [o, dy] of [[base, 0], [base + 0.2, 0], [base + 0.4, -0.1], [base + 0.2, -0.35], [base + 0.6, -0.3], [0, -0.5], [base + 0.9, -0.4]]) {
      _cs.set(target.x + ox * o, target.y + dy, target.z + oz * o);
      if (!camBlocked(_cs.x, _cs.y, _cs.z, EYE_R)) { found = true; break; }
    }
    if (!found) _cs.copy(camSmDt < 0 ? target : camSm); // свободного места нет — глаза не двигаем в камень
    if (camSm.distanceToSquared(_cs) > 4 || camSmDt < 0) camSm.copy(_cs);
    else {
      _pw.copy(camSm).lerp(_cs, 1 - Math.exp(-dt * 25));
      camSm.copy(camBlocked(_pw.x, _pw.y, _pw.z, EYE_R) ? _cs : _pw);
    }
    camSmDt = 0;
    camera.position.copy(camSm);
    camera.lookAt(camSm.x + fx, camSm.y + fy, camSm.z + fz);
    fpHands(dt);
    setNear(0.05); setRockSides(true);
    return;
  }
  // Третье лицо — как в обычных играх: камера на «штанге» за героем. Из головы героя назад пускаем
  // толстый луч (шар радиусом CAM_R) и ищем, где он впервые упирается в камень — рельеф, глыбу, столб.
  // Камера встаёт чуть ближе этой точки: к герою подъезжает сразу (чтобы не заглянуть внутрь камня),
  // а назад отъезжает плавно. Камера никогда не «перепрыгивает» через камни вверх — только скользит по лучу.
  // В тесноте расстояние до камня меняется каждый кадр (шаг, поворот), и камера моталась «туда-сюда».
  // Ближе подъезжаем сразу, а отъезжаем, только когда путь свободен дольше 0.3 с.
  // В тесной щели (между двумя скалами, в расселине) штанга назад упирается в стены по бокам, и камера
  // сжималась в голову героя и дёргалась. Тогда пробуем поднять её выше (смотреть сверху-сзади):
  // берём наклон, при котором луч свободен дальше всего. Подъём меняется плавно и только при заметной выгоде.
  if ((camLiftT -= dt) <= 0) {
    camLiftT = 0.12;
    const base = camHit(fx, fy, fz, camDist);
    // Поднимаем только в настоящей тесноте — когда штанга иначе сжимается почти в голову. У обычной стены
    // за спиной (стоим на камне у скалы и водим камерой) камера просто подъезжает ближе, как в других играх:
    // раньше она взлетала на макушку и смотрела на голову сверху. Берём наименьший подъём, которого хватает.
    let best = 0, bestD = base;
    if (base < 1.1) {
      for (const e of [0.3, 0.6]) {
        const pe = Math.min(1.15, pitch + e), c2 = Math.cos(pe);
        const d = camHit(-Math.sin(yaw) * c2, -Math.sin(pe), -Math.cos(yaw) * c2, camDist);
        if (d > bestD + 0.6) { best = e; bestD = d; if (d > 2.4) break; }
      }
      // держим прежний подъём, если он всё ещё не хуже выбранного (без метаний туда-сюда)
      if (camLiftGoal > 0 && best !== camLiftGoal) {
        const pe = Math.min(1.15, pitch + camLiftGoal), c2 = Math.cos(pe);
        if (camHit(-Math.sin(yaw) * c2, -Math.sin(pe), -Math.cos(yaw) * c2, camDist) > bestD - 0.6) best = camLiftGoal;
      }
    } else if (camLiftGoal > 0 && base < 1.6) best = camLiftGoal; // гистерезис
    camLiftGoal = best;
  }
  camLift += (camLiftGoal - camLift) * (1 - Math.exp(-dt * (camLiftGoal > camLift ? 5 : 2)));
  const pb = camLift > 0.001 ? Math.max(pitch, Math.min(1.15, pitch + camLift)) : pitch, cb = Math.cos(pb);
  const bx = -Math.sin(yaw) * cb, by = -Math.sin(pb), bz = -Math.cos(yaw) * cb;
  const hit = camHit(bx, by, bz, camDist);
  if (hit < camCur - 1) camLiftT = 0; // штангу вдруг перекрыло — сразу пересчитать подъём
  if (hit <= camHold) { camHold = hit; camHoldT = 0; }
  else if ((camHoldT += dt) > 0.3) camHold = hit;
  else camHold = Math.min(hit, camHold + dt * 0.5);
  const want = camHold;
  // к герою — быстро, но не скачком (если на пути лишь тонкий камень, а сама точка свободна);
  // если промежуточная точка оказалась бы в камне — сразу на безопасное место
  if (want < camCur) {
    const c = Math.max(want, camCur - Math.max(dt * 3, (camCur - want) * (1 - Math.exp(-dt * 12))));
    camCur = camBlocked(target.x - bx * c, target.y - by * c, target.z - bz * c, camR(c), c > 0.9) ? want : c;
  } else camCur += (want - camCur) * (1 - Math.exp(-dt * 3));
  camPos.set(target.x - bx * camCur, target.y - by * camCur, target.z - bz * camCur);
  // лёгкий фильтр только против дрожи (≈30 мс); в камень сглаженная точка не заходит
  if (camSm.distanceToSquared(camPos) > 4 || camSmDt < 0) camSm.copy(camPos);
  else {
    _cs.copy(camSm).lerp(camPos, 1 - Math.exp(-dt * 35));
    { const dd = _cs.distanceTo(target); camSm.copy(camBlocked(_cs.x, _cs.y, _cs.z, camR(dd), dd > 0.9) ? camPos : _cs); }
  }
  camSmDt = 0; // первый кадр прошёл — дальше фильтруем
  camera.position.copy(camSm);
  camera.lookAt(target);
  // Вплотную к стене ближняя плоскость (20 см) отсекала кусок скалы, и сквозь срез было видно небо.
  // Когда камера прижата к герою или к скале, плоскость подходит ближе; в открытом поле — как раньше
  // (у далёких предметов точность глубины падает, когда плоскость слишком близко).
  const tight = camCur < 1.8 || want < camDist - 0.3;
  setNear(tight ? 0.05 : 0.2); setRockSides(tight);
}

// Рисование скалы с обеих сторон — страховка: если камера всё же оказалась у стены или в камне, мы увидим
// камень изнутри, а не пустоту и мир «сквозь текстуры». Включаем, только когда это может понадобиться:
// в открытом поле лишние задние грани не рисуются (дешевле).
function setRockSides(both) {
  const v = both ? THREE.DoubleSide : THREE.FrontSide;
  if (rockMat && rockMat.side !== v) rockMat.side = v;
  if (rockMat && rockMat.userData.back) rockMat.userData.back.visible = !both; // при двусторонней изнанка уже нарисована
}

function setNear(v) {
  if (Math.abs(camera.near - v) < 1e-4) return;
  camera.near += (v - camera.near) * (v < camera.near ? 1 : 0.15); // ближе — сразу, дальше — плавно
  if (Math.abs(camera.near - v) < 0.004) camera.near = v;
  camera.updateProjectionMatrix();
}

// Главное меню: герой стоит перед камерой, она медленно ходит вокруг него
const IDLE = { mx: 0, my: 0, jump: false, grab: false, sprint: false };
function menuFrame(dt, t) {
  if (hands) hands.hide();
  player.update(dt, IDLE, yaw);
  player.m.root.visible = true;
  const p = player.pos, wide = camera.aspect > 1;
  const a = player.facing + 0.45 + Math.sin(t * 0.25) * 0.3;
  const dist = wide ? 3.4 : 4.6;
  camPos.set(p.x + Math.sin(a) * dist, p.y + 1.25, p.z + Math.cos(a) * dist);
  camPos.y = Math.max(camPos.y, terrainAt(camPos.x, camPos.z, camPos.y) + 0.5);
  camera.position.lerp(camPos, Math.min(1, dt * 4));
  // на широком экране герой справа от кнопок, на вертикальном — над ними
  const rx = Math.cos(a), rz = -Math.sin(a);
  if (wide) target.set(p.x - rx * 1.25, p.y + 0.85, p.z - rz * 1.25);
  else target.set(p.x, p.y - 0.35, p.z);
  camera.lookAt(target);
  U.uCenter.value.copy(p); U.uPlayer.value.copy(p);
  clouds.rotation.y += dt * 0.003;
  updateZones();
  renderer.render(scene, camera);
}

// ---- зоны видимости ----
// Без них видеокарта рисовала всё сразу: с поверхности — шахты под озером (глядя вниз на луг это
// +100…300 вызовов и +100…300 тыс. треугольников), а из шахт — луг, лес и траву на 200 м выше.
// Сквозь камень их всё равно не видно. Раскладываем объекты по слоям камеры:
// 1 — шахты (mines.js). Видны, когда камера ниже −80 м: из нижней части ствола большой шахты сквозь
//     устья туннелей видно далеко вглубь, до ям шахт. Выше −80 м их не видно ни с одного ракурса
//     (проверено: край провала, островки, ствол на −10…−78 м в сторону обоих устьев).
//     Сами туннели (tunnels.js) не прячем: их устья видно с любого края провала.
// 2 — поверхность (всё, что целиком выше −40 м). Не видна, когда камера в шахтах, вне ствола большой шахты.
// Игровые объекты, добавленные позже (герой, NPC, зал гильдии), остаются в слое 0 и видны всегда.
// Границы проверены сравнением кадров «с зонами / без зон» с края провала, из ствола, из туннелей и шахт.
const L_UNDER = 1, L_SURF = 2, UNDER_Y = -80, MINE_Y = -185, SHAFT_R = 64;
function setupZones(underObjs) {
  const under = new Set(underObjs);
  const box = new THREE.Box3();
  // что из шахт заходит в ствол большой шахты — видно сверху, это не прячем
  let kept = 0;
  for (const o of underObjs) {
    box.setFromObject(o);
    const dx = Math.max(box.min.x, Math.min(0, box.max.x)), dz = Math.max(box.min.z, Math.min(0, box.max.z));
    if (!box.isEmpty() && Math.hypot(dx, dz) < SHAFT_R + 6) { kept++; continue; }
    o.traverse((c) => c.layers.set(L_UNDER));
    const sp = new THREE.Sphere(); box.getBoundingSphere(sp);
    const kids = []; o.traverse((c) => kids.push(c));
    mineObjs.push({ sp, kids, on: true });
  }
  let n = 0;
  for (const o of scene.children) {
    if (under.has(o)) continue;
    box.setFromObject(o);
    if (box.isEmpty() || box.min.y < -40) continue;
    o.traverse((c) => c.layers.set(L_SURF)); n++;
  }
  console.log('> зоны: под землёй', underObjs.length - kept, '(у ствола оставлено', kept + ')', 'поверхность', n);
}
// Из ствола большой шахты шахты видно только сквозь устья двух туннелей. Раньше, глядя с нижней части
// ствола вниз на озеро, рисовались все шахты под ним (+370 вызовов, +300 тыс. треугольников) — отсюда
// падение FPS сразу после спуска. Теперь из ствола рисуем только куски шахт, которые попадают в «окно»:
// пирамиду от камеры через проём устья (с запасом: 6 м с боков, 4 м снизу, 8 м сверху — арка в наклонной стене шире самого хода).
const mineObjs = [], L_HIDE = 3;
const _pa = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _pm = new THREE.Vector3();
const portals = [], _pp = TUNNELS.map(() => [0, 1, 2, 3].map(() => new THREE.Plane()));
function portalPlanes(T, c, out) {
  const hw = T.hw + 6, y0 = T.F0 - 4, y1 = T.F0 + T.H + 8;
  _pa[0].set(T.x - T.nx * hw, y0, T.z - T.nz * hw); _pa[1].set(T.x + T.nx * hw, y0, T.z + T.nz * hw);
  _pa[2].set(T.x + T.nx * hw, y1, T.z + T.nz * hw); _pa[3].set(T.x - T.nx * hw, y1, T.z - T.nz * hw);
  _pm.set(T.x + T.dx * 4, (y0 + y1) / 2, T.z + T.dz * 4);   // точка за проёмом — внутри «окна»
  for (let i = 0; i < 4; i++) {
    const pl = out[i].setFromCoplanarPoints(c, _pa[i], _pa[(i + 1) % 4]);
    if (pl.distanceToPoint(_pm) < 0) pl.negate();
  }
  return out;
}
function updateZones() {
  const c = camera.position;
  const r = Math.hypot(c.x, c.z), inMines = c.y < MINE_Y && r > SHAFT_R;
  const under = c.y < UNDER_Y;   // выше −80 м шахт не видно ни с одного ракурса
  camera.layers.mask = 1 | (under ? 1 << L_UNDER : 0) | (inMines ? 0 : 1 << L_SURF);
  if (!under) return;
  // камера в стволе: перед устьями обоих туннелей (не в туннеле и не в шахтах)
  let inShaft = r < SHAFT_R + 4 && c.y > MINE_Y - 10;
  if (inShaft) for (const T of TUNNELS) if (!T.ready || tunLocal(T, c.x, c.z)[0] > -0.5) inShaft = false;
  portals.length = 0;
  if (inShaft) TUNNELS.forEach((T, i) => portals.push(portalPlanes(T, c, _pp[i])));
  for (const m of mineObjs) {
    let on = true;
    if (inShaft) {
      on = false;
      for (const P of portals) {
        let inside = true;
        for (const pl of P) if (pl.distanceToPoint(m.sp.center) < -m.sp.radius) { inside = false; break; }
        if (inside) { on = true; break; }
      }
    }
    if (on !== m.on) { m.on = on; for (const k of m.kids) k.layers.set(on ? L_UNDER : L_HIDE); }
  }
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
  if (!running) { menuFrame(dt, now / 1000); updateSound(dt, player, camera, false); return; }
  adaptQuality(dtMs);

  const inp = input.poll();
  player.held = inv.held ? inv.held.id : null;
  if (creative.on) creative.fly(dt, inp, yaw, pitch);
  else if (!falling) {
    player.update(dt, inp, yaw);
    wood.update(dt, act === 'chop' && inp.chop);
    mine.update(dt, act === 'mine' && inp.chop);
    deep.update(dt, act === 'deep' && inp.chop, act === 'deep' && inp.chop && !actHeld);
    jelly.update(dt, act === 'hunt' && inp.chop);
    picks.update(act === 'pick' && inp.chop && !actHeld);
    berries.update(act === 'berry' && inp.chop && !actHeld);
    chest.update(dt, act === 'chest' && inp.chop && !actHeld);
    town.update(dt);
    // нажатие (не удержание) кнопки действия рядом с жителем или доской
    if (inp.chop && !actHeld) {
      if (act === 'talk' || act === 'board') { if (talkOpen) closeTalk(); else showTalk(act); }
      else if (act === 'learn') craft.learn();
    }
    actHeld = inp.chop;
  }
  // упал в колодец — следующий слой ещё не открыт, возвращаем на уступ
  if ((player.pos.y < -400 || player.fell) && !falling) { falling = true; $('msg').textContent = player.fell ? 'Ты сорвался — возвращаемся на последний уступ' : 'Ты провалился слишком глубоко — возвращаемся'; $('msg').classList.add('show'); }
  // Раскалённый низ столбов у лавы: держаться дольше секунды нельзя — руки разжимаются
  if (!falling && !creative.on && player.climbing && hotRock(player.pos)) {
    hotT += dt;
    if (hotT > 1) {
      hotT = 0; player.face = null; player.climbing = false; player.climbCd = 0.8; player.airT = 1; player.vel.set(0, 0, 0);
      sfx('hurt'); $('msg').textContent = 'Камень раскалён — руки не удержали!'; $('msg').classList.add('show');
      clearTimeout(hotMsgT); hotMsgT = setTimeout(() => $('msg').classList.remove('show'), 1800);
    }
  } else hotT = Math.max(0, hotT - dt * 2);
  // Красная пропасть: упал в туман — смерть, просыпаемся на последнем уступе
  if (!falling && !creative.on && inDeadlyFog(player.pos)) { falling = true; fade = Math.max(fade, 0.5); sfx('hurt'); $('msg').textContent = inLava(player.pos) ? 'Ты упал в лаву… Возвращаемся на последний уступ' : 'Красный туман поглотил тебя… Возвращаемся на последний уступ'; $('msg').classList.add('show'); }
  if (falling) {
    fade = Math.min(1, fade + dt * 1.6);
    if (fade >= 1) { player.respawn(); falling = false; setTimeout(() => $('msg').classList.remove('show'), 2600); }
  } else fade = Math.max(0, fade - dt * 1.2);
  setCss('fade', 'opacity', fade.toFixed(2));

  updateCamera(dt, inp);
  if (deep && Q.mode !== 'low') { const c = camera.position; deep.lights(c.x, c.y, c.z, U.uGlowP.value, U.uGlowC.value, GLOW_N, now / 1000, U.uGlowB.value); }
  if (creative.on) { creative.camera(yaw, pitch); hands.hide(); }
  if (debugCam) { camera.position.fromArray(debugCam.p); camera.lookAt(debugCam.l[0], debugCam.l[1], debugCam.l[2]); }
  // камера прижата вплотную — героя прячем, чтобы не смотреть изнутри его головы
  // камера у самой головы — героя прячем; с запасом (0.55 / 0.8 м), чтобы он не мигал у стены
  heroShown = camCur > (heroShown ? 0.55 : 0.8);
  player.m.root.visible = !creative.on && !firstPerson && (heroShown || !!debugCam);
  player.haloPts.visible = player.m.root.visible;

  updateOuter(player.pos.x, player.pos.z);
  updateFloraDist(camera.position.x, camera.position.z, vegDist);
  U.uCenter.value.copy(player.pos);
  U.uPlayer.value.copy(player.pos);
  clouds.rotation.y += dt * 0.003;

  updateZones();
  renderer.render(scene, camera);
  hands.render(renderer, camera);
  updateSound(dt, player, camera, !falling && !creative.on); // руки от первого лица — поверх всего
  updateHud(dt);

  frames++; fpsT += dtMs;
  if (fpsT > 500) {
    const pp = player.pos, ri = renderer.info.render;
    // координаты, высота, куда смотрит герой и нагрузка — чтобы по скриншоту сразу видно, где это и что тормозит
    setText('fps', `${Math.round((frames * 1000) / fpsT)} FPS\n${pp.x.toFixed(0)} ${pp.y.toFixed(0)} ${pp.z.toFixed(0)}\nyaw ${player.facing.toFixed(2)}\n${ri.calls} вызовов · ${Math.round(ri.triangles / 1000)}k△`);
    frames = 0; fpsT = 0;
  }
}

// ---- интерфейс ----

// Вход в игру — тоже за экраном загрузки: сначала собираем шейдеры и прогоняем кадр во все стороны
// (геометрия и текстуры уходят в видеокарту), и только потом показываем мир — без лагов первых секунд
let starting = false;
async function start() {
  if (starting || running) return;
  starting = true;
  const L = $('loading');
  loadStep(10, 'Входим в мир…');
  L.classList.remove('hide');
  $('menu').classList.add('hide');
  yaw = player.facing + Math.PI; // камера встаёт за спину героя
  try {
    updateCamera(1 / 60, { lookX: 0, lookY: 0 });
    hands.hide();
    // при входе собираем шейдеры и отправляем в видеокарту всё, включая шахты, — без лагов на спуске
    camera.layers.enableAll();
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
    await loadStep(55, 'Входим в мир…');
    // кадр в 6 сторон с широким углом: всё вокруг героя один раз отрисовано
    const fov = camera.fov, q = camera.quaternion.clone(), pos = camera.position.clone();
    camera.fov = 100; camera.updateProjectionMatrix();
    for (let i = 0; i < 6; i++) {
      const a = (i / 4) * Math.PI * 2;
      if (i < 4) camera.lookAt(pos.x + Math.sin(a), pos.y, pos.z + Math.cos(a));
      else camera.lookAt(pos.x + 0.01, pos.y + (i === 4 ? -1 : 1), pos.z);
      renderer.render(scene, camera);
      await loadStep(60 + i * 6, 'Входим в мир…');
    }
    camera.fov = fov; camera.updateProjectionMatrix(); camera.quaternion.copy(q);
  } catch (e) { console.warn(e); }
  await loadStep(100, 'Готово!');
  $('hud').classList.add('show');
  running = true;
  starting = false;
  L.classList.add('hide');
}
$('play').addEventListener('click', start);
// есть ли что терять: сводка прогресса на главном экране
function hasProgress() { return inv.count('log') > 0 || inv.count('stone') > 0 || town.state !== 'none'; }
// Сводка на главном экране: ресурсы сверху и карточка с ближайшей целью
function showSave() {
  const logs = inv.count('log'), st = town.state;
  const chips = [`🪵 ${logs}`, `🪨 ${inv.count('stone')}`, `⚙️ ${inv.count('gear')}`, town.hall === 'built' ? '🏛️ Гильдия' : st === 'built' ? '🏠 Дом' : st === 'building' ? '🏗️ Стройка' : '⛺ Палатка'];
  $('chips').innerHTML = chips.map((t) => `<span>${t}</span>`).join('');
  const cost = RULES.build.house.cost.log, H = RULES.build.hall.cost, P = town.project || {};
  let ico, t, p, k;
  if (st === 'none') { ico = '🏠'; t = 'Построй дом'; p = `Принеси строителю ${cost} брёвен — он поставит дом с доской заданий.`; k = Math.min(1, logs / cost); }
  else if (st === 'building') { ico = '🏗️'; t = 'Дом строится'; p = `Осталось ${town.left()} с — заходи посмотреть.`; k = 1 - town.left() / (RULES.build.house.ms / 1000); }
  else if (town.hall === 'none') { ico = '🏛️'; t = 'Задание: зал гильдии'; p = `На доске в доме: ${H.log} 🪵, ${H.stone} 🪨 и ${H.gear} ⚙️ (из ящика на островке). Внесено: ${P.log || 0}/${H.log} · ${P.stone || 0}/${H.stone} · ${P.gear || 0}/${H.gear}.`; k = Object.keys(H).reduce((a, id) => a + Math.min(1, (P[id] || 0) / H[id]), 0) / 3; }
  else if (town.hall === 'building') { ico = '🏗️'; t = 'Зал гильдии строится'; p = `Осталось ${town.hallLeft()} с.`; k = 1 - town.hallLeft() / (RULES.build.hall.ms / 1000); }
  else { ico = '💎'; t = 'Глубже в бездну'; p = 'Зал гильдии готов. Ищи старые ящики на островках над бездной.'; k = 1; }
  $('goalIco').textContent = ico; $('goalT').textContent = t; $('goalP').textContent = p;
  $('goalBar').style.width = Math.round(k * 100) + '%';
  $('playSub').textContent = hasProgress() ? 'С последнего сохранения' : 'Новое приключение';
}
// появление меню: элементы выезжают по очереди, потом включаются «живые» анимации
function menuEnter() {
  const m = $('menu');
  m.classList.remove('enter', 'live'); void m.offsetWidth; m.classList.add('enter');
  setTimeout(() => { m.classList.remove('enter'); m.classList.add('live'); }, 1300);
}
// светлячки над лугом
{
  const box = $('ff');
  for (let i = 0; i < 18; i++) {
    const e = document.createElement('span');
    if (i % 4 === 0) e.className = 'c';
    e.style.left = (8 + Math.random() * 88) + '%'; e.style.top = (25 + Math.random() * 70) + '%';
    e.style.setProperty('--d', (7 + Math.random() * 8).toFixed(1) + 's'); e.style.setProperty('--t', (-Math.random() * 10).toFixed(1) + 's');
    const sc = 0.6 + Math.random() * 0.9; e.style.transform = `scale(${sc})`;
    box.appendChild(e);
  }
}
// Новая игра: стираем всё, что игрок изменил в мире, и строим его заново.
// Мир строится из зерна, поэтому «чистый» — это тот же мир без следов прошлой игры
$('newgame').addEventListener('click', () => $('confirm').classList.add('show'));
$('wipeNo').addEventListener('click', () => $('confirm').classList.remove('show'));
$('wipe').addEventListener('click', () => {
  store.flush();
  for (const k of ['bezdna.inv', 'bezdna.world', 'bezdna.axe', 'bezdna.me', 'bezdna.mineSeed']) store.del(k);
  location.reload();
});
$('tomenu').addEventListener('click', () => {
  if (creative) creative.toggle(false);
  running = false;
  $('panel').classList.remove('show');
  $('hud').classList.remove('show');
  $('menu').classList.remove('hide');
  $('playText').textContent = 'Продолжить';
  showSave();
  menuEnter();
  if (document.exitPointerLock) document.exitPointerLock();
});
$('gear').addEventListener('click', () => $('panel').classList.toggle('show'));
// пока открыто меню, кнопки управления прячем — они ложились поверх нижних пунктов меню
new MutationObserver(() => document.body.classList.toggle('panelOpen', $('panel').classList.contains('show'))).observe($('panel'), { attributes: true, attributeFilter: ['class'] });
$('view').addEventListener('click', () => {
  firstPerson = !firstPerson;
  $('view').textContent = firstPerson ? 'Вид: от первого лица' : 'Вид: от третьего лица';
});
$('creaBtn').addEventListener('click', () => { if (creative) { $('panel').classList.remove('show'); creative.toggle(true); } });
$('showfps').addEventListener('click', () => $('fps').classList.toggle('hide'));
// звук: включён по умолчанию, выбор запоминается
initSound(store);
const sndLabel = () => { $('sound').textContent = soundOn() ? '🔊 Звук: включён' : '🔇 Звук: выключен'; };
$('sound').addEventListener('click', () => { setSoundOn(!soundOn()); sndLabel(); });
sndLabel();
document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
// дальность растительности (деревья, кусты, грибы, камни): близко — легче для телефона
const VEG = { near: 70, mid: 130, far: 260 };
let vegDist = VEG[store.get('bezdna.veg', 'mid')] || VEG.mid;
function setVeg(v) {
  store.set('bezdna.veg', v); vegDist = VEG[v];
  document.querySelectorAll('[data-veg]').forEach((b) => b.classList.toggle('on', b.dataset.veg === v));
}
document.querySelectorAll('[data-veg]').forEach((b) => b.addEventListener('click', () => setVeg(b.dataset.veg)));
setVeg(store.get('bezdna.veg', 'mid'));
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
    await Promise.race([Promise.all([new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = './assets/loading.jpg'; }), loadTerrainTextures()]), new Promise((r) => setTimeout(r, 4000))]);
    // карта поля, встроенная в игру (если есть): её получают все телефоны, у кого нет своей
    try { const r = await fetch('./maps/field.json', { cache: 'no-store' }); if (r.ok) window.__builtinField = await r.text(); } catch (_) { /* нет — значит генерация */ }
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
    menuEnter();
    $('loading').classList.add('hide');
    if (location.hash === '#play') start();
    window.__game = { soundState, camDbg: () => ({ lift: camLift, goal: camLiftGoal, piv: pivOff.toArray().map((v) => +v.toFixed(2)), hold: +camHold.toFixed(2) }), outerStats, stepCam: (dt, lx, ly) => { updateCamera(dt, { lookX: lx, lookY: ly }); return camCur; }, player, camera, inv, scene, wood, world, town, picks, berries, craft, mine, chest, deep, jelly, setView: (y, p) => { yaw = y; pitch = p; }, setFirstPerson: (v) => { firstPerson = !!v; }, setCam: (c) => { debugCam = c; }, Q, renderer, creative };
  } catch (err) {
    console.error(err);
    $('loadText').textContent = 'Не удалось запустить 3D-графику на этом устройстве: ' + err.message;
  }
  requestAnimationFrame(frame);
}, 30));
