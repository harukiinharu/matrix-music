/*
 * Matrix Music — 应用装配与交互
 *
 * 把 grid / audio / sequencer / renderer 四件套组装起来，绑定指针与键盘交互。
 * 渲染驱动走 requestAnimationFrame；明暗主题由 TM.Theme 维护。
 */
(function (global) {
  'use strict';

  var TM = global.TM;
  var CFG = TM.CONFIG;
  var RUNTIME = TM.RUNTIME;

  var grid, audio, sequencer, renderer;
  var canvas;

  // ── 乐谱保存 ────────────────────────────────────────────
  var SAVE_DEBOUNCE_MS = 300;      // 拖动时会连发变更，攒一下再写
  var saveTimer = null;
  var shareBtn, shareRow, shareCode, shareStatus;

  // ── 播放位置标尺 ────────────────────────────────────────
  var ruler, rulerCursor;
  var rulerBand, rulerDimL, rulerDimR, rulerInHandle, rulerOutHandle;
  var scrubbing = false;
  var rulerStep = -1;              // 上一帧画过的步号，避免每帧都写样式

  function init() {
    canvas = document.getElementById('matrix');

    // 明暗主题：theme.js 只负责定义、不自动执行，这里解析出当前调色板。
    // 必须在构造 Renderer 之前 —— 它的构造函数会按 CFG.COLORS 画一遍底图。
    if (TM.Theme) TM.Theme.init();

    // 维度、格子尺寸、音表全部来自 TM.RUNTIME：
    // index.html 用缺省值（16×16），large.html 由
    // src/large-config.js 覆盖成 48 行 × 64 列。
    grid = new TM.Grid(RUNTIME);
    audio = new TM.AudioEngine();
    sequencer = new TM.Sequencer(audio, grid, RUNTIME);

    // 视口列数：基准版 = 数据宽度（16 列，等于改造前铺满整块画布）；
    // 大面板按容器宽算 —— 数据有 1024 列，画布只渲染看得见的那一段。
    RUNTIME.viewCols = viewColsFor(document.querySelector('.canvas-wrap'));
    renderer = new TM.Renderer(canvas, grid, RUNTIME);
    sizeCanvas();

    // 系统明暗切换时重画底图与当前帧（微光不清零，正在暗下去的光继续）
    if (TM.Theme) {
      TM.Theme.onChange(function () { renderer.refresh(); });
    }

    bindInput();
    bindControls();
    bindRuler();
    bindPan();
    buildPresets();
    syncPlayButton();          // 还没播放，按钮应该写着「播放」

    // 先载入乐谱，**再**挂自动保存 —— 否则载入本身会立刻回写一遍存储。
    // 优先级：URL hash（分享链接）> localStorage（本机自动存档）。
    // 回环区间现在是代码的一部分，所以不再单独恢复：载入时由 applyParams 套上。
    restoreScore();
    // ?demo=<id> 优先级最高：显式打开某个示例，就压过本机存档
    loadDemoFromUrl();
    // 载入的代码里可能没有回环（旧格式），也可能压根没有存档：
    // 这里按音序器当前值把标尺 / 画布 / 把手同步一次，别让它们停在初始空白。
    applyLoop(sequencer.loopIn, sequencer.loopOut, { silent: true });
    grid.onChange(projectChanged);
    // 用户一动笔就不是示例了 —— 让 chip 褪掉，别谎报「现在放的是卡农」。
    // 载入示例自己也会触发这里，随后 loadPreset 再重新标记，顺序不受影响。
    grid.onChange(function () { if (activePreset >= 0) markPreset(-1); });

    // 关页面时把还没落盘的那次改动补上（防抖窗口内退出会丢）
    global.addEventListener('pagehide', flushSave);

    // 仅在 ?debug=1 时暴露内部句柄，供自动化测试直接读模型状态。
    // 测试不应依赖渲染后的像素 —— 无头环境里 rAF 与定时器的推进节奏不一致，
    // 像素采样必然不稳定。生产环境不带该参数时不会挂任何全局变量。
    if (/[?&]debug=1/.test(global.location.search)) {
      global.__matrixMusicDebug = {
        grid: grid,
        audio: audio,
        sequencer: sequencer,
        renderer: renderer
      };
    }

    requestAnimationFrame(loop);
  }

  // ── 启动（浏览器要求先有用户手势才能出声）─────────────────
  //
  // 浏览器规定：AudioContext 必须在**用户手势**里才能从 suspended 转成 running。
  // 这不是我们能绕过的，也没必要绕 —— 这个页面上几乎每个动作本身就是手势：
  // 点格子、拖游标、按空格、点播放，都会顺手调 boot()。
  //
  // 所以**没有启动遮罩**。遮罩时代的做法是「先拦一次点击、只解锁不出声」，
  // 结果每次刷新都要多点一下才能碰棋盘，而且那一层半透明还会盖住谱子 ——
  // 挡住的恰恰是这个作品最该被第一眼看到的东西。删掉之后，「第一次点击」
  // 本身就完成了两件事：解锁音频 + 用户本来想做的那个动作。
  /**
   * 音频**真的**在跑吗？
   *
   * 不能拿「调过 start 没有」当判据：`AudioEngine.ready` 在建图时就置真了，
   * 而那时还没 `resume()`。resume 一旦被自动播放策略挂住，上下文会一直停在
   * `suspended` —— 之后再点也永远不重试。所以每次都问上下文自己的状态。
   */
  function audioLive() {
    return !!(audio.ctx && audio.ctx.state === 'running');
  }

  /**
   * 解锁音频。**只出声不出音** —— 不会自己放起来，
   * 想立刻听到，用 `togglePlayback()`（播放按钮 / 空格）。
   */
  function boot() {
    if (audioLive()) return Promise.resolve();
    return audio.start().then(function () {
      sequencer.setTempo(readTempo());
      syncPlayButton();
    }).catch(function (err) {
      // 启动失败（例如被自动播放策略拦下）时允许下次手势重试 —— 闸门是
      // audioLive()，它读的是上下文自己的状态，所以下次点击会自然重试。
      // 同时避免抛出未处理的 Promise 拒绝。
      if (global.console) global.console.warn('音频启动失败：', err);
    });
  }

  // ── 播放控制 ────────────────────────────────────────────
  // 按钮与空格键共用这一对函数，状态以 sequencer.playing 为准，
  // 避免两处各自维护一个布尔量而不同步。
  function togglePlayback() {
    if (!audioLive()) {
      // 还没出声（第一次点，或上下文被系统挂起了）：先解锁，解锁完**真的开始播**
      // —— 用户点的就是播放。这条也是「上下文被挂起」的自愈路径：
      // 切回标签页、蓝牙重连之后按一下播放就能恢复，不必刷新。
      boot().then(function () {
        if (!sequencer.playing) sequencer.start();
        syncPlayButton();
      });
      return;
    }
    if (sequencer.playing) sequencer.stop(); else sequencer.start();
    syncPlayButton();
  }

  function syncPlayButton() {
    var btn = document.getElementById('btn-toggle');
    if (btn) btn.textContent = sequencer.playing ? '暂停' : '播放';
  }

  // ── 显示开关 ────────────────────────────────────────────
  // 状态一律以 renderer 上的字段为准，按钮外观由这里派生，避免两处不同步。
  function syncToggle(id, on) {
    var btn = document.getElementById(id);
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setGlow(on) {
    renderer.setGlowEnabled(on);
    syncToggle('btn-glow', renderer.showGlow);
  }

  function setPlayhead(on) {
    renderer.showPlayhead = !!on;
    syncToggle('btn-playhead', renderer.showPlayhead);
  }

  // ── 视口与横向平移 ─────────────────────────────────────
  //
  // 大面板的数据宽度远大于视口（1024 列 vs 一屏约 80 列），所以画布只渲染
  // 可见的那一段，横向平移 = 改 `renderer.viewCol0`（见 renderer.setView）。
  //
  // **没有横向滚动条** —— 数据宽 1024 列，滚动条长度只能是编的，编了就是假。
  // 改成画布式手势：触控板横滑 / Shift+滚轮 / 中键拖动 / 画到边缘自动平移 /
  // 播放时跟随播放头。纵向仍然是原生滚动（48 行装不进屏幕）。
  var panHoldUntil = 0;        // 手动平移后短暂停止跟随播放头，别跟用户抢方向盘
  var resizeTimer = null;

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : new Date().getTime();
  }

  /** 视口能放多少列 */
  function viewColsFor(el) {
    if (!RUNTIME.scrollX) return grid.cols;         // 基准版：定宽，行为不变
    var avail = (el && el.clientWidth) || global.innerWidth || 1024;
    // 向下取整：ceil 会让画布比容器宽最多一整格，右边缘被 overflow 裁掉一条。
    // 取整后右侧可能剩不到一格的空白，那是棋盘底色，看不出来。
    return Math.max(8, Math.min(grid.cols, Math.floor(avail / RUNTIME.cell)));
  }

  /** 把视口尺寸同步到画布样式与 CSS 变量 */
  function sizeCanvas() {
    canvas.style.width = renderer.w + 'px';
    canvas.style.height = renderer.h + 'px';
    var root = global.document.documentElement;
    root.style.setProperty('--board-w', renderer.w + 'px');
    root.style.setProperty('--board-h', renderer.h + 'px');
    // 标尺游标的宽度靠它算（CSS: calc(100% / var(--cols))）
    root.style.setProperty('--cols', renderer.viewCols);
  }

  /**
   * 把视口移到某一列。
   * @param {number} col0  目标起始列
   * @param {boolean} [auto] 播放跟随触发的，不设置「暂停跟随」
   * @returns {boolean} 是否真的移动了
   */
  function panTo(col0, auto) {
    if (!RUNTIME.scrollX) return false;
    var vc = renderer.viewCols;
    var target = Math.max(0, Math.min(Math.round(col0), grid.cols - vc));
    if (target === renderer.viewCol0) return false;

    renderer.setView(target, vc);
    if (!auto) panHoldUntil = nowMs() + 2500;
    rulerStep = -1;
    paintRulerLoop();
    syncRuler(currentColumn());
    // 这里**不**调 composite：主循环每帧都会合成，多调一次等于白画一次
    // （实测合成一帧 1376×1536 要 9.4ms，滚轮事件比帧还密时直接拖垮手感）。
    return true;
  }

  function panByCols(dc, auto) { return panTo(renderer.viewCol0 + dc, auto); }

  function bindPan() {
    if (!RUNTIME.scrollX) return;
    var frame = document.querySelector('.board-frame') ||
                document.querySelector('.canvas-wrap') || canvas;

    // 触控板横滑（deltaX）/ Shift+滚轮。纯纵向的滚轮放行给原生纵向滚动。
    frame.addEventListener('wheel', function (e) {
      var dx = e.deltaX;
      if (e.shiftKey && Math.abs(dx) < Math.abs(e.deltaY)) dx = e.deltaY;
      if (!dx) return;
      if (!e.shiftKey && Math.abs(dx) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      panByCols(Math.round(dx / renderer.cell));
    }, { passive: false });

    // 中键拖动 = 抓手平移（鼠标用户的通用手势）
    var grab = null;
    frame.addEventListener('pointerdown', function (e) {
      if (e.button !== 1) return;
      e.preventDefault();
      grab = { x: e.clientX, col0: renderer.viewCol0 };
      if (frame.setPointerCapture) {
        try { frame.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    });
    global.addEventListener('pointermove', function (e) {
      if (!grab) return;
      panTo(grab.col0 - Math.round((e.clientX - grab.x) / renderer.cell));
    });
    global.addEventListener('pointerup', function () { grab = null; });
    global.addEventListener('pointercancel', function () { grab = null; });

    // 窗口尺寸变了要重算视口列数（画布尺寸跟着变）
    global.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        var vc = viewColsFor(document.querySelector('.canvas-wrap'));
        renderer.setView(renderer.viewCol0, vc);
        sizeCanvas();
        rulerStep = -1;
        paintRulerLoop();
        syncRuler(currentColumn());
      }, 120);
    });
  }

  /**
   * 涂抹 / 框选拖到视口边缘时继续平移 —— 无限画布的关键手感：
   * 不用松手、不用滚轮，一直往右拖就一直画。
   *
   * 判据是「有没有按住」（`press`），不是 `dragMode`：画笔在按下那一刻就落笔了，
   * 根本不进 `dragMode`，但它同样需要贴着边缘继续画。
   */
  function autoPanAtEdge(e) {
    if (!RUNTIME.scrollX || !press) return;
    var r = canvas.getBoundingClientRect();
    var edge = Math.max(24, renderer.cell * 1.2);
    if (e.clientX > r.right - edge) panByCols(1);
    else if (e.clientX < r.left + edge) panByCols(-1);
  }

  // ── 交互 ────────────────────────────────────────────────
  //
  // 落笔与音频启动解耦：格子的增删不等 AudioContext 就绪。
  //
  // **左键 = 画笔，右键 = 选择。** 一个键只做一件事：
  // 左键管音符（点开、点关、按住拖画一整条 / 按住拖擦一整条），
  // 右键管选区（单击选一格、拖动框一片）。两条路互不干扰，
  // 所以不像上一版那样需要靠「按下 / 松手」去猜意图 ——
  // 左键按下就能落笔，画一笔的手感是立刻的。
  function bindInput() {
    var rect = null;          // 缓存的画布矩形，避免每次 pointermove 都触发重排
    // 拖动状态（press / dragMode / move*）声明在模块级 —— 见文件下方「指针意图」
    // 那段注释：applyMove() 定义在 bindInput 外面，声明在这里它就看不见了。

    canvas.addEventListener('pointerdown', function (e) {
      // 只认左键（0）和右键（2）。中键留给 bindPan 的抓手平移，
      // 这里不 preventDefault 就是为了让它继续冒泡上去。
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      rect = canvas.getBoundingClientRect();
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      var cell = cellAt(e, rect);
      if (!cell) return;
      boot();                          // 点击本身就是用户手势，顺手解锁音频

      // ── 右键：只做选区 ──────────────────────────────────
      if (e.button === 2) {
        press = { cell: cell, mode: 'select', moved: false };
        setSelection(cell, cell);      // 单击 = 选中这一格；拖出去再扩成一片
        return;
      }

      // ── 左键：画笔 ──────────────────────────────────────
      //
      // 按在**已有选区里面**是唯一的例外：那是「整块搬走」的起手式
      // （按住 Alt 则是复制一份、原件留在原地）。
      // 代价是选区里画不了线 —— 想画先按 Esc 或点画布外把选区撤掉。
      // 这条与图形软件「按住已选中的对象拖动」一致，也是上一版定下的规则。
      if (renderer.selection && inSelection(cell)) {
        press = { cell: cell, mode: 'block', moved: false, alt: !!e.altKey };
        moveBase = grid.cells.slice();
        moveFrom = cell;
        moveRect = renderer.selection;
        moveDc = 0; moveDr = 0;
        return;
      }

      // 落笔值由**起手那一格**决定，整次拖动统一写这个值 ——
      // 如果改成逐格 toggle，指针经过同一格两次会反复翻转，画出毛边。
      //   起手是空格 → 画（值 1）
      //   起手有音   → 擦（值 0）
      press = { cell: cell, mode: 'paint', moved: false };
      paintValue = grid.get(cell.col, cell.row) ? 0 : 1;
      pushHistory();                   // 一次按下 = 一步撤销（整条一起退）
      grid.set(cell.col, cell.row, paintValue);
      if (paintValue) audition(cell);  // 点亮时响一声；擦掉不出声
      lastCell = cell;
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!rect) rect = canvas.getBoundingClientRect();
      if (!press) return;
      autoPanAtEdge(e);                // 拖到边缘继续平移（大面板）

      var cell = cellAt(e, rect);

      if (press.mode === 'paint') {
        // 快速拖动时浏览器会把多个移动合并成一个事件，
        // getCoalescedEvents() 能取回中间点，避免漏格。
        var pts = (e.getCoalescedEvents && e.getCoalescedEvents().length)
          ? e.getCoalescedEvents() : [e];
        for (var i = 0; i < pts.length; i++) {
          var c = cellAt(pts[i], rect);
          if (!c) continue;            // 拖出画布：跳过这一点，继续处理后面的
          grid.paintLine(lastCell, c, paintValue);
          lastCell = c;
          press.moved = true;
        }
        return;
      }

      if (!cell) return;

      if (press.mode === 'select') {
        press.moved = true;
        setSelection(press.cell, cell);
        return;
      }

      // block：搬走 / 复制。整次拖动 = 一步撤销，所以推迟到真的拖起来再拍快照。
      if (!press.moved) {
        if (cell.col === press.cell.col && cell.row === press.cell.row) return;
        press.moved = true;
        dragMode = press.alt ? 'dup' : 'move';
        pushHistory();
      }
      applyMove(cell, dragMode === 'dup');
    });

    /**
     * 松手收尾。
     *
     * 画笔的每一格在 pointerdown / pointermove 里就写完了，这里无事可做；
     * 选区在 pointerdown / pointermove 里也实时铺好了。
     * 只有一种情况要在这里补一刀：**在选区里按了一下但没拖动** ——
     * 那既不是搬走，就该按普通的「单击 = 开 / 关」处理。
     *
     * @param {boolean} commit 指针在画布内抬起（true）还是取消 / 抬在画布外（false）
     */
    var finishPress = function (commit) {
      var p = press;
      if (!p) return;
      press = null;

      if (p.mode === 'block' && commit && !p.moved) {
        var on = grid.get(p.cell.col, p.cell.row);
        pushHistory();
        grid.set(p.cell.col, p.cell.row, !on);
        if (!on) audition(p.cell);     // 点亮发声，关掉不发声
      }

      dragMode = null;
      paintValue = null;
      lastCell = null;
      moveBase = null;
      moveFrom = null;
      moveRect = null;
    };
    canvas.addEventListener('pointerup', function () { finishPress(true); });
    canvas.addEventListener('pointercancel', function () { finishPress(false); });
    // 指针在画布外抬起：收尾但不落笔（坐标已经不在棋盘上了）
    global.addEventListener('pointerup', function () { finishPress(false); });

    // 空格 = 暂停 / 继续（清空不再占用快捷键）
    global.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        togglePlayback();
      }
    });

    // I / O = 在游标处设入点 / 出点。跟 DAW 的习惯一致，也不必开额外面板。
    // 焦点在输入框里时放行，别把打字吞掉。
    global.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      var k = (e.key || '').toLowerCase();
      if (k !== 'i' && k !== 'o') return;

      e.preventDefault();
      setLoopEdge(k === 'i', currentColumn());
    });

    // ⌘/Ctrl+Z 撤销、⌘/Ctrl+Shift+Z（或 Ctrl+Y）反撤销。
    // 焦点在输入框里时**放行** —— 让浏览器自带的文本撤销生效，
    // 否则在「谱子」面板里按 ⌘Z 会去撤销棋盘，很出戏。
    global.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (k === 'y') {          // Windows 习惯的反撤销
        e.preventDefault();
        redo();
      }
    });

    // 点画布**外面**的留白（页面四周、控件之间的空隙）也要取消选择。
    // 光靠 canvas 上的 pointerdown 不够：那些区域的事件根本不在 canvas 上，
    // 就算到了 canvas，cellAt() 也会因为坐标越界返回 null 直接 return，
    // 选区就杵在那儿不动了。踩过。
    global.addEventListener('pointerdown', function (e) {
      if (!renderer.selection) return;
      var t = e.target;
      if (t === canvas) return;                       // 画布内的由上面的 handler 管
      if (t && t.closest &&
          t.closest('.controls, .ruler')) return;     // 控件区（含「谱子」面板）不动选区
      setSelection(null);
    });

    // 选区快捷键：X 删除、A 填充、Esc 取消选择。
    // 不带修饰键、且焦点不在输入框里 —— 否则 Cmd+A（全选）之类会被误伤。
    global.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (!renderer.selection) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      var k = (e.key || '').toLowerCase();
      if (k === 'x') {
        e.preventDefault();
        setSelectionCells(0);          // 删除
      } else if (k === 'a') {
        e.preventDefault();
        setSelectionCells(1);          // 填充
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSelection(null);            // 取消选择
      }
    });

    // ⌘/Ctrl + C / X / V：复制 / 剪切 / 粘贴选区。
    // 焦点在输入框里时**放行** —— 那是文本复制粘贴，别去动棋盘。
    // 没选区（复制 / 剪切）或剪贴板空着（粘贴）时也不拦：别让浏览器白丢一次原生行为。
    global.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;

      var k = (e.key || '').toLowerCase();
      if (k === 'c') {
        if (!renderer.selection) return;
        e.preventDefault();
        if (copySelection()) hint('已复制 ' + clipSizeText());
      } else if (k === 'x') {
        if (!renderer.selection) return;
        e.preventDefault();
        if (cutSelection()) hint('已剪切 ' + clipSizeText());
      } else if (k === 'v') {
        if (!clip) return;
        e.preventDefault();
        if (pasteClipboard()) hint('已粘贴 ' + clipSizeText());
      }
    });

    // 布局变化后缓存的矩形会失效
    global.addEventListener('resize', function () { rect = null; });
    global.addEventListener('scroll', function () { rect = null; }, true);

    // 右键已经用来框选了，它自带的那个菜单必须挡掉 ——
    // canvas 上弹出的「存储图像」对一块实时绘制的画布毫无意义，只会打断拉框。
    // 挂在容器上而不是 canvas 上：落在棋盘周围的留白里也一并屏蔽。
    // 大面板（large.html）的容器是 .board-shell。
    var wrap = document.querySelector('.board-shell') ||
               document.querySelector('.canvas-wrap') || canvas;
    wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  /**
   * 试听某一格对应的音：发声 + 在该格套一圈描边，确认响的是哪一格。
   *
   * 走音序器同一张音表，保证「点出来的音」与「播放时听到的音」永远一致。
   * 音频未启动时先启动（boot 内部已 catch，始终会 resolve）。
   */
  function audition(cell) {
    var note = sequencer.notes[cell.row];
    renderer.flash(cell.col, cell.row);   // 同步给出「响的是这格」的提示
    boot().then(function () {
      audio.synthNote(note, 0);
    });
  }

  // ── 指针意图 ────────────────────────────────────────────
  //
  // 这些必须声明在**模块级**：`applyMove()` 等 helper 定义在 `bindInput` 外面，
  // 若把它们声明在 `bindInput` 里，helper 里访问到的是未声明变量 ——
  // 在 'use strict' 下直接抛 ReferenceError，而事件处理里的异常会被吞掉，
  // 表现成「按下去什么也没发生」，极难查。踩过。
  var press = null;           // 按下了但还没松手：{ cell, mode: 'paint'|'block'|'select', moved, alt }
  var dragMode = null;        // 只有 block 模式会设：null | 'move'（搬选区）| 'dup'（复制并拖走）
  // 画笔：本次拖动统一写入的值（1 = 画、0 = 擦），以及上一格（补格用）
  var paintValue = null;
  var lastCell = null;
  var moveBase = null;        // 搬动开始时整张谱子的副本（每次移动都从它重算）
  var moveFrom = null;        // 搬动起点格
  var moveRect = null;        // 搬动开始时选区的矩形
  var moveDc = 0, moveDr = 0;

  // ── 框选 ────────────────────────────────────────────────
  //
  // 选区就是一块矩形，**只由右键产生**：右键单击选一格、右键拖动框一片。
  // 框好了之后：框内按住左键拖 = 整块搬走（按 Alt = 复制一份）；
  // X 清空这一块、A 填满这一块、⌘C / ⌘X / ⌘V 复制粘贴、Esc 取消。
  function setSelection(a, b) {
    if (!a) { renderer.selection = null; return; }
    renderer.selection = {
      col0: Math.min(a.col, b.col), row0: Math.min(a.row, b.row),
      col1: Math.max(a.col, b.col), row1: Math.max(a.row, b.row)
    };
  }

  function inSelection(cell) {
    var s = renderer.selection;
    return !!s && cell.col >= s.col0 && cell.col <= s.col1 &&
                   cell.row >= s.row0 && cell.row <= s.row1;
  }

  /**
   * 把整块选区搬到指针所在的格。
   *
   * 每次都从 `moveBase`（按下那一刻的整张谱子）**重算**，而不是在上一次结果上
   * 继续叠加 —— 否则来回拖会把同一块反复叠上去、越拖越多。位移还会夹在棋盘内，
   * 拖不出边界。
   *
   * @param {object} cell 指针所在格
   * @param {boolean} [copy] true = 复制（原件留着，拖走的是副本）
   *
   * 复制与搬动只差「要不要先清掉原位置」这一件事，其余完全一样 ——
   * 同一个手势族的两种变体，不该有两套覆盖规则。
   * 所以副本也**只贴音符、不清空格**（与 `applyMove` 同口径），
   * 和 ⌘V 的「盖章」不同：粘贴是明确往某处盖一块，拖动是搬一块过去。
   */
  function applyMove(cell, copy) {
    var s = moveRect;
    var dc = cell.col - moveFrom.col;
    var dr = cell.row - moveFrom.row;
    dc = Math.max(-s.col0, Math.min(dc, grid.cols - 1 - s.col1));
    dr = Math.max(-s.row0, Math.min(dr, grid.rows - 1 - s.row1));
    if (dc === moveDc && dr === moveDr) return;    // 没挪满一格就别重绘
    moveDc = dc; moveDr = dr;

    var next = moveBase.slice();
    var c, r;
    if (!copy) {
      for (c = s.col0; c <= s.col1; c++) {         // 先清掉原位置
        for (r = s.row0; r <= s.row1; r++) next[c * grid.rows + r] = 0;
      }
    }
    for (c = s.col0; c <= s.col1; c++) {           // 再把这一块贴到新位置
      for (r = s.row0; r <= s.row1; r++) {
        if (!moveBase[c * grid.rows + r]) continue;
        next[(c + dc) * grid.rows + (r + dr)] = 1;
      }
    }
    grid.replaceAll(next);
    renderer.selection = {
      col0: s.col0 + dc, row0: s.row0 + dr,
      col1: s.col1 + dc, row1: s.row1 + dr
    };
  }

  /** 把选区内所有格子设成同一个值：A 传 1（填充）、X 传 0（删除） */
  function setSelectionCells(value) {
    var s = renderer.selection;
    if (!s) return;
    pushHistory();
    var next = grid.cells.slice();
    for (var c = s.col0; c <= s.col1; c++) {
      for (var r = s.row0; r <= s.row1; r++) next[c * grid.rows + r] = value;
    }
    grid.replaceAll(next);
  }

  // ── 选区的复制 / 剪切 / 粘贴 ────────────────────────────
  //
  // 剪贴板是**本页内存**里的一块，不走系统剪贴板。理由：`navigator.clipboard.readText()`
  // 在 Chrome 上会弹「允许查看剪贴板？」、在 `file://` 下又多半直接不可用 ——
  // 而这个页面双击就能开、连 npm 都不需要，不该为了搬几格音符去要剪贴板权限。
  // 代价：跨页面搬（16×16 ↔ 大面板）用不了它，那是「谱子」面板的活（MM3，见 §13）。
  //
  // 粘贴是**盖章**语义：目标区域按剪贴板内容整个覆盖（含空格子），不是合并 ——
  // 否则「剪切 + 粘贴」还原不出一模一样的图案。
  var clip = null;        // { cols, rows, cells, col, row }，col/row 是复制时的左上角

  /** 把当前选区抄进剪贴板。返回是否真的抄了（没选区就是没抄） */
  function copySelection() {
    var s = renderer.selection;
    if (!s) return false;

    var w = s.col1 - s.col0 + 1;
    var h = s.row1 - s.row0 + 1;
    var cells = new Uint8Array(w * h);
    for (var c = 0; c < w; c++) {
      for (var r = 0; r < h; r++) {
        if (grid.get(s.col0 + c, s.row0 + r)) cells[c * h + r] = 1;
      }
    }
    clip = { cols: w, rows: h, cells: cells, col: s.col0, row: s.row0 };
    return true;
  }

  /** 剪切 = 抄一份 + 清空选区（清空只占一步撤销） */
  function cutSelection() {
    if (!copySelection()) return false;
    // 块里本来就没有音符：「剪切」和「复制」是同一件事，别白占一步撤销
    // （与「空谱子上点清空不占步骤」同口径）
    for (var i = 0; i < clip.cells.length; i++) {
      if (clip.cells[i]) { setSelectionCells(0); break; }
    }
    return true;
  }

  /**
   * 把剪贴板贴到**选区左上角**；没有选区就贴回复制时的列、原来的行
   * （于是「剪切 → Esc → ⌘V」能原样放回去）。
   *
   * 整块夹在棋盘内，而不是裁掉溢出部分 —— 贴到边缘时宁可挪一下起点，
   * 也别悄悄丢音（与 `applyMove()` 的夹法一致）。
   */
  function pasteClipboard() {
    if (!clip) return false;

    var s = renderer.selection;
    var col0 = s ? s.col0 : clip.col;
    var row0 = s ? s.row0 : clip.row;
    if (col0 + clip.cols > grid.cols) col0 = grid.cols - clip.cols;
    if (row0 + clip.rows > grid.rows) row0 = grid.rows - clip.rows;
    if (col0 < 0) col0 = 0;
    if (row0 < 0) row0 = 0;

    var next = grid.cells.slice();
    for (var c = 0; c < clip.cols; c++) {
      for (var r = 0; r < clip.rows; r++) {
        // 注意 stride：剪贴板内部按「自己的行数」编排，棋盘按 grid.rows ——
        // 两个行数不一样时混用会整片串位（矩形面板上必翻车）。
        next[(col0 + c) * grid.rows + (row0 + r)] = clip.cells[c * clip.rows + r];
      }
    }

    // 贴出来的结果和现在一模一样就不占撤销 —— 否则「⌘C 顺手 ⌘V」会白吃掉一步。
    var same = true;
    for (var i = 0; i < next.length; i++) {
      if (next[i] !== grid.cells[i]) { same = false; break; }
    }
    if (same) return true;

    pushHistory();
    grid.replaceAll(next);

    // 贴完把选区落到刚贴上去的那一块：能按住直接拖走，也能原地再 ⌘V
    setSelection({ col: col0, row: row0 },
                { col: col0 + clip.cols - 1, row: row0 + clip.rows - 1 });
    return true;
  }

  function clipSizeText() {
    return clip.cols + ' × ' + clip.rows;
  }

  // ── 一闪而过的提示 ──────────────────────────────────────
  //
  // 复制 / 粘贴是「看不见的动作」：不做声的话，用户没法确认 ⌘C 到底有没有抄到。
  // 用一条浮在底部的胶囊，`pointer-events: none` 所以不会挡住棋盘。
  var hintEl = null, hintTimer = null;

  function hint(msg) {
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'hint';
      hintEl.setAttribute('role', 'status');    // 屏幕阅读器也念一遍
      document.body.appendChild(hintEl);
    }
    hintEl.textContent = msg;
    hintEl.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      hintTimer = null;
      hintEl.classList.remove('show');
    }, 1100);
  }

  // 命中测试按画布上的归一化坐标缩放。**必须**取 grid.cols / grid.rows，
  // 不能写死 CFG.GRID —— 矩形网格下会把右半边整片映射到错误列。
  function cellAt(e, rect) {
    var r = rect || canvas.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    var y = (e.clientY - r.top) / r.height;
    // 画布只显示视口那一段 → 列号要加上起始列
    var col = renderer.viewCol0 + Math.floor(x * renderer.viewCols);
    var row = Math.floor(y * grid.rows);
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
    return { col: col, row: row };
  }

  // ── 控件 ────────────────────────────────────────────────
  function bindControls() {
    document.getElementById('btn-toggle').addEventListener('click', function () {
      togglePlayback();
    });

    document.getElementById('btn-clear').addEventListener('click', function () {
      if (!grid.any()) return;         // 空谱子别占一步撤销
      pushHistory();
      grid.clear();
    });

    // 微光 / 播放列：大面板的 UI 里没有这两个开关（默认一直开），
    // 基准版还有。所以这里必须容错 —— 元素不存在就跳过绑定。
    var glowBtn = document.getElementById('btn-glow');
    if (glowBtn) {
      glowBtn.addEventListener('click', function () { setGlow(!renderer.showGlow); });
    }
    var playheadBtn = document.getElementById('btn-playhead');
    if (playheadBtn) {
      playheadBtn.addEventListener('click', function () { setPlayhead(!renderer.showPlayhead); });
    }

    document.getElementById('tempo').addEventListener('input', function () {
      setTempo(this.value);
      projectChanged();
    });

    document.getElementById('volume').addEventListener('input', function () {
      setVolume(this.value);
      projectChanged();
    });


    // ── 乐谱：导出 / 载入面板 ─────────────────────────────
    shareBtn = document.getElementById('btn-share');
    shareRow = document.getElementById('share-row');
    shareCode = document.getElementById('share-code');
    shareStatus = document.getElementById('share-status');

    shareBtn.addEventListener('click', function () { toggleShare(); });
    bindPopovers();
    document.getElementById('btn-share-copy').addEventListener('click', copyShare);
    document.getElementById('btn-share-load').addEventListener('click', loadShare);
  }

  function readTempo() {
    return parseInt(document.getElementById('tempo').value, 10) || CFG.TEMPO;
  }

  /** 速度：滑块、读数、音序器三处一起改（唯一入口） */
  function setTempo(bpm) {
    var v = parseInt(bpm, 10);
    if (isNaN(v)) v = CFG.TEMPO;
    if (v < 20) v = 20;
    if (v > 300) v = 300;

    document.getElementById('tempo').value = v;
    document.getElementById('tempo-out').textContent = v + ' BPM';
    sequencer.setTempo(v);
    return v;
  }

  /** 音量：滑块、读数、音频引擎三处一起改（唯一入口） */
  function setVolume(percent) {
    var v = parseInt(percent, 10);
    if (isNaN(v)) v = CFG.VOLUME;
    if (v < 0) v = 0;
    if (v > 100) v = 100;

    document.getElementById('volume').value = v;
    document.getElementById('volume-out').textContent = v + '%';
    audio.setVolume(v / 100);
    return v;
  }

  // ── 工程状态：代码里要带走的那几个参数 ──────────────────
  function collectParams() {
    return {
      bpm: readTempo(),
      vol: parseInt(document.getElementById('volume').value, 10),
      loopIn: sequencer.loopIn,
      loopOut: sequencer.loopOut
    };
  }

  /**
   * 把代码里带的参数套到界面上。
   * 逐项判断：旧代码（MM2）根本没有这些字段，缺哪个就保持现状。
   */
  function applyParams(p) {
    if (!p) return;
    if (p.bpm !== undefined) setTempo(p.bpm);
    if (p.vol !== undefined) setVolume(p.vol);
    if (p.loopIn !== undefined && p.loopOut !== undefined) {
      applyLoop(p.loopIn, p.loopOut, { silent: true });
    }
  }

  // ── 回环区间（入点 / 出点）─────────────────────────────
  //
  // 走到出点之后回到入点。区间比整圈短时，图案每转一圈就和自己的前半段错开几格，
  // 一张静态图案会因此走成一条很长的旋律（polymeter）——
  // 这是本项目最核心的玩法差异，不是显示选项。
  //
  // 交互全在上方标尺：拖两个把手，或在游标处按 I / O。底部不再有滑块。
  // 区间**不再单独存一个键**：它是工程状态的一部分，跟着 MM3 代码一起存
  // （见 storage.js 文件头）。少一个真相来源。

  /** 当前可见的列号：播放时取耳朵听到的那一步，暂停时取游标停的位置 */
  function currentColumn() {
    if (sequencer.playing) {
      var live = sequencer.audibleStep();
      if (live !== null && live !== undefined) return live;
    }
    return renderer.stepIndex;
  }

  /**
   * 应用回环区间（闭区间）。音序器决定「播到哪」、渲染器决定「画到哪」、
   * 标尺决定「看到哪」—— 三处必须同调，否则画面和声音互相矛盾。
   */
  function applyLoop(inStep, outStep, opts) {
    opts = opts || {};

    sequencer.setLoop(inStep, outStep);
    var a = sequencer.loopIn;          // 以音序器归一化后的值为准
    var b = sequencer.loopOut;
    renderer.setLoop(a, b);

    paintRulerLoop();
    rulerStep = -1;                    // 区间变了，已播部分要按新入点重算
    syncRuler(currentColumn());

    if (!opts.silent) projectChanged();      // 防抖存档 + 刷新分享代码
    return { in: a, out: b };
  }

  /**
   * 把回环区间画到标尺上。
   *
   * 百分比按**可见列**算（不是数据宽度）：大面板能画到一千多列，回环端点
   * 常在屏幕外，硬按全宽算会把它压成一条看不见的缝。
   */
  function paintRulerLoop() {
    var v0 = renderer.viewCol0;
    var vc = renderer.viewCols;
    var v1 = v0 + vc - 1;
    var a = sequencer.loopIn;
    var b = sequencer.loopOut;

    // 可见区整个落在回环里 → 没有「区间外」，不染色（与画布 _drawLoopBounds 同口径）
    var full = (a <= v0 && b >= v1);
    function pct(n) { return ((n - v0) / vc * 100) + '%'; }
    // 把手宽 11px、竖线居中；贴边时整条把手往里挪，否则一半被 overflow 裁掉
    function handleLeft(n) {
      return 'clamp(5.5px, ' + pct(n) + ', calc(100% - 5.5px))';
    }

    if (rulerBand) {
      var a0 = Math.max(a, v0);
      var b1 = Math.min(b, v1);
      rulerBand.hidden = full;
      rulerBand.style.left = pct(a0);
      rulerBand.style.width = (Math.max(0, b1 - a0 + 1) / vc * 100) + '%';
    }
    if (rulerDimL) rulerDimL.style.width = (a > v0) ? pct(a) : '0%';
    if (rulerDimR) rulerDimR.style.width = (b < v1) ? ((v1 - b) / vc * 100) + '%' : '0%';

    // 把手在视口外就藏起来：位置算出来没有意义，别给人一个假的可抓点
    if (rulerInHandle) {
      rulerInHandle.hidden = (a < v0 || a > v1 + 1);
      rulerInHandle.style.left = handleLeft(a);
    }
    if (rulerOutHandle) {
      rulerOutHandle.hidden = (b + 1 < v0 || b + 1 > v1 + 1);
      rulerOutHandle.style.left = handleLeft(b + 1);
    }
  }

  /**
   * 只移动一端，并保持「入点 ≤ 出点」：越过另一端时把它一起推走。
   *
   * 不能直接 `applyLoop(col, loopOut)` —— 那样会触发 setLoop 的「顺序反了就交换」，
   * 用户往右拖入点反而变成拖出点，手感完全相反。
   */
  function setLoopEdge(isIn, col) {
    if (isIn) applyLoop(col, Math.max(col, sequencer.loopOut));
    else applyLoop(Math.min(col, sequencer.loopIn), col);
  }


  // ── 乐谱：本地保存 / 导入导出 ───────────────────────────
  //
  // 自动保存是**静默**的：改动后防抖写进 localStorage，刷新或关掉重开都还在。
  // 「导出 / 载入」面板负责跨设备搬运 —— 把整份工程编成一段自包含的代码
  // （音符 + 入点/出点 + 速度 + 音量，见 storage.js 的 MM3）。

  /**
   * 载入工程。优先 URL 的 hash（分享链接），其次本机的自动存档。
   * hash 用过一次就清掉：否则它会在每次刷新时盖住之后自动保存的新内容，
   * 用户改完一刷新发现被打回原样。
   */
  function restoreScore() {
    var fromHash = readHashCode();
    if (fromHash) {
      if (applyScore(fromHash).ok) { clearHash(); return; }
    }
    var saved = TM.Store.load(grid);       // 新键优先，读不到会退回旧尺寸键
    if (saved) applyScore(saved);
  }

  // 编解码都要带上行→音高的表：音符是按音高存的，不是按行号（见 storage.js 文件头）
  function applyScore(text) {
    var r = TM.Store.applyCode(grid, text, RUNTIME.notes);
    if (r.ok) applyParams(r.params);      // 代码里带的参数（速度 / 音量 / 回环）
    return r;
  }

  function encodeScore() {
    return TM.Store.encode(grid, RUNTIME.notes, collectParams());
  }

  // ── 示例谱（src/presets.js）─────────────────────────────
  //
  // 陌生人打开是一片空棋盘：不知道该画什么，也不知道画出来是什么声音。
  // 所以给几份现成的 MM3 代码。点一下 = 载入 + 立刻开始播。
  //
  // 走的是 `applyScore()` —— 和「别人发你的谱子」完全同一条路，
  // 载入时同样套上代码里的速度 / 音量 / 回环，预设不可能和分享行为不一致。
  var presetChips = [];
  var activePreset = -1;       // 当前选中的示例下标；-1 = 用户自己的谱子

  function buildPresets() {
    var row = document.getElementById('presets');
    if (!row || !TM.PRESETS) return;

    TM.PRESETS.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name;
      b.setAttribute('aria-pressed', 'false');
      if (p.hint) b.title = p.hint;
      b.addEventListener('click', function () { loadPreset(i, { play: true }); });
      row.appendChild(b);
      presetChips.push(b);
    });
  }

  /**
   * URL 参数 `?demo=<id>` → 载入对应示例。
   *
   * 这是「打开就是这首」的分享入口：`large.html?demo=dango` 直接铺满棋盘，
   * 按播放就能听。刻意**不做成默认行为** —— 一进来就自动装谱、一按播放就开响，
   * 会让人以为那首曲子是应用自带的内容，而不是一张等你来画的空棋盘。
   *
   * @returns {boolean} 是否真的载入了
   */
  function loadDemoFromUrl() {
    var m = /[?&]demo=([^&]+)/.exec(global.location.search || '');
    if (!m || !TM.PRESETS) return false;

    var id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return false; }

    for (var i = 0; i < TM.PRESETS.length; i++) {
      if (TM.PRESETS[i].id === id) {
        loadPreset(i, { play: false });     // 不自动播：浏览器也不让，见 boot()
        return true;
      }
    }
    return false;
  }

  /** 标记当前是第几个示例；-1 = 用户自己的谱子 */
  function markPreset(i) {
    activePreset = i;
    for (var k = 0; k < presetChips.length; k++) {
      presetChips[k].setAttribute('aria-pressed', String(k === i));
    }
  }

  /**
   * 载入一个示例。
   *
   * 示例可以带两份代码：定宽面板（16 列）用 `codeSmall`，能横向平移的大面板用
   * `code`。同一首曲子两种长度 —— 全曲 897 列塞进 16 列面板只剩 9 个音，
   * 那还不如给它一段完整的 4 小节。
   *
   * @param {number} i
   * @param {Object} [opts] play: 载入后是否顺手开始播放（默认 true）
   */
  function loadPreset(i, opts) {
    opts = opts || {};
    var p = TM.PRESETS && TM.PRESETS[i];
    if (!p) return;

    var code = (RUNTIME.scrollX || !p.codeSmall) ? p.code : p.codeSmall;

    // 载入会覆盖当前棋盘，先存一步 —— 「点了示例，我画的没了」不该无解
    if (grid.any()) pushHistory();

    var r = applyScore(code);
    if (!r.ok) return;
    // applyScore 里 onChange 先把 chip 褪掉，这里再重新点亮
    markPreset(i);

    // 把套上参数之后的状态落盘（applyScore 的 onChange 发生在 applyParams 之前，
    // 那一次存的是旧参数），顺带刷新分享代码
    projectChanged();

    if (opts.play !== false && !sequencer.playing) togglePlayback();
  }

  function readHashCode() {
    var m = /(?:^#|&)p=([^&]+)/.exec(global.location.hash || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  function clearHash() {
    if (!global.history || !global.history.replaceState) return;
    global.history.replaceState(null, '',
      global.location.pathname + global.location.search);
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    TM.Store.save(grid, RUNTIME.notes, collectParams());
  }

  /** 工程状态变了（音符 / 速度 / 音量 / 回环）：防抖存档 + 刷新分享代码 */
  function projectChanged() {
    scheduleSave();
    refreshShare();
  }

  function setShareStatus(msg) {
    if (shareStatus) shareStatus.textContent = msg;
  }

  /** 上一次由我们填进面板的代码，用来分辨「面板里是生成的代码」还是「用户在粘贴」 */
  var shareEncoded = '';

  function fillShareCode() {
    shareEncoded = encodeScore();
    shareCode.value = shareEncoded;
  }

  /**
   * 面板开着时让代码跟着谱子实时更新。
   * 但如果面板里的内容**不是**我们填的那段（说明用户正在往里粘别人的代码），
   * 就不动它 —— 否则改一下格子就把人家刚粘的东西冲掉了。
   */
  function refreshShare() {
    if (!shareRow || shareRow.hidden || !shareCode) return;
    if (shareCode.value !== shareEncoded) return;
    fillShareCode();
  }

  /**
   * 顶栏浮层（谱子 / 帮助）。
   *
   * 谱子的开关仍然走 `toggleShare()` —— index.html 里它是一行往下挤出来的面板，
   * 大面板里则是 `.pop` 浮层（绝对定位，弹出时棋盘不动）。所以这里只补
   * 「浮层形态才需要」的两件事：点外面收起、Esc 收起，外加两个浮层互斥。
   */
  function bindPopovers() {
    var helpBtn = document.getElementById('btn-help');
    var helpPop = document.getElementById('help-pop');

    function closeHelp() {
      if (!helpPop || helpPop.hidden) return;
      helpPop.hidden = true;
      helpBtn.setAttribute('aria-expanded', 'false');
    }

    if (helpBtn && helpPop) {
      helpBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var show = helpPop.hidden;
        helpPop.hidden = !show;
        helpBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        if (show) toggleShare(false);        // 两个浮层不同时开
      });
      // 浮层内部的点击不要冒到 document，否则刚点开就被关掉
      helpPop.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    }

    // 只有浮层形态才做「点外面收起」；index.html 的行内面板保持原行为
    if (!shareRow || !shareRow.classList.contains('pop')) return;

    // 点外面：两个浮层各自判断，谁开着收谁
    document.addEventListener('pointerdown', function (e) {
      if (helpPop && !helpPop.hidden &&
          !helpPop.contains(e.target) && !helpBtn.contains(e.target)) {
        closeHelp();
      }
      if (shareRow.hidden) return;
      if (shareRow.contains(e.target)) return;
      if (shareBtn && shareBtn.contains(e.target)) return;
      toggleShare(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!shareRow.hidden) toggleShare(false);
      closeHelp();
    });

    // 打开谱子时顺手收起帮助
    shareBtn.addEventListener('click', function () { closeHelp(); });
  }

  function toggleShare(force) {
    var show = (force === undefined) ? shareRow.hidden : !!force;
    shareRow.hidden = !show;
    shareBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (!show) return;

    fillShareCode();
    shareCode.select();
    setShareStatus(TM.Store.available()
      ? '这段代码装的是整份工程：音符 + 入点/出点 + 速度 + 音量。' +
        '它会跟着你的改动实时更新，换个面板（加/减八度）也照样能载入。'
      : '当前环境不能自动保存（无痕模式或存储被禁用），请用「复制」手动备份。');
  }

  function copyShare() {
    shareCode.select();
    // **先**给出确定的反馈：clipboard.writeText 的 promise 在无用户手势、
    // 无权限或 file:// 下可能一直挂着不 resolve 也不 reject（实测如此），
    // 把反馈挂在它上面会让按钮点了没反应。写入成功时再升级文案。
    setShareStatus('已选中，按 ⌘C / Ctrl+C 复制');
    var clip = global.navigator && global.navigator.clipboard;
    if (!clip || !clip.writeText) return;      // 非安全上下文下根本没有这个 API
    try {
      clip.writeText(shareCode.value).then(function () {
        setShareStatus('已复制到剪贴板');
      }, function () { /* 保持上面那句提示 */ });
    } catch (e) { /* 保持提示 */ }
  }

  function loadShare() {
    var text = shareCode.value;
    var probe = TM.Store.decode(text);             // 先校验，别把坏代码记进撤销历史
    if (!probe.ok) { setShareStatus('载入失败：' + probe.error); return; }

    pushHistory();                                 // 载入也能撤销回原来的谱子
    var r = applyScore(text);
    if (!r.ok) { setShareStatus('载入失败：' + r.error); return; }
    fillShareCode();                               // 规整成当前面板的标准写法
    shareCode.select();
    setShareStatus(describeLoad(r));
  }

  /** 如实告诉用户载入时发生了什么 —— 跨面板载入会有就近对齐和丢弃 */
  function describeLoad(r) {
    var s = (r.legacy ? '已载入旧格式乐谱：' : '已载入 ') + r.placed + ' 个音符';
    if (r.snapped) s += '，其中 ' + r.snapped + ' 个本面板没有该音高，已按音高就近对齐';
    if (r.dropped) s += '，' + r.dropped + ' 个超出本面板范围被丢弃';
    return s;
  }

  // ── 撤销 / 反撤销 ───────────────────────────────────────
  //
  // 只在**一次操作的开始**拍快照，所以「按住拖过一整条」是一步撤销，不是几十步。
  // 快照就是整张 grid 的副本：16×16 是 256 字节、64×48 是 3072 字节，
  // 存满 60 步最多也就 180 KB —— 不值得为省这点内存去做增量记录。
  var HISTORY_MAX = 60;
  var history = [];
  var redoStack = [];

  function snapshot() { return grid.cells.slice(); }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > HISTORY_MAX) history.shift();
    redoStack.length = 0;        // 走了新分支，原来的反撤销链就作废了
  }

  function undo() {
    if (!history.length) return false;
    redoStack.push(snapshot());
    grid.replaceAll(history.pop());
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    history.push(snapshot());
    grid.replaceAll(redoStack.pop());
    return true;
  }

  // ── 播放位置标尺（鼠标控制游标）──────────────────────────
  //
  // 标尺宽度 = 整块棋盘的宽度（大面板 2048px，跟着棋盘一起横向滚），所以
  // 「点在标尺的哪个位置」直接对应「第几列」。点一下跳过去，按住拖动就是擦洗。
  function bindRuler() {
    ruler = document.getElementById('ruler');
    if (!ruler) return;
    rulerCursor = document.getElementById('ruler-cursor');
    rulerBand = document.getElementById('ruler-band');
    rulerDimL = document.getElementById('ruler-dim-l');
    rulerDimR = document.getElementById('ruler-dim-r');
    rulerInHandle = document.getElementById('ruler-in');
    rulerOutHandle = document.getElementById('ruler-out-edge');

    // 入点 / 出点把手：拖它们改回环区间（标尺其余部分仍然是「移动游标」）
    bindLoopHandle(rulerInHandle, true);
    bindLoopHandle(rulerOutHandle, false);

    // 刻度背景与游标宽度都按**可见列数**算（CSS: calc(100% / var(--cols))）。
    // 这里以前写的是 `grid.cols` —— 大面板数据宽 1024，游标就成了 1/1024 宽的细线，
    // 要等改窗口触发 sizeCanvas() 重新写入才恢复成整格（2026-10-24 报的问题）。
    // 所以统一由 sizeCanvas() 写，这里不再重复设置。

    ruler.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;         // 与画布同样的约定：只管左键
      e.preventDefault();
      scrubbing = true;
      if (ruler.setPointerCapture) {
        try { ruler.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
      seekFromEvent(e);
      boot();                             // 拖动游标也算一次用户手势，顺手解锁音频
    });

    ruler.addEventListener('pointermove', function (e) {
      if (scrubbing) seekFromEvent(e);
    });

    var end = function () { scrubbing = false; };
    ruler.addEventListener('pointerup', end);
    ruler.addEventListener('pointercancel', end);
    global.addEventListener('pointerup', end);   // 指针在标尺外抬起也要收尾
  }

  /** 指针横坐标 → 列号（标尺覆盖的是**可见列**，所以映射到 viewCol0 起算） */
  function colFromEvent(e) {
    var r = ruler.getBoundingClientRect();
    var col = renderer.viewCol0 +
              Math.floor((e.clientX - r.left) / r.width * renderer.viewCols);
    if (col < 0) col = 0;
    if (col >= grid.cols) col = grid.cols - 1;
    return col;
  }

  /**
   * 把手的拖动。
   *
   * `pointerdown` 必须 stopPropagation —— 否则事件冒泡到标尺，又被当成
   * 「点标尺 = 移动游标」，一拖把手游标就跟着乱跑（踩过）。
   *
   * 拖动过程中不写 localStorage（每移动一像素写一次太浪费），松手才落盘。
   */
  function bindLoopHandle(el, isIn) {
    if (!el) return;

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      var dragging = true;
      if (el.setPointerCapture) {
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }

      var move = function (ev) {
        if (!dragging) return;
        setLoopEdge(isIn, colFromEvent(ev));
      };

      var up = function () {
        dragging = false;
        global.removeEventListener('pointermove', move);
        global.removeEventListener('pointerup', up);
        global.removeEventListener('pointercancel', up);
        // 松手时补写一次存档（拖动过程中刻意不写，每移一像素写一次太浪费）
        applyLoop(sequencer.loopIn, sequencer.loopOut);
      };

      global.addEventListener('pointermove', move);
      global.addEventListener('pointerup', up);
      global.addEventListener('pointercancel', up);
    });
  }

  function seekFromEvent(e) {
    var col = colFromEvent(e);
    sequencer.seek(col);
    // 暂停时 audibleStep() 返回 null，主循环会退回 renderer.stepIndex ——
    // 不把它一起挪过去的话，游标在暂停状态下不会跟着走。
    renderer.stepIndex = col;
    syncRuler(col);
  }

  /** 把游标画到当前位置。同一帧内重复同一步号就不写样式了。 */
  function syncRuler(step) {
    if (!rulerCursor || step === rulerStep) return;
    rulerStep = step;
    // 游标是一整格宽的块（宽度由 CSS 按 --cols 算），这里只负责移动。
    // 播放头跑到视口外就藏起来 —— 硬挤在边上会让人以为它就在那儿。
    var sx = step - renderer.viewCol0;
    if (sx < 0 || sx >= renderer.viewCols) {
      rulerCursor.style.visibility = 'hidden';
    } else {
      rulerCursor.style.visibility = '';
      rulerCursor.style.left = (sx / renderer.viewCols * 100) + '%';
    }
    ruler.setAttribute('aria-valuenow', step);
  }

  // ── 主循环 ──────────────────────────────────────────────
  //
  // 微光用固定步长推进，与显示刷新率解耦：60Hz 与 120Hz 屏上暗下去的速度一致。
  // 播放头位置则来自音序器的真实排程反查（audibleStep），
  // 因此任何速度下都与听到的声音对齐，改速度也不会跳。
  var SIM_DT = 1 / 60;
  var MAX_CATCHUP = 5;          // 单帧最多补算几步，避免切回标签页时追帧
  var simAccumulator = 0;
  var lastFrameTime = 0;

  function loop(now) {
    requestAnimationFrame(loop);

    var dt = lastFrameTime ? (now - lastFrameTime) / 1000 : SIM_DT;
    lastFrameTime = now;
    if (dt > 0.25) {           // 标签页刚切回来，重新起步
      dt = SIM_DT;
      simAccumulator = 0;
    }

    var step = sequencer.audibleStep();
    if (step === null || step === undefined) step = renderer.stepIndex;

    // 大面板：播放头走出视口就跟过去（手动平移后 2.5 秒内不跟，别抢方向盘）
    if (RUNTIME.scrollX && sequencer.playing && nowMs() > panHoldUntil) {
      var v0 = renderer.viewCol0;
      if (step < v0 || step >= v0 + renderer.viewCols) {
        panTo(step - Math.floor(renderer.viewCols / 3), true);
      }
    }

    // 微光关掉时整段跳过：省掉每帧的亮度场推进。
    // 暂停时仍然推进（让已有的光继续暗下去），但不再点亮 —— 暂停时步号冻结，
    // 继续点亮等于给同一格反复充能，画面会一直卡在全亮上。
    if (renderer.showGlow) {
      simAccumulator += dt;
      var n = 0;
      while (simAccumulator >= SIM_DT && n < MAX_CATCHUP) {
        renderer.simulate(step, sequencer.playing);
        simAccumulator -= SIM_DT;
        n++;
      }
      if (n >= MAX_CATCHUP) simAccumulator = 0;
    } else {
      simAccumulator = 0;
    }

    syncRuler(step);
    renderer.composite(step);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
