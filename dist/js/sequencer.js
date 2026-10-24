/*
 * Matrix Music — 步进音序器
 *
 * 采用 lookahead 排程：定时器每 25ms 轮询一次，把未来 120ms 窗口内的音符
 * 按 Web Audio 的音频时钟精确排好，而不是靠 setInterval 卡时间点。
 *
 * 关键设计：音序器是整条链路唯一的时基。
 * 每把一步排进音频时钟，就记录 {step, time} 到 timeline；视觉层用 stepAtTime()
 * 反查「此刻听到的是哪一步」，而不是用「起点 + 步长 × n」去推算 —— 后者在
 * 改速度、或起点与首步之间存在启动延迟时都会和真实音频错位。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;
  var LOOKAHEAD_MS = 25;      // 调度器轮询间隔
  var SCHEDULE_AHEAD = 0.12;  // 提前排程的时间窗（秒）
  var START_DELAY = 0.06;     // 首步相对 currentTime 的启动延迟
  var TIMELINE_KEEP = 1.0;    // 保留最近 1 秒的排程记录

  /**
   * 延迟补偿上限，单位是「步长」。
   *
   * 未校准的 `outputLatency` 在蓝牙耳机上往往被高估到一整步以上，补偿满额
   * 就会让游标整整滞后一格。夹到半步之后，最坏情况也只是差半个格子，
   * 不会再出现「声音比游标早一格」这种一眼可见的错位。
   */
  var MAX_COMPENSATION = 0.5;

  /**
   * @param {Object} [opts]
   * @param {number[]} [opts.notes] 行 → 音高。缺省 CONFIG.NOTES（基准版 16 音）。
   *        大面板会传一张更长的表（见 src/large-config.js）。
   */
  function Sequencer(audio, grid, opts) {
    opts = opts || {};
    this.audio = audio;
    this.grid = grid;
    this.notes = opts.notes || CFG.NOTES;
    this.tempo = CFG.TEMPO;
    this.currentStep = 0;
    this.playing = false;
    this.nextStepTime = 0;
    this.timer = null;
    this.onStep = null;
    this.timeline = [];       // [{step, time}]，time 单调递增
    // 回环区间：[loopIn, loopOut]，**闭区间**，单位是列。缺省整圈。
    // 走到出点之后回到入点。区间比整圈短时，图案每转一圈就和自己的前半段
    // 错开几格 —— 静态图案因此会走成一条长旋律（polymeter），
    // 这是本项目最核心的「生成」玩法。
    this.loopIn = 0;
    var initCols = (global.TM.CONFIG && global.TM.CONFIG.INITIAL_LOOP_COLS) || grid.cols;
    this.loopOut = Math.min(grid.cols, initCols) - 1;
  }

  /** 把任意输入夹成合法列号 */
  Sequencer.prototype._clampStep = function (n, fallback) {
    var max = this.grid.cols - 1;
    n = parseInt(n, 10);
    if (isNaN(n)) n = fallback;
    if (n < 0) n = 0;
    if (n > max) n = max;
    return n;
  };

  /**
   * 设置回环区间（闭区间）。两端都夹到 [0, cols-1]，顺序反了自动交换。
   *
   * 当前步落到区间外时拉回入点：否则改完区间还要等一拍才「回来」，
   * 听起来像漏了一个音。
   */
  Sequencer.prototype.setLoop = function (a, b) {
    a = this._clampStep(a, 0);
    b = this._clampStep(b, this.grid.cols - 1);
    if (a > b) { var t = a; a = b; b = t; }

    this.loopIn = a;
    this.loopOut = b;

    if (this.currentStep < a || this.currentStep > b) this.currentStep = a;
    this.timeline.length = 0;      // 旧的反查记录已不对应新的回环
  };

  /**
   * 只改入点。越过出点时把出点一起推走 —— 用户在很远的地方按 I，
   * 意图显然是「从这儿开始」，静默夹住会让人以为快捷键没反应。
   */
  Sequencer.prototype.setLoopIn = function (n) {
    var a = this._clampStep(n, this.loopIn);
    if (a > this.loopOut) { this.setLoop(a, a); return; }
    this.setLoop(a, this.loopOut);
  };

  /** 只改出点。越过入点时把入点一起带回，理由同上。 */
  Sequencer.prototype.setLoopOut = function (n) {
    var b = this._clampStep(n, this.loopOut);
    if (b < this.loopIn) { this.setLoop(b, b); return; }
    this.setLoop(this.loopIn, b);
  };

  /** 区间包含多少列（含两端）。整圈时等于列数。 */
  Sequencer.prototype.loopSpan = function () {
    return this.loopOut - this.loopIn + 1;
  };

  /**
   * 开始 / 继续播放。
   *
   * **这里不能把 `currentStep` 归零。** 空格键与「播放」按钮都是「暂停 / 继续」
   * 语义，归零会让每次继续都从头重放（曾经就是这个 bug）。
   *
   * `currentStep` 天然就是「下一个待排的步」：
   *   - 构造函数里是 0 → **首次播放自然从头开始**，不需要在这里重置；
   *   - 播放中它指向下一步，`stop()` 只是停下计时器、不动它；
   *   - 于是 `start()` 接着往下排就是「继续」。
   * 以后若要「回到开头重新播」，把 `currentStep = 0` **单独**写成一个方法，
   * 别塞回 `start()` 里。
   */
  Sequencer.prototype.start = function () {
    if (this.playing || !this.audio.ready) return;
    this.playing = true;
    this.timeline.length = 0;
    this.nextStepTime = this.audio.ctx.currentTime + START_DELAY;

    var self = this;
    this.timer = setInterval(function () { self._tick(); }, LOOKAHEAD_MS);
    this._tick();
  };

  /**
   * 跳到指定步（鼠标点 / 拖时间轴标尺时用）。
   *
   * 只改「下一个待排的步」，**不去重建已经排进音频时钟的音符** —— 那些在未来
   * `SCHEDULE_AHEAD`（120ms）内还会照原样响完。为了拖动去 flush 音频图得不偿失
   * （会咔哒一声，还得重建整条延迟链），120ms 的尾巴可以接受。
   *
   * 暂停时只改步号；播放时顺手补排一步，让新位置马上生效。
   */
  Sequencer.prototype.seek = function (step) {
    // 允许停到区间外（拖动游标探索图案时有用）；播放时 _tick 会自愈回入点
    this.currentStep = this._clampStep(step, this.currentStep);
    this.timeline.length = 0;                           // 旧的反查记录已不对应新位置
    if (!this.playing) return;
    this.nextStepTime = this.audio.ctx.currentTime + START_DELAY;
    this._tick();
  };

  Sequencer.prototype.stop = function () {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  /**
   * 改速度。音频与视觉都从真实排程派生，因此这里不需要做任何重新对齐：
   * 之后新排的步用新步长，已排的步保持不变，视觉反查自然连续。
   */
  Sequencer.prototype.setTempo = function (bpm) {
    this.tempo = bpm;
    this.audio.setTempo(bpm);
  };

  Sequencer.prototype.stepDuration = function () {
    return global.TM.stepSeconds(this.tempo);
  };

  Sequencer.prototype._tick = function () {
    if (!this.playing) return;
    var ctx = this.audio.ctx;
    var stepDur = this.stepDuration();
    var horizon = ctx.currentTime + SCHEDULE_AHEAD;

    var guard = 0;
    while (this.nextStepTime < horizon && guard++ < 256) {
      // 当前步落在回环区间外（游标被拖出去了）时先带回入点，
      // 否则会把这个区间外的音也排进去 —— 听感上是「漏了一拍」。
      if (this.currentStep < this.loopIn || this.currentStep > this.loopOut) {
        this.currentStep = this.loopIn;
      }
      this._scheduleStep(this.currentStep, this.nextStepTime);
      this.nextStepTime += stepDur;
      // 绕回：走过出点就回到入点。曾经写死 % GRID，矩形网格下会在第 16 步
      // 提前归零，后半段永远播不到（test/large.html 有断言锁这条）。
      this.currentStep += 1;
      if (this.currentStep > this.loopOut) this.currentStep = this.loopIn;
    }

    // 丢弃已经过去的排程记录
    var cutoff = ctx.currentTime - TIMELINE_KEEP;
    while (this.timeline.length && this.timeline[0].time < cutoff) {
      this.timeline.shift();
    }
  };

  /**
   * 把某一列的所有音符排进音频时钟。
   * 对应 Sequencer.processTimedEvents 中的内层循环：扫描每一行。
   */
  Sequencer.prototype._scheduleStep = function (step, time) {
    for (var row = 0; row < this.grid.rows; row++) {
      if (this.grid.get(step, row)) {
        this.audio.synthNote(this.notes[row], time);
      }
    }
    this.timeline.push({ step: step, time: time });
    if (this.onStep) this.onStep(step, time);
  };

  /** 二分查找：音频时钟 t 时刻正在播放的步号；早于首步则返回 null */
  Sequencer.prototype.stepAtTime = function (t) {
    var tl = this.timeline;
    if (!tl.length || t < tl[0].time) return null;
    var lo = 0, hi = tl.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tl[mid].time <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return tl[best].step;
  };

  /**
   * 此刻「正从扬声器出来」的音频时钟位置（秒）。
   *
   * 视觉的播放头（画布高亮列 + 标尺游标）全部由它反查，所以这里选哪个时钟，
   * 直接决定「游标压到哪个格子时听到哪个音」。两个来源，按可靠性排序：
   *
   * 1. `getOutputTimestamp().contextTime` —— 规范里它的定义就是「输出设备正在
   *    播放的那一帧的音频时钟」，硬件缓冲与设备延迟都已经算在里面，不用我们再猜。
   * 2. 退路：`currentTime − 链路延迟`。`outputLatency` 在蓝牙设备上经常被高估
   *    （报的是设备缓冲，而不是真实听觉延迟），整整一格地滞后就是这么来的。
   *    所以这里把补偿**夹到半个步长以内**：宁可差半格，也不能差一整格 ——
   *    一格就是「游标还停在前一格，声音已经响了」，肉眼可见的错位。
   */
  Sequencer.prototype.audibleTime = function () {
    var ctx = this.audio.ctx;
    if (!ctx) return 0;
    var now = ctx.currentTime;

    // 1) 浏览器给出的「正在出声」时钟
    if (typeof ctx.getOutputTimestamp === 'function') {
      var ts = ctx.getOutputTimestamp();
      var t = ts && ts.contextTime;
      // 没有输出设备 / 时钟还没起步时会返回 0 或停在很久以前，那就不采用
      if (t > 0 && t <= now + 0.001 && now - t < TIMELINE_KEEP) return t;
    }

    // 2) 退路：写入头减延迟，补偿上限半个步长
    var lat = this.audio.outputLatency();
    var maxLat = this.stepDuration() * MAX_COMPENSATION;
    if (!(lat > 0)) lat = 0;
    if (lat > maxLat) lat = maxLat;
    return now - lat;
  };

  /**
   * 此刻「听得到」的步号。
   *
   * ctx.currentTime 是音频图的写入头；耳朵听到的位置要再退一个链路延迟，
   * 具体退多少由 audibleTime() 负责（见那里的说明）。
   */
  Sequencer.prototype.audibleStep = function () {
    if (!this.playing) return null;
    return this.stepAtTime(this.audibleTime());
  };

  global.TM.Sequencer = Sequencer;
})(window);
