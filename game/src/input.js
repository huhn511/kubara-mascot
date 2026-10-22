// Keyboard + touch input. Produces an analog move vector (x = right, y = forward) and
// edge-triggered actions (jump, emote).

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'run', ShiftRight: 'run',
};

export class Input {
  constructor({ joystick, jumpButton, emoteButton } = {}) {
    this.held = new Set();
    this.pressed = new Set();     // consumed by consume()
    this.stick = { x: 0, y: 0, active: false };
    this.usingTouch = false;

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = KEYMAP[e.code];
      if (k) { this.held.add(k); e.preventDefault(); }
      if (e.repeat) return;
      if (e.code === 'Space') { this.pressed.add('jump'); e.preventDefault(); }
      if (e.code === 'KeyE') this.pressed.add('emote');
      if (e.code === 'KeyH') this.pressed.add('help');
      if (e.code === 'KeyM') this.pressed.add('mute');
      if (e.code === 'KeyR') this.pressed.add('reset');
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYMAP[e.code];
      if (k) this.held.delete(k);
    });
    window.addEventListener('blur', () => this.held.clear());

    if (joystick) this._bindJoystick(joystick);
    const tap = (el, action) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.pressed.add(action); el.classList.add('down'); });
      const up = () => el.classList.remove('down');
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    tap(jumpButton, 'jump');
    tap(emoteButton, 'emote');
  }

  _bindJoystick(base) {
    const knob = base.querySelector('.knob');
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const move = (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const m = Math.min(1, len / R);
      const live = m < 0.12 ? 0 : 1; // dead zone
      this.stick.x = (dx / R) * live;
      this.stick.y = (-dy / R) * live;
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.stick.x = this.stick.y = 0;
      this.stick.active = false;
      knob.style.transform = '';
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.usingTouch = true;
      id = e.pointerId;
      base.setPointerCapture(id);
      const r = base.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      this.stick.active = true;
      move(e);
    });
    base.addEventListener('pointermove', move);
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
  }

  /** analog move vector, |v| <= 1 */
  move() {
    let x = 0, y = 0;
    if (this.held.has('left')) x -= 1;
    if (this.held.has('right')) x += 1;
    if (this.held.has('up')) y += 1;
    if (this.held.has('down')) y -= 1;
    const len = Math.hypot(x, y);
    if (len > 0) return { x: x / len, y: y / len, run: this.held.has('run') };
    if (this.stick.active) {
      const m = Math.hypot(this.stick.x, this.stick.y);
      return { x: this.stick.x, y: this.stick.y, run: m > 0.92 };
    }
    return { x: 0, y: 0, run: false };
  }

  /** true once per press */
  consume(action) {
    const had = this.pressed.has(action);
    this.pressed.delete(action);
    return had;
  }
}
