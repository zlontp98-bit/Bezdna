// Инвентарь: 3 активных слота (на экране) + рюкзак на 12 ячеек.
// Предметы складываются стопками. Перенос — коснуться ячейки, потом другой.

export const ITEMS = {
  axe:    { name: 'Топор',   icon: '🪓', max: 1, tool: true, tip: 'Рубит деревья: возьми в руку и подойди к стволу' },
  berry:  { name: 'Ягоды',   icon: '🫐', max: 20, tip: 'Растут на некоторых кустах. Строитель покупает их' },
  gear:   { name: 'Шестерёнка', icon: '⚙️', max: 5, tip: 'Деталь старого механизма. Находится в ящиках на островках. Нужна для улучшения дома' },
  log:    { name: 'Бревно',  icon: '🪵', max: 20, tip: 'Древесина. С одного дерева — три бревна' },
  bpPick: { name: 'Чертёж: кирка', icon: '📜', max: 1, tip: 'Свёрток от строителя. Возьми в руку и нажми «Изучить»' },
  bpSpear:{ name: 'Чертёж: копьё', icon: '📜', max: 1, tip: 'Свёрток от строителя. Возьми в руку и нажми «Изучить»' },
  pickaxe:{ name: 'Кирка',   icon: '⛏️', max: 1, tool: true, svg: `<svg viewBox="0 0 48 48"><path d="M13 41 L31 17" stroke="#4a2e1c" stroke-width="7.5" stroke-linecap="round"/><path d="M13 41 L31 17" stroke="#a8703f" stroke-width="4.5" stroke-linecap="round"/><path d="M15 37 L27 21" stroke="#c99566" stroke-width="1.4" stroke-linecap="round"/><path d="M7 21 Q25 3 43 22" stroke="#3f4650" stroke-width="9.5" fill="none" stroke-linecap="round"/><path d="M7 21 Q25 3 43 22" stroke="#b8c3cd" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M12 15 Q25 6 37 14" stroke="#eef3f7" stroke-width="1.8" fill="none" stroke-linecap="round"/><rect x="25.5" y="11.5" width="8" height="7" rx="1.5" transform="rotate(-38 29.5 15)" fill="#5a3824" stroke="#3a2416" stroke-width="1.2"/></svg>`, tip: 'Добывает камень из больших валунов: возьми в руку и подойди' },
  spear:  { name: 'Копьё',   icon: '🗡️', max: 1, tool: true, svg: `<svg viewBox="0 0 48 48"><g transform="rotate(45 24 24)"><rect x="21.6" y="17" width="4.8" height="31" rx="2.4" fill="#4a2e1c"/><rect x="22.6" y="17" width="2.8" height="30" rx="1.4" fill="#a8703f"/><path d="M24 0 C30.5 7 30.5 14 24 19.5 C17.5 14 17.5 7 24 0 Z" fill="#b8c3cd" stroke="#3f4650" stroke-width="1.6" stroke-linejoin="round"/><path d="M24 3 L24 17" stroke="#eef3f7" stroke-width="1.3" stroke-linecap="round"/><rect x="20.6" y="17.5" width="6.8" height="5" rx="1.2" fill="#5a3824" stroke="#3a2416" stroke-width="1"/><path d="M27 21 q5 2 4 7 M27 21 q2 4 -1 8" stroke="#e5483a" stroke-width="1.6" fill="none" stroke-linecap="round"/></g></svg>`, tip: 'Сделано своими руками. Пригодится, когда в бездне появятся жители' },
  stone:  { name: 'Камень',  icon: '🪨', max: 20, tip: 'Материал для построек' },
  shroom: { name: 'Гриб',    icon: '🍄', max: 20, tip: 'Светится. Растёт на кольце' },
  crystal:{ name: 'Кристалл',icon: '💎', max: 10, tip: 'Редкая находка из глубины' },
};
export const HOT = 3, BAG = 12;
// значок предмета: нарисованный (svg), если есть, иначе эмодзи
export function iconHtml(id) { const it = ITEMS[id]; return it.svg || it.icon; }

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
  };
  inv.onChange = render;
  bagBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  bagBtn.addEventListener('click', () => { inv.open = !inv.open; inv.pick = -1; render(); });
  render();
  return render;
}
