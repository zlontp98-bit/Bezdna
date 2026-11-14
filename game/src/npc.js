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
    this.buildHall(scene);
    this.hall = 'none'; this.hallAt = 0; // улучшение: none | building | built

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
    if (snap.built && snap.built.hall !== undefined) this.beginHall(snap.built.hall);
    this.wallet = snap.wallet || 0;
    this.treasury = snap.treasury || { logs: 0 };
    world.on((ev) => {
      if (ev.type === 'built' && ev.what === 'house') this.begin(ev.at);
      if (ev.type === 'built' && ev.what === 'hall') this.beginHall(ev.at);
      // ответы на продажу и взнос: брёвна снимаем ровно столько, сколько принято
      if (ev.type === 'deposited') this.treasury = ev.treasury;
      if (ev.type === 'boughtBlueprint' && ev.by === world.me) this.wallet = ev.wallet;
      if ((ev.type === 'paid' || ev.type === 'deposited') && ev.by === world.me) {
        const item = ev.item || 'log';
        this.inv.remove(item, ev.n);
        this.wallet = ev.wallet;
        this.toast(ev.done ? `🎉 Казна собрана! +${ev.coins} ✨` : `−${ev.n} ${item === 'berry' ? '🫐' : '🪵'}  +${ev.coins} ✨`);
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

  // ---- уровень 2: мастерская ----
  // Дом остаётся ядром, вокруг вырастает большое здание: каменное крыло с красной крышей справа,
  // сторожевая башня, навес с оружейной стойкой слева, красные флаги, мишень, забор, фонари.
  // Всё — три простые модели (основание, верх, леса): три вызова отрисовки.
  buildHall(scene) {
    const M = propMaterial(), box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const stone = 0x8f8c88, stoneD = 0x77746f, logC = 0x9a6a44, dark = 0x5a3b26, plaster = 0xe4d6b4, roofC = 0x9a4a3c, red = 0xa9322c, cream = 0xe8d9b8, wood = 0x7a5034;
    const WX = HW + 3.8;                 // правая стена крыла
    const mk = (parts, visible) => {
      const mesh = new THREE.Mesh(merge(parts), M);
      mesh.position.set(this.hx, this.floorY, this.hz);
      mesh.rotation.y = this.a; mesh.visible = visible; mesh.frustumCulled = false;
      scene.add(mesh); return mesh;
    };
    const base = [], top = [], scaf = [];
    // --- правое крыло: каменный цоколь, фахверк (светлая штукатурка с тёмными балками), окна ---
    const wx0 = HW, wx1 = WX, wcx = (wx0 + wx1) / 2, ww = wx1 - wx0, wd = 2 * HD - 0.4, wz = -0.2, WH = 3.0;
    base.push(
      part(box(ww, 1.0, wd + 0.2), stone, { stone: 1, m: T(wcx, 0.5 - 0.0, wz) }),
      part(box(ww - 0.1, WH - 1.0, wd), plaster, { m: T(wcx, 1.0 + (WH - 1.0) / 2, wz) }),
    );
    for (const lz of [-wd / 2, wd / 2]) for (let i = 0; i <= 4; i++) base.push(part(box(0.16, WH - 1.0, 0.16), dark, { m: T(wx0 + 0.1 + i * (ww - 0.2) / 4, 1.0 + (WH - 1.0) / 2, wz + lz) }));
    base.push(part(box(ww, 0.16, wd + 0.2), dark, { m: T(wcx, 1.0, wz) }), part(box(ww, 0.16, wd + 0.2), dark, { m: T(wcx, WH, wz) }));
    // диагональные связи на лицевой стене
    for (const sd of [-1, 1]) base.push(part(box(0.12, 1.9, 0.12), dark, { m: T(wcx + sd * 1.3, 2.0, wz + wd / 2 + 0.04, 1, 1, 1, 0, sd * 0.55) }));
    // окна (светятся)
    for (const o of [wx0 + 1.1, wx1 - 1.1]) base.push(part(box(0.8, 0.8, 0.14), 0xffe9a0, { glow: 0.8, m: T(o, 2.0, wz + wd / 2 + 0.08) }), part(box(0.95, 0.95, 0.1), dark, { m: T(o, 2.0, wz + wd / 2 + 0.03) }));
    base.push(part(box(0.14, 0.8, 0.8), 0xffe9a0, { glow: 0.8, m: T(wx1 + 0.02, 2.0, wz) }));
    // --- башня справа от крыла ---
    const tx = wx1 + 1.25, tz = wz - 0.4, TW = 2.2, TH2 = 7.6;
    base.push(
      part(box(TW + 0.3, 1.4, TW + 0.3), stone, { stone: 1, m: T(tx, 0.7, tz) }),
      part(box(TW, TH2 - 1.4, TW), logC, { m: T(tx, 1.4 + (TH2 - 1.4) / 2, tz) }),
    );
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) base.push(part(box(0.22, TH2, 0.22), dark, { m: T(tx + sx * (TW / 2), TH2 / 2, tz + sz * (TW / 2)) }));
    for (let k = 0; k < 3; k++) base.push(part(box(TW + 0.1, 0.12, TW + 0.1), dark, { m: T(tx, 2.4 + k * 1.9, tz) }));
    // смотровая площадка с перилами
    base.push(part(box(TW + 1.1, 0.2, TW + 1.1), wood, { m: T(tx, TH2 - 0.3, tz) }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) base.push(part(box(0.12, 1.0, 0.12), dark, { m: T(tx + sx * (TW / 2 + 0.5), TH2 + 0.3, tz + sz * (TW / 2 + 0.5)) }));
    for (const sd of [-1, 1]) {
      base.push(part(box(TW + 1.1, 0.1, 0.1), wood, { m: T(tx, TH2 + 0.7, tz + sd * (TW / 2 + 0.5)) }), part(box(0.1, 0.1, TW + 1.1), wood, { m: T(tx + sd * (TW / 2 + 0.5), TH2 + 0.7, tz) }));
    }
    // --- верх: крыша крыла, крыша башни, дымоход, флаги, навес, мишень, забор, фонари ---
    const tri = (w, h) => { const sh = new THREE.Shape(); sh.moveTo(-w, 0); sh.lineTo(w, 0); sh.lineTo(0, h); sh.closePath(); return sh; };
    // крыша крыла — вдоль x (двускатная, конёк по x): экструзия профиля по глубине, повёрнута
    top.push(part(new THREE.ExtrudeGeometry(tri(wd / 2 + 0.5, 1.6), { depth: ww + 0.8, bevelEnabled: false }).rotateY(Math.PI / 2).translate(wx0 - 0.4, WH, wz), roofC));
    top.push(part(box(0.7, 1.7, 0.7), stone, { stone: 1, m: T(wcx - 0.8, WH + 1.5, wz - 0.7) }), part(box(0.9, 0.16, 0.9), stoneD, { stone: 1, m: T(wcx - 0.8, WH + 2.4, wz - 0.7) }));
    // шатровая крыша башни
    top.push(part(new THREE.ConeGeometry(TW * 0.95, 2.3, 4).rotateY(Math.PI / 4), roofC, { m: T(tx, TH2 + 2.55, tz) }), part(box(0.1, 0.9, 0.1), dark, { m: T(tx, TH2 + 4.2, tz) }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) top.push(part(box(0.14, 1.9, 0.14), dark, { m: T(tx + sx * (TW / 2 + 0.5), TH2 + 1.6, tz + sz * (TW / 2 + 0.5)) }));
    // красные флаги со скрещёнными мечами: над входом, на башне, на столбе у навеса
    const flag = (x, y, z, ry, w, h) => {
      top.push(part(box(w, h, 0.05), red, { m: T(x, y, z, 1, 1, 1, ry) }), part(box(w + 0.1, 0.1, 0.1), dark, { m: T(x, y + h / 2 + 0.05, z, 1, 1, 1, ry) }));
      for (const sd of [-1, 1]) top.push(part(box(0.09, h * 0.62, 0.02), 0xf1ece0, { m: T(x, y + h * 0.05, z + 0.035, 1, 1, 1, ry, sd * 0.62) }));
      // «хвост» флага
      top.push(part(new THREE.ConeGeometry(w / 2, 0.35, 3).rotateX(Math.PI), red, { m: T(x, y - h / 2 - 0.12, z, 1, 1, 1, ry) }));
    };
    flag(0, 3.1, HD + 0.07, 0, 0.9, 1.6);                 // над дверью
    flag(tx, TH2 - 2.4, tz + TW / 2 + 0.08, 0, 0.7, 1.4);  // на башне
    flag(wcx, 2.2, wz + wd / 2 + 0.2, 0, 0.7, 0.0001);     // (под окнами крыла — только перекладина)
    // навес слева: четыре столба, полосатое полотно с наклоном, оружейная стойка под ним
    const ax0 = -HW - 4.4, ax1 = -HW - 0.3, az0 = -0.2, az1 = 3.6;
    for (const [x, z] of [[ax0, az0], [ax0, az1], [ax1, az1]]) top.push(part(box(0.16, 2.9, 0.16), dark, { m: T(x, 1.45, z) }));
    const stripes = 8;
    for (let i = 0; i < stripes; i++) top.push(part(box((ax1 - ax0) / stripes + 0.01, 0.07, az1 - az0 + 0.4), i % 2 ? cream : red, { m: T(ax0 + (i + 0.5) * (ax1 - ax0) / stripes, 3.0 - 0.0, (az0 + az1) / 2 + 0.1, 1, 1, 1, 0, 0) }));
    // подпорки и «волны» полотна по краю
    for (let i = 0; i < stripes; i++) top.push(part(new THREE.ConeGeometry(0.28, 0.3, 3).rotateX(Math.PI), i % 2 ? cream : red, { m: T(ax0 + (i + 0.5) * (ax1 - ax0) / stripes, 2.8, az1 + 0.28, 1, 1, 1, 0) }));
    // оружейная стойка: рама и копья с мечами
    top.push(part(box(2.6, 0.12, 0.12), dark, { m: T((ax0 + ax1) / 2, 1.5, az0 + 0.5) }), part(box(2.6, 0.12, 0.12), dark, { m: T((ax0 + ax1) / 2, 0.5, az0 + 0.5) }));
    for (let i = 0; i < 7; i++) top.push(part(box(0.06, 1.7, 0.06), i % 3 ? wood : 0xb9c2cb, { m: T(ax0 + 0.6 + i * 0.4, 1.0, az0 + 0.5, 1, 1, 1, 0, (i - 3) * 0.03) }));
    // столы и ящики под навесом
    top.push(part(box(1.5, 0.12, 0.7), wood, { m: T(ax0 + 1.5, 0.85, az1 - 0.8) }), part(box(0.9, 0.9, 0.9), 0xa06c44, { m: T(ax1 - 0.9, 0.45, az1 - 1.0) }), part(box(0.7, 0.7, 0.7), 0xa06c44, { m: T(ax1 - 1.3, 0.35, az1 - 0.3, 1, 1, 1, 0.5) }));
    // красный флаг на высоком столбе слева от навеса
    top.push(part(box(0.18, 5.4, 0.18), dark, { m: T(ax0 - 0.9, 2.7, az1 + 0.3) }));
    flag(ax0 - 0.9 + 0.0, 4.5, az1 + 0.3 + 0.12, 0, 0.9, 1.7);
    // мишень на подставке
    top.push(part(box(0.1, 1.3, 0.1), dark, { m: T(-HW - 2.6, 0.65, HD + 3.2) }), part(new THREE.CylinderGeometry(0.62, 0.62, 0.12, 14).rotateX(Math.PI / 2), 0xf1ece0, { m: T(-HW - 2.6, 1.5, HD + 3.2) }),
      part(new THREE.CylinderGeometry(0.44, 0.44, 0.13, 14).rotateX(Math.PI / 2), red, { m: T(-HW - 2.6, 1.5, HD + 3.2) }), part(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateX(Math.PI / 2), 0xf1ece0, { m: T(-HW - 2.6, 1.5, HD + 3.2) }));
    // забор спереди слева и справа от входа (вход свободен)
    for (const [x0, x1] of [[-HW - 5.0, -2.2], [2.2, WX + 0.6]]) {
      const n = Math.round(Math.abs(x1 - x0) / 0.9);
      for (let i = 0; i <= n; i++) top.push(part(box(0.14, 1.0, 0.14), wood, { m: T(x0 + i * (x1 - x0) / n, 0.5, HD + 4.4) }));
      top.push(part(box(Math.abs(x1 - x0), 0.1, 0.08), wood, { m: T((x0 + x1) / 2, 0.8, HD + 4.4) }), part(box(Math.abs(x1 - x0), 0.1, 0.08), wood, { m: T((x0 + x1) / 2, 0.45, HD + 4.4) }));
    }
    // фонари: у входа, у крыла и на навесе
    for (const [x, z] of [[-1.5, HD + 0.5], [1.5, HD + 0.5], [wx0 + ww / 2, wz + wd / 2 + 0.6], [ax1, az1]]) {
      top.push(part(box(0.1, 1.5, 0.1), dark, { m: T(x, 1.0, z) }), part(box(0.28, 0.34, 0.28), 0xffe9a0, { glow: 1, m: T(x, 1.9, z) }), part(box(0.34, 0.06, 0.34), dark, { m: T(x, 2.1, z) }));
    }
    // ящики и бочки у стены крыла, жаровня у входа
    top.push(part(box(0.9, 0.9, 0.9), 0xa06c44, { m: T(WX - 0.8, 0.45, wz + wd / 2 + 0.9) }), part(box(0.7, 0.7, 0.7), 0x8a5a3a, { m: T(WX - 1.9, 0.35, wz + wd / 2 + 0.8, 1, 1, 1, 0.4) }),
      part(new THREE.CylinderGeometry(0.38, 0.34, 1.0, 9), 0x7b5a3c, { m: T(WX - 2.9, 0.5, wz + wd / 2 + 0.8) }));
    top.push(part(new THREE.CylinderGeometry(0.5, 0.35, 0.4, 8), 0x3a3a40, { m: T(3.8, 0.55, HD + 2.0) }), part(new THREE.ConeGeometry(0.3, 0.8, 6), 0xff8a2a, { glow: 1, sway: 9, m: T(3.8, 1.15, HD + 2.0) }), part(new THREE.ConeGeometry(0.17, 0.5, 5), 0xffd257, { glow: 1, sway: 9, m: T(3.8, 1.1, HD + 2.0) }));
    for (const sx of [-1, 1]) top.push(part(box(0.1, 0.5, 0.1), 0x3a3a40, { m: T(3.8 + sx * 0.4, 0.25, HD + 2.0 + 0.2) }));
    // леса вокруг крыла и башни на время стройки
    for (const [x, z, h] of [[wx0 - 0.5, wz - wd / 2 - 0.5, 3.6], [wx0 - 0.5, wz + wd / 2 + 0.5, 3.6], [wx1 + 0.5, wz + wd / 2 + 0.5, 3.6], [tx - TW / 2 - 0.6, tz + TW / 2 + 0.6, 8.2], [tx + TW / 2 + 0.6, tz + TW / 2 + 0.6, 8.2], [tx + TW / 2 + 0.6, tz - TW / 2 - 0.6, 8.2]])
      scaf.push(part(box(0.12, h, 0.12), dark, { m: T(x, h / 2, z) }));
    for (const y of [1.8, 3.4, 5.0, 6.6]) scaf.push(part(box(ww + TW + 2.4, 0.1, 0.1), dark, { m: T((wx0 + tx + TW / 2) / 2, y, wz + wd / 2 + 0.55) }));
    this.hallBase = mk(base, false); this.hallTop = mk(top, false); this.hallScaf = mk(scaf, false);
    this.hallDims = { wx0, wx1, wd, wz, tx, tz, TW, ax0, ax1, az0, az1, WH, TH2 };
  }

  // улучшение началось в момент at
  beginHall(at) {
    if (this.hall !== 'none' || this.state === 'none') { if (this.state === 'none') this.pendingHall = at; return; }
    this.hall = 'building'; this.hallAt = at;
    const { W, a, floorY } = this, d = this.hallDims;
    const solid = (lx, lz, hx, hz, top, bottom) => { const [x, z] = W(lx, lz); addBox(x, z, hx, hz, a, floorY + top, bottom === undefined ? -1e9 : floorY + bottom); };
    solid((d.wx0 + d.wx1) / 2, d.wz, (d.wx1 - d.wx0) / 2, d.wd / 2, d.WH + 1.0);   // крыло: сплошное
    solid(d.tx, d.tz, d.TW / 2 + 0.15, d.TW / 2 + 0.15, d.TH2);                      // башня
    solid((d.ax0 + d.ax1) / 2, d.az0 + 0.5, (d.ax1 - d.ax0) / 2 - 0.1, 0.12, 1.5);   // оружейная стойка
    this.hallBase.visible = this.hallScaf.visible = true;
    clearGrass(this.hx + (d.wx0 + d.tx) / 2 * Math.cos(a), this.hz - (d.wx0 + d.tx) / 2 * Math.sin(a), 8, 4, a);
    this.refreshHall(true);
  }
  refreshHall(force) {
    if (this.hall !== 'building') return;
    const k = Math.min(1, (this.world.now() - this.hallAt) / RULES.build.hall.ms);
    this.hallBase.scale.y = 0.05 + 0.95 * k;
    if (k >= 1) {
      this.hall = 'built'; this.hallBase.scale.y = 1;
      this.hallScaf.visible = false; this.hallTop.visible = true;
      if (!force) this.toast('🏛️ Мастерская готова!');
    }
  }
  hallLeft() { return Math.max(0, Math.ceil((RULES.build.hall.ms - (this.world.now() - this.hallAt)) / 1000)); }

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
    if (this.pendingHall !== undefined) { const h = this.pendingHall; this.pendingHall = undefined; this.beginHall(h); }
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
    else if (this.hall === 'building') text = `Мастерскую строим! Осталось ${this.hallLeft()} с. Леса не трогай.`;
    else if (this.hall === 'built') text = `Мастерская готова — красота! Брёвна покупаю по ${price} ✨, а в казну на доске за них дают больше.`;
    else text = `Дом готов. Хочешь большую мастерскую — с башней, навесом и стойкой для оружия? Нужны брёвна, камень и одна шестерёнка из старых ящиков на островках. Брёвна покупаю по ${price} ✨.`;
    // улучшение дома до мастерской: ресурсы снимаются сразу, как и за первый дом
    if (this.state === 'built' && this.hall === 'none') {
      const H = RULES.build.hall.cost, lg = this.inv.count('log'), st = this.inv.count('stone'), gr = this.inv.count('gear');
      acts.push({ label: `Улучшить до мастерской: ${H.log} 🪵 ${lg}/${H.log} · ${H.stone} 🪨 ${st}/${H.stone} · ${H.gear} ⚙️ ${gr}/${H.gear}`, can: lg >= H.log && st >= H.stone && gr >= H.gear, run: () => this.acceptHall() });
    }
    acts.push({ label: have ? `Продать ${have} 🪵 за ${have * price} ✨` : 'Продать брёвна — нет брёвен', can: have > 0, run: () => this.world.send({ type: 'sell', item: 'log', n: have }) });
    const bn = this.inv.count('berry'), bp = RULES.trade.price.berry;
    if (bn) acts.push({ label: `Продать ${bn} 🫐 за ${bn * bp} ✨`, can: true, run: () => this.world.send({ type: 'sell', item: 'berry', n: bn }) });
    // чертежи: по одному, пока не изучен
    for (const what in RULES.blueprints) {
      const bp = RULES.blueprints[what], r = RULES.recipes[what];
      if (this.craft.known.includes(what)) continue;
      const has = this.inv.count(bp.item) > 0;
      acts.push({ label: has ? `📜 ${r.name}: чертёж уже у тебя — изучи его` : `Купить чертёж: ${r.icon} ${r.name} — ${bp.price} ✨`, can: !has && this.wallet >= bp.price, run: () => this.world.send({ type: 'buyBlueprint', what }) });
    }
    return { name, text, acts };
  }
  acceptHall() {
    const H = RULES.build.hall.cost;
    if (this.state !== 'built' || this.hall !== 'none') return;
    for (const id in H) if (this.inv.count(id) < H[id]) return;
    for (const id in H) this.inv.remove(id, H[id]);
    this.world.send({ type: 'build', what: 'hall' });
    this.toast('🏗️ Стройка мастерской началась');
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
    this.refresh(false); this.refreshHall(false);
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
    const work = this.state === 'building' || this.hall === 'building';
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
