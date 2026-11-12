// Общий мир: всё, что игроки в нём меняют.
//
// Рельеф, деревья, камни строятся у всех одинаково из зерна мира — их передавать не нужно.
// По сети (а пока — в память телефона) идут только ИЗМЕНЕНИЯ, и только событиями:
//   игра  → world.send({ type: 'chop', id })          «хочу срубить дерево id»
//   мир   → слушатели: { type: 'chopped', id, at, by, reward }   «срублено, вот что выпало»
// Решает «мир» (authority). Сейчас это LocalAuthority прямо в игре; потом его место займёт
// сервер, а код игры не изменится: он и сейчас ничего не меняет сам, только просит и слушает.

import { SEED } from './noise.js';

// Версия мира: растёт, когда меняется генерация так, что старые сохранения к ней не подходят.
// Сервер по ней отличит клиент со старой картой.
export const WORLD_VERSION = 1;

// Постоянный номер объекта — по виду и месту в мире (с точностью 10 см), а не по порядку
// генерации. Поэтому правка расстановки камней или новых деревьев не сдвигает номера
// остальных объектов, и «дерево срублено» указывает на то же дерево после обновления игры.
export function objId(kind, x, z) {
  return kind + ':' + Math.round(x * 10) + ':' + Math.round(z * 10);
}

// Детерминированное «случайное» число 0..1 по номеру объекта: у всех игроков одинаковое
export function idRand(id) {
  let h = SEED | 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Правила, одинаковые для игры и (потом) сервера
export const RULES = {
  tree: { logs: 3, regrowMs: (id) => 100000 + idRand(id) * 50000 },
  // большие валуны: кирка разбивает их на камни, через 3–4 минуты валун на месте
  boulder: { hits: 5, stones: 4, respawnMs: (id) => 180000 + idRand(id) * 60000 },
  // камушки на лугу: подобрал — через пару минут на том же месте лежит новый
  pebble: { stones: 1, respawnMs: (id) => 120000 + idRand(id) * 60000 },
  // чертежи у строителя (цена в искрах) и рецепты: что нужно, чтобы сделать вещь
  blueprints: { pickaxe: { item: 'bpPick', price: 30 }, spear: { item: 'bpSpear', price: 20 } },
  recipes: {
    pickaxe: { name: 'Кирка', icon: '⛏️', cost: { log: 3, stone: 2 } },
    spear:   { name: 'Копьё', icon: '🗡️', cost: { log: 2, stone: 1 } },
  },
  // постройки: цена и время стройки
  build: { house: { cost: { log: 40 }, ms: 30000 } },
  // местная валюта — искры ✨. Строитель покупает брёвна; казна лагеря платит за них больше,
  // но принимает только до цели следующего улучшения
  trade: { logPrice: 1 },
  treasury: { goal: 100, perLog: 2, bonus: 25, next: 'Мастерская' },
};

// Пока сервера нет: решает сама игра и хранит состояние в памяти телефона
class LocalAuthority {
  constructor(store, me) {
    this.store = store; this.me = me;
    this.cut = {}; // id дерева → когда срублено (мс, общие часы)
    this.built = {}; // постройка → когда начали строить
    this.wallets = {}; // игрок → искры
    this.known = {}; // игрок → изученные рецепты
    this.picked = {}; // камушек → когда подобран
    this.mined = {}; // валун → когда разбит
    this.treasury = { logs: 0 }; // казна лагеря: сколько брёвен внесено к следующему улучшению
    try {
      const d = JSON.parse(store.get('bezdna.world', 'null'));
      if (d && d.cut) this.cut = d.cut;
      if (d && d.built) this.built = d.built;
      if (d && d.wallets) this.wallets = d.wallets;
      if (d && d.known) this.known = d.known;
      if (d && d.picked) this.picked = d.picked;
      if (d && d.mined) this.mined = d.mined;
      if (d && d.treasury) this.treasury = d.treasury;
    } catch (_) { /* пустой мир */ }
  }
  save() { this.store.set('bezdna.world', JSON.stringify({ v: WORLD_VERSION, cut: this.cut, built: this.built, wallets: this.wallets, treasury: this.treasury, known: this.known, picked: this.picked, mined: this.mined })); }
  snapshot(now) {
    // выросшие деревья из списка убираем — список не растёт бесконечно
    for (const id in this.cut) if (now - this.cut[id] > RULES.tree.regrowMs(id) + 60000) delete this.cut[id];
    for (const id in this.mined) if (now - this.mined[id] > RULES.boulder.respawnMs(id) + 60000) delete this.mined[id];
    for (const id in this.picked) if (now - this.picked[id] > RULES.pebble.respawnMs(id) + 60000) delete this.picked[id];
    this.save();
    return { cut: { ...this.cut }, built: { ...this.built }, wallet: this.wallets[this.me] || 0, treasury: { ...this.treasury }, known: (this.known[this.me] || []).slice(), picked: { ...this.picked }, mined: { ...this.mined } };
  }
  handle(ev, now, emit) {
    if (ev.type === 'chop') {
      const at = this.cut[ev.id];
      if (at !== undefined && now - at < RULES.tree.regrowMs(ev.id)) return; // уже срублено
      this.cut[ev.id] = now;
      this.save();
      emit({ type: 'chopped', id: ev.id, at: now, by: this.me, reward: { log: RULES.tree.logs } });
    }
    // стройка: плату пока снимает сама игра (инвентарь у неё); сервер будет проверять её сам
    if (ev.type === 'build' && RULES.build[ev.what] && this.built[ev.what] === undefined) {
      this.built[ev.what] = now;
      this.save();
      emit({ type: 'built', what: ev.what, at: now, by: this.me });
    }
    if (ev.type === 'mine') {
      const at = this.mined[ev.id];
      if (at !== undefined && now - at < RULES.boulder.respawnMs(ev.id)) return; // уже разбит
      this.mined[ev.id] = now;
      this.save();
      emit({ type: 'mined', id: ev.id, at: now, by: this.me, reward: { stone: RULES.boulder.stones } });
    }
    if (ev.type === 'pick') {
      const at = this.picked[ev.id];
      if (at !== undefined && now - at < RULES.pebble.respawnMs(ev.id)) return; // уже подобран
      this.picked[ev.id] = now;
      this.save();
      emit({ type: 'picked', id: ev.id, at: now, by: this.me, reward: { stone: RULES.pebble.stones } });
    }
    // Чертежи, изучение, крафт. Игра сама проверяет инвентарь; сервер потом будет проверять его у себя
    if (ev.type === 'buyBlueprint' && RULES.blueprints[ev.what]) {
      const bp = RULES.blueprints[ev.what], w = this.wallets[this.me] || 0;
      if (w < bp.price || (this.known[this.me] || []).includes(ev.what)) return;
      this.wallets[this.me] = w - bp.price; this.save();
      emit({ type: 'boughtBlueprint', what: ev.what, item: bp.item, by: this.me, price: bp.price, wallet: this.wallets[this.me] });
    }
    if (ev.type === 'learn' && RULES.recipes[ev.what]) {
      const k = this.known[this.me] || (this.known[this.me] = []);
      if (k.includes(ev.what)) return;
      k.push(ev.what); this.save();
      emit({ type: 'learned', what: ev.what, by: this.me, known: k.slice() });
    }
    if (ev.type === 'craft' && RULES.recipes[ev.what] && (this.known[this.me] || []).includes(ev.what)) {
      emit({ type: 'crafted', what: ev.what, by: this.me, cost: { ...RULES.recipes[ev.what].cost } });
    }
    // Продажа и казна. Брёвна игра снимает, только получив ответ, и ровно столько, сколько принято.
    const pay = (coins) => (this.wallets[this.me] = (this.wallets[this.me] || 0) + coins);
    if (ev.type === 'sell' && ev.n > 0) {
      const coins = ev.n * RULES.trade.logPrice;
      pay(coins); this.save();
      emit({ type: 'paid', by: this.me, n: ev.n, coins, wallet: this.wallets[this.me] });
    }
    if (ev.type === 'deposit' && ev.n > 0) {
      const T = RULES.treasury, n = Math.min(ev.n, T.goal - this.treasury.logs);
      if (n <= 0) return;
      this.treasury.logs += n;
      const done = this.treasury.logs >= T.goal, coins = n * T.perLog + (done ? T.bonus : 0);
      pay(coins); this.save();
      emit({ type: 'deposited', by: this.me, n, coins, wallet: this.wallets[this.me], treasury: { ...this.treasury }, done });
    }
  }
}

export class World {
  constructor(store) {
    // кто я: постоянный номер игрока на этом устройстве (сервер потом выдаст свой)
    let me = store.get('bezdna.me', '');
    if (!me) { me = 'p' + Math.random().toString(36).slice(2, 10); store.set('bezdna.me', me); }
    this.me = me;
    this.offset = 0; // поправка к часам телефона; сервер пришлёт свою
    this.listeners = [];
    this.auth = new LocalAuthority(store, me);
  }
  // общие часы мира (мс)
  now() { return Date.now() + this.offset; }
  // состояние мира на момент входа
  snapshot() { return this.auth.snapshot(this.now()); }
  on(fn) { this.listeners.push(fn); }
  send(ev) { this.auth.handle(ev, this.now(), (out) => this.listeners.forEach((fn) => fn(out))); }
}
