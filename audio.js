/* =============================================================================
 * 罗德岛棋局 · 音频引擎 (audio.js)  —— 采样版
 * -----------------------------------------------------------------------------
 * 设计：Game Audio Engineer（游戏音频工程师）
 * SFX：真实采样（window.AUDIO_ASSETS，由 tools/gen_audio_samples.py 生成）。
 * 音乐：生成式自适应（程序化合成，无音频资源；预留替换为真·分层音乐）。
 * 约束：无任何外部依赖、可完全离线、纯静态双击运行（与项目一致）。
 *
 * 集成规范（对齐专业中间件 FMOD/Wwise）：
 *   1) 游戏逻辑不直接播放声音 —— 一切声音通过命名事件 window.AUDIO.play(name)。
 *   2) 参数（tension / 伤害类型 / 阵营 / 技能 archetype）由游戏写入，音频逻辑留引擎内。
 *   3) 每个事件有总线归属、优先级与语音管理（voice limit + steal），无默认值裸奔。
 *   4) SFX 为预渲染采样：懒解码 base64→AudioBuffer、round-robin 变体抗机械重复。
 *   5) 自适应音乐由 tension 驱动，状态切换走交叉淡入，无硬切（除非设计需要）。
 *
 * 对外接口：
 *   AUDIO.play(event, params)        播放命名事件（采样键见 window.AUDIO_ASSETS）
 *   AUDIO.setMusic(state)            切换音乐状态：exploration|shop|combat|boss|victory|defeat
 *   AUDIO.setTension(0..1)           设置战斗强度，影响 combat/boss 层密度与亮度
 *   AUDIO.toggle() / isMuted()       静音开关（持久化 localStorage）
 *   AUDIO.setVolume(0..1)            主音量
 *   window.SFX                       向后兼容别名（旧 sfx.js 调用方式仍可工作）
 * ========================================================================== */
(function () {
  'use strict';

  // ---- 平台常量 ----------------------------------------------------------
  var SAMPLE_RATE = 44100;          // Web Audio 上下文采样率（采样会自动重采样到该率）
  var MAX_SFX_VOICES = 24;          // 单端 SFX 并发语音上限（移动端可调低）
  var MUSIC_BUS_BASE = 0.45;        // 音乐总线基准增益

  // ---- 核心对象（懒初始化） ---------------------------------------------
  var AC = null;                    // AudioContext
  var master = null;                // 主增益
  var masterSoft = null;            // 柔化低通（滚降极高频，去刺耳）
  var masterShelf = null;           // 柔化高架（衰减 3.5k+，去明亮毛刺）
  var comp = null;                  // 总线压缩（防止混音削波）
  var buses = {};                   // { music, sfx, ui }
  var noiseBuffer = null;           // 复用白噪声缓冲（生成式音乐用）
  var unlocked = false;

  // 采样播放
  var sampleCache = {};             // key -> AudioBuffer（已解码）
  var sampleDecoding = {};          // key -> Promise（解码中）
  var rr = {};                      // 每个采样键的 round-robin 计数

  // 语音管理
  var activeVoices = [];            // 当前活跃 SFX 语音（用于 steal）

  // 音乐状态
  var musicBaseState = 'exploration';
  var curTempo = 96;
  var curTension = 0.2;
  var schedTimer = null;
  var nextStepTime = 0;
  var step = 0;

  // 持久化
  var STORE_KEY = 'rh_audio_muted';
  var muted = false;
  try { muted = localStorage.getItem(STORE_KEY) === '1'; } catch (e) {}

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function assets() { return (typeof window !== 'undefined' && window.AUDIO_ASSETS) || {}; }

  // ---- 初始化（首次用户手势后调用） -------------------------------------
  function ensure() {
    if (AC) {
      if (AC.state === 'suspended') AC.resume();
      return AC;
    }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx({ sampleRate: SAMPLE_RATE });

    master = AC.createGain();
    master.gain.value = 0.82;
    // 柔化主链：低通滚降极高频 + 高架衰减 3.5kHz 以上，整体更圆润不刺耳
    masterSoft = AC.createBiquadFilter();
    masterSoft.type = 'lowpass'; masterSoft.frequency.value = 9000; masterSoft.Q.value = 0.7;
    masterShelf = AC.createBiquadFilter();
    masterShelf.type = 'highshelf'; masterShelf.frequency.value = 3500; masterShelf.gain.value = -5;
    comp = AC.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    master.connect(masterSoft);
    masterSoft.connect(masterShelf);
    masterShelf.connect(comp);
    comp.connect(AC.destination);

    buses.music = AC.createGain(); buses.music.gain.value = MUSIC_BUS_BASE;
    buses.sfx = AC.createGain();   buses.sfx.gain.value = 0.82;
    buses.ui = AC.createGain();     buses.ui.gain.value = 0.82;
    buses.music.connect(master);
    buses.sfx.connect(master);
    buses.ui.connect(master);

    // 预生成白噪声缓冲（生成式音乐的 hat / 打击复用）
    var len = Math.floor(SAMPLE_RATE * 1.0);
    noiseBuffer = AC.createBuffer(1, len, SAMPLE_RATE);
    var d = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    unlocked = true;
    startScheduler();
    return AC;
  }

  // ---- 语音管理（steal） ------------------------------------------------
  function trackVoice(node, endAt, priority) {
    var v = { node: node, endAt: endAt, priority: priority };
    var idx = activeVoices.length;
    activeVoices.push(v);
    node.onended = function () {
      var j = activeVoices.indexOf(v);
      if (j >= 0) activeVoices.splice(j, 1);
    };
  }
  function stealIfNeeded(priority) {
    if (activeVoices.length < MAX_SFX_VOICES) return;
    var victim = null, vi = -1;
    for (var i = 0; i < activeVoices.length; i++) {
      var v = activeVoices[i];
      if (v.priority >= priority) continue;       // 只抢占更低优先级的
      if (!victim || v.endAt < victim.endAt) { victim = v; vi = i; }
    }
    if (victim) {
      try { victim.node.stop(AC.currentTime + 0.01); } catch (e) {}
      activeVoices.splice(vi, 1);
    } else if (activeVoices.length >= MAX_SFX_VOICES) {
      var v0 = activeVoices.shift();
      try { v0.node.stop(AC.currentTime + 0.01); } catch (e) {}
    }
  }

  // ---- 降级合成（仅当采样资产缺失时，保证游戏仍有声音反馈） -------------
  function blip(o) {
    if (!AC) return;
    var t0 = AC.currentTime + (o.when || 0);
    var dur = o.dur || 0.1;
    var vol = Math.max(0.0008, o.vol == null ? 0.15 : o.vol);
    var osc = AC.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + dur);
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(buses[o.bus] || buses.sfx);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
    trackVoice(osc, t0 + dur, o.priority || 2);
  }

  // ===========================================================================
  // 采样播放（核心）
  // ===========================================================================
  // 把命名事件 + params 解析为「采样键 + 总线 + 优先级」
  function resolve(name, params) {
    params = params || {};
    if (name === 'combat/hit') {
      return { key: params.dmgType === 'arts' ? 'combat/hit_arts' : 'combat/hit', bus: 'sfx', pri: 2 };
    }
    if (name === 'combat/skill') {
      return { key: 'combat/skill_' + (params.arch || 'default'), bus: 'sfx', pri: 2 };
    }
    if (name === 'combat/death') {
      return { key: params.side === 'ally' ? 'combat/death_ally' : 'combat/death_enemy', bus: 'sfx', pri: 2 };
    }
    if (name === 'result/win')  return { key: 'result/win',  bus: 'music', pri: 0 };
    if (name === 'result/lose') return { key: 'result/lose', bus: 'music', pri: 0 };
    if (name === 'result/boss') return { key: 'result/boss', bus: 'music', pri: 0 };
    // 默认：事件名即采样键
    var bus = (name.indexOf('ui/') === 0) ? 'ui'
            : (name.indexOf('result/') === 0) ? 'music'
            : 'sfx';
    var pri = (bus === 'ui' || bus === 'music') ? 0
            : (name.indexOf('combat/') === 0 ? 2 : 1);
    return { key: name, bus: bus, pri: pri };
  }

  // base64 data URI -> AudioBuffer（懒解码，按 key 缓存）
  function getBuffer(key, uri) {
    if (sampleCache[key]) return Promise.resolve(sampleCache[key]);
    if (sampleDecoding[key]) return sampleDecoding[key];
    var p = new Promise(function (resolve, reject) {
      try {
        var comma = uri.indexOf(',');
        var b64 = comma >= 0 ? uri.slice(comma + 1) : uri;
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        AC.decodeAudioData(arr.buffer,
          function (buf) { sampleCache[key] = buf; resolve(buf); },
          function (err) { reject(err || new Error('decode failed')); });
      } catch (e) { reject(e); }
    });
    sampleDecoding[key] = p;
    p.then(function () { delete sampleDecoding[key]; },
           function () { delete sampleDecoding[key]; });
    return p;
  }

  function fallbackKey(key, busName, priority) {
    if (!AC) return;
    blip({ freq: 440, type: 'sine', dur: 0.08, vol: 0.12, bus: busName, priority: priority });
  }

  function playSampleKey(key, busName, priority) {
    ensure();
    if (!AC) return;
    var uris = assets()[key];
    if (!uris || !uris.length) { fallbackKey(key, busName, priority); return; }
    var idx = (rr[key] = ((rr[key] || 0) + 1) % uris.length);
    var uri = uris[idx];
    getBuffer(key, uri).then(function (buf) {
      if (!buf || muted) return;
      stealIfNeeded(priority);
      var t0 = AC.currentTime;
      var src = AC.createBufferSource();
      src.buffer = buf;
      // 每次播放微扰播放速率，避免机械重复感
      src.playbackRate.value = 1 + (Math.random() * 0.04 - 0.02);
      src.connect(buses[busName] || buses.sfx);
      var dur = buf.duration;
      src.start(t0);
      trackVoice(src, t0 + dur, priority);
    }).catch(function () { fallbackKey(key, busName, priority); });
  }

  // 向后兼容映射（旧 SFX.play 名称 → 新事件键）
  var ALIAS = {
    click: 'ui/click', select: 'ui/select', buy: 'shop/buy', reroll: 'shop/reroll',
    error: 'ui/error', node: 'strategic/node_enter',
    win: 'result/win', lose: 'result/lose', boss: 'result/boss'
  };

  // ===========================================================================
  // 生成式自适应音乐（无音频资源，纯合成；预留接口替换为真·分层音乐）
  // ===========================================================================
  var PROG = [
    [220.00, 261.63, 329.63], // Am: A3 C4 E4
    [174.61, 220.00, 261.63], // F : F3 A3 C4
    [261.63, 329.63, 392.00], // C : C4 E4 G4
    [196.00, 246.94, 293.66]  // G : G3 B3 D4
  ];

  function fadeMusic(target) {
    if (!AC || !buses.music) return;
    var t = AC.currentTime;
    buses.music.gain.cancelScheduledValues(t);
    buses.music.gain.setValueAtTime(buses.music.gain.value, t);
    buses.music.gain.linearRampToValueAtTime(target, t + 0.8);
  }

  function playPad(notes, t, dur) {
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.8);
    g.gain.setValueAtTime(0.045, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1100;
    g.connect(f); f.connect(buses.music);
    notes.forEach(function (n, i) {
      var o = AC.createOscillator();
      o.type = 'triangle';
      o.frequency.value = n; o.detune.value = (i - 1) * 4;
      o.connect(g); o.start(t); o.stop(t + dur + 0.05);
    });
  }
  function playBass(freq, t, ten) {
    var o = AC.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.98, t + 0.18);
    var g = AC.createGain();
    var vol = 0.10 * (0.5 + ten * 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(buses.music);
    o.start(t); o.stop(t + 0.25);
  }
  function playKick(t, ten) {
    var o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    var g = AC.createGain();
    var vol = 0.18 * (0.5 + ten * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(buses.music);
    o.start(t); o.stop(t + 0.18);
  }
  function playHat(t, ten) {
    var src = AC.createBufferSource(); src.buffer = noiseBuffer;
    var f = AC.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5500;
    var g = AC.createGain();
    var vol = 0.045 * ten;
    g.gain.setValueAtTime(Math.max(0.0008, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(buses.music);
    src.start(t); src.stop(t + 0.06);
  }
  function playDrone(freq, t, dur) {
    var o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
    var o2 = AC.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 1.005;
    var f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 360;
    var g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 1.0);
    g.gain.setValueAtTime(0.06, t + dur - 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); o2.connect(f); f.connect(g); g.connect(buses.music);
    o.start(t); o2.start(t); o.stop(t + dur); o2.stop(t + dur);
  }

  function scheduleStep(s, t) {
    var base = musicBaseState;
    if (base !== 'exploration' && base !== 'shop' && base !== 'combat' && base !== 'boss') return;
    var sec16 = 60 / curTempo / 4;
    var barStep = s % 16;
    var chord = PROG[Math.floor(s / 16) % PROG.length];
    var barDur = sec16 * 16;
    var ten = (base === 'combat' || base === 'boss') ? curTension
            : (base === 'shop' ? 0.35 : 0.15);

    if (barStep === 0) playPad(chord, t, barDur);
    if (base === 'combat' || base === 'boss' || base === 'shop') {
      if (barStep % 4 === 0) playBass(chord[0] / 2, t, ten);
    }
    if (base === 'boss' && barStep === 0) playDrone(chord[0] / 2, t, barDur);

    if (base === 'combat' || base === 'boss') {
      if (barStep === 0 || barStep === 8) playKick(t, ten);
      if (barStep % 4 === 2 && Math.random() < ten) playHat(t, ten);
      if (base === 'boss' && barStep % 2 === 0 && Math.random() < ten * 0.7) playKick(t, ten * 0.7);
    } else if (base === 'shop') {
      if (barStep === 8) playKick(t, 0.3);
    }
  }

  function startScheduler() {
    if (schedTimer || !AC) return;
    nextStepTime = AC.currentTime + 0.1;
    step = 0;
    schedTimer = setInterval(function () {
      if (!AC) return;
      while (nextStepTime < AC.currentTime + 0.2) {
        scheduleStep(step, nextStepTime);
        nextStepTime += (60 / curTempo / 4);
        step++;
      }
    }, 25);
  }

  // ===========================================================================
  // 公开 API
  // ===========================================================================
  function play(name, params) {
    if (muted) return;
    var r = resolve(name, params);
    playSampleKey(r.key, r.bus, r.pri);
  }

  function setMusic(state) {
    ensure();
    if (state === 'victory') { playSampleKey('result/win', 'music', 0); return; }
    if (state === 'defeat')  { playSampleKey('result/lose', 'music', 0); return; }
    if (state === 'boss') {
      musicBaseState = 'boss'; curTempo = 138; fadeMusic(0.7);
      playSampleKey('result/boss', 'music', 0); return;
    }
    musicBaseState = state;
    if (state === 'exploration') { curTempo = 96; fadeMusic(MUSIC_BUS_BASE * 0.9); }
    else if (state === 'shop')   { curTempo = 104; fadeMusic(MUSIC_BUS_BASE); }
    else if (state === 'combat') { curTempo = 124; fadeMusic(MUSIC_BUS_BASE * 1.15); }
  }

  function setTension(v) { curTension = clamp(v == null ? 0.2 : v, 0, 1); }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch (e) {}
    return muted;
  }
  function isMuted() { return muted; }
  function setVolume(v) {
    ensure();
    if (master) master.gain.value = clamp(v == null ? 0.9 : v, 0, 1);
  }

  // 首次手势解锁（浏览器自动播放策略）
  function unlockOnce() {
    ensure();
    if (AC && AC.state === 'suspended') AC.resume();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', unlockOnce, { once: true });
    document.addEventListener('keydown', unlockOnce, { once: true });
  }

  window.AUDIO = {
    play: play,
    setMusic: setMusic,
    setTension: setTension,
    toggle: toggle,
    isMuted: isMuted,
    setVolume: setVolume,
    get muted() { return muted; }
  };

  // 向后兼容别名（旧 sfx.js 调用方无需改动）
  window.SFX = {
    play: function (name) { var ev = ALIAS[name]; if (ev) play(ev); },
    toggle: function () { return toggle(); },
    get muted() { return muted; },
    isOn: function () { return !muted; }
  };
})();
