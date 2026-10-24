/*
 * Matrix Music — 音频引擎
 *
 * 两层结构：
 *   声部      单个正弦声部（相位累加 + 二次衰减包络 + 随机声像）
 *   复音池    128 复音，超限时回收最早发声的声部
 *
 * **没有延迟 / 混响**（曾经有过一条 3 步反馈延迟，已删除，原因见下）。
 * 干声直出：画什么就听到什么，音符之间不会有从别处拍回来的重影。
 *
 * 用 OscillatorNode + GainNode.setValueCurveAtTime 得到与采样级合成
 * 数学等价的波形与包络，省掉逐样本填 PCM 的循环。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var NOTE_SECONDS = CFG.NOTE_SECONDS;

  function AudioEngine() {
    this.ctx = null;
    this.ready = false;
    this.activeVoices = 0;
    this.peakVoices = 0;
    this._envelopeCurve = global.TM.buildEnvelopeCurve(96);
    this.volume = CFG.VOLUME / 100;
    this.tempo = CFG.TEMPO;
  }

  /**
   * 确保音频上下文在跑。
   *
   * **`ready` 只说明图建好了，不说明它真的在出声。** `buildGraph` 里就把 `ready`
   * 置了 true，可那时代码还没 resume —— 若那次 resume 被自动播放策略挂住
   * （没有用户手势），上下文会一直停在 `suspended`。所以这里对已经建过图的
   * 情况重新 `resume()`：调用方保证这发生在用户手势里，重复调也安全
   * （running 状态下 resume 立即 resolve）。
   */
  AudioEngine.prototype.start = function () {
    var self = this;

    if (this.ready) {
      return this.ctx.resume().then(function () {
        return self.ctx;
      });
    }

    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx();
    this.buildGraph(ctx);

    return ctx.resume().then(function () {
      return ctx;
    });
  };

  /** 构建音频图。抽出来是为了能在 OfflineAudioContext 上做自动化验证。 */
  AudioEngine.prototype.buildGraph = function (ctx) {
    this.ctx = ctx;

    // ── 母线 ───────────────────────────────────────────────
    // 基准版没有限幅器，多声部直接相加后由驱动钳位；
    // Web Audio 输出到设备时同样会钳位，因此这里保持纯净通路。
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // ── 声部汇流 ───────────────────────────────────────────
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;

    // ── 路由：声部汇流直接进母线 ──────────────────────────
    //
    // 这里曾经串着一条「3 步反馈延迟」（干 1.0 / 湿 0.06 / 反馈 0.4，
    // 并带三角波微调制）。它是从基准版照搬的：在那套密集织体里，延迟把声音
    // 糊成一片空间感；但在这个「你画什么就听什么」的格子里，它变成了
    // **每个音后面跟着一个 375 ms（120 BPM）的重影，而且每 375 ms 再响一次、
    // 每次衰减 8 dB**。单音听起来像回声、稀疏图案里还会冒出不属于图案的鬼音。
    // 所以整条延迟线连同调制 LFO 一起删掉，干声直出。
    //
    // 不要再「顺手加回来」：回声会让「游标压到哪一格」和「听到哪个音」之间
    // 多出一条听不见来源的尾巴，也会让回环错位（polymeter）听起来像卡带。
    this.voiceBus.connect(this.master);

    // ── 就绪 ───────────────────────────────────────────────
    this.ready = true;
  };

  AudioEngine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  };

  /**
   * 改速度。音序器的步长由 `TM.stepSeconds(tempo)` 派生，音频侧没有需要
   * 重定时的东西了（延迟线删掉之后，这里只剩记录）。
   */
  AudioEngine.prototype.setTempo = function (bpm) {
    this.tempo = bpm;
  };

  /**
   * 输出链路总延迟（秒）。
   * 此刻写进音频图的样本要再过这么久才从扬声器出来，
   * 所以「耳朵此刻听到的位置」= currentTime − outputLatency。
   */
  AudioEngine.prototype.outputLatency = function () {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  };

  /**
   * 播放一个音符：起振 + 相位累加 + 二次衰减包络。
   * @param {number} note  NOTES 表中的音高值
   * @param {number} when  音频时钟上的触发时刻（秒）
   */
  AudioEngine.prototype.synthNote = function (note, when) {
    if (!this.ready) return;
    // 复音上限：与 VoiceStack(capacity = 128) 一致
    if (this.activeVoices >= CFG.MAX_VOICES) return;

    var ctx = this.ctx;
    var t0 = Math.max(when, ctx.currentTime + 0.001);

    // ── 随机声像（playEvent 原文：r = rand - rand）──────────
    var r = Math.random() - Math.random();
    var g = 1 / (1 + Math.abs(r));
    var gainL = (1 - r) * g;
    var gainR = (1 + r) * g;

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = global.TM.noteToFrequency(note);

    // ── 包络：amp(t) = (0.4·(1-t/T))² ─────────────────────
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.setValueCurveAtTime(this._envelopeCurve, t0, NOTE_SECONDS);

    var panL = ctx.createGain();
    panL.gain.value = gainL;
    var panR = ctx.createGain();
    panR.gain.value = gainR;

    var merger = ctx.createChannelMerger(2);

    osc.connect(env);
    env.connect(panL);
    env.connect(panR);
    panL.connect(merger, 0, 0);
    panR.connect(merger, 0, 1);
    merger.connect(this.voiceBus);

    var self = this;
    this.activeVoices++;
    if (this.activeVoices > this.peakVoices) this.peakVoices = this.activeVoices;

    osc.onended = function () {
      self.activeVoices--;
      try { osc.disconnect(); } catch (e) {}
      try { env.disconnect(); } catch (e) {}
      try { panL.disconnect(); } catch (e) {}
      try { panR.disconnect(); } catch (e) {}
      try { merger.disconnect(); } catch (e) {}
    };

    osc.start(t0);
    osc.stop(t0 + NOTE_SECONDS + 0.01);
  };

  global.TM.AudioEngine = AudioEngine;
})(window);
