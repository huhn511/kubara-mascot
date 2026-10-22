// Tiny WebAudio synth blips: no audio files needed. Audio starts after the first user gesture.

export class Sfx {
  constructor() {
    this.muted = false;
    this.ctx = null;
    const unlock = () => {
      if (!this.ctx) {
        try { this.ctx = new AudioContext(); } catch { this.ctx = null; }
      }
      this.ctx?.resume?.();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  toggle() { this.muted = !this.muted; }

  _tone(freq, dur, { type = 'sine', gain = 0.12, slide = 0, delay = 0 } = {}) {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  jump() { this._tone(320, 0.18, { type: 'triangle', slide: 380, gain: 0.08 }); }
  land() { this._tone(140, 0.09, { type: 'sine', slide: -60, gain: 0.1 }); }
  splash() { this._tone(600, 0.25, { type: 'sine', slide: -450, gain: 0.05 }); }
  wave() {
    this._tone(660, 0.12, { type: 'triangle', gain: 0.07 });
    this._tone(880, 0.16, { type: 'triangle', gain: 0.07, delay: 0.1 });
  }
  pickup(n) {
    const base = 520 * Math.pow(2, ((n - 1) % 8) / 12);
    this._tone(base, 0.12, { type: 'square', gain: 0.04 });
    this._tone(base * 1.5, 0.18, { type: 'square', gain: 0.04, delay: 0.07 });
  }
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.25, { type: 'triangle', gain: 0.08, delay: i * 0.11 }));
  }
}
