// Инвентарь: 3 активных слота (на экране) + рюкзак на 12 ячеек.
// Предметы складываются стопками. Перенос — коснуться ячейки, потом другой.

export const ITEMS = {
  axe:    { name: 'Топор',   icon: '🪓', max: 1,  tip: 'Рубит деревья: возьми в руку и подойди к стволу' },
  log:    { name: 'Бревно',  icon: '🪵', max: 20, tip: 'Древесина. С одного дерева — три бревна' },
  root:   { name: 'Корень',  icon: '🌿', max: 20, tip: 'Остаётся от срубленного дерева. Нужен для крафта' },
  bpPick: { name: 'Чертёж: кирка', icon: '📜', max: 1, tip: 'Свёрток от строителя. Возьми в руку и нажми «Изучить»' },
  bpSpear:{ name: 'Чертёж: копьё', icon: '📜', max: 1, tip: 'Свёрток от строителя. Возьми в руку и нажми «Изучить»' },
  pickaxe:{ name: 'Кирка',   icon: '⛏️', max: 1,  tip: 'Сделана своими руками. Скоро ею можно будет добывать камень' },
  spear:  { name: 'Копьё',   icon: '🔱', max: 1,  tip: 'Сделано своими руками. Пригодится, когда в бездне появятся жители' },
  stone:  { name: 'Камень',  icon: '🪨', max: 20, tip: 'Материал для построек' },
  shroom: { name: 'Гриб',    icon: '🍄', max: 20, tip: 'Светится. Растёт на кольце' },
  crystal:{ name: 'Кристалл',icon: '💎', max: 10, tip: 'Редкая находка из глубины' },
};
export const HOT = 3, BAG = 12;

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
      if (d && Array.isArray(d.slots) && d.slots.length === this.slots.length) {
        // предметов, которых больше нет в игре (факел, верёвка, ягоды), в старых сохранениях не будет
        this.slots = d.slots.map((s) => (s && ITEMS[s.id] && s.n > 0 ? { id: s.id, n: s.n } : null));
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

  // Касание ячейки: первое — взять, второе — положить/поменять/сложить
  tap(i) {
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
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', () => inv.tap(i));
    parent.appendChild(b);
    cells[i] = b;
  };
  for (let i = 0; i < HOT; i++) mk(i, hotEl);
  for (let i = HOT; i < HOT + BAG; i++) mk(i, bagEl);

  const render = () => {
    inv.slots.forEach((s, i) => {
      const c = cells[i];
      c.querySelector('.ic').textContent = s ? ITEMS[s.id].icon : '';
      c.querySelector('.n').textContent = s && s.n > 1 ? s.n : '';
      c.title = s ? ITEMS[s.id].name : '';
      c.classList.toggle('active', i === inv.active);
      c.classList.toggle('pick', i === inv.pick);
    });
    const h = inv.held;
    nameEl.textContent = h ? ITEMS[h.id].name : '';
    bagPanel.classList.toggle('show', inv.open);
    bagBtn.classList.toggle('on', inv.open);
  };
  inv.onChange = render;
  bagBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  bagBtn.addEventListener('click', () => { inv.open = !inv.open; inv.pick = -1; render(); });
  render();
  return render;
}
