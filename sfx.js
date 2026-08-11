/* 轻量音效：Web Audio API 合成，无需任何二进制资源（纯静态可运行）。
 * 提供 window.SFX.play(name) 与 window.SFX.toggle()。游戏内按钮/事件调用。 */
(function () {
  let ctx = null;
  let muted = false;
  let unlocked = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function blip(freq, dur, type, vol, when) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.12));
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + (dur || 0.12) + 0.02);
  }

  function seq(notes, step, type, vol) {
    notes.forEach((f, i) => blip(f, step * 1.4, type, vol, i * step));
  }

  const PLAY = {
    click:  () => blip(440, 0.06, 'triangle', 0.07),
    select: () => blip(640, 0.05, 'sine', 0.06),
    buy:    () => { blip(720, 0.07, 'square', 0.06); blip(1040, 0.09, 'square', 0.06, 0.06); },
    reroll: () => blip(520, 0.06, 'triangle', 0.06),
    error:  () => blip(170, 0.2, 'sawtooth', 0.08),
    node:   () => blip(560, 0.08, 'sine', 0.06),
    win:    () => seq([523, 659, 784, 1046], 0.11, 'triangle', 0.1),
    lose:   () => seq([392, 330, 262], 0.16, 'sawtooth', 0.09),
    boss:   () => seq([196, 247, 294, 392], 0.14, 'square', 0.1)
  };

  window.SFX = {
    play(name) {
      if (muted) return;
      // 浏览器要求用户手势后才能播放：首次交互时解锁
      if (!unlocked) { ensure(); unlocked = true; }
      const fn = PLAY[name];
      if (fn) { try { fn(); } catch (e) { /* 静默失败 */ } }
    },
    toggle() { muted = !muted; return muted; },
    get muted() { return muted; },
    isOn() { return !muted; }
  };
})();
