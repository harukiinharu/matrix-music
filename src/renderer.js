/*
 * Matrix Music — 渲染器
 *
 * 三层合成：
 *   图层 1  格子底图（底 + 方块，按设备分辨率渲染）
 *   图层 2  播放列高亮（半透明竖条，可关）
 *   图层 3  微光（格子亮度包络 → 模糊 → 叠加，可关）
 *
 * 格子用两种纯色直接画，不做减淡合成：
 *   开 → COLORS.on，关 → COLORS.off（取值随明暗主题切换，见 src/theme.js）
 *
 * 微光层的混合模式也跟着主题走：
 *   深色主题用 lighter + 亮辉光；浅色主题用 multiply + 反相灰度
 *   （白底上提亮等于看不见，必须改成压暗）。
 *
 * **微光不是涟漪。** 早先这里跑的是二维波动场：点一下格子，光会一圈圈向外
 * 扩散。现在没有扩散 —— 播放到某一列时，那一列亮着的格子像灯泡一样瞬间亮起，
 * 然后在约 0.3 秒内衰减回原色，光只停在自己的格子里。见 stepGlow()。
 *
 * 分辨率策略：
 *   - 格子图层按设备分辨率渲染，保证方块边缘锐利（见 AGENTS.md §6）。
 *   - 微光图层不需要按设备分辨率渲染 —— 它本来就要被大半径模糊。
 *
 * 维度策略：网格尺寸全部取自 grid.cols / grid.rows，没有模块级的 N/CELL/SIZE。
 */
(function (global) {
  'use strict';

  var CFG = global.TM.CONFIG;

  // 微光低于这个值就直接归零，免得到处留下永远擦不掉的小数
  var GLOW_MIN = 1 / 255;

  /** opts 未提供时回落到 CONFIG —— 保留 test/perf.html 直接改 CONFIG 做 A/B 的用法 */
  function pick(v, fallback) {
    return (v === undefined || v === null) ? fallback : v;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} grid 需提供 cols / rows
   * @param {Object} [opts] 可选覆盖：cell / inset / radius / blurCell / blurGlow /
   *                        glowSize / hlInset / hlWidth
   */
  function Renderer(canvas, grid, opts) {
    opts = opts || {};

    this.canvas = canvas;
    this.grid = grid;

    // cols = **数据宽度**（能画到多远），viewCols = **视口宽度**（一次画多少列）。
    // 大面板的 cols 是一千多列，画布只画视口那一段 —— 2048px 已接近浏览器
    // 画布上限，32px 一列铺到 1024 列就是 32768px，整块画布根本建不出来。
    // 小面板两者相等（16），因此渲染路径与改造前逐位一致。
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.viewCol0 = 0;
    this.viewCols = Math.min(this.cols, Math.max(1, Math.round(
      (opts.viewCols === undefined || opts.viewCols === null) ? this.cols : opts.viewCols)));
    // 行 → 音高。格子颜色按八度分块，需要知道每一行是哪个音（见 _cellColor）
    this.notes = (opts.notes && opts.notes.length) ? opts.notes : (CFG.NOTES || []);

    this.cell = pick(opts.cell, CFG.CELL);
    this.inset = pick(opts.inset, CFG.CELL_INSET);
    this.radius = pick(opts.radius, CFG.CELL_RADIUS);
    this.blurCell = pick(opts.blurCell, CFG.BLUR_CELL);
    this.blurGlow = pick(opts.blurGlow, CFG.GLOW_BLUR);
    this.hlInset = pick(opts.hlInset, CFG.HIGHLIGHT_INSET);
    this.hlWidth = pick(opts.hlWidth, CFG.HIGHLIGHT_WIDTH);

    // ── 逻辑尺寸 = 视口尺寸（CSS 空间）──────────────────────
    this.w = this.viewCols * this.cell;
    this.h = this.rows * this.cell;

    // 设备像素比。格子图层按设备分辨率渲染，主画布绘制时再缩回逻辑坐标，
    // 这样位图与屏幕像素 1:1 对应，不会被浏览器二次重采样。
    this.scale = Math.min(global.devicePixelRatio || 1, 3);
    this.devW = Math.round(this.w * this.scale);
    this.devH = Math.round(this.h * this.scale);
    // 正方形网格下 devSize 即边长。test/selftest.html、sharp.html、perf.html
    // 都是拿它平方着取像素的，保留这个别名以免动到那些探针。
    this.devSize = this.devW;

    canvas.width = this.devW;
    canvas.height = this.devH;

    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    // ── 图层 1：格子底图（设备分辨率）─────────────────────
    this.patternLayer = makeCanvas(this.devW, this.devH);
    this.patternCtx = this.patternLayer.getContext('2d');

    // ── 图层 3：微光 ──────────────────────────────────────
    // 强度场用**绝对列**（rows × cols，覆盖整个数据宽度），平移画布时不用搬家；
    // 光晕图层只覆盖**视口**（viewCols × rows），否则宽度会跟着数据宽度涨。
    this.glowSmall = makeCanvas(this.viewCols, this.rows);
    this.glowSmallCtx = this.glowSmall.getContext('2d');
    this.glowImage = this.glowSmallCtx.createImageData(this.viewCols, this.rows);

    // 微光图层与画布同宽高比，放大后不会拉伸。
    // 每列占多少像素沿用改造前的口径（基准版 512/16 = 32，大面板 512/64 = 8），
    // 视口变宽时按同一密度放大，模糊的观感才不随窗口大小漂移。
    var baseSize = Math.round(pick(opts.glowSize, CFG.GLOW_SIZE));
    var baseCols = Math.min(this.cols, 64);
    this._glowBaseSize = baseSize;      // 换视口时按同一口径重算（见 _relayout）
    this._glowBaseCols = baseCols;
    this.glowW = Math.max(64, Math.round(baseSize / baseCols * this.viewCols));
    this.glowH = Math.round(this.glowW * this.rows / this.viewCols);
    this.glowBig = makeCanvas(this.glowW, this.glowH);
    this.glowBigCtx = this.glowBig.getContext('2d');

    // ── 微光强度场：每格一个 0..1 的亮度包络 ────────────────
    // 索引沿用 glow[行][列]。这里**没有**波动方程，也没有邻域耦合：
    // 一个格子的亮度只跟它自己被点亮的时刻有关，不会传染给旁边。
    this.glow = create2DMap(this.rows, this.cols);
    this._glowDirty = false;      // 上一帧图层里还有没有光（用于空闲时跳过重绘）

    this.loopIn = 0;               // 回环区间（闭区间，列号）
    // 初始回环宽度取 min(列数, INITIAL_LOOP_COLS)：大面板有 1024 列可画，
    // 但一上来就循环 1024 步，第一遍要播几分钟才回到起点。
    this.loopOut = Math.min(this.cols, CFG.INITIAL_LOOP_COLS || this.cols) - 1;
    this.showPlayhead = true;
    this.showGlow = true;         // 微光开关
    this.highlights = [];         // 右键试听的临时白色描边 [{col,row,until}]
    this.selection = null;        // 框选区域 {col0,row0,col1,row1}（已归一化）
    this.stepIndex = 0;

    this.grid.onChange(function (grid, action) {
      this.applyChange(action);
    }.bind(this));
    this.drawPattern();
  }

  // ────────────────────────────────────────────────────────
  // 格子底图
  // ────────────────────────────────────────────────────────

  /** 重绘整层。仅在启动、清空、以及开启模糊（局部重绘会不精确）时使用 */
  Renderer.prototype.drawPattern = function () {
    var c = this.patternCtx;

    // 离屏层不使用变换，尺寸与滤镜半径都用设备像素，避免 ctx.filter 的单位歧义
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(0, 0, this.devW, this.devH);

    this._applyCellFilter(c);
    // 只画视口内的列：一次最多 viewCols × rows 个格子（大面板约 80 × 48），
    // 比改造前固定画满 64 列还便宜。
    for (var i = 0; i < this.viewCols; i++) {
      var col = this.viewCol0 + i;
      for (var row = 0; row < this.rows; row++) this._paintCell(c, col, row);
    }
    c.filter = 'none';
  };

  /**
   * 只重绘一个格子。
   * 关闭模糊时，方块完全落在自己那一格里（inset > 0），因此局部重绘是精确的
   * —— 拖动涂抹时把它从「重绘所有方块」降到「重绘 1 个」。
   */
  Renderer.prototype.drawCell = function (col, row) {
    if (this.blurCell > 0) { this.drawPattern(); return; }   // 有模糊时局部重绘不精确
    var c = this.patternCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = 'none';
    this._paintCell(c, col, row);
  };

  /** 响应网格变化：点亮该格的微光 + 更新对应像素 */
  Renderer.prototype.applyChange = function (action) {
    if (action && action.type === 'set') {
      // 点格子时立刻亮一下：手指按下就该有反馈，不用等下一次播放。
      // 关闭微光时不点亮，否则重新打开会冒出一片积压的亮斑。
      if (this.showGlow) this.glow[action.row][action.col] = 1;
      this.drawCell(action.col, action.row);
    } else {
      this.drawPattern();          // clear 或未知动作 → 整层重绘
    }
  };

  /**
   * 在指定格子上套一圈白色描边，持续 ms 毫秒后自动消失。
   * 用于右键试听时告诉用户「我正在按这一格」。
   *
   * 注意：**只描边，不改填充**。曾经试过用微光做反馈，
   * 但那样会让暗格整体变亮，看起来像右键把格子状态改了（见 AGENTS.md §7）。
   */
  Renderer.prototype.flash = function (col, row, ms) {
    if (!this.grid.inBounds(col, row)) return false;
    this.highlights.push({
      col: col,
      row: row,
      until: nowMs() + (ms === undefined ? CFG.HIGHLIGHT_MS : ms)
    });
    return true;
  };

  /** 画并清理临时描边。描边落在格子的边距上，因此明格暗格都看得见 */
  Renderer.prototype._drawHighlights = function () {
    var list = this.highlights;
    if (!list.length) return;

    var now = nowMs();
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].until <= now) list.splice(i, 1);
    }
    if (!list.length) return;

    var ctx = this.ctx;
    var inset = this.hlInset;
    var side = this.cell - 2 * inset;
    var fade = CFG.HIGHLIGHT_MS * CFG.HIGHLIGHT_FADE;

    ctx.save();
    ctx.lineWidth = this.hlWidth;
    ctx.strokeStyle = CFG.COLORS.highlight;
    for (var j = 0; j < list.length; j++) {
      var h = list[j];
      var remain = h.until - now;
      var hx = h.col - this.viewCol0;
      if (hx < -1 || hx > this.viewCols) continue;
      ctx.globalAlpha = remain < fade ? Math.max(0, remain / fade) : 1;
      roundRect(ctx, hx * this.cell + inset, h.row * this.cell + inset, side, side, 4);
      ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * 画框选高亮：淡色填充 + 一圈描边。
   *
   * 画的是整个矩形（包含区域内的空格子），不是只给亮着的格子上色 ——
   * 移动 / 填充 / 删除都是对「这一块矩形」操作的，边界要看得见。
   * 描边取 2px 并内缩 1px，这样在任意整数 dpr 下都是偶数设备像素，不会糊。
   */
  Renderer.prototype._drawSelection = function () {
    var s = this.selection;
    if (!s) return;

    var ctx = this.ctx;
    // 视口坐标：选区两端都按 viewCol0 平移，超出视口的部分由画布自然裁掉
    var x = (s.col0 - this.viewCol0) * this.cell;
    var y = s.row0 * this.cell;
    var w = (s.col1 - s.col0 + 1) * this.cell;
    var h = (s.row1 - s.row0 + 1) * this.cell;

    ctx.save();
    ctx.fillStyle = CFG.COLORS.selectFill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = CFG.COLORS.select;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  };

  /**
   * 开关微光。
   * 关闭时把亮度场清零 —— 否则重新打开会冒出一片冻结的旧亮斑。
   */
  Renderer.prototype.setGlowEnabled = function (on) {
    this.showGlow = !!on;
    if (this.showGlow) return;

    for (var i = 0; i < this.rows; i++) this.glow[i].fill(0);
    this._glowDirty = false;
    var wb = this.glowBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.glowW, this.glowH);
  };

  Renderer.prototype._applyCellFilter = function (c) {
    c.filter = this.blurCell > 0
      ? 'blur(' + (this.blurCell * this.scale) + 'px)'
      : 'none';
  };

  Renderer.prototype._paintCell = function (c, col, row) {
    var sx = col - this.viewCol0;
    if (sx < 0 || sx >= this.viewCols) return;      // 视口外不画
    var S = this.scale;
    var step = this.cell * S;
    var x = sx * step;
    var y = row * step;
    var inset = this.inset * S;
    var side = (this.cell - 2 * this.inset) * S;

    // 先清成背景，再画方块（局部重绘时这一步保证旧状态被擦掉）
    c.fillStyle = CFG.COLORS.background;
    c.fillRect(x, y, step, step);

    // 颜色编码音区：每八度一个颜色（见 constants.js 的 buildOctavePalette）
    c.fillStyle = this._cellColor(row, this.grid.get(col, row) === true);
    roundRect(c, x + inset, y + inset, side, side, this.radius * S);
    c.fill();
  };

  // ────────────────────────────────────────────────────────
  // 微光：播放到哪一列，那一列的灯就亮起来
  // ────────────────────────────────────────────────────────

  /**
   * 推进一帧微光，并把它画进光晕图层。
   *
   * 行为是「灯泡」而不是「涟漪」：
   *   1. 播放到某一列时，那一列**亮着的**格子瞬间拉到满亮度；
   *   2. 之后每帧按 GLOW_DECAY 衰减，约 0.3 秒回到原色；
   *   3. **没有任何横向传播** —— 一个格子的光不会传染给邻居。
   * 所以画面是「一排灯逐个点亮」，而不是水面上的同心圆。
   *
   * 关于「当前列」：涟漪时代这条写错过（种子打在 stepIndex + 1，于是光标还压在
   * 前一格时右边那格就先亮，看起来像声音比游标早一格）。视觉与听觉必须同源。
   *
   * @param {number}  stepIndex 当前列
   * @param {boolean} [seed]    是否点亮当前列，默认 true。
   *        暂停时必须传 false：步号冻结时若继续点亮，同一格会被反复充能，
   *        画面会一直卡在「全亮」，看不出已经暂停。
   */
  /**
   * 某一行格色的「浅色版」，供 multiply 合成使用（只在浅色主题走这条路）。
   *
   * 为什么不直接用格色：直接把格色乘到白底上，光晕会浓得像一块颜料。
   * 往白里兑到 glowTintMix（默认 0.55）之后，白底只染出一层淡色，
   * 而格子乘上去仍然是「同一色相、更深更浓」—— 这才是灯泡该有的方向。
   *
   * 按行缓存：一行一次 hex 解析，之后每帧只是三次乘法。
   */
  Renderer.prototype._glowTintOf = function (row) {
    var cache = this._glowTints || (this._glowTints = []);
    var hit = cache[row];
    if (hit) return hit;

    var hex = this._cellColor(row, true);
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var k = CFG.COLORS.glowTintMix;
    if (k === undefined) k = 0.55;

    hit = [
      Math.round(r + (255 - r) * k),
      Math.round(g + (255 - g) * k),
      Math.round(b + (255 - b) * k)
    ];
    cache[row] = hit;
    return hit;
  };

  Renderer.prototype.stepGlow = function (stepIndex, seed) {
    if (seed === undefined) seed = true;

    var cols = this.cols;
    var rows = this.rows;
    var col = ((stepIndex % cols) + cols) % cols;
    var glow = this.glow;
    var decay = CFG.GLOW_DECAY;
    var data = this.glowImage.data;

    var gain = CFG.COLORS.glowGain === undefined ? 1 : CFG.COLORS.glowGain;
    // 两种表达，取决于这一层怎么合成：
    //   lighter（深色）→ 写灰度，加法提亮，单位元是黑
    //   multiply（浅色）→ 写本行格色的浅色版，乘法加深，单位元是白
    // 浅色下**不能**提亮：白底上提亮只会把格子洗白，颜色反而丢了。
    // 灯泡在亮纸上更像「颜色更浓、周围散出一圈同色光」，而不是「变淡」。
    var tinted = (CFG.COLORS.glowComposite === 'multiply');

    // 1) 先衰减：低于 1/255 直接归零，免得留下永远擦不掉的小数
    var lit = 0;
    for (var y = 0; y < rows; y++) {
      var gr = glow[y];
      for (var x = 0; x < cols; x++) {
        var v = gr[x] * decay;
        if (v < GLOW_MIN) v = 0;
        gr[x] = v;
        if (v > lit) lit = v;
      }
    }

    // 2) 点亮当前列里亮着的格子。空格子不给光 —— 空列走过时不该有亮斑。
    if (seed) {
      for (var r = 0; r < rows; r++) {
        if (this.grid.get(col, r)) { glow[r][col] = 1; lit = 1; }
      }
    }

    // 空闲时（暂停且已经暗透）直接返回：图层上一帧就被清空了，
    // 不必每帧再跑一次 putImageData + 模糊。全暗是本项目的常态。
    if (lit <= 0 && !this._glowDirty) return;
    this._glowDirty = lit > 0;

    // 3) 写进光晕图层（一格一个像素，之后统一放大 + 模糊）
    for (var gy = 0; gy < rows; gy++) {
      var grow = glow[gy];
      var tint = tinted ? this._glowTintOf(gy) : null;
      var gbase = this.viewCol0;
      for (var gx = 0; gx < this.viewCols; gx++) {
        var e = grow[gbase + gx];
        var p = (gy * this.viewCols + gx) * 4;
        if (tinted) {
          // 从白色往「本行格色的浅色版」插值：e=0 时是纯白（乘法的单位元，
          // 画面原样），e=1 时是那层浅色 —— 白底染出淡淡的光晕，
          // 格子本身则沿着自己的色相变深、变浓。
          var a = e * gain;
          if (a > 1) a = 1;
          data[p]     = 255 - ((255 - tint[0]) * a) | 0;
          data[p + 1] = 255 - ((255 - tint[1]) * a) | 0;
          data[p + 2] = 255 - ((255 - tint[2]) * a) | 0;
        } else {
          var g = e <= 0 ? 0 : (e * 255 * gain) | 0;
          if (g > 255) g = 255;
          data[p] = data[p + 1] = data[p + 2] = g;
        }
        data[p + 3] = 255;
      }
    }

    this.glowSmallCtx.putImageData(this.glowImage, 0, 0);

    // 最近邻放大到 glowW × glowH，再模糊 —— 那一圈柔光是**模糊**给的，
    // 不是靠格与格之间互相传能量传出来的
    var wb = this.glowBigCtx;
    wb.setTransform(1, 0, 0, 1, 0, 0);
    wb.clearRect(0, 0, this.glowW, this.glowH);
    // 有模糊半径时用 filter（柔和的圆晕）；关掉半径则退回双线性放大
    // （每个源像素放大成一格，边缘自带一格宽的过渡），别让它变成硬方块
    wb.imageSmoothingEnabled = !(this.blurGlow > 0);
    wb.filter = this.blurGlow > 0 ? 'blur(' + this.blurGlow + 'px)' : 'none';
    wb.drawImage(this.glowSmall, 0, 0, this.glowW, this.glowH);
    wb.filter = 'none';
  };

  // ────────────────────────────────────────────────────────
  // 每帧合成
  // ────────────────────────────────────────────────────────

  /**
   * 推进微光。调用方应按固定步长驱动（见 app.js），
   * 这样衰减速度与显示刷新率无关 —— 60Hz 与 120Hz 屏上一样长。
   * 暂停时传 seed = false，让已有的光自然暗下去。
   */
  Renderer.prototype.simulate = function (stepIndex, seed) {
    this.stepIndex = stepIndex;
    this.stepGlow(stepIndex, seed);
  };

  /** 只做图层合成，不推进微光 */
  Renderer.prototype.composite = function (stepIndex) {
    this.stepIndex = stepIndex;

    var ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.drawImage(this.patternLayer, 0, 0, this.w, this.h);

    if (this.showPlayhead) {
      // 可关闭的辅助指示：一条极淡的竖条标出当前播放列（在视口外就不画）
      var px = stepIndex - this.viewCol0;
      if (px >= 0 && px < this.viewCols) {
        ctx.fillStyle = CFG.COLORS.playhead;
        ctx.fillRect(px * this.cell, 0, this.cell, this.h);
      }
    }

    // 微光。混合模式由主题决定：深色 lighter，浅色 multiply。
    // 光晕层是柔和渐变，放大时开插值让过渡更顺
    if (this.showGlow) {
      ctx.globalCompositeOperation = CFG.COLORS.glowComposite || 'lighter';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.glowBig, 0, 0, this.w, this.h);
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 回环区间之外压暗 + 接缝画一条线：让「这几列不会播」一眼看得出来。
    // 放在辉光之后、框选之前 —— 它属于棋盘状态，但不该压住交互高亮。
    this._drawLoopBounds();

    // 框选高亮在辉光之上 —— 它是交互状态，不能被 ADD 辉光冲淡
    this._drawSelection();

    // 描边放在最上层，保证辉光不会把它冲淡
    this._drawHighlights();
  };

  /** 推进 + 合成（一次性调用，供测试与简单场景使用） */
  Renderer.prototype.render = function (stepIndex) {
    this.stepGlow(stepIndex);
    this.composite(stepIndex);
  };

  /**
   * 换视口：起始列 + 可见列数。大面板的横向平移就靠它（见 app.js 的 panTo）。
   *
   * **只改视口，不动数据。** 数据宽度 `this.cols` 是固定的（大面板 1024 列），
   * 视口只是往里看一眼 —— 所以平移不需要搬移任何音符。
   *
   * 可见列数变了才重建图层（画布与光晕缓冲尺寸依赖它）；只平移时仅重画格子层。
   */
  Renderer.prototype.setView = function (col0, viewCols) {
    var vc = Math.min(this.cols, Math.max(1, Math.round(viewCols || this.viewCols)));
    var c0 = Math.max(0, Math.min(
      Math.round(col0 === undefined ? this.viewCol0 : col0), this.cols - vc));

    if (vc !== this.viewCols) {
      this.viewCols = vc;
      this.viewCol0 = c0;
      this._relayout();
    } else {
      if (c0 === this.viewCol0) return;
      this.viewCol0 = c0;
    }
    this.drawPattern();
  };

  /** 视口尺寸变了：重建画布与依赖尺寸的图层 */
  Renderer.prototype._relayout = function () {
    this.w = this.viewCols * this.cell;
    this.h = this.rows * this.cell;
    this.devW = Math.round(this.w * this.scale);
    this.devH = Math.round(this.h * this.scale);
    this.devSize = this.devW;

    this.canvas.width = this.devW;          // 赋值会清空画布并重置变换
    this.canvas.height = this.devH;
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    this.patternLayer = makeCanvas(this.devW, this.devH);
    this.patternCtx = this.patternLayer.getContext('2d');

    // 光晕层按视口宽度重建：每列占多少像素沿用构造时的口径，模糊观感不漂移
    this.glowW = Math.max(64, Math.round(this._glowBaseSize / this._glowBaseCols * this.viewCols));
    this.glowH = Math.round(this.glowW * this.rows / this.viewCols);
    this.glowSmall = makeCanvas(this.viewCols, this.rows);
    this.glowSmallCtx = this.glowSmall.getContext('2d');
    this.glowImage = this.glowSmallCtx.createImageData(this.viewCols, this.rows);
    this.glowBig = makeCanvas(this.glowW, this.glowH);
    this.glowBigCtx = this.glowBig.getContext('2d');
    // 强度场是绝对列，不用搬；新图层先当作空的，等下一帧 stepGlow 重新写入
    this._glowDirty = false;
  };

  /**
   * 设置回环区间（闭区间，列号）。只影响合成层，不必重画格子图层。
   * 整圈时 _drawLoopBounds 什么都不画。
   */
  Renderer.prototype.setLoop = function (a, b) {
    var max = this.cols - 1;
    a = parseInt(a, 10);
    b = parseInt(b, 10);
    if (isNaN(a)) a = 0;
    if (isNaN(b)) b = max;
    if (a < 0) a = 0; else if (a > max) a = max;
    if (b < 0) b = 0; else if (b > max) b = max;
    if (a > b) { var t = a; a = b; b = t; }
    this.loopIn = a;
    this.loopOut = b;
  };

  /**
   * 画出回环区间：区间内铺一层极淡的高亮，两侧压暗，边界各一条竖线。
   * 整圈时直接返回 —— 那时不存在「区间外」，画了反而像bug。
   */
  Renderer.prototype._drawLoopBounds = function () {
    // 全部换算成**视口坐标**。回环端点可以远在屏幕外（大面板能画到一千多列），
    // 所以先和可见区间求交，再看两侧还要不要压暗。
    var v0 = this.viewCol0;
    var v1 = v0 + this.viewCols - 1;
    var a = this.loopIn;
    var b = this.loopOut;

    // 可见区整个落在回环里 → 没有「区间外」，什么都不画（= 改造前的「整圈」）
    if (a <= v0 && b >= v1) return;

    var ctx = this.ctx;
    var cell = this.cell;
    var a0 = Math.max(a, v0);          // 可见的交集
    var b1 = Math.min(b, v1);

    ctx.save();

    // 1) 区间内先铺一层极淡的高亮：光靠「两侧压暗」在浅色主题下不够明显，
    //    两边一齐下手，「中间亮、两边暗」才读得出来
    if (b1 >= a0) {
      ctx.fillStyle = CFG.COLORS.loopBand;
      ctx.fillRect((a0 - v0) * cell, 0, (b1 - a0 + 1) * cell, this.h);
    }

    // 2) 两侧压暗
    ctx.fillStyle = CFG.COLORS.outOfLoop;
    if (a > v0) ctx.fillRect(0, 0, (a - v0) * cell, this.h);
    if (b < v1) ctx.fillRect((b + 1 - v0) * cell, 0, this.w - (b + 1 - v0) * cell, this.h);

    // 3) 入点 / 出点各一条竖线（出点画在区间右边界上）
    ctx.fillStyle = CFG.COLORS.loopEdge;
    if (a > v0) ctx.fillRect((a - v0) * cell - 0.5, 0, 1, this.h);
    if (b < v1) ctx.fillRect((b + 1 - v0) * cell - 0.5, 0, 1, this.h);

    ctx.restore();
  };

  /**
   * 明暗主题切换后调用：底图按新配色整层重画，再合成当前帧。
   * 微光不清零 —— 切主题时正在暗下去的光应该继续，不该突然消失。
   */
  Renderer.prototype.refresh = function () {
    this._glowTints = null;          // 配色变了，按行缓存的微光色也要重算
    this.drawPattern();
    this.composite(this.stepIndex);
  };

  // ────────────────────────────────────────────────────────

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now()
      : Date.now();
  }

  function create2DMap(rows, cols) {
    var m = new Array(rows);
    for (var i = 0; i < rows; i++) {
      m[i] = new Float64Array(cols);
    }
    return m;
  }

  function makeCanvas(w, h) {
    var c = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : global.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /**
   * 格子颜色：按**八度**取，不按行取。
   *
   * 行 → 音高（this.notes）→ MIDI 八度号（note / 12 取整）→ 调色板下标。
   * 所以同一个八度内的所有格子同色，16 行与 48 行面板里同一个音高也同色。
   * 配色表缺失时回落到单色 on / off（老测试可能只改那两个值）。
   */
  Renderer.prototype._cellColor = function (row, on) {
    var list = on ? CFG.COLORS.octaveOn : CFG.COLORS.octaveOff;
    var fallback = on ? CFG.COLORS.on : CFG.COLORS.off;
    if (!list || !list.length) return fallback;

    var note = this.notes && row < this.notes.length ? this.notes[row] : (this.rows - 1 - row);
    var o = Math.floor(note / 12);
    if (o < 0) o = 0;
    else if (o > list.length - 1) o = list.length - 1;
    return list[o];
  };

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  global.TM.Renderer = Renderer;
})(window);
