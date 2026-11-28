// Инвентарь: 4 активных слота (на экране) + рюкзак на 12 ячеек.
// Предметы складываются стопками. Перенос — коснуться ячейки, потом другой.
// Выбросить: выбрать предмет в открытом рюкзаке — внизу появятся кнопки «−1» и «Выбросить».

// значки лежат в assets/items/<id>.png; emoji — запасной вариант для текстовых строк
export const ITEMS = {
  axe:    { name: 'Топор',   icon: '🪓', max: 1, tool: true, tip: 'Рубит деревья: возьми в руку и подойди к стволу' },
  berry:  { name: 'Ягоды',   icon: '🫐', max: 20, tip: 'Растут на некоторых кустах. Строитель покупает их' },
  gear:   { name: 'Шестерёнка', icon: '⚙️', max: 5, tip: 'Деталь старого механизма. Находится в ящиках на островках. Нужна для улучшения дома' },
  log:    { name: 'Бревно',  icon: '🪵', max: 20, tip: 'Древесина. С одного дерева — три бревна' },
  pickaxe:{ name: 'Кирка',   icon: '⛏️', max: 1, tool: true, tip: 'Добывает камень из больших валунов: возьми в руку и подойди' },
  spear:  { name: 'Копьё',   icon: '🗡️', max: 1, tool: true, tip: 'Сделано своими руками. Пригодится, когда в бездне появятся жители' },
  stone:  { name: 'Камень',  icon: '🪨', max: 20, tip: 'Материал для построек' },
  shroom: { name: 'Гриб',    icon: '🍄', max: 20, tip: 'Светится в темноте. Растёт на глыбах глубже −75 м, большие — у озера' },
  crystal:{ name: 'Синий кристалл', icon: '💎', max: 20, tip: 'Светится в темноте' },
  dust:   { name: 'Кристальная пыль', icon: '💠', max: 40, tip: 'Выпадает из синих кристаллов, когда разбиваешь их киркой. Большой кристалл даёт больше пыли' },
  jelly:  { name: 'Желе медузы', icon: '🪼', max: 20, tip: 'Светящееся желе. Выпадает из медуз в озере на дне бездны' },
};
export const HOT = 4, BAG = 12;
const OLD_HOT = 3; // раньше активных слотов было три: старые сохранения переносим
const imgSrc = (id) => `./assets/items/${id}.png`;
// значок предмета для ячейки
export function iconHtml(id) { return `<img src="${imgSrc(id)}" alt="" draggable="false">`; }
// маленький значок внутри строки текста (стоимость рецепта и т.п.)
export function iconInline(id) { return `<img class="mi" src="${imgSrc(id)}" alt="" draggable="false">`; }

export class Inventory {
  constructor(store) {
    this.store = store;
    this.slots = new Array(HOT + BAG).fill(null); // { id, n } | null
    this.active = 0;
    this.pick = -1; // ячейка, взятая для переноса
    this.open = false;
    this.onChange = null;
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(this.store.get('bezdna.inv', 'null'));
      let sv = d && Array.isArray(d.slots) ? d.slots : null;
      // сохранение с тремя активными слотами: четвёртый слот вставляем после них, рюкзак едет следом
      if (sv && sv.length === OLD_HOT + BAG) sv = [...sv.slice(0, OLD_HOT), null, ...sv.slice(OLD_HOT)];
      if (sv && sv.length === this.slots.length) {
        // предметов, которых больше нет в игре (факел, верёвка, ягоды), в старых сохранениях не будет
        this.slots = sv.map((s) => (s && ITEMS[s.id] && s.n > 0 ? { id: s.id, n: s.n } : null));
        this.active = Math.min(HOT - 1, Math.max(0, d.active | 0));
        // топор появился позже: тем, кто уже играл, выдаём его один раз
        if (!this.store.get('bezdna.axe', '')) { this.store.set('bezdna.axe', '1'); if (!this.count('axe')) this.add('axe'); }
        return;
      }
    } catch (_) { /* начнём заново */ }
    // стартовый набор — только топор
    this.slots[0] = { id: 'axe', n: 1 };
    this.store.set('bezdna.axe', '1');
  }
  save() { this.store.set('bezdna.inv', JSON.stringify({ slots: this.slots, active: this.active })); }
  changed() { this.save(); if (this.onChange) this.onChange(); if (this.onCraft) this.onCraft(); }

  // Положить n предметов; возвращает, сколько не поместилось
  add(id, n = 1) {
    const max = ITEMS[id].max;
    for (const s of this.slots) if (s && s.id === id && s.n < max && n > 0) { const k = Math.min(n, max - s.n); s.n += k; n -= k; }
    for (let i = 0; i < this.slots.length && n > 0; i++) if (!this.slots[i]) { const k = Math.min(n, max); this.slots[i] = { id, n: k }; n -= k; }
    this.changed();
    return n;
  }
  count(id) { return this.slots.reduce((a, s) => a + (s && s.id === id ? s.n : 0), 0); }
  remove(id, n = 1) {
    for (let i = this.slots.length - 1; i >= 0 && n > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const k = Math.min(n, s.n); s.n -= k; n -= k;
      if (s.n === 0) this.slots[i] = null;
    }
    this.changed();
  }
  get held() { return this.slots[this.active]; }

  // Выбросить из ячейки i: n штук (по умолчанию всю стопку). Предмет просто исчезает
  discard(i, n = Infinity) {
    const s = this.slots[i];
    if (!s) return;
    s.n -= Math.min(n, s.n);
    if (s.n <= 0) { this.slots[i] = null; if (this.pick === i) this.pick = -1; }
    this.changed();
  }

  // Касание ячейки: первое — взять, второе — положить/поменять/сложить
  tap(i) {
    // рюкзак закрыт: касание слота только выбирает его (раньше оно ещё и «брало» предмет
    // для переноса, и следующее касание меняло слоты местами вместо выбора)
    if (!this.open) {
      if (i < HOT) this.active = i;
      this.pick = -1;
      this.changed();
      return;
    }
    // инструмент в рюкзаке — сразу в руку (в выбранный слот)
    if (this.pick < 0 && i >= HOT && this.slots[i] && ITEMS[this.slots[i].id].tool) {
      const a = this.active;
      [this.slots[a], this.slots[i]] = [this.slots[i], this.slots[a]];
      this.changed();
      return;
    }
    if (this.pick < 0) {
      if (i < HOT) this.active = i;
      if (this.slots[i]) this.pick = i;
      this.changed();
      return;
    }
    const a = this.slots[this.pick], b = this.slots[i];
    if (i !== this.pick) {
      if (b && a && b.id === a.id) {
        const k = Math.min(a.n, ITEMS[a.id].max - b.n);
        b.n += k; a.n -= k;
        if (a.n === 0) this.slots[this.pick] = null;
      } else { this.slots[i] = a; this.slots[this.pick] = b; }
    }
    this.pick = -1;
    if (i < HOT) this.active = i;
    this.changed();
  }
}

// ---------- отрисовка ----------
export function bindInventoryUI(inv, ui) {
  const { hotEl, bagEl, bagBtn, bagPanel, nameEl } = ui;
  const cells = [];
  const mk = (i, parent) => {
    const b = document.createElement('button');
    b.className = 'cell';
    b.innerHTML = '<span class="ic"></span><span class="n"></span>';
    b._ic = b.querySelector('.ic'); b._nn = b.querySelector('.n');
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', () => inv.tap(i));
    parent.appendChild(b);
    cells[i] = b;
  };
  for (let i = 0; i < HOT; i++) mk(i, hotEl);
  for (let i = HOT; i < HOT + BAG; i++) mk(i, bagEl);

  // панель выбранного предмета: что это и как его выбросить
  const actEl = document.createElement('div');
  actEl.id = 'bagAct';
  actEl.innerHTML = '<div class="sel"><b></b><span></span></div><div class="btns">'
    + '<button type="button" class="dropOne">−1</button>'
    + '<button type="button" class="dropAll"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg><span>Выбросить</span></button>'
    + '</div>';
  bagPanel.insertBefore(actEl, bagPanel.querySelector('.tip'));
  const selName = actEl.querySelector('.sel b'), selTip = actEl.querySelector('.sel span');
  const dropOne = actEl.querySelector('.dropOne'), dropAll = actEl.querySelector('.dropAll'), dropTxt = dropAll.querySelector('span');
  for (const b of [dropOne, dropAll]) b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });

  // выбросить всю стопку — со вторым касанием, чтобы не потерять нужное случайно
  let armed = false, armTimer = 0;
  const disarm = () => { armed = false; clearTimeout(armTimer); dropAll.classList.remove('armed'); };
  dropOne.addEventListener('click', () => { disarm(); if (inv.pick >= 0) inv.discard(inv.pick, 1); });
  dropAll.addEventListener('click', () => {
    if (inv.pick < 0) return;
    if (!armed) { armed = true; dropAll.classList.add('armed'); armTimer = setTimeout(() => { disarm(); render(); }, 2500); render(); return; }
    disarm();
    inv.discard(inv.pick);
  });

  let lastPick = -1;
  const render = () => {
    // меняем в ячейке только то, что поменялось: иначе каждое бревно заново разбирало
    // все картинки и заставляло телефон перерисовывать весь интерфейс
    inv.slots.forEach((s, i) => {
      const c = cells[i], id = s ? s.id : '', n = s && s.n > 1 ? String(s.n) : '';
      if (c._id !== id) { c._id = id; c._ic.innerHTML = s ? iconHtml(id) : ''; c.title = s ? ITEMS[id].name : ''; }
      if (c._n !== n) { c._n = n; c._nn.textContent = n; }
      const act = i === inv.active, pk = i === inv.pick;
      if (c._a !== act) { c._a = act; c.classList.toggle('active', act); }
      if (c._p !== pk) { c._p = pk; c.classList.toggle('pick', pk); }
    });
    const h = inv.held;
    nameEl.textContent = h ? ITEMS[h.id].name : '';
    bagPanel.classList.toggle('show', inv.open);
    bagBtn.classList.toggle('on', inv.open);

    const p = inv.pick >= 0 ? inv.slots[inv.pick] : null;
    if (inv.pick !== lastPick) { lastPick = inv.pick; disarm(); }
    actEl.classList.toggle('show', !!p);
    if (p) {
      const it = ITEMS[p.id];
      selName.textContent = p.n > 1 ? `${it.name} ×${p.n}` : it.name;
      selTip.textContent = it.tip || '';
      dropOne.hidden = p.n < 2;
      dropTxt.textContent = armed ? 'Точно?' : p.n > 1 ? 'Выбросить всё' : 'Выбросить';
    }
  };
  inv.onChange = render;
  bagBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  bagBtn.addEventListener('click', () => { inv.open = !inv.open; inv.pick = -1; render(); });
  render();
  return render;
}
