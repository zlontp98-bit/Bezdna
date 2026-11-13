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
  // камни по размеру s (0.6…2.8 м): маленький — 2 камня за 3 удара, самый большой — 6 за 6
  boulder: {
    size: (s) => Math.min(1, Math.max(0, (s - 0.6) / 2.2)),
    hits: (s) => 3 + Math.round(3 * RULES.boulder.size(s)),
    stones: (s) => 2 + Math.round(4 * RULES.boulder.size(s)),
    respawnMs: (id) => 180000 + idRand(id) * 60000,
  },
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
  trade: { logPrice: 1, price: { log: 1, berry: 1 } },
  // старый ящик на островках: стоит на случайном острове, внутри — кирка;
  // открыли — через 3–5 минут появляется новый, на другом острове
  chest: { loot: { pickaxe: 1 }, islands: 7, respawnMs: () => 180000 + Math.random() * 120000 },
  // ягодные кусты: собрал — через 2.5–4 минуты ягоды снова висят; ягоды не на каждом кусте
  bush: { berries: 3, share: 0.4, respawnMs: (id) => 150000 + idRand(id) * 90000 },
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
    this.chest = null; // { id, island, seed, opened, respawn } — где сейчас старый ящик
    this.treasury = { logs: 0 }; // казна лагеря: сколько брёвен внесено к следующему улучшению
    try {
      const d = JSON.parse(store.get('bezdna.world', 'null'));
      if (d && d.cut) this.cut = d.cut;
      if (d && d.built) this.built = d.built;
      if (d && d.wallets) this.wallets = d.wallets;
      if (d && d.known) this.known = d.known;
      if (d && d.picked) this.picked = d.picked;
      if (d && d.mined) this.mined = d.mined;
      if (d && d.chest) this.chest = d.chest;
      if (d && d.treasury) this.treasury = d.treasury;
    } catch (_) { /* пустой мир */ }
  }
  save() { this.store.set('bezdna.world', JSON.stringify({ v: WORLD_VERSION, cut: this.cut, built: this.built, wallets: this.wallets, treasury: this.treasury, known: this.known, picked: this.picked, mined: this.mined, chest: this.chest })); }
  snapshot(now) {
    // выросшие деревья из списка убираем — список не растёт бесконечно
    for (const id in this.cut) if (now - this.cut[id] > RULES.tree.regrowMs(id) + 60000) delete this.cut[id];
    for (const id in this.mined) if (now - this.mined[id] > RULES.boulder.respawnMs(id) + 60000) delete this.mined[id];
    for (const id in this.picked) if (now - this.picked[id] > (id.startsWith('bush:') ? RULES.bush : RULES.pebble).respawnMs(id) + 60000) delete this.picked[id];
    this.ensureChest(now);
    this.save();
    return { cut: { ...this.cut }, built: { ...this.built }, wallet: this.wallets[this.me] || 0, treasury: { ...this.treasury }, known: (this.known[this.me] || []).slice(), picked: { ...this.picked }, mined: { ...this.mined }, chest: { ...this.chest } };
  }
  // Ящика нет или открытый простоял своё — ставим новый на другой остров.
  // Мир выбирает только остров и «зерно»; точное место на острове игра выводит из них сама,
  // одинаково у всех (см. chest.js). Возвращает true, если поставили новый.
  ensureChest(now) {
    const c = this.chest;
    if (c && !(c.opened && now - c.opened > c.respawn)) return false;
    let island;
    do island = Math.floor(Math.random() * RULES.chest.islands); while (c && island === c.island);
    this.chest = { id: 'chest:' + now, island, seed: (Math.random() * 1e9) | 0, opened: 0, respawn: 0 };
    this.save();
    return true;
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
    // время от времени игра спрашивает «что нового»: тут мир, например, ставит новый ящик
    if (ev.type === 'tick' && this.ensureChest(now)) emit({ type: 'chestSpawned', chest: { ...this.chest } });
    if (ev.type === 'openChest' && this.chest && this.chest.id === ev.id && !this.chest.opened) {
      this.chest.opened = now; this.chest.respawn = RULES.chest.respawnMs();
      this.save();
      emit({ type: 'chestOpened', id: ev.id, at: now, by: this.me, loot: { ...RULES.chest.loot } });
    }
    if (ev.type === 'mine') {
      const at = this.mined[ev.id];
      if (at !== undefined && now - at < RULES.boulder.respawnMs(ev.id)) return; // уже разбит
      this.mined[ev.id] = now;
      this.save();
      emit({ type: 'mined', id: ev.id, at: now, by: this.me, reward: { stone: RULES.boulder.stones(ev.s) } }); // размер сервер возьмёт из своей копии мира
    }
    // подобрать с земли или с куста: камушек — камень, ягодный куст — ягоды
    if (ev.type === 'pick') {
      const bush = ev.id.startsWith('bush:'), rule = bush ? RULES.bush : RULES.pebble;
      const at = this.picked[ev.id];
      if (at !== undefined && now - at < rule.respawnMs(ev.id)) return; // уже собрано
      this.picked[ev.id] = now;
      this.save();
      emit({ type: 'picked', id: ev.id, at: now, by: this.me, reward: bush ? { berry: RULES.bush.berries } : { stone: RULES.pebble.stones } });
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
      const item = ev.item || 'log', coins = ev.n * (RULES.trade.price[item] || 0);
      pay(coins); this.save();
      emit({ type: 'paid', by: this.me, item, n: ev.n, coins, wallet: this.wallets[this.me] });
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
