import { ITEMS } from './inventory.js';
import { RULES } from './world.js';

// Крафт. Кнопка на экране с самого начала; пока ни один чертёж не изучен — «Крафты пока не изучены».
// Чертёж покупается у строителя свёртком, свёрток изучается кнопкой действия, когда он в руке.
// Изученные рецепты — у игрока в мире (сохраняются; с сервером — за аккаунтом).
export class Crafting {
  constructor(inv, world, toast) {
    this.inv = inv; this.world = world; this.toast = toast;
    this.known = world.snapshot().known || [];
    world.on((ev) => {
      if (ev.by !== world.me) return;
      if (ev.type === 'boughtBlueprint') { inv.add(ev.item, 1); toast(`−${ev.price} ✨  📜 ${RULES.recipes[ev.what].name}: чертёж получен`); }
      if (ev.type === 'learned') {
        this.known = ev.known;
        inv.remove(RULES.blueprints[ev.what].item, 1);
        toast(`📖 Изучено: ${RULES.recipes[ev.what].name}. Открой крафт`);
        if (this.onChange) this.onChange();
      }
      if (ev.type === 'crafted') {
        for (const id in ev.cost) inv.remove(id, ev.cost[id]);
        inv.add(ev.what, 1);
        toast(`${RULES.recipes[ev.what].icon} ${RULES.recipes[ev.what].name} готова!`);
        if (this.onChange) this.onChange();
      }
    });
  }
  // какой рецепт откроет свёрток в руке (или null)
  heldBlueprint() {
    const h = this.inv.held;
    if (!h) return null;
    for (const what in RULES.blueprints) if (RULES.blueprints[what].item === h.id && !this.known.includes(what)) return what;
    return null;
  }
  learn() { const w = this.heldBlueprint(); if (w) this.world.send({ type: 'learn', what: w }); }
  canMake(what) {
    const c = RULES.recipes[what].cost;
    for (const id in c) if (this.inv.count(id) < c[id]) return false;
    return !this.inv.count(what); // вещь одна: вторую не делаем
  }
  make(what) { if (this.known.includes(what) && this.canMake(what)) this.world.send({ type: 'craft', what }); }
  // строки для окна крафта
  list() {
    return this.known.map((what) => {
      const r = RULES.recipes[what];
      const need = Object.keys(r.cost).map((id) => `${ITEMS[id].icon} ${this.inv.count(id)}/${r.cost[id]}`).join('  ');
      return { what, name: r.name, icon: r.icon, need, can: this.canMake(what), have: this.inv.count(what) > 0 };
    });
  }
}
