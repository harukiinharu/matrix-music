/*
 * Matrix Music — 工程状态（乐谱 + 参数）的编解码与本地存档
 *
 * 两条路：
 *   1) **自动保存**：改动后（防抖）写进 localStorage，刷新 / 关掉重开接着玩。
 *   2) **导入导出**：把整份工程编成一段自包含的代码，可以复制给别人、粘回来载入，
 *      也可以塞进 URL 的 hash 当分享链接。
 *
 * ── 三种代码格式 ─────────────────────────────────────────
 *
 *   MM1   最早的格式：**稠密位图**，每格 1 bit，**尺寸耦合**。只能载入尺寸完全
 *         相同的面板。现在只用于向后兼容（存量分享链接 / 存档），不再产出。
 *
 *   MM2   上一版：**按音高记的稀疏坐标**（CSC 二进制 + base64url）。尺寸无关，
 *         但**只装得下音符** —— 速度、音量、回环区间全在代码之外，别人打开你
 *         的链接听到的和你的不是同一首歌。同样只解不产。
 *
 *   MM3   当前格式：**JSON + LZW + base64url**。一份完整的工程状态：
 *         点亮的音符、入点/出点、BPM、音量。见下。
 *
 * ── MM3 长什么样 ─────────────────────────────────────────
 *
 *   MM3.<base64url( LZW( UTF-8( JSON ) ) )>
 *
 *   JSON 明文（短键，省的是压缩前的字符数）：
 *
 *     { "c": 16,                                  // 列数
 *       "n": [[2,[84,72]], [5,[79]]],             // 有音符的列 → 音高（升序）
 *       "in": 0, "out": 15,                       // 回环区间（闭区间，列号）
 *       "bpm": 120, "vol": 85 }                   // 速度 / 音量（百分比）
 *
 * 为什么从「稀疏二进制」换成「JSON 再压缩」：
 *
 *   - **要装的是工程状态，不只是音符**。二进制头里塞四个参数当然也能做，
 *     但每加一个字段就要改编码器、解码器和版本号；JSON 加字段只是加一个键。
 *   - 解开压缩就能直接读，排查问题不用写解码器（`TM.Store.decode()` 就还你一份 JSON）。
 *   - 代价是**更长**。实测同一份 16×16 谱子：
 *
 *       空谱 64 字符（MM2 10）／1 个音符 74（12）
 *       3 个音符 94（22）／满格 480（108）
 *
 *     也就是 4~6 倍。分享链接因此变长，但仍然远在 URL 的安全长度内 ——
 *     换来的是「别人打开你发的链接，听到的就是你做的那个工程」。
 *
 * 压缩是自己写的 LZW：本项目零依赖，而 CompressionStream 是异步的，
 * 会把这套同步 API 全打乱。对 JSON 这种键名高度重复的文本，LZW 能压掉约 40%。
 *
 * ── 为什么音符仍按音高存，而不是行号 ─────────────────────
 *
 * 行号是相对的：大面板多一个八度，行号整体平移；换音阶（五声 ↔ 半音阶）
 * 会重新定义每一行是什么音。按行号存的谱子一改规格就整体跑调。
 * 这里存的是**音高本身**（和 CONFIG.NOTES 同一套编号，72 = A），于是
 * 面板怎么加减八度、换不换音阶，旧谱子都还对得上；目标面板没有那个音高时，
 * 就近对齐到最接近的一行（同面板载入是精确的，不会触发）。
 *
 * ── 存储键 ───────────────────────────────────────────────
 *
 * `matrixmusic.score.<面板 id>`（small / large）。**故意不带尺寸**：面板加减八度
 * 之后键不变，存档自动接着用。
 * 旧键 `matrixmusic.pattern.<cols>x<rows>` 会在读不到新键时兜底一次（一次性迁移）。
 */
(function (global) {
  'use strict';

  var KEY_PREFIX = 'matrixmusic.score.';
  var LEGACY_KEY_PREFIX = 'matrixmusic.pattern.';
  var MM1_RE = /^MM1\.(\d+)x(\d+)\.([A-Za-z0-9\-_]+)$/;
  var MM2_RE = /^MM2\.([A-Za-z0-9\-_]+)$/;
  var MM3_RE = /^MM3\.([A-Za-z0-9\-_]+)$/;

  var ENC_DENSE = 0;        // 仅用于解 MM2
  var ENC_SPARSE = 1;

  var MAX_COLS = 4096;      // 解码时的防御上限：别让畸形代码逼出巨型分配
  var MAX_SPAN = 255;
  var MAX_PITCH = 127;
  var MAX_NOTES = 1 << 16;

  function fail(msg) { return { ok: false, error: msg }; }

  // ── base64url ────────────────────────────────────────────
  function toBase64Url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';                 // 补回被去掉的 padding
    var bin = global.atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── varint（LEB128）—— 只用来解 MM2 ─────────────────────
  function readVarint(bytes, pos) {
    var v = 0, shift = 0, b;
    do {
      if (pos.i >= bytes.length) throw new Error('varint 越界');
      b = bytes[pos.i++];
      v += (b & 0x7f) * Math.pow(2, shift);        // 用乘法，避免 << 在 31 位溢出
      shift += 7;
      if (shift > 35) throw new Error('varint 过长');
    } while (b & 0x80);
    return v;
  }

  // ── UTF-8（JSON 目前全是 ASCII，但别假设它永远是）─────────
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        // 代理对：合成一个码点再编码，别把 emoji 拆成两个坏字符
        var cc = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cc >> 18), 0x80 | ((cc >> 12) & 63),
                 0x80 | ((cc >> 6) & 63), 0x80 | (cc & 63));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  /** 字符串 → 字节值数组（LZW 解出来的是「码点串」，要当字节用） */
  function strToBytes(str) {
    var out = new Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function utf8Decode(bytes) {
    var out = '', i = 0, b, cp;
    while (i < bytes.length) {
      b = bytes[i++];
      if (b < 0x80) {
        cp = b;
      } else if (b < 0xe0) {
        cp = ((b & 31) << 6) | (bytes[i++] & 63);
      } else if (b < 0xf0) {
        cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      } else {
        cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) |
             ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }

  // ── LZW ─────────────────────────────────────────────────
  // 按字节做字典。码不是固定 16 位——那会让每个 ASCII 码都白搭一个 0x00 字节
  // （base64 之后仍然白白胖三分之一）。这里按「当前字典有多大」决定码宽，
  // 从 9 位长到 16 位，再用位流拼起来。
  //
  // 编解码两侧的码宽必须严格同步。难点在于解码器比编码器**晚一步**才补上那条
  // 字典项（第一码没法补），所以两边用同一个函数、但解码侧传 `next + 1`：
  // 这样在字典长度跨过 2 的幂时两边同时换宽，不会读错位。
  var MIN_WIDTH = 9;
  var MAX_WIDTH = 16;

  function widthFor(n) {
    var w = MIN_WIDTH;
    while (w < MAX_WIDTH && n > (1 << w)) w++;
    return w;
  }

  function lzwEncode(bytes) {
    var dict = Object.create(null);
    var i, code = 256, w = '';
    var out = [], buf = 0, bits = 0;

    for (i = 0; i < 256; i++) dict[String.fromCharCode(i)] = i;

    function emit(c, width) {
      buf = (buf << width) | c;
      bits += width;
      while (bits >= 8) {
        bits -= 8;
        out.push((buf >>> bits) & 0xff);
      }
      buf &= (1 << bits) - 1;
    }

    for (i = 0; i < bytes.length; i++) {
      var ch = String.fromCharCode(bytes[i]);
      var wc = w + ch;
      if (dict[wc] !== undefined) { w = wc; continue; }
      emit(dict[w], widthFor(code));
      if (code < 65535) dict[wc] = code++;
      w = ch;
    }
    if (w !== '') emit(dict[w], widthFor(code));

    if (bits > 0) out.push((buf << (8 - bits)) & 0xff);     // 末字节补零
    return out;
  }

  function lzwDecode(bytes) {
    var dict = [], i, prev = null, next = 256, entry;
    var pos = 0, buf = 0, bits = 0;
    var out = [];

    for (i = 0; i < 256; i++) dict[i] = String.fromCharCode(i);

    function take(width) {
      while (bits < width) {
        if (pos >= bytes.length) return -1;      // 尾巴上的补零最多凑不齐一码
        buf = (buf << 8) | bytes[pos++];
        bits += 8;
      }
      bits -= width;
      var c = (buf >>> bits) & ((1 << width) - 1);
      buf &= (1 << bits) - 1;
      return c;
    }

    for (;;) {
      var k = take(widthFor(prev === null ? next : next + 1));
      if (k < 0) break;

      if (k < next) {
        entry = dict[k];
      } else if (k === next && prev !== null) {
        entry = prev + prev.charAt(0);           // KwKwK：字典里还没这一条
      } else {
        throw new Error('LZW 码越界：' + k);
      }
      out.push(entry);
      if (prev !== null && next < 65535) dict[next++] = prev + entry.charAt(0);
      prev = entry;
    }

    var str = '';
    for (i = 0; i < out.length; i++) str += out[i];
    return str;
  }

  // ── 音高 → 行 / 就近取整 ─────────────────────────────────
  /** 目标面板里离 target 最近的音高（有序数组） */
  function nearestPitch(sorted, target) {
    if (!sorted.length) return undefined;
    var lo = 0, hi = sorted.length - 1, mid;
    while (lo < hi) {
      mid = (lo + hi) >> 1;
      if (sorted[mid] < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(sorted[lo] - target)) {
      return sorted[lo - 1];
    }
    return sorted[lo];
  }

  function currentNotes() {
    var R = global.TM && global.TM.RUNTIME;
    return (R && R.notes) || (global.TM && global.TM.CONFIG.NOTES);
  }

  function intIn(v, lo, hi, fallback) {
    v = parseInt(v, 10);
    if (isNaN(v)) return fallback;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  // ── 编码（MM3）──────────────────────────────────────────
  /**
   * grid（+ 可选参数）→ 代码字符串。
   *
   * @param {Object}   grid
   * @param {number[]} [notes]  行 → 音高。缺省取 TM.RUNTIME.notes。
   * @param {Object}   [params] `{bpm, vol, loopIn, loopOut}`，缺省按面板默认值。
   *
   * 结果**与网格尺寸无关**：只记录有音符的 (列, 音高)。
   */
  function encode(grid, notes, params) {
    notes = notes || currentNotes();
    params = params || {};

    var CFG = global.TM.CONFIG;
    var cols = grid.cols, rows = grid.rows;
    var groups = [];                      // 只收「有音符的列」，空列一个字节都不占

    for (var c = 0; c < cols; c++) {
      var list = null;
      for (var r = rows - 1; r >= 0; r--) {   // 行号大 = 音低；倒着走天然升序
        if (!grid.get(c, r)) continue;
        if (list === null) list = [];
        list.push(notes[r]);
      }
      if (list !== null) groups.push([c, list]);
    }

    var loopIn = intIn(params.loopIn, 0, cols - 1, 0);
    // 缺省回环宽度取 min(列数, INITIAL_LOOP_COLS)：大面板 1024 列，
    // 不能因为「没传参数」就默认循环 1024 步
    var defOut = Math.min(cols, CFG.INITIAL_LOOP_COLS || cols) - 1;
    var loopOut = intIn(params.loopOut, 0, cols - 1, defOut);
    if (loopIn > loopOut) { var t = loopIn; loopIn = loopOut; loopOut = t; }

    var obj = {
      c: cols,
      n: groups,
      'in': loopIn,
      out: loopOut,
      bpm: intIn(params.bpm, 20, 300, CFG.TEMPO),
      vol: intIn(params.vol, 0, 100, CFG.VOLUME === undefined ? 85 : CFG.VOLUME)
    };

    var json = JSON.stringify(obj);
    return 'MM3.' + toBase64Url(lzwEncode(utf8Encode(json)));
  }

  // ── 解码 ─────────────────────────────────────────────────
  /**
   * 代码 → 归一化的坐标列表（+ 参数）。
   * @returns {{ok:true, version:number, cols:number, notes:Array<{col:number,note:number}>,
   *            params?:{bpm?:number, vol?:number, loopIn?:number, loopOut?:number}}}
   *          或 `{ok:false, error}`
   */
  function decode(text) {
    if (typeof text !== 'string') return fail('不是文本');
    var s = text.trim();

    var m1 = MM1_RE.exec(s);
    if (m1) return decodeV1(m1);

    var m2 = MM2_RE.exec(s);
    if (m2) return decodeV2(m2[1]);

    var m3 = MM3_RE.exec(s);
    if (m3) return decodeV3(m3[1]);

    return fail('格式不对（应形如 MM3.xxxx，也认旧的 MM2.xxxx 与 MM1.16x16.xxxx）');
  }

  /** 旧格式：稠密位图，尺寸写死在代码里 */
  function decodeV1(m) {
    var cols = parseInt(m[1], 10);
    var rows = parseInt(m[2], 10);
    var cells;
    try {
      cells = fromBase64Url(m[3]);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (cells.length !== Math.ceil(cols * rows / 8)) {
      return fail('代码长度与尺寸不符（' + cols + '×' + rows + ' 需要 ' +
                  Math.ceil(cols * rows / 8) + ' 字节，实际 ' + cells.length + '）');
    }
    return { ok: true, version: 1, cols: cols, rows: rows, cells: cells };
  }

  /** MM2：按音高的稀疏坐标（只有音符，没有参数） */
  function decodeV2(payload) {
    var bytes;
    try {
      bytes = fromBase64Url(payload);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (!bytes.length) return fail('正文为空');

    var enc = bytes[0];
    if (enc !== ENC_DENSE && enc !== ENC_SPARSE) {
      return fail('未知的编码类型 ' + enc);
    }

    var pos = { i: 1 };
    var base, span, cols;
    try {
      base = readVarint(bytes, pos);
      span = readVarint(bytes, pos);
      cols = readVarint(bytes, pos);
    } catch (e) {
      return fail('头部损坏：' + e.message);
    }
    if (cols < 1 || cols > MAX_COLS) return fail('列数不合理：' + cols);
    if (span > MAX_SPAN) return fail('音域跨度不合理：' + span);

    var list = [];
    var c, count, k;

    if (enc === ENC_DENSE) {
      var pitchCount = span + 1;
      var need = Math.ceil(cols * pitchCount / 8);
      if (bytes.length - pos.i !== need) {
        return fail('正文长度与列数/音域不符（需要 ' + need + ' 字节，实际 ' +
                    (bytes.length - pos.i) + '）');
      }
      for (c = 0; c < cols; c++) {
        for (k = 0; k < pitchCount; k++) {
          var bit = c * pitchCount + k;
          if (bytes[pos.i + (bit >> 3)] & (1 << (bit & 7))) {
            list.push({ col: c, note: base + k });
          }
        }
      }
      return { ok: true, version: 2, cols: cols, base: base, span: span, notes: list };
    }

    // 稀疏：逐列读「列号增量 / 个数 / 各音高偏移」
    var col = -1;
    try {
      while (pos.i < bytes.length) {
        col += readVarint(bytes, pos);
        if (col >= MAX_COLS) return fail('列号越界：' + col);
        count = readVarint(bytes, pos);
        if (count > MAX_SPAN + 1) return fail('单列音符数不合理：' + count);
        for (k = 0; k < count; k++) {
          list.push({ col: col, note: base + readVarint(bytes, pos) });
        }
      }
    } catch (e) {
      return fail('正文损坏：' + e.message);
    }
    if (list.length > MAX_COLS * (MAX_SPAN + 1)) return fail('音符数量不合理');
    return { ok: true, version: 2, cols: cols, base: base, span: span, notes: list };
  }

  /** MM3：JSON + LZW */
  function decodeV3(payload) {
    var bytes;
    try {
      bytes = fromBase64Url(payload);
    } catch (e) {
      return fail('内容不是合法的 base64');
    }
    if (!bytes.length) return fail('正文为空');

    var json;
    try {
      json = JSON.parse(utf8Decode(strToBytes(lzwDecode(bytes))));
    } catch (e) {
      return fail('正文损坏：' + e.message);
    }
    if (!json || typeof json !== 'object' || json instanceof Array) {
      return fail('正文不是 JSON 对象');
    }

    var cols = intIn(json.c, 1, MAX_COLS, NaN);
    if (isNaN(cols)) return fail('列数不合理：' + json.c);

    var groups = json.n;
    if (!(groups instanceof Array)) return fail('音符列表格式不对');

    var list = [];
    for (var i = 0; i < groups.length; i++) {
      var pair = groups[i];
      if (!(pair instanceof Array) || pair.length !== 2) return fail('音符分组格式不对');
      var col = intIn(pair[0], 0, cols - 1, NaN);
      if (isNaN(col)) return fail('列号越界：' + pair[0]);
      var ps = pair[1];
      if (!(ps instanceof Array)) return fail('音符格式不对');
      for (var j = 0; j < ps.length; j++) {
        var note = intIn(ps[j], 0, MAX_PITCH, NaN);
        if (isNaN(note)) return fail('音高不合理：' + ps[j]);
        list.push({ col: col, note: note });
        if (list.length > MAX_NOTES) return fail('音符数量不合理');
      }
    }

    // 参数：缺哪个就跳过哪个（旧代码 / 手改的 JSON 都可能少字段）
    var params = null;
    if (json.bpm !== undefined) {
      var bpm = intIn(json.bpm, 20, 300, NaN);
      if (!isNaN(bpm)) (params || (params = {})).bpm = bpm;
    }
    if (json.vol !== undefined) {
      var vol = intIn(json.vol, 0, 100, NaN);
      if (!isNaN(vol)) (params || (params = {})).vol = vol;
    }
    var a = intIn(json['in'], 0, cols - 1, NaN);
    var b = intIn(json.out, 0, cols - 1, NaN);
    if (!isNaN(a)) (params || (params = {})).loopIn = a;
    if (!isNaN(b)) (params || (params = {})).loopOut = b;
    if (params && params.loopIn !== undefined && params.loopOut !== undefined &&
        params.loopIn > params.loopOut) {
      var tmp = params.loopIn;
      params.loopIn = params.loopOut;
      params.loopOut = tmp;
    }

    return { ok: true, version: 3, cols: cols, notes: list, params: params || undefined };
  }

  /** 把旧格式的位图摊成 0/1 数组（布局与网格一致：列 × 行数 + 行） */
  function unpack(data) {
    var n = data.cols * data.rows;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = (data.cells[i >> 3] >> (i & 7)) & 1;
    return out;
  }

  // ── 落位 ─────────────────────────────────────────────────
  /**
   * 把一段代码载入 grid。
   *
   * 音符按音高走，所以**换面板也能载**：列超出目标宽度就丢弃；音高在目标
   * 音阶里没有就**就近对齐**到最接近的一条行（同面板载入时全都能精确命中，
   * 不会触发）。
   *
   * 参数**不在这里套用** —— 原样放在返回值里由调用方决定怎么用。
   * storage 不该知道滑块和音序器的存在。
   *
   * @returns {{ok:boolean, error?:string, placed?:number, dropped?:number,
   *            snapped?:number, legacy?:boolean, params?:Object}}
   */
  function applyCode(grid, text, notes) {
    notes = notes || currentNotes();
    var d = decode(text);
    if (!d.ok) return d;

    // 旧格式：稠密位图，行号 ↔ 音高的对应关系写在当时的面板配置里，
    // 现在重建不出来，所以只认尺寸完全一致的网格。
    if (d.version === 1) {
      if (d.cols !== grid.cols || d.rows !== grid.rows) {
        return fail('旧格式（MM1）是稠密位图，只能载入 ' + d.cols + '×' + d.rows +
                    ' 的谱子，与当前面板（' + grid.cols + '×' + grid.rows +
                    '）不匹配。请用新版导出的 MM3 代码。');
      }
      var flat = unpack(d);
      var placed = 0;
      for (var i = 0; i < flat.length; i++) if (flat[i]) placed++;
      grid.replaceAll(flat);
      return { ok: true, placed: placed, dropped: 0, snapped: 0, legacy: true };
    }

    var rowOf = {};                       // 音高 → 行号（同音高取最靠上的那行）
    var sorted = [];
    for (var r = 0; r < grid.rows; r++) {
      if (!(notes[r] in rowOf)) { rowOf[notes[r]] = r; sorted.push(notes[r]); }
    }
    sorted.sort(function (a, b) { return a - b; });

    var cells = new Uint8Array(grid.cols * grid.rows);
    var placedN = 0, droppedN = 0, snappedN = 0;

    for (var j = 0; j < d.notes.length; j++) {
      var e = d.notes[j];
      if (e.col >= grid.cols) { droppedN++; continue; }

      var row = rowOf[e.note];
      if (row === undefined) {
        var near = nearestPitch(sorted, e.note);
        if (near === undefined) { droppedN++; continue; }
        row = rowOf[near];
        snappedN++;
      }
      var idx = e.col * grid.rows + row;
      if (!cells[idx]) { cells[idx] = 1; placedN++; }
    }

    grid.replaceAll(cells);
    return { ok: true, placed: placedN, dropped: droppedN, snapped: snappedN,
             params: d.params };
  }

  // ── localStorage ────────────────────────────────────────
  // 全部包在 try 里：隐私模式、配额满、或被策略禁用时不该把页面搞崩。

  /** 面板身份（small / large）。**故意不含尺寸**，见文件头说明。 */
  function panelId() {
    var R = global.TM && global.TM.RUNTIME;
    if (R && R.id) return R.id;
    return R ? (R.cols + 'x' + R.rows) : 'unknown';
  }

  function storageKey() { return KEY_PREFIX + panelId(); }
  function legacyKey(cols, rows) { return LEGACY_KEY_PREFIX + cols + 'x' + rows; }

  function save(grid, notes, params) {
    try {
      global.localStorage.setItem(storageKey(), encode(grid, notes, params));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 读存档。先读新键；读不到就退回旧键（按尺寸分的那种）一次。
   * 调用方只要 applyCode 成功，下一次自动保存就会写到新键上，迁移自然完成。
   */
  function load(grid) {
    try {
      var v = global.localStorage.getItem(storageKey());
      if (v) return v;
      var old = global.localStorage.getItem(legacyKey(grid.cols, grid.rows));
      return old || null;
    } catch (e) {
      return null;
    }
  }

  function remove() {
    try {
      global.localStorage.removeItem(storageKey());
      return true;
    } catch (e) {
      return false;
    }
  }

  /** localStorage 是否真的可用（用于给出「本次会话不会保存」的提示） */
  function available() {
    try {
      var k = KEY_PREFIX + '__probe';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  global.TM.Store = {
    storageKey: storageKey,
    legacyKey: legacyKey,
    panelId: panelId,
    encode: encode,
    decode: decode,
    unpack: unpack,
    applyCode: applyCode,
    save: save,
    load: load,
    remove: remove,
    available: available
  };
})(window);
