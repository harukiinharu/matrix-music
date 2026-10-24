/*
 * Matrix Music — 网格数据模型
 *
 * 索引方式为 steps[列][行]：
 *   列 = 时间步，行 = 音高索引（0 最高音）。
 * 用一维 Uint8Array 按列主序存储，索引 = 列 * 行数 + 行。
 *
 * 维度可配置（见 TM.RUNTIME），**缺省 16×16**。
 */
(function (global) {
  'use strict';

  var RUNTIME = global.TM.RUNTIME;

  /**
   * @param {Object} [opts] 覆盖运行时维度；不给则取 TM.RUNTIME（缺省 = 基准版 16×16）
   * @param {number} [opts.cols] 列数（时间步）
   * @param {number} [opts.rows] 行数（音高）
   */
  function Grid(opts) {
    opts = opts || {};
    this.cols = opts.cols || RUNTIME.cols;
    this.rows = opts.rows || RUNTIME.rows;
    // 兼容旧代码：历史上是正方形网格，size 即边长。**不要**拿它当 stride 用，
    // 矩形网格下列步长是 rows —— 这正是必须把索引写成 col * rows + row 的原因。
    this.size = this.rows;
    this.cells = new Uint8Array(this.cols * this.rows);
    this.listeners = [];
  }

  Grid.prototype.index = function (col, row) {
    return col * this.rows + row;
  };

  Grid.prototype.get = function (col, row) {
    return this.cells[col * this.rows + row] === 1;
  };

  Grid.prototype.set = function (col, row, value) {
    if (!this.inBounds(col, row)) return;
    var next = value ? 1 : 0;
    var i = col * this.rows + row;
    if (this.cells[i] === next) return;
    this.cells[i] = next;
    this.emit({ type: 'set', col: col, row: row, value: next === 1 });
  };

  Grid.prototype.toggle = function (col, row) {
    var v = !this.get(col, row);
    this.set(col, row, v);
    return v;
  };

  Grid.prototype.clear = function () {
    if (!this.any()) return;
    this.cells.fill(0);
    this.emit({ type: 'clear' });
  };

  /**
   * 整张替换（载入乐谱代码时用）。
   * **只发一次变更事件** —— 逐格 set 会触发 N 次局部重绘和 N 次微光点亮，
   * 载入 64×48 的谱子会明显卡一下。替换走的是渲染器的整层重绘路径。
   */
  Grid.prototype.replaceAll = function (cells) {
    if (!cells || cells.length !== this.cells.length) return false;
    this.cells.set(cells);
    this.emit({ type: 'replace' });
    return true;
  };

  Grid.prototype.any = function () {
    for (var i = 0; i < this.cells.length; i++) {
      if (this.cells[i]) return true;
    }
    return false;
  };

  Grid.prototype.count = function () {
    var n = 0;
    for (var i = 0; i < this.cells.length; i++) n += this.cells[i];
    return n;
  };

  Grid.prototype.inBounds = function (col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  };

  /**
   * 把 from 到 to 之间经过的格子全部设为 value（含 to，不含 from）。
   * 快速拖动时指针事件之间会跳过若干格，用它补齐，保证涂抹连续不断。
   */
  Grid.prototype.paintLine = function (from, to, value) {
    if (!from) { this.set(to.col, to.row, value); return; }
    var dc = to.col - from.col;
    var dr = to.row - from.row;
    var steps = Math.max(Math.abs(dc), Math.abs(dr));
    if (steps === 0) { this.set(to.col, to.row, value); return; }
    for (var i = 1; i <= steps; i++) {
      this.set(Math.round(from.col + dc * i / steps),
               Math.round(from.row + dr * i / steps), value);
    }
  };

  Grid.prototype.onChange = function (fn) {
    this.listeners.push(fn);
  };

  Grid.prototype.emit = function (action) {
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i](this, action);
  };

  global.TM.Grid = Grid;
})(window);
