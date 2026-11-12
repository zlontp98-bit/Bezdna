import * as THREE from '../vendor/three.min.js';
import { part, merge, T, propMaterial } from './flora.js';
import { heightAt, clearGrass } from './terrain.js';
import { addBox } from './solids.js';
import { buildModel, SKIN_COLORS } from './player.js';
import { RULES } from './world.js';

// Лагерь оживает: у палатки стоит бородатый строитель. За брёвна он ставит на месте палатки
// дом, в который можно зайти; внутри — доска заданий (сами задания появятся позже).
// Стройка — событие мира (world.send 'build'), время идёт по общим часам: дом достроится,
// даже если игру закрыть, а с сервером его увидят все.
// Нагрузка: четыре небольшие модели без анимации вершин; житель шевелится, только когда герой рядом.

const HW = 2.7, HD = 2.3, WALL = 2.6, TH = 0.28, DOOR = 0.85; // полуразмеры дома, стены, полпроёма

export class Settlement {
  constructor(scene, camp, player, inv, world, toast) {
    this.player = player; this.inv = inv; this.world = world; this.toast = toast; this.camp = camp;
    this.near = false; this.nearBoard = false; this.state = 'none'; this.at = 0;

    // ---- место дома: на месте палатки, дверью к костру ----
    const a = camp.site.a, fx = Math.sin(a), fz = Math.cos(a); // куда смотрит дверь
    this.a = a; this.fx = fx; this.fz = fz;
    this.hx = camp.site.x - fx * 1.3; this.hz = camp.site.z - fz * 1.3;
    // из координат дома (lx — вправо от двери, lz — к двери) в мир
    const W = (lx, lz) => [this.hx + lx * Math.cos(a) + lz * fx, this.hz - lx * Math.sin(a) + lz * fz];
    this.W = W;
    let top = -1e9;
    for (const [lx, lz] of [[-HW, -HD], [HW, -HD], [-HW, HD], [HW, HD], [0, 0], [0, HD + 0.9]]) top = Math.max(top, heightAt(...W(lx, lz)));
    this.floorY = top + 0.12;
    this.buildHouse(scene);

    // ---- строитель: такой же глубинник, но с бородой и другого цвета ----
    const mine = player.look.color;
    const color = [0x58d3ae, 0xffc93a, 0xb48bff].find((c) => c !== mine) || SKIN_COLORS[3];
    this.m = buildModel({ color, armor: false, beard: true });
    const nx = camp.site.x + fx * 2.6 + Math.cos(a) * 2.6, nz = camp.site.z + fz * 2.6 - Math.sin(a) * 2.6;
    this.npc = { x: nx, z: nz, y: heightAt(nx, nz), facing: Math.atan2(camp.fire.x - nx, camp.fire.z - nz), t: Math.random() * 9, blink: 2 };
    this.m.root.position.set(nx, this.npc.y, nz);
    this.m.root.rotation.y = this.npc.facing;
    this.m.armL.rotation.z = -0.3; this.m.armR.rotation.z = 0.3;
    scene.add(this.m.root);
    player.addCollider({ x: nx, z: nz, r: 0.42 });

    // ---- состояние из мира ----
    const snap = world.snapshot();
    if (snap.built && snap.built.house !== undefined) this.begin(snap.built.house);
    this.wallet = snap.wallet || 0;
    this.treasury = snap.treasury || { logs: 0 };
    world.on((ev) => {
      if (ev.type === 'built' && ev.what === 'house') this.begin(ev.at);
      // ответы на продажу и взнос: брёвна снимаем ровно столько, сколько принято
      if (ev.type === 'deposited') this.treasury = ev.treasury;
      if (ev.type === 'boughtBlueprint' && ev.by === world.me) this.wallet = ev.wallet;
      if ((ev.type === 'paid' || ev.type === 'deposited') && ev.by === world.me) {
        this.inv.remove('log', ev.n);
        this.wallet = ev.wallet;
        this.toast(ev.done ? `🎉 Казна собрана! +${ev.coins} ✨` : `−${ev.n} 🪵  +${ev.coins} ✨`);
      }
    });
  }

  buildHouse(scene) {
    const M = propMaterial(), box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const logC = 0x9a6a44, dark = 0x6b432b, plank = 0xc09462, stone = 0x8f8c88, roofC = 0x8a4338, paper = 0xf4ecd8;
    const mk = (parts, visible) => {
      const mesh = new THREE.Mesh(merge(parts), M);
      mesh.position.set(this.hx, this.floorY, this.hz);
      mesh.rotation.y = this.a;
      mesh.visible = visible; mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    const fw = HW - DOOR; // ширина куска передней стены сбоку от двери
    // основание: фундамент, пол, крыльцо
    this.base = mk([
      part(box(HW * 2 + 0.3, 1.5, HD * 2 + 0.3), stone, { m: T(0, -0.81, 0), stone: 1 }),
      part(box(HW * 2, 0.1, HD * 2), plank, { m: T(0, -0.05, 0) }),
      part(box(2.1, 1.2, 0.9), stone, { m: T(0, -0.75, HD + 0.45), stone: 1 }),
    ], false);
    // стены растут во время стройки (масштаб по высоте)
    const wall = [
      part(box(HW * 2, WALL, TH), logC, { m: T(0, WALL / 2, -HD + TH / 2) }),
      part(box(TH, WALL, HD * 2), logC, { m: T(-HW + TH / 2, WALL / 2, 0) }),
      part(box(TH, WALL, HD * 2), logC, { m: T(HW - TH / 2, WALL / 2, 0) }),
      part(box(fw, WALL, TH), logC, { m: T(-DOOR - fw / 2, WALL / 2, HD - TH / 2) }),
      part(box(fw, WALL, TH), logC, { m: T(DOOR + fw / 2, WALL / 2, HD - TH / 2) }),
      part(box(DOOR * 2, 0.55, TH), logC, { m: T(0, WALL - 0.275, HD - TH / 2) }),
      // светящиеся окна в боковых стенах
      part(box(TH + 0.04, 0.7, 0.9), 0xffe9a0, { glow: 0.75, m: T(-HW + TH / 2, 1.55, 0.2) }),
      part(box(TH + 0.04, 0.7, 0.9), 0xffe9a0, { glow: 0.75, m: T(HW - TH / 2, 1.55, 0.2) }),
    ];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) wall.push(part(box(0.38, WALL + 0.02, 0.38), dark, { m: T(sx * (HW - 0.12), WALL / 2, sz * (HD - 0.12)) }));
    for (const sx of [-1, 1]) wall.push(part(box(0.16, WALL - 0.5, TH + 0.08), dark, { m: T(sx * (DOOR + 0.05), (WALL - 0.5) / 2, HD - TH / 2) }));
    this.walls = mk(wall, false);
    // крыша: двускатная, с трубой; прячется, когда герой внутри — видно комнату
    const tri = new THREE.Shape();
    tri.moveTo(-HW - 0.45, 0); tri.lineTo(HW + 0.45, 0); tri.lineTo(0, 1.75); tri.closePath();
    this.roof = mk([
      part(new THREE.ExtrudeGeometry(tri, { depth: HD * 2 + 0.9, bevelEnabled: false }).translate(0, WALL, -HD - 0.45), roofC),
      part(box(0.55, 1.3, 0.55), stone, { m: T(1.5, WALL + 1.25, -0.9), stone: 1 }),
    ], false);
    // обстановка: доска заданий у дальней стены, кровать, стол с фонарём
    const bz = -HD + 0.75;
    this.inside = mk([
      part(box(0.1, 2.0, 0.1), dark, { m: T(-0.8, 1.0, bz) }), part(box(0.1, 2.0, 0.1), dark, { m: T(0.8, 1.0, bz) }),
      part(box(1.8, 1.15, 0.08), plank, { m: T(0, 1.45, bz) }),
      part(box(1.3, 0.14, 0.04), 0xffc247, { glow: 0.45, m: T(0, 1.93, bz + 0.05) }),
      part(box(0.34, 0.42, 0.02), paper, { m: T(-0.55, 1.5, bz + 0.05, 1, 1, 1, 0, 0.06) }),
      part(box(0.3, 0.36, 0.02), paper, { m: T(-0.1, 1.42, bz + 0.05, 1, 1, 1, 0, -0.05) }),
      part(box(0.34, 0.44, 0.02), 0xe9dcc0, { m: T(0.38, 1.5, bz + 0.05, 1, 1, 1, 0, 0.03) }),
      part(box(0.22, 0.26, 0.02), paper, { m: T(0.68, 1.3, bz + 0.05, 1, 1, 1, 0, -0.1) }),
      // кровать
      part(box(1.0, 0.36, 2.0), logC, { m: T(-HW + 0.85, 0.18, 0.5) }),
      part(box(1.02, 0.12, 1.35), 0xb0483c, { m: T(-HW + 0.85, 0.42, 0.75) }),
      part(box(0.8, 0.14, 0.4), paper, { m: T(-HW + 0.85, 0.44, -0.25) }),
      // стол и фонарь
      part(box(1.1, 0.08, 0.7), plank, { m: T(HW - 0.95, 0.78, 0.9) }),
      part(box(0.1, 0.76, 0.1), dark, { m: T(HW - 1.4, 0.38, 0.65) }), part(box(0.1, 0.76, 0.1), dark, { m: T(HW - 0.5, 0.38, 0.65) }),
      part(box(0.1, 0.76, 0.1), dark, { m: T(HW - 1.4, 0.38, 1.15) }), part(box(0.1, 0.76, 0.1), dark, { m: T(HW - 0.5, 0.38, 1.15) }),
      part(box(0.18, 0.26, 0.18), 0xffe9a0, { glow: 1, m: T(HW - 0.95, 0.95, 0.9) }),
    ], false);
    // леса и штабель брёвен — видны, пока идёт стройка
    const sc = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) sc.push(part(box(0.12, 3.5, 0.12), dark, { m: T(sx * (HW + 0.4), 1.75, sz * (HD + 0.4)) }));
    for (const sz of [-1, 1]) sc.push(part(box(HW * 2 + 0.95, 0.1, 0.1), dark, { m: T(0, 3.3, sz * (HD + 0.4)) }), part(box(HW * 2 + 0.95, 0.1, 0.1), dark, { m: T(0, 1.7, sz * (HD + 0.4)) }));
    for (let i = 0; i < 3; i++) sc.push(part(new THREE.CylinderGeometry(0.17, 0.17, 2.2, 6), logC, { m: T(HW + 1.3, -0.1 + (i === 2 ? 0.3 : 0), HD - 0.6 + (i === 2 ? 0.2 : i * 0.4), 1, 1, 1, 0.2, Math.PI / 2) }));
    this.scaffold = mk(sc, false);
  }

  // стройка началась в момент at (общие часы мира)
  begin(at) {
    if (this.state !== 'none') return;
    this.at = at; this.state = 'building';
    const { camp, W, a, floorY } = this;
    camp.tent.visible = false;
    camp.tentCol.r = -10;
    clearGrass(this.hx + this.fx * 0.45, this.hz + this.fz * 0.45, HW + 0.2, HD + 0.65, a);
    // дом твёрдый сразу: пол, стены, притолока (под ней проходим), крыльцо, мебель
    const solid = (lx, lz, hx, hz, top, bottom) => { const [x, z] = W(lx, lz); addBox(x, z, hx, hz, a, floorY + top, bottom === undefined ? -1e9 : floorY + bottom); };
    const fw = HW - DOOR;
    solid(0, 0, HW, HD, 0);
    solid(0, HD + 0.45, 1.05, 0.45, -0.15);
    solid(0, -HD + TH / 2, HW, TH / 2, WALL);
    solid(-HW + TH / 2, 0, TH / 2, HD, WALL); solid(HW - TH / 2, 0, TH / 2, HD, WALL);
    solid(-DOOR - fw / 2, HD - TH / 2, fw / 2, TH / 2, WALL); solid(DOOR + fw / 2, HD - TH / 2, fw / 2, TH / 2, WALL);
    solid(0, HD - TH / 2, DOOR, TH / 2, WALL, 2.05);
    solid(0, -HD + 0.75, 0.9, 0.1, 2.0);            // доска заданий
    solid(-HW + 0.85, 0.5, 0.5, 1.0, 0.48);         // кровать
    solid(HW - 0.95, 0.9, 0.55, 0.35, 0.82);        // стол
    this.base.visible = this.walls.visible = this.scaffold.visible = true;
    this.npc.facing = Math.atan2(this.hx - this.npc.x, this.hz - this.npc.z);
    this.refresh(true);
  }

  // привести вид дома к состоянию: стены по ходу стройки, в конце — крыша и обстановка
  refresh(force) {
    if (this.state !== 'building') return;
    const k = Math.min(1, (this.world.now() - this.at) / RULES.build.house.ms);
    this.walls.scale.y = 0.06 + 0.94 * k;
    if (k >= 1) {
      this.state = 'built';
      this.walls.scale.y = 1;
      this.scaffold.visible = false;
      this.roof.visible = this.inside.visible = true;
      if (!force) this.toast('🏠 Дом готов — заходи!');
    }
  }
  left() { return Math.max(0, Math.ceil((RULES.build.house.ms - (this.world.now() - this.at)) / 1000)); }

  // что говорит строитель и что предлагает: { name, text, acts: [{ label, can, run }] }
  dialog() {
    const cost = RULES.build.house.cost.log, have = this.inv.count('log'), price = RULES.trade.logPrice;
    const name = 'Борода, строитель', acts = [];
    let text;
    if (this.state === 'none') {
      text = `Привет! Палатка — это не дом. Принеси ${cost} брёвен, и я за полминуты поставлю настоящий — с дверью и доской заданий. Лишние брёвна тоже куплю.`;
      acts.push({ label: `Построить дом: ${cost} 🪵 (есть ${have})`, can: have >= cost, run: () => this.accept() });
    } else if (this.state === 'building') text = `Строю, не отвлекай! Осталось ${this.left()} с. Брёвна куплю, если есть.`;
    else text = `Дом готов. Брёвна покупаю по ${price} ✨. А в казну лагеря на доске заданий за них дают больше.`;
    acts.push({ label: have ? `Продать ${have} 🪵 за ${have * price} ✨` : 'Продать брёвна — нет брёвен', can: have > 0, run: () => this.world.send({ type: 'sell', n: have }) });
    // чертежи: по одному, пока не изучен
    for (const what in RULES.blueprints) {
      const bp = RULES.blueprints[what], r = RULES.recipes[what];
      if (this.craft.known.includes(what)) continue;
      const has = this.inv.count(bp.item) > 0;
      acts.push({ label: has ? `📜 ${r.name}: чертёж уже у тебя — изучи его` : `Купить чертёж: ${r.icon} ${r.name} — ${bp.price} ✨`, can: !has && this.wallet >= bp.price, run: () => this.world.send({ type: 'buyBlueprint', what }) });
    }
    return { name, text, acts };
  }
  // доска заданий: пока одно задание — казна лагеря
  boardDialog() {
    const T = RULES.treasury, got = this.treasury.logs, have = this.inv.count('log'), k = Math.min(have, T.goal - got);
    if (got >= T.goal) return { name: 'Доска заданий', text: `Казна собрана: ${T.goal}/${T.goal} 🪵. «${T.next}» скоро начнут строить — следи за доской.`, prog: 1, acts: [] };
    return {
      name: 'Доска заданий',
      text: `Казна лагеря. Следующее улучшение — «${T.next}». Внесено ${got}/${T.goal} 🪵. За бревно — ${T.perLog} ✨, за последнее — ещё ${T.bonus} ✨.`,
      prog: got / T.goal,
      acts: [{ label: k ? `Внести ${k} 🪵 → ${k * T.perLog} ✨` : 'Внести брёвна — нет брёвен', can: k > 0, run: () => this.world.send({ type: 'deposit', n: k }) }],
    };
  }
  // игрок согласился: платим брёвнами и просим мир начать стройку
  accept() {
    const cost = RULES.build.house.cost.log;
    if (this.state !== 'none' || this.inv.count('log') < cost) return;
    this.inv.remove('log', cost);
    this.world.send({ type: 'build', what: 'house' });
    this.toast(`−${cost} 🪵 Стройка началась`);
  }

  update(dt) {
    const p = this.player.pos, n = this.npc, m = this.m;
    this.refresh(false);
    const dx = p.x - n.x, dz = p.z - n.z, d = Math.hypot(dx, dz);
    this.near = d < 2.6 && Math.abs(p.y - n.y) < 2;
    // в координатах дома: внутри ли герой и стоит ли у доски
    const ex = p.x - this.hx, ez = p.z - this.hz, ca = Math.cos(this.a), sa = Math.sin(this.a);
    const lx = ex * ca - ez * sa, lz = ex * sa + ez * ca;
    const indoors = this.state !== 'none' && Math.abs(lx) < HW && Math.abs(lz) < HD && Math.abs(p.y - this.floorY) < 2.4;
    this.nearBoard = this.state === 'built' && indoors && Math.abs(lx) < 1.6 && lz < -HD + 2.3;
    if (this.state === 'built') this.roof.visible = !indoors;
    if (d > 45) return; // далеко — житель стоит как стоял
    n.t += dt;
    const work = this.state === 'building';
    // смотрит на героя, когда тот рядом; на стройке — на дом
    const want = work ? Math.atan2(this.hx - n.x, this.hz - n.z) : d < 7 ? Math.atan2(dx, dz) : n.facing;
    let df = want - m.root.rotation.y;
    while (df > Math.PI) df -= Math.PI * 2;
    while (df < -Math.PI) df += Math.PI * 2;
    m.root.rotation.y += df * Math.min(1, dt * 5);
    const t = n.t;
    m.rig.position.y = Math.sin(t * 2.2) * 0.012;
    m.head.rotation.z = Math.sin(t * 0.7) * 0.04;
    if (work) {
      // стучит молотком
      m.axe.visible = true;
      m.armR.rotation.x = -1.5 + Math.sin(t * 10) * 0.75;
      m.armL.rotation.x = -0.5;
      m.rig.rotation.x = 0.12;
    } else {
      m.axe.visible = false;
      m.armR.rotation.x = Math.sin(t * 1.3) * 0.08;
      m.armL.rotation.x = -Math.sin(t * 1.3) * 0.08;
      m.rig.rotation.x = 0;
    }
    if ((n.blink -= dt) < -0.13) n.blink = 1.5 + Math.random() * 3.5;
    m.eyes.scale.set(1, n.blink < 0 ? 0.12 : 1, 1);
  }
}
