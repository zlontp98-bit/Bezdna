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
};

// Пока сервера нет: решает сама игра и хранит состояние в памяти телефона
class LocalAuthority {
  constructor(store, me) {
    this.store = store; this.me = me;
    this.cut = {}; // id дерева → когда срублено (мс, общие часы)
    try {
      const d = JSON.parse(store.get('bezdna.world', 'null'));
      if (d && d.cut) this.cut = d.cut;
    } catch (_) { /* пустой мир */ }
  }
  save() { this.store.set('bezdna.world', JSON.stringify({ v: WORLD_VERSION, cut: this.cut })); }
  snapshot(now) {
    // выросшие деревья из списка убираем — список не растёт бесконечно
    for (const id in this.cut) if (now - this.cut[id] > RULES.tree.regrowMs(id) + 60000) delete this.cut[id];
    this.save();
    return { cut: { ...this.cut } };
  }
  handle(ev, now, emit) {
    if (ev.type === 'chop') {
      const at = this.cut[ev.id];
      if (at !== undefined && now - at < RULES.tree.regrowMs(ev.id)) return; // уже срублено
      this.cut[ev.id] = now;
      this.save();
      emit({ type: 'chopped', id: ev.id, at: now, by: this.me, reward: { log: RULES.tree.logs } });
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
