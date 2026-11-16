import * as THREE from '../vendor/three.min.js';
import { STONEAPI } from './descent.js';
import { rockAt } from './solids.js';
import { heightAt } from './terrain.js';
import { U } from './shaders.js';

// Режим «Творчество»: свободный полёт и сборка рельефа поля глыб (ниже −101 м) прямо в игре.
// Глыбы ставятся в точку под прицелом, их можно выбрать, переставить, изменить (размер, форма, наклон…) и убрать.
// Раскладка сохраняется на устройстве и подхватывается при запуске; код раскладки можно скопировать и вставить на другом телефоне.
const TAU = Math.PI * 2;
const PRESETS = {
  boulder: { label: 'Валун', n: 2.1, dome: 1.2, ratio: 1, hs: 1, gs: 0, flt: false },
  slab: { label: 'Плита', n: 2.8, dome: 0.15, ratio: 1.6, hs: 0.6, gs: 0, flt: false },
  block: { label: 'Блок', n: 3.6, dome: 0.25, ratio: 1.1, hs: 1, gs: 0, flt: false },
  spire: { label: 'Шпиль', n: 2.2, dome: 0.5, ratio: 1, hs: 3, gs: 0, flt: false, size: 2 },
  bridge: { label: 'Мост', n: 3.2, dome: 0, ratio: 3.4, hs: 1, gs: 0, flt: true, size: 3 },
  shelf: { label: 'Полка', n: 2.6, dome: 0.12, ratio: 1.3, hs: 1, gs: 0, flt: true, size: 2.2 },
};
const SLIDERS = [
  ['size', 'Размер', 0.8, 16, 0.2, 'м'], ['ratio', 'Вытянутость', 0.35, 3.5, 0.05, '×'], ['ang', 'Поворот', 0, 360, 5, '°'],
  ['hs', 'Толщина тела', 0.3, 4, 0.05, '×'], ['n', 'Квадратность', 1.8, 4.5, 0.05, ''], ['dome', 'Купол', 0, 5, 0.05, 'м'],
  ['gs', 'Наклон', -0.8, 0.8, 0.02, ''], ['bump', 'Неровность', 0, 0.5, 0.01, ''],
];

// паспорт глыбы по кисти в точке (x, z) с верхом на высоте y
function specFrom(b, x, z, y) {
  const A = b.size * b.ratio, B = b.size / b.ratio, a = b.size;
  const h = 2.4 + a * 0.5, T = b.flt ? 1.7 : y - heightAt(x, z) + 1.5;
  const prof = b.flt
    ? [[T * 0.3, 1.02], [T * 0.7, 0.93], [T, 0.62]]
    : [[h * 0.3, 1.06], [h * 0.7, 0.98], [h, 0.78], [Math.max(h + 1, T), 0.7]];
  return { x, z, y, A, B, ang: b.ang * TAU / 360, n: b.n, bump: b.bump, dome: b.dome, gs: b.gs, arch: 0, seg: a > 6 ? 18 : 12, T, prof, flt: b.flt, hs: b.hs, col: b.col, kind: 'built', rv: Array.from({ length: 9 }, () => +Math.random().toFixed(4)) };
}
const brushOf = (s) => ({ size: +Math.sqrt(s.A * s.B).toFixed(2), ratio: +Math.sqrt(s.A / s.B).toFixed(2), ang: Math.round(((s.ang * 360 / TAU) % 360 + 360) % 360), hs: s.hs ?? 1, n: s.n, dome: s.dome, gs: s.gs || 0, bump: s.bump, flt: !!s.flt, col: s.col !== false });

export function initCreative({ scene, camera, player, input, hud, onToggle }) {
  const C = { on: false };
  const brush = { ...brushOf(specFrom({ size: 4, ratio: 1, ang: 0, hs: 1, n: 2.1, dome: 1.2, gs: 0, bump: 0.15, flt: false, col: false }, 0, 0, -120)) };
  let sel = null, hit = null, saveT = 0, flushing = false;
  const undo = [];
  const fl = { up: false, down: false };

  // ---- интерфейс ----
  const css = document.createElement('style');
  css.textContent = `
  #edBar { position: absolute; top: max(14px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); display: none; gap: 6px; padding: 6px; border-radius: 14px; z-index: 5; }
  #edBar button, #edPanel button, .edUD button { padding: 9px 10px; border-radius: 10px; background: rgba(255,255,255,.14); font-size: 13px; font-weight: 800; color: #fff; }
  #edBar button.pri { background: var(--accent); color: #3a2500; }
  #edPanel { position: absolute; top: max(66px, calc(env(safe-area-inset-top) + 52px)); right: max(14px, env(safe-area-inset-right)); width: 218px; max-height: calc(100vh - 90px); overflow-y: auto; padding: 10px; border-radius: 14px; display: none; z-index: 5; font-size: 12px; }
  #edPanel h4 { margin: 8px 0 4px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; opacity: .75; }
  #edPanel .g { display: flex; flex-wrap: wrap; gap: 4px; }
  #edPanel .g button { flex: 1 1 30%; padding: 8px 2px; font-size: 12px; }
  #edPanel .g button.on { background: var(--accent); color: #3a2500; }
  #edPanel .sl { display: flex; align-items: center; gap: 4px; margin: 3px 0; }
  #edPanel .sl span { width: 72px; font-size: 11px; opacity: .9; }
  #edPanel .sl input { flex: 1; min-width: 0; height: 26px; }
  #edPanel .sl b { width: 34px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
  #edPanel textarea { width: 100%; height: 70px; font-size: 10px; background: rgba(0,0,0,.4); color: #fff; border: 1px solid var(--line); border-radius: 8px; display: none; }
  #edInfo { font-size: 12px; opacity: .95; margin: 2px 0 4px; min-height: 16px; }
  .edUD { position: absolute; left: max(14px, env(safe-area-inset-left)); bottom: 38%; display: none; flex-direction: column; gap: 8px; z-index: 5; }
  .edUD button { width: 52px; height: 52px; font-size: 22px; padding: 0; }
  #edCross { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; display: none; pointer-events: none; }
  #edCross:before, #edCross:after { content: ''; position: absolute; background: #fff; box-shadow: 0 0 3px #000; }
  #edCross:before { left: 10px; top: 0; width: 2px; height: 22px; } #edCross:after { top: 10px; left: 0; height: 2px; width: 22px; }
  body.crea #jump, body.crea #grab, body.crea #chop, body.crea #hotbar, body.crea #lift, body.crea #craftBtn { display: none !important; }
  body.crea #edBar { display: flex; } body.crea .edUD { display: flex; } body.crea #edCross { display: block; }`;
  document.head.appendChild(css);
  const el = (tag, props = {}, parent) => { const e = Object.assign(document.createElement(tag), props); if (parent) parent.appendChild(e); return e; };
  const stop = (e) => e.stopPropagation();
  const bar = el('div', { id: 'edBar', className: 'glass' }, hud), panel = el('div', { id: 'edPanel', className: 'glass' }, hud);
  const ud = el('div', { className: 'edUD' }, hud), cross = el('div', { id: 'edCross' }, hud);
  for (const e of [bar, panel, ud]) for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart']) e.addEventListener(ev, stop);
  const btn = (label, fn, parent, cls = '') => { const b = el('button', { textContent: label, className: cls }, parent); b.addEventListener('click', (e) => { e.preventDefault(); fn(); }); return b; };
  const hold = (label, key) => {
    const b = el('button', { textContent: label, className: 'glass' }, ud);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); fl[key] = true; });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => { fl[key] = false; });
  };
  hold('▲', 'up'); hold('▼', 'down');

  const info = el('div', { id: 'edInfo' }, panel);
  const sliders = {};
  el('h4', { textContent: 'Форма' }, panel);
  const pg = el('div', { className: 'g' }, panel);
  for (const [k, p] of Object.entries(PRESETS)) btn(p.label, () => preset(k), pg);
  el('h4', { textContent: 'Настройка' }, panel);
  for (const [key, label, min, max, step, unit] of SLIDERS) {
    const row = el('div', { className: 'sl' }, panel);
    el('span', { textContent: label }, row);
    const inp = el('input', { type: 'range', min, max, step }, row), val = el('b', {}, row);
    inp.addEventListener('pointerdown', () => { if (sel) pushUndo(sel); });
    inp.addEventListener('input', () => { brush[key] = +inp.value; val.textContent = (+inp.value).toFixed(step < 0.1 ? 2 : 1) + unit; applyBrush(key); });
    sliders[key] = { inp, val, unit, step };
  }
  const tg = el('div', { className: 'g' }, panel);
  const colBtn = btn('Опора до дна', () => { if (sel) pushUndo(sel); brush.col = !brush.col; applyBrush('col'); refreshUI(); }, tg);
  btn('Перемешать', () => { if (sel) { pushUndo(sel); edit(sel, { rv: Array.from({ length: 9 }, () => +Math.random().toFixed(4)) }); } }, tg);
  el('h4', { textContent: 'Высота выбранной' }, panel);
  const hg = el('div', { className: 'g' }, panel);
  btn('−2', () => nudge(-2), hg); btn('−0.5', () => nudge(-0.5), hg); btn('+0.5', () => nudge(0.5), hg); btn('+2', () => nudge(2), hg);
  el('h4', { textContent: 'Раскладка' }, panel);
  const sg = el('div', { className: 'g' }, panel);
  const lightBtn = btn('☀ Светлее', () => setLight(!lit), sg);
  btn('К полю', () => { const e = STONEAPI.entry(); player.pos.set(e[0], e[1] + 3, e[2]); }, sg);
  btn('Сохранить', () => { save(true); }, sg);
  // код карты — чтобы перенести её на другой телефон: скопировать, отправить себе (почта, заметки, файл), вставить там
  btn('Скопировать код', async () => {
    const code = await STONEAPI.code();
    ta.style.display = 'block'; ta.value = code; ta.focus(); ta.select();
    let ok = false;
    try { await navigator.clipboard.writeText(code); ok = true; } catch (_) { try { ok = document.execCommand('copy'); } catch (__) { /* скопируй вручную */ } }
    toast(ok ? `Код скопирован (${Math.round(code.length / 1000)} тыс. знаков): отправь его себе` : 'Выдели текст в поле и скопируй');
  }, sg);
  btn('Вставить код', () => { ta.style.display = 'block'; ta.value = ''; ta.placeholder = 'Вставь код сюда и нажми «Применить»'; applyBtn.style.display = 'block'; }, sg);
  const ta = el('textarea', {}, panel);
  const applyBtn = btn('Применить', async () => {
    let a = null;
    try { a = await STONEAPI.decode(ta.value); } catch (_) { a = null; }
    if (!a || !a.length) return toast('Не получилось прочитать код');
    undo.length = 0; STONEAPI.backup();
    const bad = STONEAPI.load(a); select(null); save();
    ta.style.display = 'none'; applyBtn.style.display = 'none';
    toast('Карта загружена: глыб ' + (a.length - bad) + (bad ? ', пропущено ' + bad : '')); refreshUI();
  }, panel);
  applyBtn.style.display = 'none'; applyBtn.style.width = '100%';
  const dg = el('div', { className: 'g' }, panel);
  // опасные кнопки — с повторным нажатием (окна confirm в приложении могут не открываться)
  const sure = (label, fn) => { const b = btn(label, () => { if (b.dataset.arm) { delete b.dataset.arm; b.textContent = label; fn(); } else { b.dataset.arm = 1; b.textContent = 'Точно?'; setTimeout(() => { delete b.dataset.arm; b.textContent = label; }, 2500); } }, dg); };
  // перед «Очистить» и «Как было» текущая карта откладывается в запас — «Вернуть прошлую» её достаёт
  sure('Очистить поле', () => { undo.length = 0; STONEAPI.backup(); STONEAPI.clear(); select(null); save(); });
  sure('Как было', () => { STONEAPI.reset(); location.reload(); });
  sure('Вернуть прошлую', () => { const n = STONEAPI.restoreBackup(); undo.length = 0; select(null); toast(n ? 'Вернули прошлую карту: глыб ' + n : 'Запасной карты нет'); refreshUI(); });
  btn('Выйти', () => toggle(false), dg);

  btn('📌 Поставить', place, bar, 'pri'); btn('👆 Выбрать', pickSel, bar); btn('⤴ Сюда', moveSel, bar); btn('🗑 Убрать', removeSel, bar); btn('↩', doUndo, bar);
  const msg = el('div', { className: 'glass', style: 'position:absolute;bottom:64px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:12px;font-size:13px;display:none;z-index:6' }, hud);
  let msgT = 0;
  function toast(t) { msg.textContent = t; msg.style.display = 'block'; clearTimeout(msgT); msgT = setTimeout(() => { msg.style.display = 'none'; }, 2200); }

  // внизу шахты тёмно: на время стройки подсвечиваем глубину и тени, чтобы форма читалась
  let lit = false;
  const keep = { b: U.uAbyssB.value.clone(), lo: U.uAmbLo.value.clone(), hi: U.uAmbHi.value.clone(), den: U.uFogDen.value };
  function setLight(v) {
    lit = v; lightBtn.classList.toggle('on', v);
    if (v) { U.uAbyssB.value.setRGB(0.42, 0.5, 0.58); U.uAmbLo.value.setRGB(0.55, 0.55, 0.6); U.uAmbHi.value.setRGB(0.7, 0.74, 0.82); U.uFogDen.value = keep.den * 0.6; }
    else { U.uAbyssB.value.copy(keep.b); U.uAmbLo.value.copy(keep.lo); U.uAmbHi.value.copy(keep.hi); U.uFogDen.value = keep.den; }
  }

  // ---- маркеры: куда смотрим и что выбрано ----
  const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc247, depthTest: false, transparent: true, opacity: 0.9 }));
  dot.renderOrder = 999; dot.visible = false; dot.frustumCulled = false; scene.add(dot);
  const selLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }));
  selLine.renderOrder = 998; selLine.frustumCulled = false; selLine.visible = false; scene.add(selLine);

  function refreshUI() {
    for (const [key] of SLIDERS) { const s = sliders[key]; s.inp.value = brush[key]; s.val.textContent = (+brush[key]).toFixed(s.step < 0.1 ? 2 : 1) + s.unit; }
    colBtn.classList.toggle('on', !!brush.col);
    const st = sel && STONEAPI.get(sel);
    info.textContent = st ? `Выбрана глыба №${sel} · верх ${st.spec.y.toFixed(1)} м` : 'Ничего не выбрано · глыб: ' + STONEAPI.count;
  }
  function markSel() {
    const st = sel && STONEAPI.get(sel);
    selLine.visible = !!st;
    if (!st) return;
    const r = st.l.ring, v = [];
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; v.push(a[0], a[1] + 0.15, a[2], b[0], b[1] + 0.15, b[2]); }
    v.push(st.l.cx, st.l.yTop, st.l.cz, st.l.cx, st.l.yTop + 8, st.l.cz);
    selLine.geometry.dispose();
    selLine.geometry = new THREE.BufferGeometry();
    selLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  }
  function select(id) {
    sel = id && STONEAPI.get(id) ? id : null;
    if (sel) Object.assign(brush, brushOf(STONEAPI.get(sel).spec));
    markSel(); refreshUI();
  }

  // ---- правки ----
  function pushUndo(id) { const s = STONEAPI.get(id); if (s) { undo.push({ t: 'upd', id, spec: JSON.parse(JSON.stringify(s.spec)) }); if (undo.length > 40) undo.shift(); } }
  function edit(id, patch) { const n = STONEAPI.update(id, patch); if (id === sel) markSel(); queueSave(); return n; }
  function patchOf(key) {
    const A = brush.size * brush.ratio, B = brush.size / brush.ratio;
    return { size: { A, B }, ratio: { A, B }, ang: { ang: brush.ang * TAU / 360 }, hs: { hs: brush.hs }, n: { n: brush.n }, dome: { dome: brush.dome }, gs: { gs: brush.gs }, bump: { bump: brush.bump }, col: { col: brush.col } }[key];
  }
  function applyBrush(key) { if (sel && STONEAPI.get(sel)) edit(sel, patchOf(key)); }
  function preset(k) {
    const p = PRESETS[k];
    if (sel) pushUndo(sel);
    for (const f of ['n', 'dome', 'ratio', 'hs', 'gs', 'flt']) brush[f] = p[f];
    if (p.size) brush.size = p.size;
    brush.col = false;
    const st = sel && STONEAPI.get(sel);
    if (st) { const s = specFrom(brush, st.spec.x, st.spec.z, st.spec.y); edit(sel, { A: s.A, B: s.B, n: s.n, dome: s.dome, gs: s.gs, hs: s.hs, col: s.col, flt: s.flt, T: s.T, prof: s.prof, seg: s.seg }); }
    refreshUI();
  }
  function nudge(d) { if (!sel) return toast('Сначала выбери глыбу'); pushUndo(sel); edit(sel, { y: STONEAPI.get(sel).spec.y + d }); refreshUI(); }
  function place() {
    if (!hit) return toast('Прицел никуда не попал');
    const s = specFrom(brush, hit.x, hit.z, hit.y + 0.6), n = STONEAPI.add(s);
    undo.push({ t: 'add', id: n.id }); select(n.id); queueSave();
  }
  function pickSel() { if (hit && hit.stone) { select(hit.stone.id); toast('Выбрана глыба №' + hit.stone.id); } else toast('Здесь нет глыбы поля'); }
  function moveSel() {
    if (!sel) return toast('Сначала выбери глыбу');
    if (!hit) return;
    pushUndo(sel); edit(sel, { x: hit.x, z: hit.z, y: hit.y + 0.6 }); refreshUI();
  }
  function removeSel() {
    const id = sel || (hit && hit.stone && hit.stone.id);
    const st = id && STONEAPI.get(id);
    if (!st) return toast('Нечего убирать: наведи прицел на глыбу');
    undo.push({ t: 'del', spec: JSON.parse(JSON.stringify(st.spec)) });
    STONEAPI.remove(id); if (id === sel) select(null); queueSave(); refreshUI();
  }
  function doUndo() {
    const u = undo.pop();
    if (!u) return toast('Больше нечего отменять');
    if (u.t === 'add') { STONEAPI.remove(u.id); if (sel === u.id) select(null); }
    else if (u.t === 'del') select(STONEAPI.add(u.spec).id);
    else if (u.t === 'upd' && STONEAPI.get(u.id)) { STONEAPI.update(u.id, u.spec); select(u.id); }
    queueSave(); refreshUI();
  }
  function queueSave() { clearTimeout(saveT); saveT = setTimeout(() => save(false), 1200); refreshUI(); }
  function save(say) { clearTimeout(saveT); const ok = STONEAPI.save(); if (say) toast(ok ? 'Сохранено: глыб ' + STONEAPI.count : 'Не удалось сохранить на устройстве'); }

  // ---- луч из центра экрана: первая точка внутри камня или земли ----
  const _o = new THREE.Vector3(), _d = new THREE.Vector3();
  const inside = (x, y, z) => rockAt(x, z, y) || y < heightAt(x, z);
  function cast() {
    camera.getWorldDirection(_d); _o.copy(camera.position);
    let t = 0.3, prev = 0;
    for (; t < 220; t += t < 25 ? 0.2 : 0.6) {
      const x = _o.x + _d.x * t, y = _o.y + _d.y * t, z = _o.z + _d.z * t;
      if (inside(x, y, z)) {
        let a = prev, b = t;
        for (let k = 0; k < 8; k++) { const m = (a + b) / 2; if (inside(_o.x + _d.x * m, _o.y + _d.y * m, _o.z + _d.z * m)) b = m; else a = m; }
        const px = _o.x + _d.x * a, py = _o.y + _d.y * a, pz = _o.z + _d.z * a;
        const st = STONEAPI.byRock(rockAt(_o.x + _d.x * b, _o.z + _d.z * b, _o.y + _d.y * b));
        return { x: px, y: py, z: pz, stone: st };
      }
      prev = t;
    }
    return null;
  }

  // ---- полёт и камера ----
  C.fly = (dt, inp, yaw, pitch) => {
    const sp = inp.sprint ? 34 : 13, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), spn = Math.sin(pitch);
    // вперёд — по взгляду (вместе с наклоном), вбок — по горизонтали
    const fx = -sy * cp, fy = -spn, fz = -cy * cp, rx = cy, rz = -sy;
    let vx = fx * inp.my + rx * inp.mx, vy = fy * inp.my, vz = fz * inp.my + rz * inp.mx;
    if (fl.up || input.keys.has('Space')) vy += 0.9;
    if (fl.down || input.keys.has('KeyC') || input.keys.has('ControlLeft')) vy -= 0.9;
    player.pos.x += vx * sp * dt; player.pos.y += vy * sp * dt; player.pos.z += vz * sp * dt;
    player.vel.set(0, 0, 0);
    player.pos.y = Math.max(player.pos.y, -400);
    player.m.root.visible = false;
  };
  C.camera = (yaw, pitch) => {
    const p = player.pos;
    camera.position.set(p.x, p.y + 1.6, p.z);
    camera.lookAt(p.x - Math.sin(yaw) * Math.cos(pitch), p.y + 1.6 - Math.sin(pitch), p.z - Math.cos(yaw) * Math.cos(pitch));
    camera.updateMatrixWorld(true);
    hit = cast();
    dot.visible = !!hit;
    if (hit) { dot.position.set(hit.x, hit.y, hit.z); dot.scale.setScalar(Math.max(0.12, Math.min(1.2, 0.012 * camera.position.distanceTo(dot.position)))); }
  };
  function toggle(v) {
    C.on = v ?? !C.on;
    document.body.classList.toggle('crea', C.on);
    panel.style.display = C.on ? 'block' : 'none';
    setLight(C.on);
    if (!C.on) { dot.visible = false; selLine.visible = false; player.vel.set(0, 0, 0); }
    else { refreshUI(); toast('Творчество: лети, ставь и убирай глыбы'); }
    if (onToggle) onToggle(C.on);
  }
  C.toggle = toggle;
  C.api = { place, pickSel, moveSel, removeSel, doUndo, preset, select, brush, get hit() { return hit; }, get sel() { return sel; }, edit, nudge };
  addEventListener('keydown', (e) => {
    if (!C.on || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'KeyB') place(); else if (e.code === 'KeyX') removeSel(); else if (e.code === 'KeyT') pickSel(); else if (e.code === 'KeyM') moveSel(); else if (e.code === 'KeyZ') doUndo();
  });
  return C;
}
