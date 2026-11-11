// Ввод: сенсорный экран (джойстик слева, обзор справа) и клавиатура с мышью.
export class Input {
  constructor(canvas, ui) {
    this.mx = 0; this.my = 0; this.lookX = 0; this.lookY = 0;
    this.jump = false; this.sprint = false; this.sprintLock = false;
    this.keys = new Set();
    this.touch = false;
    this.stick = null; this.look = null;
    this.jx = 0; this.jy = 0;
    const { stickEl, knobEl } = ui;

    const down = (e) => {
      if (e.pointerType === 'mouse') {
        if (document.pointerLockElement !== canvas) {
          try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* обзор перетаскиванием */ }
        }
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      this.touch = true;
      document.body.classList.add('touch');
      if (e.clientX < innerWidth * 0.42 && !this.stick) {
        this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
        stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px';
        stickEl.classList.add('on');
      } else if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
    };
    const move = (e) => {
      if (e.pointerType === 'mouse' && document.pointerLockElement === canvas) {
        this.lookX += e.movementX * 0.0024; this.lookY += e.movementY * 0.0024;
        return;
      }
      if (this.stick && e.pointerId === this.stick.id) {
        const R = 56;
        let dx = e.clientX - this.stick.x, dy = e.clientY - this.stick.y;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        this.jx = dx / R; this.jy = -dy / R;
        knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
        this.sprint = this.sprintLock || l > R * 1.7; // сильно отклонил — бег
      } else if (this.look && e.pointerId === this.look.id) {
        const k = e.pointerType === 'mouse' ? 0.004 : 0.0052;
        this.lookX += (e.clientX - this.look.x) * k; this.lookY += (e.clientY - this.look.y) * k;
        this.look.x = e.clientX; this.look.y = e.clientY;
      }
    };
    const up = (e) => {
      if (this.stick && e.pointerId === this.stick.id) {
        this.stick = null; this.jx = this.jy = 0;
        knobEl.style.transform = ''; stickEl.classList.remove('on');
        this.sprint = this.sprintLock;
      }
      if (this.look && e.pointerId === this.look.id) this.look = null;
    };
    canvas.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') { this.jump = true; e.preventDefault(); }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const btn = (el, fn) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    btn(ui.jumpEl, () => { this.jump = true; });
    btn(ui.runEl, () => {
      this.sprintLock = !this.sprintLock; this.sprint = this.sprintLock;
      ui.runEl.classList.toggle('on', this.sprintLock);
    });
  }

  // вызывается раз в кадр
  poll() {
    const k = this.keys;
    let x = this.jx, y = this.jy;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    this.mx = x; this.my = y;
    const sprint = this.sprint || k.has('ShiftLeft') || k.has('ShiftRight');
    const out = { mx: x, my: y, jump: this.jump, sprint, lookX: this.lookX, lookY: this.lookY };
    this.jump = false; this.lookX = 0; this.lookY = 0;
    return out;
  }
}
