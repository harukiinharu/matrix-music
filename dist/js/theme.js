/*
 * Matrix Music — 明暗主题
 *
 * 黑白两套配色，默认跟随系统（prefers-color-scheme）。
 * 系统切换时立刻生效，不需要刷新页面。
 *
 * 解析优先级（从高到低）：
 *   1. URL 查询参数 ?theme=dark|light   —— 截图、回归测试用，钉死不跟随系统
 *   2. localStorage["mm.theme"]         —— 给将来的手动开关预留
 *   3. <html data-theme="...">          —— 由 head 内联脚本按系统偏好预置，避免首屏闪白
 *   4. 系统偏好
 *
 * 生效方式是把调色板写进 TM.CONFIG.COLORS（原地覆盖同名键），
 * 渲染器本来就每次绘制都读 CFG.COLORS，因此换主题不需要重建渲染器，
 * 调一次 renderer.refresh() 重绘即可。
 */
(function (global) {
  'use strict';

  var TM = global.TM;
  var CFG = TM.CONFIG;

  var STORAGE_KEY = 'mm.theme';

  // 两套调色板。键名必须与 CONFIG.COLORS 一一对应。
  // octaveOn / octaveOff 不写在这里 —— 它们由 TM.buildOctavePalette(OCTAVE_SPEC[name])
  // 生成（下标 = MIDI 八度号），手写这张表不现实。
  var PALETTES = {
    dark: {
      background: '#07090C',
      select: '#FFFFFF',
      selectFill: 'rgba(255, 255, 255, 0.12)',
      playhead: 'rgba(255, 255, 255, 0.06)',
      highlight: '#FFFFFF',
      loopBand: 'rgba(255, 255, 255, 0.045)',
      outOfLoop: 'rgba(7, 9, 12, 0.66)',
      loopEdge: 'rgba(255, 255, 255, 0.45)',
      glowComposite: 'lighter',
      glowGain: 0.55
    },

    // 浅色不是简单反色：白底上格子用中低明度的饱和色。
    // 微光的方向也跟着反：深色是「加光」，浅色是「加浓」。
    light: {
      background: '#FFFFFF',
      select: '#111111',
      selectFill: 'rgba(0, 0, 0, 0.07)',
      playhead: 'rgba(0, 0, 0, 0.05)',
      highlight: '#111111',
      loopBand: 'rgba(14, 140, 121, 0.05)',
      outOfLoop: 'rgba(255, 255, 255, 0.70)',
      loopEdge: 'rgba(0, 0, 0, 0.30)',
      // 浅色用 multiply + 本行格色的浅色版：格子沿自己的色相变深变浓，
      // 白底只染出一层淡光。**不要改成 screen / lighter** —— 白底提亮
      // 只会把格子洗白，颜色丢了，看起来像「变淡」而不是「亮起来」。
      glowComposite: 'multiply',
      glowGain: 1,
      glowTintMix: 0.30
    }
  };

  var current = 'dark';
  var pinned = false;        // 由 ?theme= 或 set() 钉死时不再跟随系统
  var listeners = [];
  var mql = null;

  function systemPrefers() {
    if (!global.matchMedia) return 'dark';
    return global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function fromUrl() {
    var m = /[?&]theme=(dark|light)(?:&|$)/.exec(global.location ? global.location.search : '');
    return m ? m[1] : null;
  }

  function fromStorage() {
    try {
      var v = global.localStorage.getItem(STORAGE_KEY);
      return (v === 'dark' || v === 'light') ? v : null;
    } catch (e) { return null; }
  }

  function fromAttr() {
    var v = global.document.documentElement.getAttribute('data-theme');
    return (v === 'dark' || v === 'light') ? v : null;
  }

  /** 把调色板原地写进 CONFIG.COLORS */
  function paint(name) {
    var p = PALETTES[name] || PALETTES.dark;
    for (var k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) CFG.COLORS[k] = p[k];
    }

    // 每八度一个颜色：按主题规格重建整张表（下标 = MIDI 八度号，见 constants.js）
    var pal = TM.buildOctavePalette(TM.OCTAVE_SPEC[name] || TM.OCTAVE_SPEC.dark);
    CFG.COLORS.octaveOn = pal.on;
    CFG.COLORS.octaveOff = pal.off;
    // 单色回退取八度 5（中音区），供只认 on / off 的老代码与测试使用
    CFG.COLORS.on = pal.on[5];
    CFG.COLORS.off = pal.off[5];
  }

  function apply(name, opts) {
    opts = opts || {};
    current = (name === 'light') ? 'light' : 'dark';

    paint(current);
    global.document.documentElement.setAttribute('data-theme', current);

    // 移动端地址栏配色跟着变
    var meta = global.document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CFG.COLORS.background);

    if (opts.silent) return;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    }
  }

  /** 系统偏好变化时：钉死了就不跟，否则跟着换 */
  function onSystemChange() {
    if (pinned) return;
    apply(systemPrefers());
  }

  /** 初步解析一次（head 内联脚本通常已经设过 data-theme，这里是兜底） */
  function init() {
    var forced = fromUrl();
    if (forced) {
      pinned = true;
      apply(forced, { silent: true });
    } else {
      var saved = fromStorage();
      if (saved) {
        pinned = true;
        apply(saved, { silent: true });
      } else {
        apply(fromAttr() || systemPrefers(), { silent: true });
      }
    }

    if (global.matchMedia) {
      mql = global.matchMedia('(prefers-color-scheme: light)');
      if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
      else if (mql.addListener) mql.addListener(onSystemChange);
    }
  }

  global.TM.Theme = {
    /** 当前生效的主题名 */
    current: function () { return current; },
    /** 是否还被系统偏好驱动（不是被 ?theme / set 钉死） */
    isAuto: function () { return !pinned; },

    /** 手动切换。传 null 回到跟随系统。 */
    set: function (name) {
      if (name === null || name === undefined) {
        pinned = false;
        try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        apply(systemPrefers());
        return;
      }
      if (name !== 'dark' && name !== 'light') return;
      pinned = true;
      try { global.localStorage.setItem(STORAGE_KEY, name); } catch (e) {}
      apply(name);
    },

    /** 订阅变化，返回取消订阅函数 */
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    init: init
  };
})(window);
