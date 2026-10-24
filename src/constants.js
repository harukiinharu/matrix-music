/*
 * Matrix Music — 常量与派生量
 *
 * 音频与视觉的全部数值集中在这里，改之前请先读 AGENTS.md §5。
 */
(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────
  // 音高配色：每八度一个颜色
  // ────────────────────────────────────────────────────────
  //
  // 格子颜色不是装饰，它编码**音区**：同一个八度里的所有格子是同一个颜色，
  // 换一个八度就换一档。于是图案读起来是几条色带 —— 哪一段在高音区、
  // 哪一段沉在低音区，一眼就分得开。
  //
  // 为什么按八度而不是按行做连续渐变：连续渐变在 48 行面板上会糊成一片，
  // 相邻行差半个色号，眼睛分辨不出来，等于没编码；八度是音乐里真实的分层单位，
  // 按它切块才有意义，而且块数不多（16 行 4 块、48 行 5 块），看着干净。
  //
  // 颜色按 **MIDI 八度号**（note / 12 取整）取，不是按行号 ——
  // 于是同一个音高在 16 行与 48 行面板里永远是同一个颜色。
  //
  // 整族保持在「青 → 蓝 → 紫」这一段，不跨越整个色环，界面才不会像玩具。
  // 除格子之外的元素（播放列、试听描边、框选、微光）一律走中性灰，
  // 保证「有颜色的东西 = 有音的东西」这条视觉语法不被破坏。
  var OCTAVE_MIN = 0;
  var OCTAVE_MAX = 10;           // MIDI 八度 0..10 足够覆盖所有面板

  var OCTAVE_SPEC = {
    dark: {
      refOctave: 5, hueAtRef: 202, hueStep: 24,   // 每高一个八度 +24°：青 → 蓝 → 紫
      sat: 58,
      lightAtRef: 62, lightStep: 3,               // 越高越亮一点，块与块更有层次
      offSat: 26, offLight: 11                    // 未点亮的格子：同色相，压到几乎看不见
    },
    light: {
      refOctave: 5, hueAtRef: 204, hueStep: 22,
      sat: 56,
      lightAtRef: 48, lightStep: 1,
      offSat: 40, offLight: 91                    // 未点亮的格子：同色相，极淡但留一点彩度
    }
  };

  /** HSL → #RRGGBB。h 用度，s / l 用百分比。 */
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100;
    l /= 100;

    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;

    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }

    function part(v) {
      var n = Math.round((v + m) * 255);
      if (n < 0) n = 0; else if (n > 255) n = 255;
      return (n < 16 ? '0' : '') + n.toString(16);
    }
    return '#' + part(r) + part(g) + part(b);
  }

  /** 音高 → MIDI 八度号（60 = C4 那一套） */
  function octaveOf(note) {
    return Math.floor(note / 12);
  }

  /**
   * 生成「每八度一个颜色」的调色板。
   * @param {Object} spec OCTAVE_SPEC.dark / .light
   * @returns {{on: string[], off: string[]}} **下标就是 MIDI 八度号**（0..10）
   */
  function buildOctavePalette(spec) {
    var on = [], off = [], o, hue;

    for (o = OCTAVE_MIN; o <= OCTAVE_MAX; o++) {
      hue = spec.hueAtRef + (o - spec.refOctave) * spec.hueStep;
      on.push(hslToHex(hue, spec.sat,
        spec.lightAtRef + (o - spec.refOctave) * spec.lightStep));
      off.push(hslToHex(hue, spec.offSat, spec.offLight));
    }
    return { on: on, off: off };
  }

  // 深色主题的配色同时充当「无主题脚本」时的兜底（test/selftest.html 就走这条）
  var DARK_OCTAVES = buildOctavePalette(OCTAVE_SPEC.dark);

  var CONFIG = {
    // ── 音频 ──────────────────────────────────────────────
    SAMPLE_RATE: 44100,          // 基准版 SampleDataEvent 采样率
    TEMPO: 120,                  // BPM，AudioEngine 默认值
    INITIAL_LOOP_COLS: 64,       // 初始回环宽度（列）。大面板数据宽 1024，
                                 // 但不能一上来就循环 1024 步 —— 取 min(列数, 这个值)
    VOLUME: 85,                  // 音量（百分比），滑块与 AudioEngine 共用
    RESOLUTION: 16,              // 每小节 16 步（Sequencer.RESOLUTION）
    NOTE_SECONDS: 22050 / 44100, // 音符时长 0.5 s（playEvent 中 _length = 22050）
    ENV_PEAK: 0.4,               // 包络线性峰值，平方后为 0.16
    MAX_VOICES: 128,             // VoiceStack 容量

    // ── 网格与视觉 ────────────────────────────────────────
    GRID: 16,                    // 16 × 16
    CELL: 32,                    // 每格像素
    CELL_INSET: 3,               // 方块相对格子的内缩
    CELL_RADIUS: 2,              // 方块圆角

    // 模糊半径。离屏图层按设备分辨率渲染，因此这里统一用「设备像素」，
    // 不再随 DPI 缩放 —— 这样 retina 屏上边缘锐利，且与 1x 屏观感一致。
    //
    // BLUR_CELL = 0 表示方块边缘不做任何柔化，纯平直角（当前设定）。
    // 若改成 3px 作用在 512 逻辑空间，在 2x 屏上会变成 6 设备像素并填满
    // 6px 的格子间隙，整体就糊了。
    BLUR_CELL: 0,
    // ── 微光：播放到某一列时，那一列的格子像灯泡一样亮起来 ──
    // 注意这里**没有**扩散系数：早先的二维波动场（邻域求和 + 阻尼）已经删除。
    GLOW_BLUR: 12,               // 光晕柔化半径（逻辑分辨率上的 px）
    GLOW_SIZE: 512,              // 光晕图层边长（逻辑分辨率，够用且省 4 倍面积）
    GLOW_DECAY: 0.9,             // 每帧衰减系数（60fps → 半衰约 110ms，约 0.4s 收干净）

    // 右键试听时套在那一格上的描边（只是描边，不改填充 —— 见 AGENTS.md §7）
    HIGHLIGHT_MS: 280,           // 持续时间
    HIGHLIGHT_INSET: 1.2,        // 相对格子边缘的内缩（逻辑像素）
    HIGHLIGHT_WIDTH: 1.6,        // 线宽（逻辑像素）
    HIGHLIGHT_FADE: 0.4,         // 末段淡出所占比例

    // ── 配色 ──────────────────────────────────────────────
    // 这里是**深色主题**的取值，同时也是无主题脚本时的兜底（test/selftest.html
    // 不加载 theme.js，就靠这份默认值跑）。浅色主题由 src/theme.js 原地覆盖。
    COLORS: {
      background: '#07090C',

      // **下标 = MIDI 八度号**（0..10）。同一个音高在 16 行与 48 行面板里
      // 永远取到同一个颜色 —— 这是按八度上色、而不是按行上色的关键好处。
      octaveOn: DARK_OCTAVES.on,
      octaveOff: DARK_OCTAVES.off,
      // 单色回退：配色表缺失时才用到（测试里可能只改 on/off）
      on: DARK_OCTAVES.on[5],
      off: DARK_OCTAVES.off[5],

      // 框选高亮刻意保持**无彩色**：界面里只有格子带色相，交互状态一律中性，
      // 这样框选不会和高音格的蓝绿糊在一起。
      select: '#FFFFFF',
      selectFill: 'rgba(255, 255, 255, 0.12)',

      // 播放列高亮 + 右键试听描边
      playhead: 'rgba(255, 255, 255, 0.06)',
      highlight: '#FFFFFF',

      // 回环区间：区间内一层极淡的高亮，区间外压暗，两条边界线。
      // 都在中性色里取，不跟格子色相抢注意力
      loopBand: 'rgba(255, 255, 255, 0.045)',
      outOfLoop: 'rgba(7, 9, 12, 0.66)',
      loopEdge: 'rgba(255, 255, 255, 0.45)',

      // 微光的合成方式：深色 lighter（加法提亮）；浅色 multiply + 浅色版格色
      // （颜色变浓，而不是变白）。只有 multiply 那条路会读 glowTintMix。
      glowComposite: 'lighter',
      glowGain: 1,                // 亮度系数
      glowTintMix: 0.30           // 浅色主题：格色往白里兑多少（0 = 原色，1 = 纯白）
    },

    // ── 音阶：Sequencer.NOTES（行 0 音最高）────────────────
    NOTES: [96, 93, 91, 89, 86, 84, 81, 79, 77, 74, 72, 69, 67, 65, 62, 60]
  };

  /** 与 playEvent 的 `440 * 2^(note/12 - 6)` 完全等价 */
  function noteToFrequency(note) {
    return 440 * Math.pow(2, (note - 72) / 12);
  }

  /** 一小节秒数：enterFrame 里 240000/tempo 是毫秒 */
  function barSeconds(tempo) {
    return (240000 / tempo) / 1000;
  }

  /** 单步秒数 */
  function stepSeconds(tempo) {
    return barSeconds(tempo) / CONFIG.RESOLUTION;
  }

  /**
   * 包络曲线：amp(t) = (0.4 · (1 - t/T))²   —— processAdd 里的 env*env
   * 返回 Float32Array，供 GainNode.setValueCurveAtTime 使用。
   */
  function buildEnvelopeCurve(points) {
    points = points || 96;
    var curve = new Float32Array(points);
    for (var i = 0; i < points; i++) {
      var linear = CONFIG.ENV_PEAK * (1 - i / (points - 1));
      curve[i] = linear * linear;          // 平方，和基准版一致
    }
    curve[points - 1] = 0;
    return curve;
  }

  // ────────────────────────────────────────────────────────
  // 运行时网格配置
  // ────────────────────────────────────────────────────────
  //
  // 基准版是 16×16 的正方形网格，CONFIG.GRID 一个数同时充当「列数」和「行数」。
  // 这里把维度单独抽出来，让同一套引擎能跑不同规格的面板（见 large.html）。
  //
  // **缺省值等于基准版**，所以不传参数构造出来的东西与改造前逐位一致 ——
  // test/selftest.html 的 71 项断言全部建立在这个前提上。
  //
  // 另外几个可调项（inset / radius / blurCell / blurGlow / glowSize / hl*）
  // 刻意**不在这里给默认值**：缺省一律回落 CONFIG.*，因为 test/perf.html 会
  // 直接改 CONFIG 做 A/B，把值抄进这里会让它失效。
  var RUNTIME = {
    id: 'small',            // 面板身份，只用于 localStorage 的键（见 storage.js）
    cols: CONFIG.GRID,      // 时间步数（一圈走多少步）
    rows: CONFIG.GRID,      // 音高行数
    cell: CONFIG.CELL,      // 格子边长（逻辑像素）
    notes: CONFIG.NOTES     // 行 → 音高，长度必须等于 rows
  };

  // ── 音阶 ───────────────────────────────────────────────
  // 写成「相对 A 的半音偏移」的升序数组（音高编号里 72 = A）。
  //
  // 基准版是 **D 大调五声** D E F# A B。放到 D 大调里看它正好是 1 2 3 5 6 级，
  // 缺的是**第 4 音 G 与第 7 音 C#** —— 补回这两个就是完整的 D 大调七声。
  // 大面板要的就是补全后的那张（见 src/large-config.js）。
  var SCALES = {
    pentatonic: [0, 2, 5, 7, 9],                 // A B D  E F#      （= 基准版规格）
    major:      [0, 2, 4, 5, 7, 9, 10],         // A B C# D E F# G  （五声补上 4、7 级）
    chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]  // 半音阶：相邻行差 1 个半音
  };

  /**
   * 从 topNote 起**逐级下行**，生成 rows 个音的行表（行 0 最高）。
   *
   * 用「逐级下行」而不是按固定音程展开，是为了让音阶可换：换 `scale` 数组
   * 即换音阶，行数与音域都不用动。
   *
   * `buildScaleTable(16, CONFIG.NOTES[0], SCALES.pentatonic)` 应当**逐位复现
   * 基准版 CONFIG.NOTES** —— test/large.html 拿这条校验生成器本身没写错。
   *
   * @param {number}   rows    行数
   * @param {number}   topNote 行 0 的音（必须在音阶内）
   * @param {number[]} scale   音阶相对 A 的半音偏移，升序
   */
  function buildScaleTable(rows, topNote, scale) {
    var last = scale.length - 1;
    var out = [topNote];
    var n = topNote;
    var i, p, idx;

    for (i = 1; i < rows; i++) {
      p = ((n - 72) % 12 + 12) % 12;             // 取模后落到 [0, 12)
      idx = scale.indexOf(p);
      if (idx < 0) {
        throw new Error('buildScaleTable: 音 ' + n + ' 不在音阶里（起手音 ' + topNote + '）');
      }
      // 退到低一级；若已经是本级最低音，就跨回上一个八度
      n -= (idx > 0) ? (scale[idx] - scale[idx - 1]) : (12 + scale[0] - scale[last]);
      out.push(n);
    }
    return out;
  }

  global.TM = global.TM || {};
  global.TM.CONFIG = CONFIG;
  global.TM.RUNTIME = RUNTIME;
  global.TM.SCALES = SCALES;
  global.TM.buildScaleTable = buildScaleTable;
  global.TM.noteToFrequency = noteToFrequency;
  global.TM.barSeconds = barSeconds;
  global.TM.stepSeconds = stepSeconds;
  global.TM.buildEnvelopeCurve = buildEnvelopeCurve;
  global.TM.OCTAVE_SPEC = OCTAVE_SPEC;
  global.TM.buildOctavePalette = buildOctavePalette;
  global.TM.octaveOf = octaveOf;
  global.TM.hslToHex = hslToHex;
})(window);
