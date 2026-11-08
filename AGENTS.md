# AGENTS.md

给在本仓库工作的编码代理（以及人类协作者）的项目说明。

---

## 1. 这是什么

**Matrix Music** —— 一个放在浏览器里的格子音序器：点亮格子，它按列循环扫过，
每一列被点亮的格子就发声，于是图案变成一段可以一直听下去的循环曲。

两个入口，同一套引擎：

- `index.html` —— 16 步 × 16 音，D 大调五声音阶（怎么点都不难听）
- `large.html` —— 64 步 × 48 音，半音阶，音域将近 4 个八度

**技术约束（请勿引入例外）**

- 原生 JavaScript，**ES5 风格**（`var` / `function` / 无箭头函数、无 `let/const`）
- **无框架、无构建、无依赖、无包管理器**。不需要 `npm install`，没有 `node_modules`
- 使用**普通 `<script>` 标签**按依赖顺序加载，**不使用 ES Module**
  —— 这样直接双击 `index.html`（`file://`）也能运行，不受 CORS 限制
- 音画渲染只用 Canvas 2D + Web Audio API

**配色约定**

**每八度一个颜色**，不是连续渐变：`OCTAVE_SPEC`（constants.js）给出两张规格，
`buildOctavePalette()` 各生成一张长度 11 的表，**下标就是 MIDI 八度号**
（`note / 12` 取整）。渲染器 `_cellColor()` 走 行 → 音高（`this.notes`）→ 八度 → 取色，
所以同一八度内所有格子同色，同一个音高在 16 行与 48 行面板里也同色。

按八度而不是按行上色是刻意的：48 行面板上相邻行只差半个音，连续渐变等于没编码。

三条硬规则：

1. **只有格子带色相**。播放列、试听描边、框选、微光一律中性灰 ——
   「有颜色的东西 = 有音的东西」这条语法一旦破了，图案就没法读了。
2. 新增颜色一律进调色板（`dist/js/theme.js` 的 PALETTES 或 `PITCH_SPEC`），
   **不要在渲染器或 CSS 里写死色值**，否则另一套主题下必漏改。
3. 浅色主题的主色**不能是黑 / 灰**：它要是青绿（与色阶高音端同族），
   `test/interaction.html` 有一条断言在守这件事（`--accent` 三通道差 > 20）。

明暗两套默认跟随系统（`prefers-color-scheme`），系统切换即时生效。
由 `dist/js/theme.js` 把调色板写进 `TM.CONFIG.COLORS`，`<html data-theme>`
驱动 CSS 变量。

## 2. 运行与验证

```bash
# 直接打开（推荐，零依赖）
open index.html

# 或起本地服务
python3 -m http.server 8000
```

改动后**必须**跑回归。用无头 Chrome 抓 DOM 断言：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --virtual-time-budget=15000 --user-data-dir=/tmp/tm-check \
  --dump-dom "file://$PWD/test/selftest.html"
```

结果在 `<pre id="results">` 里。**必须全部通过（当前 145 项），不允许出现 FAIL / JS ERROR / WATCHDOG。**

页面级交互回归（文案 / 空格键 / 微光开关 / 点按涂抹）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=25000 \
  --user-data-dir=/tmp/tm-ui \
  --dump-dom "file://$PWD/test/interaction.html"
```

结果在 `<pre id="out">` 里（当前 167 项）。这个测试靠 iframe 加载 `index.html?debug=1`，
断言建立在模型状态上，**不要改成采样渲染后的像素**（原因见 §10）。

大面板回归（32 行 × 64 列，即 `large.html` 那条入口）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=30000 \
  --user-data-dir=/tmp/tm-large \
  --dump-dom "file://$PWD/test/large.html"
```

结果在 `<pre id="out">` 里（当前 119 项）。它盯的是**矩形网格相对正方形多出来的
失败模式**：一维数组拿错 stride、音序器 `% GRID` 提前归零、行扫描写死 16 行、
命中测试写死 `CFG.GRID`、微光场维度接反、剪贴板跨 stride 串位。每一条都做过变异验证（见 §10）。

视觉回归（渲染是否被改坏）：

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --force-device-scale-factor=2 --virtual-time-budget=6000 --user-data-dir=/tmp/tm-vis \
  --dump-dom "file://$PWD/test/visual.html"
```

会输出 `log`（均值/峰值/活跃格数）和 `lum`（画布 16×16 亮度采样，便于逐格核对）。

## 3. 文件地图

```
index.html            基准版入口（16×16）。脚本顺序：constants → grid → audio → sequencer → renderer → storage → app
large.html            大面板入口（36×64，半音阶）。比上面多一层 large-config，见 §12
style.css             视觉风格（纯黑底 + 浅灰方块）。.stage-wide 是大面板的宽版布局
dist/js/constants.js      全部常量、音阶表、包络曲线 + TM.RUNTIME（运行时维度）。改动前先读 §5
dist/js/large-config.js   只被 large.html 加载：把 TM.RUNTIME 覆盖成 48 行 × 64 列。见 §12
dist/js/grid.js           音符网格（对应 toneMatrix::Pattern）。维度取自 TM.RUNTIME
dist/js/audio.js          音频引擎：振荡器 / 包络 / 声像（干声直出，无延迟）
dist/js/sequencer.js      步进音序器。**整条链路的唯一时基**，见 §4
dist/js/renderer.js       Canvas 渲染：**视口**格子图层 + 微光 + 播放列高亮
dist/js/storage.js        乐谱的编解码 + localStorage 存档。见 §13
dist/js/presets.js        示例谱（团子大家族全曲 + 16 列节选，两份 MM3 代码）
dist/                  **站点本身**：index.html / large.html / style.css / js/*.js
                       （GitHub Pages 发布的也是这个目录，没有第二份副本）
test/                  回归页（不进产物，只在本地 / CI 跑）
scripts/               ci-test.sh（页面级回归）、bump.sh（资源缓存戳）
dist/js/app.js            装配、输入、主循环（固定步长）。两套入口共用这一份
test/selftest.html    145 项断言（离线音频渲染、微光衰减、描边不变式、乐谱编解码、暂停续播）
test/interaction.html 167 项页面级交互断言（iframe + ?debug=1）
test/large.html       119 项大面板断言（矩形网格 stride / 视口平移与命中 / 微光维度）
test/sharp.html       格子边缘锐度探针（读图层像素）
test/perf.html        渲染开销探针（?cell=&glow=&gblur= 可切配置做 A/B）
test/visual.html      渲染回归 + 亮度量化
test/glow.html        微光亮度场 ASCII 可视化（看「有没有扩散」最快）
test/diag.html        频率/节点诊断
```

`index.html?debug=1` 会在 `window.__matrixMusicDebug` 上暴露 `grid / audio / sequencer / renderer`。
**不带该参数时不会挂任何全局变量** —— 保持生产环境干净，改动时别把这条去掉。

## 4. 核心架构：单一时基

**音序器是所有时间相关行为的唯一真相来源。**

每次把一步排进音频时钟时，都会把 `{step, time}` 记入 `Sequencer.timeline`；
视觉层用 `Sequencer.audibleStep()` 反查「此刻耳朵听到的是哪一步」。

```
排程 ──> timeline[{step,time}] ──> audibleStep() ──> renderer.composite()
```

- **不要**改用「起点 + 步长 × n」这类公式去推算播放位置。它在两种情况下必然错位：
  1. 改速度时整条时间轴会整体错位；
  2. 起点与首步之间存在启动延迟（`START_DELAY`）。
- **听觉时钟只由 `Sequencer.audibleTime()` 提供**，时钟的选择权集中在那一处：

  1. 首选 `ctx.getOutputTimestamp().contextTime` —— 规范里它就是「输出设备正在播放的
     那一帧的音频时钟」，硬件缓冲与设备延迟都已经算在里面。返回 0 / 停更时忽略。
  2. 退路 `currentTime − outputLatency`，且**补偿夹到半个步长以内**。
     理由：`outputLatency` 在蓝牙耳机上经常被高估到一整步以上，补偿满额会让
     播放头整整滞后一格 —— 那就是「游标还停在前一格，声音已经响了」。
     宁可差半格，也不能差一整格。

  **符号不要写反**（`currentTime` 是写入头，要往前退才是听到的位置）。
- 改速度**不需要**做任何重新对齐：已排的步保持不变，之后新排的步用新步长，
  反查自然连续。

**回环区间（`loopIn` / `loopOut`）**

`Sequencer.loopIn` / `loopOut` 是一对**闭区间**的列号，缺省 0..cols-1（整圈）。
走过 `loopOut` 就回到 `loopIn`。区间比整圈短时，图案每转一圈就错开几格，
静态图案因此会走成一条很长的旋律（polymeter）—— 这是本项目最核心的玩法差异。

交互入口只有标尺：拖两个把手，或在游标处按 **I** / **O**（`setLoopEdge()` 统一处理）。
**底部没有回环滑块**，那是被否掉的方案。

四条必须守住的不变量：

1. **音序器与渲染器必须同时改**。`app.js` 的 `applyLoop()` 是唯一入口：
   它同时调 `sequencer.setLoop()` 与 `renderer.setLoop()`，再刷标尺的
   高亮 / 两侧压暗 / 两个把手，否则会出现「声音走 3..9、画面压暗 0..2」这种自相矛盾。
2. **绕回用的是 `loopIn/loopOut`，不是 `grid.cols`**（`_tick()`）；
   改回 cols 会让区间完全失效（`test/selftest.html` 的「排程只落在回环区间内」会红）。
3. **只改一端要用 `setLoopEdge()`**，不能写成 `applyLoop(col, loopOut)` ——
   那会触发 `setLoop()` 的「顺序反了就交换」，用户往右拖入点反而变成拖出点。
4. **当前步落在区间外要拉回入点**：`setLoop()` 里做一次，`_tick()` 排程前再做一次 ——
   后者是防止漏排一个区间外的音。

`test/interaction.html` 锁了：I/O 快捷键、拖把手、标尺高亮/压暗的百分比、
画面内外被区分开（深浅主题压暗方向相反，所以只比较「拉开程度」）。

**暂停 / 继续不重置步号。** `currentStep` 的语义是「**下一个待排的步**」：

- 构造函数里是 0 → 首次播放自然从头开始，**不需要**在 `start()` 里再置零；
- 播放中它指向下一步，`stop()` 只停计时器、不动它；
- 于是 `start()` 接着往下排就是「继续」。

**不要在 `start()` 里写 `currentStep = 0`** —— 空格键与播放按钮都是「暂停 / 继续」
语义，归零会让每次继续都从头重放（踩过这个 bug）。真要「回到开头重播」，
单写一个方法，别塞回 `start()`。`test/selftest.html`（单元）和
`test/interaction.html`（页面级）各有一条断言守着「继续是接着排，不是从 0 排」。

**凡是与时间有关的量，都必须从速度派生，不能写死。** 历史上的坑：延迟时长曾被
写死成 120 BPM 的 375 ms，导致换速度后回声脱离步网格、听起来「不合拍」。
（那条延迟后来被**整条删掉**了，理由见下 —— 但「时间不能写死」这条规矩仍然有效：
步长走 `TM.stepSeconds(tempo)`，包络长度当初也是从采样数换算的。）

**没有延迟 / 混响，干声直出。** 早先这里串着一条从基准版照搬的 3 步反馈延迟
（湿 0.06 / 反馈 0.4），实测单音后面每 375 ms（120 BPM）跟着一次重影，
依次 -24 / -32 / -40 / -48 dB。在稀疏图案里它听起来就是「回声」，而在这个
「你画什么就听什么」的作品里，那是多余的：游标压到哪一格和听到哪个音之间
不该多出一条来源不明的尾巴。

**别加回来**，任何形式的回声都会让 `test/selftest.html` 的
「0.55 s 之后完全安静（没有回声 / 延迟）」变红 —— 那条断言就是为此设的。

## 5. 不可随意改动的量

这些值决定音色与手感的基准，改动会影响听感与既有回归断言。要改请先说明理由。

```
采样率 44100 / 速度 120 BPM / 每小节 16 步
音符时长 22050 采样 = 0.5 s
包络 amp(t) = (0.4·(1−t/T))²，峰值 0.16（注意是平方，不是指数衰减）
声像 L=(1−r)/(1+|r|), R=(1+r)/(1+|r|)，r = rand − rand
复音上限 128
音频通路：声部 → 复音池 → 母线，**没有延迟 / 混响**（干声直出）
音阶 NOTES[16] = 96,93,91,89,86,84,81,79,77,74,72,69,67,65,62,60
      → D 大调五声 A–B–D–E–F#（A6→A3），行 0 音最高
频率 f = 440 · 2^((note − 72)/12)
网格 16×16 / 格子 32px / 画布 512×512
配色 格子：行 → 音高 → MIDI 八度 → 每八度一色（OCTAVE_SPEC，青 → 蓝 → 紫）
      底色：深色 #07090C / 浅色 #FFFFFF，由 dist/js/theme.js 覆盖
      其余元素（播放列 / 描边 / 框选 / 微光）一律中性，不参与配色
微光 每格一个 0..1 的亮度包络，逐帧 ×0.9，不做任何邻域耦合
```

以上量都与网格规格无关，两种面板共用。**`CONFIG.GRID` / `CONFIG.NOTES` /
`CONFIG.RESOLUTION` 描述的是基准版规格**，`test/selftest.html` 直接断言它们等于
16 / 16 / 16 —— 要做别的规格的面板，**不要动这三个值**，去改 `TM.RUNTIME`（见 §12）。

## 6. 渲染约定

- **离屏图层按设备分辨率渲染**（`512 × min(devicePixelRatio, 3)`），主画布绘制时把坐标
  缩回 512 逻辑空间，使位图与屏幕像素 **1:1**。不要引入二次重采样 —— 曾经因此整片糊掉。
  唯一例外是**微光层**：它本来就要被大半径模糊，固定 512 就够，按设备分辨率渲染纯属浪费面积。
- 离屏层**不使用 `setTransform`**，坐标直接乘 `scale`。这既避开 `ctx.filter` 半径的
  单位歧义，也保证像素对齐。
- **格子不模糊**（`BLUR_CELL = 0`），纯平直角。不要照搬基准版的 `BlurFilter(3)`：
  那是作用在 512 逻辑空间的，在 2x 屏上会变成 6 设备像素并填满 6px 的格子间隙，整体糊成一片。
- **格子改动只重绘那一格**（`drawCell`），不要整层重绘。模糊关闭时方块完全落在自己
  32px 的格子里，局部重绘精确且几乎零成本；整层重绘要付 256 个方块的钱。
  `test/selftest.html` 有断言守住「局部重绘 == 整层重绘」这个不变式。
  > 如果哪天要把 `BLUR_CELL` 调回 > 0，`drawCell` 会自动回退成整层重绘（模糊会溢出格子，
  > 局部重绘不再精确）。此时必须接受拖动变卡，或者改用带 padding 的区域重绘。
- 微光用**固定步长**（`app.js` 的 `SIM_DT = 1/60`）推进，与显示刷新率解耦，
  否则 60Hz 与 120Hz 屏上灯暗下去的速度不一致。
- **微光必须点在「当前列」**（`stepIndex` 那一列），不能点在 `stepIndex + 1`。
  它标记的是「这一列正在响」，点下一列就等于让光标还压在前一格时目标格先亮，
  看上去正是「声音比游标早一格」。`test/selftest.html` 有两条断言守着
  （当前列 = 1、下一列恒为 0），`test/large.html` 同样按当前列点亮。
- **浅色主题的微光是「加浓」，不是「加亮」**：白底上提亮只会把格子洗白，
  看上去像被关掉。所以浅色走 `multiply` + 本行格色的浅色版（`glowTintMix = 0.30`）：
  格子沿自己的色相变深变浓，周围散出一圈同色光，这才是亮纸上的「灯泡」。
  `test/interaction.html` 有一条像素断言守着（浅色下亮格必须比同色未亮格**更暗**）。
- **微光不向邻居传播**。别再把二维波动场（邻域求和 + 阻尼）加回来：
  用户要的是「灯泡亮一下」，不是水面涟漪。`test/selftest.html` 的
  「相邻格没有被带动（不扩散）」锁着这一条。
- **暂停时不得点亮**：`renderer.simulate(step, seed)` 的 `seed` 必须传
  `sequencer.playing`。步号冻结时继续点亮同一列，等于给同一格反复充能，
  画面会一直卡在「全亮」上，看不出已经暂停。亮度上限是 1，所以不会像
  旧波动场那样指数爆炸，但「暂停却全亮」本身就是错的。
  传 `false` 后按 `GLOW_DECAY`（0.9/帧）衰减，约 0.4 秒彻底熄灭。
- **全暗时跳过重绘**：`stepGlow` 在「这一帧没有任何亮度 + 上一帧图层已经清空」
  时直接 return，省掉每帧的 `putImageData` + 模糊。全暗是本项目的常态
  （暂停、空谱子），这一步把空闲开销降到接近零。
- Canvas 2D 没有 `subtract` 合成模式，所以「底图 + 减淡」两层按公式预计算颜色后直接上色。

## 7. 输入约定

- **绘制与音频启动解耦**：`pointerdown` 必须**同步**上色，不能等 `AudioContext` 就绪。
  音频在后台异步启动。
- 拖动时用 `Grid.prototype.paintLine(from, to, value)` 补齐两次事件之间跳过的格子。
  契约是**涂 `(from, to]`** —— 含终点、不含起点（起点那格上一轮已经画过）。
- 用 `e.getCoalescedEvents()` 取回被浏览器合并掉的中间移动点，否则快速拖动会漏格。
- 缓存的画布矩形（`getBoundingClientRect`）在 `resize` / `scroll` 后必须失效重取。

**大面板的顶栏布局（2026-10-24 改版）**

`large.html` 只有一个 `.topbar`：标题 / 简介 / 播放 / 清空 / 示例 / 速度 / 音量 / 谱子 / `?`，
棋盘（`.board-shell` → `.board-frame`）`flex: 1` 吃掉剩下的高度。**没有 `.head` / `.controls` / `.foot`**
（那是 `index.html` 的结构，两页共用 `style.css`，所以新样式一律写在 `.topbar` / `.body.wide` 作用域下）。

四条容易踩的：

1. **`.topbar` 必须写 `width: 100%`** —— `.stage` 是 `align-items: center`，不写会缩成内容宽度、
   整条顶栏居中，浮层的 `right: 14px` 也跟着错位（踩过）。
2. **微光 / 播放列按钮只在大面板被移除**（默认常开）。`bindControls()` 里的绑定必须容错
   （`getElementById` 拿到 null 就跳过），`syncToggle()` 本来就有判空。
3. **谱子的开关仍是 `toggleShare()`**，`index.html` 是往下挤出来的一行，大面板是 `.pop` 浮层。
   `bindPopovers()` 只在 `shareRow.classList.contains('pop')` 时挂「点外面 / Esc 收起」。
4. **两个浮层互斥**：打开一个就收起另一个；点浮层内部不能冒泡到 document（否则刚开就被关）。

`test/large.html` 锁了这些：`.topbar` 存在 / 旧三段式不存在 / 棋盘紧贴顶栏且高度 > 300 /
没有 glow·playhead 按钮且渲染器仍默认开 / 谱子 `position: absolute` 且展开不改变棋盘高度 /
`?` 浮层能开能点外面收起。

**大面板的视口模型（2026-10-24 起）**

大面板的数据宽度是 1024 列（`large-config` 的 `COLS`），但**画布只渲染可见的那一段**：
`renderer.viewCol0` 是起始列、`renderer.viewCols` 是一次画多少列。32px 一列铺到 1024 列
是 32768px，超过浏览器画布上限，整块画布建不出来 —— 这不是优化，是硬约束。

五条必须守住的口径：

1. **`grid.cols` = 数据宽度，`viewCols` = 视口宽度。** 两者只有基准版相等（16）。
   写新代码时凡是「画到屏幕上」的地方都要 `(col - viewCol0)`，凡是「判断能不能画」
   的地方都看 `grid.cols`。
2. **微光强度场是绝对列**（`rows × cols`，1024 宽），**光晕图层是视口**（`viewCols × rows`）。
   这样平移时强度场不用搬家，只换写入窗口的起点。视口宽度变了走 `_relayout()` 重建图层，
   模糊密度按「每列多少像素」延续原口径。
3. **命中测试 = `viewCol0 + floor(x * viewCols)`**，标尺同理。任何地方再写
   `x * grid.cols` 都会在平移后整片错位。
4. **回环宽度不跟着数据宽度走。** `INITIAL_LOOP_COLS = 64`：1024 列的画布如果默认循环
   1024 步，第一遍要播几分钟。`renderer` / `sequencer` / `storage.encode` 三处都用
   `min(cols, INITIAL_LOOP_COLS)` 作为缺省出点。
5. **没有横向滚动条**，平移靠手势（`app.js` 的 `bindPan` / `panTo` / `autoPanAtEdge`）：
   触控板横滑、Shift+滚轮、中键拖动、画到边缘自动平移、播放时跟随播放头
   （手动平移后 2.5 秒内不跟随，避免和用户抢）。**`panTo` 里不要调 `composite`** ——
   主循环每帧都会合成，多调一次白画 9ms（实测）。

**性能（实测，无头 Chrome 软件渲染，dpr 1，视口 43 列）**：整层重绘 `4.2 ms`、
合成一帧 `9.4 ms`。重绘量 = `viewCols × rows`（2064 格），比改造前固定画 64 列还便宜；
合成面积也从 2048×1536 降到视口大小。

**快捷键与开关（当前约定）**

| 操作 | 绑定 |
|---|---|
| 空格 | **暂停 / 继续**（`togglePlayback()`）。继续是**接着播**，不回到第 0 步（见 §4）。清空**没有**快捷键，只有按钮 |
| 左键点击 / 拖动 | 开关方格 |
| **右键方格** | **试听该格的音**（`audition()`）—— 发声 + 套一圈白色描边，**不改图案、不改填充色** |
| `#btn-toggle` | 播放 / 暂停 |
| `#btn-clear` | 清空 |
| `#btn-glow` | 开关微光 |
| `#btn-playhead` | 开关播放列高亮 |
| `#btn-share` | 展开 / 收起「谱子」面板（导出代码 / 粘贴载入），见 §13 |
| **点 / 拖棋盘上方的位置标尺** | **移动播放游标**（`sequencer.seek()`）—— 按住拖动即擦洗 |
| **⌘/Ctrl + Z** | 撤销 |
| **⌘/Ctrl + ⇧ + Z**（或 `Ctrl+Y`） | 反撤销 |
| **Alt + 左键拖动** | 拉框选择一块矩形 |
| **选区内按住左键拖** | 整块搬走（夹在棋盘内，拖不出去） |
| **⌘/Ctrl + C** | 复制选区（抄进**页面内存**的剪贴板，见 §8-9） |
| **⌘/Ctrl + X** | 剪切选区 = 复制 + 清空 |
| **⌘/Ctrl + V** | 粘贴到**选区左上角**；没有选区就贴回复制时的位置 |
| **A** / **X** | 把选区填满 / 清空 |
| **Esc** | 取消选择（点选区外也一样） |

- **框选**：选区就是一块矩形（`renderer.selection`，已归一化）。Alt+拖画框；
  框内按住左键整体搬走；A 填满、X 清空、Esc 取消。
  点**选区外**会先取消选择再照常涂抹 —— 和图像编辑器的习惯一致。
  - **取消选择有三条路，缺一不可**：① 点画布内、选区外（同时照常涂抹）；
    ② 点**画布外**的页面留白；③ Esc。
    ② 必须靠一条**文档级的 `pointerdown`**（`global.addEventListener`）——
    画布外那些留白上的事件根本不在 canvas 上；就算勉强落到 canvas，
    `cellAt()` 也会因为坐标越界返回 `null` 直接 `return`，选区就杵在那儿不动。
    **踩过**：只写了 ①，用户点四周一大片留白时选区不消失。
    控件区（`.controls` / `.ruler`）要豁免，否则调速度、按播放都会把选区弄丢。
  - **拖动状态（`dragMode` / `dragAnchor` / `move*`）声明在模块级，不在 `bindInput` 里。**
    `applyMove()` 这些 helper 定义在 `bindInput` **外面**；声明在里面的话 helper 访问到的
    是未声明变量，在 `'use strict'` 下直接抛 ReferenceError，而事件处理里的异常会被静默
    吞掉 —— 表现成「按下去什么也没发生」，极难查。**踩过一次。**
  - **搬动每次都从按下那一刻的整张谱子（`moveBase`）重算**，不在上一次结果上叠加。
    位移还要按选区尺寸夹在棋盘内（`Math.max(-s.col0, Math.min(dc, cols-1-s.col1))`），
    否则拖出边界时 `Uint8Array` 会静默丢弃越界写入、整块悄悄缺一块。
  - **选区高亮是青色的（`CONFIG.COLORS.select`），这是本项目新增的色相**：
    基准版只有黑白灰，不留个颜色的话「选中区域」和「亮着的格子」分不出来
    （尤其选了一片全是亮格的区域）。它是**交互状态**，画在合成层最上层
    （辉光之上，`_drawSelection`），**不碰格子图层**。

- **复制 / 剪切 / 粘贴（⌘C / ⌘X / ⌘V）**：剪贴板是 `app.js` 里的一块**页面内存**
  （`clip = {cols, rows, cells, col, row}`），不是系统剪贴板（理由见 §8-9）。四条口径：
  1. **粘贴是「盖章」**：目标矩形按剪贴板内容整个覆盖（**含空格子**），不是合并 ——
     否则「剪切 → 粘贴」还原不出一模一样的图案。`test/interaction.html` 拿一块
     「只有四角」的 3×3 盖在铺满的目标上，断言中空那几格被清掉。
  2. **stride 分两套**：剪贴板内部按 `clip.rows` 编排，写回棋盘按 `grid.rows`。
     矩形面板上混用会整片串位，正方形面板（16 == 16）恰好看不出来 ——
     `test/large.html` 专门守这条。
  3. **整块夹在棋盘内**，不裁掉溢出部分（与 `applyMove()` 同口径）：贴到边缘时
     宁可挪一下起点，也别悄悄丢音。
  4. **一次粘贴 = 一步撤销**（贴出来和现状一样时不占步骤 —— 「⌘C 顺手 ⌘V」不该
     白吃掉一步）；贴完选区落到刚贴上去的那块（能按住直接拖走）。
     没有选区时贴回复制时的列 / 行，所以「⌘X → Esc → ⌘V」能原样放回去。
     同理，剪一块**空的**区域只算复制，不占撤销。
- **复制必须有反馈**：`hint()` 在页面底部弹一条 1.1 秒的反色胶囊（`.hint`，
  `pointer-events: none`）。复制是「看不见的动作」，不吭声的话用户没法确认 ⌘C 生效没有。
- **⌘C / ⌘X / ⌘V 在 `input` / `textarea` 里要放行**（同上面的 ⌘Z）；没选区（复制 /
  剪切）或剪贴板空着（粘贴）时也**不** `preventDefault` —— 别白拦一次浏览器原生行为。

- **撤销的粒度是「一次操作」，不是「一格」。** 快照在**操作开始时**拍
  （画布 `pointerdown` / 清空 / 载入），所以按住拖过一整条只占一步。
  历史里直接存整张 grid 的副本（16×16 = 256 B、64×48 = 3 KB），上限 60 步 ——
  为省这点内存去做增量记录不划算。
  空谱子上点「清空」不占步骤（`if (!grid.any()) return`），否则会攒出一串空撤销。
- **焦点在 `input` / `textarea` 里时 ⌘Z 要放行给浏览器**（判 `e.target.tagName`），
  否则在「谱子」面板里按 ⌘Z 会去撤销棋盘，很出戏。
- **「谱子」面板里的代码是实时同步的**：`grid.onChange` → `refreshShare()`。
  但**只在面板里那段内容没被用户改过时**才刷新（`shareCode.value === shareEncoded`
  才刷）—— 否则用户正在往里粘别人的代码，改一下格子就被冲掉了。

**示例谱与自动填充**

- 示例存在 `dist/js/presets.js`，是**MM3 代码字符串**（不是坐标表）：载入走
  `applyScore()`，与「别人发你的谱子」同一条解码路径，速度 / 音量 / 回环一起套上。
- **示例只出现在大面板**：`index.html` 里没有 `#presets` 这一行，`buildPresets()` 见不到容器
  就直接返回，chip 数组为空 —— 于是自动填充也不会发生。这是产品决定，不是没做完：
  897 列的歌塞进 16 列只剩 9 个音，听不出曲子。
- `presets.js` 里仍保留 `codeSmall`（64 列节选），留给将来 16 列面板若要恢复示例时用；
  当前 `index.html` 不建 chip，所以它不会被用到。
- `loadPreset(i)` 载入前若棋盘非空会 `pushHistory()`（⌘Z 能退回），载入后
  `projectChanged()` 落盘 —— applyScore 的 onChange 发生在 applyParams 之前，
  那一次存的是旧参数，不补这次就会存错。
- chip 的选中态靠 `activePreset`；`grid.onChange` 里有一个「一动笔就 markPreset(-1)」
  的钩子，载入示例自己也会触发它，所以 loadPreset 要在 applyScore **之后**再标记。
- **不做「空棋盘首播自动装示例」。** 曾经有：空棋盘按播放会自动装一段示例再响。
  被否掉了 —— 一按播放就自己冒出谱子，会让人以为那是应用自带的内容，
  而不是一张等你来画的空棋盘。想听示例走 chip，或 URL 参数 `?demo=<id>`。
- **`?demo=<id>`**（`loadDemoFromUrl()`）：`large.html?demo=dango` 打开即铺满全曲，
  但仍**不自动播放**（浏览器要求手势）。它在 `init()` 里排在 `restoreScore()` 之后，
  优先级高于本机存档 —— 显式打开某个示例就该压过上次的工作。
  参数名与 `TM.PRESETS[].id` 对应，改 id 时记得同步。
  想改这两个行为，先想清楚：这个填充是为了「陌生人的第一次点播不该是安静」。
- **写新示例的三条约束**（见 presets.js 文件头）：只用面板音阶内的音；
  16 列以内；**低音不低于 D4（62）** —— 大面板音域下限 61（C#4），
  C4 会被就近对齐成 C#4。改完用 `TM.Store.decode()` 验证往返，
  并对照 `large-config` 的音表确认全部精确命中。

- **没有启动遮罩，`boot()` 只解锁不播。** 浏览器要求 `AudioContext` 在用户手势里
  才能启动，但这个页面上每个动作本身就是手势（点格子 `boot()`、拖游标 `boot()`、
  空格 / 播放走 `togglePlayback()`），所以遮罩是多余的 —— 它只会让每次刷新都多点
  一下才能碰棋盘，还用一层半透明盖住谱子。**别加回来**，
  `test/interaction.html` 与 `test/large.html` 各有一条「没有启动遮罩」的断言。
  `boot()` 仍然**不**调用 `sequencer.start()`：解锁不等于播放，想听到按播放。
  「播放」按钮与空格走的 `togglePlayback()` 才是**解锁 + 真的播**那条路，
  改的时候注意别把「第一次点播放」也变成只解锁。
- **播放游标可以用鼠标拖。** 棋盘上方那条标尺（`#ruler`）宽度 = 棋盘宽度，
  所以「点在标尺的哪一处」直接对应「第几列」。实现见 `app.js` 的 `bindRuler()`：
  pointer capture 做按住擦洗；`seekFromEvent()` 除了 `sequencer.seek()` 还要同步
  `renderer.stepIndex` —— 否则**暂停时游标不会动**（主循环在 `audibleStep()`
  返回 null 时会退回 `renderer.stepIndex`）。
  大面板里标尺是 `.board-frame` 内的 `position: sticky`：纵向吸顶（滚到棋盘
  下半部分也够得着），横向跟着棋盘一起滚（所以位置始终对着同一列）。

- **`pointerdown` 必须判断 `e.button !== 0` 就返回。** 浏览器在右键时会**先**派发
  `pointerdown(button=2)` 再派发 `contextmenu`；不判断按键的话，右键会先把格子翻转，
  然后才发出试听的声音。任何"只有左键才应该生效"的指针处理都要加这道闸。
- 试听的 `contextmenu` 监听挂在 `.canvas-wrap` / `.board-shell` 上而不是 `canvas` 上：
  这样右键落在棋盘周围的留白里也不会弹出浏览器菜单。
- **试听的视觉反馈必须是描边，不能是填充。** `renderer.flash(col, row)` 只在格子边距
  （黑底）上画一圈白色描边，所以明格暗格都看得见。
  - 反例一：用微光做反馈（已删除的 `renderer.pulse()`）—— 暗格整体变亮，像被点开了。
  - 反例二：把描边画成填充白块 —— 就是直接改了格子的颜色。
  - `test/selftest.html` 有断言守着「填充色不变」（实测描边前后都是 51），
    撤掉成就会失败，别绕过去。

- 播放状态以 `sequencer.playing` 为唯一真相，按钮文案由 `syncPlayButton()` 派生，
  不要在事件处理里各自维护一个布尔量。
- 显示开关统一用 `.btn.toggle` 组件：**用 `aria-pressed` 表示状态**（圆点亮度 + 整块明暗），
  **文案里不写「开/关」**，避免按钮宽度随状态跳动。`setGlow()` / `setPlayhead()`
  是唯一入口，状态各自以 `renderer.showGlow` / `renderer.showPlayhead` 为准。
- 控件布局固定为两行（`.ctl-actions` / `.ctl-fields`），参数行是
  `标签 | 滑块 | 数值` 的三列网格 —— 不要在按钮行里混排滑块，否则换行不可控。

## 8. 刻意的设计取舍

这一节记录「为什么是这样而不是那样」，避免后来者顺手改掉又踩一遍坑。

1. **未加限幅器。** 多声部直接相加，由 `destination` 自己钳位。
   不要加 `WaveShaper` 软限幅：其 `oversample` 会引入明显振铃（实测主频不变但混入高频）。
2. **拖动涂抹语义。** 按下时决定目标值，拖动时统一写入。
   如果让拖动复用「翻转」语义，经过同一格会反复 toggle，涂出一条毛边。
3. **播放列高亮。** 除了微光之外，另给一条极淡的列高亮标出当前列，可在控件区关闭。
   微光只说明「这一列的格子亮过」，密集图案下仍看不出游标到底停在哪一列。
4. **方块不做模糊**（见 §6），纯平直角，避免高 DPI 下的糊化与拖动卡顿。
5. **品牌名 Matrix Music。** 页面标题、`<title>`、测试断言里的品牌串必须一致。
6. **空格键 = 暂停 / 继续**，清空不占用快捷键（只剩按钮入口）。
   这是刻意去掉了「空格清空」—— 误触代价太大，别"顺手加回来"。
7. **微光可开关**（`#btn-glow`）。低性能设备上关掉它是最有效的提速手段。
8. **右键试听**。右键某一格会单独播一次该格的音（走同一条发声链路），
   并在该格套一圈描边提示「按的是这一格」；**不动图案，也不改格子填充色**。
9. **选区的剪贴板放在页面内存里，不走系统剪贴板。** `navigator.clipboard.readText()`
   在 Chrome 上会弹「允许查看剪贴板？」、在 `file://` 下又多半直接不可用 ——
   而这个页面双击就能开、连 `npm install` 都不需要，不该为了搬几格音符去要剪贴板权限。
   代价：**跨页面**搬（16×16 ↔ 大面板）用不了 ⌘C / ⌘V，那是「谱子」面板的活（MM3，见 §13）。
   将来真要支持跨页面搬块，走「块级代码（音高式编码，参照 MM3）+ 一次明确的权限提示」，
   别在后台静默读剪贴板。

## 9. 提交约定

- **作者身份写在本仓库的 local 配置里**：`haruki <harukiinharu@gmail.com>`。
  全局配置是另一套身份，所以这里**必须保留 local 覆盖** —— 删掉它，之后的提交就会
  换回全局身份。提交前扫一眼 `git config user.name` 确认。
- **协作署名钩子默认关闭**：`scripts/hooks/prepare-commit-msg` 会在提交信息末尾补一行
  `Co-authored-by: WorkBuddy <noreply@workbuddy.cn>`（幂等，反复 amend 不会叠出第二条）。
  它依赖 `core.hooksPath = scripts/hooks`，而这个配置不进仓库 —— **本仓库当前没有启用**，
  想要就自己跑一次 `git config core.hooksPath scripts/hooks`。
- 提交信息用**中文**，采用 Conventional Commits 前缀：
  `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `test:` / `chore:`
- 正文写清「问题 → 根因 → 改动 → 实测数据」。视觉 / 音频类改动**必须附量化证据**
  （探针读数、离线渲染测量值、测试通过数），不要只说"看起来好了"。
- 每次提交前跑通 §2 的回归。
- **改完即提交**：仓库所有者要求「每次更改完之后，自动 commit」，不需要逐次征求确认。
  除非用户明确说「先别提交」。
- 目前**没有配置远端**（本地仓库）。要发布 Pages 时再按 §11 配远端，
  配之前先确认远端是自己的仓库，且 `core.sshCommand` 带上
  `-o IdentityAgent=none`（本机 ssh-agent 不可用，否则 push 会静默挂死）。

## 10. 调试技巧

- 验证画布视觉问题**不要**在合成结果上做灰度统计 —— 辉光梯度会污染测量。
  应直接读对应图层的 `getImageData`（见 `test/sharp.html`）。
- **页面级测试不要断言渲染后的像素**。无头环境里 rAF 与 `setTimeout` 的推进节奏不一致：
  定时器可能跑得飞快而合成帧还没发生，固定等待与轮询都会拿到过期画面。
  用 `index.html?debug=1` 暴露的 `__matrixMusicDebug` 直接读模型状态；
  需要验证渲染链路时**显式调一次 `renderer.composite()`** 再读像素。
- **轮询 `waitFor` 会误判**：拿初始 HTML 文案当目标值时（如按钮默认就写着「暂停」），
  条件立刻成立，等于没等。要等**状态量**（`sequencer.playing`），不要等派生的文案。
  同理 `audio.ready` 在 `buildGraph` 里就置位了，早于 `sequencer.start()`，不能拿它当"启动完成"。
- **量 canvas 性能必须强制同步**：`getImageData(0,0,1,1)`，且要同步**对应的那个 canvas**
  （只 flush 主画布量不到离屏图层的工作）。否则 `performance.now()` 只统计到 JS 提交时间，
  会得到 0.27ms 这类假数据。
- **性能探针：一个浏览器进程只测一个配置，并多轮取中位数。** 在同一页面里连着量
  两种规格，第二组会被前一组拖慢 —— 实测同一操作给出过 12.9 / 28.0 / 76.4 ms
  三种结果（差 2.7 倍），是显存压力下的降级，不是被测代码的问题。
  模板：`?which=small|large` 由 query 选配置 → 每配置单起一次无头 Chrome →
  热身 4 轮 × 10 次 → 采样 9 轮 × 10 次 → 报中位数/最小/最大。
  **单次读数一律不可信**，宁可多花 30 秒起两个进程。
- 无头环境下 **`OfflineAudioContext` 只渲染一次**，第二次 `startRendering()` 不会推进
  （会卡住）。需要多个渲染场景时，合并到一次渲染里，或用单元测试覆盖。
- 截图核对：`--headless=new --force-device-scale-factor=2 --screenshot=...`，
  再用 Pillow 做像素分析。
- macOS **没有 `timeout` 命令**，用了会 `exit 127` 且无输出，别误判成"页面挂了"。
- 画面「逐渐被填满 / 发白」这类问题，**先量模型状态，不要盯着截图猜**：
  把微光场按帧打印成 ASCII（见 `test/glow.html`），
  能立刻区分是「衰减不动」还是「被持续驱动」，也能顺手确认正常播放是否有界。
- **探针本身也会写错**，跑之前先自检两件事：索引对不对（`stepDiffusion(n)` 播种的是
  `n+1` 列，不是 `n` 列）、单位/取整有没有吃掉信号（`Math.round(0.85)` = `1`，
  会让你以为场是空的；要用 `Math.round(v * 1000) / 1000`）。
- **模拟用户操作要按真实事件序列派发**。右键在浏览器里是
  `pointerdown(button=2)` **加** `contextmenu` 两个事件；只派发后者测不出
  "右键把格子翻转了" 这类 bug（曾经就这么漏掉了）。拖动同理，是
  `pointerdown` + 若干 `pointermove`。
- **写完回归测试，把修复撤掉再跑一遍**，确认它确实会失败。
  不会失败的回归测试等于没写。撤掉后失败的条目数应与新增断言数吻合。
- **负向断言先确认前置状态是非平凡的。** 「删除之后数量不变」「撤销之后没变化」
  这类断言，如果被作用的对象**本来就是空的**，撤掉实现也照样绿 —— 等于没写。
  已经踩过两次：在空时间轴上验证「seek 清空时间轴」，在空选区里验证
  「焦点在输入框时 X 不动选区」。**先断言前置状态（`count === 2`），再断言结果。**
  变异验证就是用来抓这种假断言的 —— 它专门暴露「撤掉实现也不红」。
- 改速度相关的逻辑时，重点验证 60 / 90 / 120 / 180 / 240 BPM 五个点。

## 11. 发布与部署

- **目前没有配置远端** —— 这是本地仓库，历史从初始提交开始。
- 要发布时，在自己的账号下建同名仓库再接远端（下面的 ssh 别名按你本机 `~/.ssh/config`
  里的实际写法替换）：

  ```bash
  git remote add origin github:haruki/matrix-music.git
  # 本机 ssh-agent 是坏的（SSH_AUTH_SOCK 指向无人应答的 listener），
  # 不加下面这行 push 会静默挂死 —— 端口 22 可达、BatchMode 也救不了。
  git config core.sshCommand "ssh -o IdentityAgent=none"
  git push -u origin main
  ```

  推上去后在网页端启用 Pages（Source 选 GitHub Actions）。
- **自动化**：`.github/workflows/deploy.yml`。push 到 `main` 即触发：
  跑 `scripts/ci-test.sh` → 组装 `_site/` → 部署到 Pages。**回归不通过就不部署。**
- 只有 `index.html` / `large.html` / `style.css` / `src/` / `test/` / `AGENTS.md` 会被发布；
  `.github/` 与 `scripts/` 不进站点。README.md / screenshot-*.png 只进仓库
  （GitHub 渲染 README 时解析相对图片），不进 Pages 站点 —— 站点首页就是应用本身。
  **改发布范围时记得同步 `deploy.yml` 的 `cp -R` 行**：那里列了谁就复制谁，
  少列一个文件会让整个部署直接失败。
- 站点是**项目页**（仓库名就是路径前缀），所有资源引用必须保持**相对路径**，
  不要写成 `/src/...`，否则在 `<user>.github.io/matrix-music/` 下会 404。
- 本地跑同一套回归：`bash scripts/ci-test.sh`
  （退出码 0 = 通过，1 = 有失败；找不到 Chrome 会跳过并返回 0）。
- 发布新版本：`git tag -a vX.Y.Z -m "..."` 并 `git push origin main --tags`。

## 12. 两套面板：16×16 与 32×64

同一个引擎跑两种规格，靠的是把**维度**从常量里解耦到 `TM.RUNTIME`。

| | 基准版 `index.html` | 大面板 `large.html` |
|---|---|---|
| 列（时间步） | 16 | 64 |
| 行（音高） | 16 | 48 |
| 音阶 | D 大调**五声**（1 2 3 5 6） | **半音阶**（相邻行差 1 个半音，像吉他每格一品） |
| 音域 | A6 → A3（3 个八度） | A7 → A#3（47 个半音，将近 4 个八度） |
| 一圈 | 1 小节 = 2 s @120BPM | 4 小节 = 8 s @120BPM |
| 格子 / 方块 | 32 px / 26 px | **32 px / 26 px（与基准版逐像素同尺寸）** |
| 画布 | 512×512 | 2048×1536（1:1 上屏，装不下就在框内滚动） |
| 配置来源 | `CONFIG`（缺省） | `dist/js/large-config.js` 覆盖 `TM.RUNTIME` |

**步长不变**：`RESOLUTION` 两种规格都是 16 步/小节，所以大面板变长的是**段落**，
不是音符时值 —— 同一个速度下，两版单步的时长完全一致。

**音阶可换**：`TM.buildScaleTable(rows, topNote, scale)` 从 topNote 起逐级下行，
`scale` 是「相对 A 的半音偏移」升序数组，见 `TM.SCALES`。
`buildScaleTable(16, CONFIG.NOTES[0], TM.SCALES.pentatonic)` 会**逐位复现基准版
`CONFIG.NOTES`** —— `test/large.html` 拿这条校验生成器本身没写错，改生成器时
先看这条有没有红。

**两版之间没有「行号平移对应」关系** —— 音阶完全不同，同一份图案搬过来音高会变。
行 0 取基准版最高音**再高一个八度**（`CONFIG.NOTES[0] + 12` = A7），48 行往下铺到
A#3，所以整块棋盘把基准版的音域整个包住了。

> 注意 48 行铺 108..61，基准版 16 个音里有 15 个落在表内，**只有最低的 A3(60)
> 差一个半音**（底部是 A#3）。`test/large.html` 有一条断言把这条边界钉死。
> 再加八度 = `TOP + 12` 且 `ROWS + 12`，**底部不动** —— 旧表会原样落成新表的
> 行 12..47，有断言守着这个「加八度不动底部」的性质。

`SCALES` 里三张音阶都留着：`pentatonic`（基准版规格，用来校验生成器）、
`major`（D 大调七声，上一版大面板用过）、`chromatic`（当前大面板）。
换音阶只要改 `large-config.js` 里的一个参数，行数与音域都不用动。

### 改这里时容易踩的坑

矩形网格（`cols ≠ rows`）会引入正方形网格下不存在的一类 bug，**全都踩过**：

- 一维数组的 stride 必须是 `rows`：`index = col * rows + row`。写成 `cols` 会让
  右下角落到数组之外被 Uint8Array **静默丢弃**（不报错）。
- 音序器绕回按 `cols` 取模，行扫描按 `rows` 循环。写死 `CFG.GRID` 会让第 16 步
  提前归零、且后 16 行永远播不到。
- 命中测试（`app.js` 的 `cellAt`）要分别用 `grid.cols` / `grid.rows`。
- 微光场是 `rows × cols`（`glow[行][列]`），`create2DMap(rows, cols)` 别接反。
- 越界判断要分别看 `cols` 与 `rows`。

### 布局：不缩放，可滚动

大盘面的方块**与基准版逐像素同尺寸**，代价是棋盘 2048 × 1024 —— 既超出笔记本横向视口，
也超出纵向视口（32 行 × 26px 光棋盘就 1024px 高）。这是几何决定的：想同时要
「大盘面」和「基准版大小的方块」就必然要滚动。所以大盘面的布局是：

- **整页高度锁死**（`body.wide` 是 `height:100dvh` 的 flex 列 + `overflow:hidden`），
  滚动条**收进 `.board-frame` 里** —— 页头、控件、页脚永远不动。这是关键：
  让 `body` 去滚的话，一滚页头控件全跑掉了。
- `.canvas-wrap` 的 CSS 宽高由 `large-config.js` 写进 `--board-w` / `--board-h`，
  **等于逻辑尺寸**，这样无论 dpr 多少都 1:1 上屏、浏览器不做二次重采样
  （`test/large.html` 有断言守着这条，它是「方块一样大」在上屏环节的保证）。
- `.board-frame` 用 `overflow:auto` + `max-width/height` = 棋盘尺寸：**装得下就没有
  滚动条**，装不下才滚。实测 2560×1300 时横向纵向都是 100%，一格都不用滚。
- 框内的 `.canvas-wrap` 用 `margin: auto` 居中，**不要**改用 flex 的
  `justify-content: center` —— 后者在内容溢出时会把起始边挤出容器、
  且那个方向永远滚不到（经典陷阱，踩过）。
- `.overlay` 挂在 `.board-shell` 上（滚动框**外面**），否则「点击开始」会跟着
  2048×1024 的棋盘一起被滚出可见区。`app.js` 的 contextmenu 监听也因此优先挂
  `.board-shell`。
- 控件栏另限宽 900px 居中：跟 2048 的棋盘同宽的话滑块会拉成一条 2000px 的线。

**实测各屏可容纳程度**（页头+控件+页脚共占 277px）：

| 视口 | 滚动框 | 横向可见 | 纵向可见 |
|---|---|---|---|
| 1512×747（14" 笔记本） | 1480×493 | 72% | 32% |
| 1512×982（最大化） | 1480×728 | 72% | 47% |
| 2560×1450（2K） | 2048×1196 | **100%** | 78% |
| 2560×1800（2K 足够高） | 2048×1536 | **100%** | **100%** |

笔记本上纵向只能看到三分之一左右，这是 48 行 × 26px 的方块尺寸决定的，**不是 bug**。
想整块可见又不想滚，只有「减行数」或「缩小方块」两条路，都改变手感，别擅自选。

> 曾经把格子减半到 16px 想塞进屏幕，但按比例算出的 `inset` 是 1.5，在 1x 屏上
> 方块边界落在半像素、被抗锯齿糊出灰边（实测过渡值 25 / 119，而整数内缩下灰度只
> 出现 `0 / 51 / 238` 三个值）。既然要跟基准版一样大，索性连格子尺寸一起沿用基准版。
> **如果将来要动 `cell`，`inset` 必须保持整数。**

### 参数怎么定的（都有实测依据）

- **微光层刻意远低于画布分辨率**：基准版 512×512、大面板 512×384（画布是 2048×1536），
  合成时放大 4×。它本来就模糊，按画布分辨率渲染纯属浪费。`blurGlow = 3`：
  这里一个微光格 = 512/64 = 8px，基准版是 512/16 = 32px、模糊 12，
  取 `8 × 12/32 = 3` 两版的光晕柔和程度才一致。
  > 光晕层尺寸只影响成本、不影响观感：大面板实测 1024 时每帧 `5.3 ms`，
  > 512 只要 `1.2 ms`，而放大到画布上看不出差别。**别再往大调。**
- **每帧开销（无头 Chrome / dpr2 / 硬件 GPU）**：微光推进 `1.4 ms`（16×16）
  / `1.2 ms`（64×48）。整帧的大头仍然是**合成**：把 2048×1536 的格子层上屏
  约 `28 ms`，基准版整帧 `5.2 ~ 6.7 ms` → 大面板 `30.1 ~ 32.1 ms`（约 5×），
  拖动 ~0.6 → ~1.8 ms（点格子本身仍然跟手）。
  设备层面积 1.0 → 12.6 Mpx，耗时的放大倍数与面积基本同步，**是固有代价**
  （格子层必须按设备分辨率 1:1 上屏，见 §6）。已经明显越过 60fps 的 16.7 ms 预算，
  微光会掉到 30fps 上下、偶尔更差。
- **⚠️ 量这里的性能必须「一个浏览器进程只测一个配置」。** 在同一个页面里连着量
  基准版和大面板，第二组会被显著拖慢 —— 实测同一操作能给出 12.9 / 28.0 / 76.4 ms
  三种结果（最多差 2.7 倍），是显存压力导致的降级，不是代码问题。
  正确做法：一次进程只构造一个 Renderer，热身 4 轮后采 9 轮取中位数
  （见 §10「性能探针」）。**别信单次读数。**
- 要再降只能改渲染模型（例如把辉光拆成独立的 `mix-blend-mode` 图层、
  不再每帧整块重合成，格子层只在改动时更新），那是独立的一件事，别顺手做。

**加新规格面板的步骤**：写一个 `dist/js/xxx-config.js` 覆盖 `TM.RUNTIME`（含
`notes`），照 `large.html` 复制一份页面并把脚本插在 `constants.js` 之后，
然后 **记得同步 `deploy.yml` 的 `cp -R` 行**。

## 13. 乐谱的保存与导入导出

`dist/js/storage.js` 负责两件事：**自动保存**（localStorage）与**导入导出**（一段自包含代码）。

### 格式：MM3（当前）

```
MM3.<base64url( LZW( UTF-8( JSON ) ) )>
```

JSON 明文（短键省的是压缩前的字符数）：

```json
{ "c": 16,                                 // 列数
  "n": [[2,[84,72]], [5,[79]]],            // 有音符的列 → 音高（升序）
  "in": 0, "out": 15,                      // 回环区间（闭区间，列号）
  "bpm": 120, "vol": 85 }                  // 速度 / 音量（百分比）
```

**代码装的是「整份工程状态」，不只是音符。** 别人打开你的链接，速度、音量、回环
都要跟过来 —— 否则他听到的和你做的不是同一首歌。

为什么从稀疏二进制换成 JSON 再压缩：

- 加一个状态字段只需要加一个键，不用动编码器、解码器和版本号；
- 解开压缩直接可读（`TM.Store.decode()` 就还你一份 JSON），排查问题不用写解码器；
- 代价是**更长**（见下表）。这是「完整工程状态」换来的，认了。

压缩是自己写的 LZW（`lzwEncode` / `lzwDecode`）：本项目零依赖，而 `CompressionStream`
是异步的，会把这套同步 API 全打乱。码宽 9→16 位自适应，**不要退回固定 16 位** ——
那样每个 ASCII 码都要白搭一个 `0x00` 字节，base64 之后仍然白白胖三分之一。

两个必须守住的细节：

1. **编解码两侧的码宽要严格同步。** 解码器比编码器晚一步才补上字典项（第一码没法补），
   所以两侧共用 `widthFor()`，但解码侧传 `next + 1`。
2. **LZW 解出来的是「码点串」，不是字节。** 必须先 `strToBytes()` 再 `utf8Decode()`，
   否则每个字符都被当成多字节序列的首字节，解出一串 NUL（踩过，而且 JSON.parse 的
   报错信息完全指不到这里）。

### 为什么按音高存，而不是按行号

直觉上存 (列, **行号**) 就够了，但行号是**相对**的：

- 大面板加一个八度，行号整体平移（A6 顶 → A7 顶，旧行 0 变成新行 12）；
- 换音阶（五声 ↔ 半音阶）会重新定义每一行是什么音。

所以按行号存的谱子一改规格就整体跑调。这里存的是**音高本身**（与 `CONFIG.NOTES`
同一套编号，72 = A）。载入时：

- 目标面板有那个音高 → 精确落到对应行；
- 没有 → **就近对齐**到最接近的一条行（同面板载入时全部精确命中，不会触发）；
- 列号超出目标宽度 → 丢弃。

`applyCode` 会返回 `placed / snapped / dropped` 三个计数，UI 如实显示（`describeLoad`），
外加 `params`（代码里的速度 / 音量 / 回环）—— **storage 不套用参数**，套不套、怎么套
由 `app.js` 的 `applyParams()` 决定，存储层不该知道滑块和音序器的存在。

### 容量（实测）

16×16：

| 音符数 | 空 | 1 | 3 | 满格 256 |
|---|---|---|---|---|
| MM3 | 64 | 74 | 94 | 480 |
| MM2（旧） | 10 | 12 | 22 | 108 |

64×48：

| 音符数 | 1 | 10 | 40 | 192 | 满格 3072 |
|---|---|---|---|---|---|
| MM3 | 76 | 107 | 194 | 492 | 3010 |

解码对列数 / 音高 / 音符总数 / 正文长度都做了上限校验，畸形代码会明确报错
（`decode` 返回 `{ok:false, error}`），不会静默少读几个音。

### 向后兼容

- `MM2` = 按音高的稀疏二进制（`MM2.<base64url>`），只有音符没有参数。仍然能解，
  解出来的 `params` 是 `undefined` —— 载入时**不覆盖**用户当前的速度 / 音量 / 回环。
- `MM1` = 旧的稠密位图（`MM1.<cols>x<rows>.<base64url>`），**尺寸耦合**。
  仍然能解，但只认尺寸完全一致的网格 —— 它的行号 ↔ 音高对应关系写在当时的面板配置里，
  现在重建不出来，所以载到大面板会明确拒绝并说明原因。
- 存储键从 `matrixmusic.pattern.<cols>x<rows>` 换成了 `matrixmusic.score.<面板 id>`。
  `load()` 在新键读不到时会**退回旧键一次**，`applyCode` 成功后下次自动保存就写到新键，
  迁移自然完成（旧键不删，保留兜底）。

### 约定

- **存储键按面板身份、故意不含尺寸**：`matrixmusic.score.small` / `matrixmusic.score.large`。
  以后再加/减八度，键不变，用户存在本机的那份工程自动接着用。
  面板 id 来自 `TM.RUNTIME.id`（`constants.js` 里缺省 `small`，`large-config.js` 设 `large`）。
- **回环区间不再单独存一个键**（原 `matrixmusic.loop.<id>` 已删）：它进了 MM3，
  一个状态只有一个真相来源。改回环 → `projectChanged()` → 防抖存档 + 刷新代码。
- **载入优先级：URL hash > localStorage**。hash 用过一次就 `replaceState` 清掉 ——
  否则那条旧链接会在每次刷新时盖住之后自动保存的新内容，用户改完一刷新发现被打回原样。
- 自动保存是**防抖 300ms 静默**写，另外挂 `pagehide` 补一次（防抖窗口内关页面会丢）。
  务必在 `restoreScore()` **之后**再挂 `onChange` 钩子，否则载入本身会立刻回写一遍。
- **初始化时补一次 `applyLoop(..., {silent:true})`**：载入的代码可能是旧格式（没有回环），
  也可能根本没有存档 —— 不补这一步，标尺的区间高亮会停在初始的「未隐藏」状态，
  看起来像整条标尺被选中。
- `encode(grid, notes, params)` / `save(grid, notes, params)` / `applyCode(grid, text, notes)`：
  形状是「网格 + 行→音高表 +（可选）参数」。音高表缺省取 `TM.RUNTIME.notes`。
  **这层耦合是刻意的**：音高是这段数据唯一稳定的坐标。
- `Grid.prototype.replaceAll` 只发**一次**变更事件（走渲染器整层重绘）。逐格 `set`
  会触发 3000+ 次局部重绘和同样多的微光点亮，载入会明显卡一下。
- 所有 localStorage 调用都包在 try 里（隐私模式 / 配额满 / 被策略禁用不该把页面搞崩）。

### 踩过的坑

- **「复制」的反馈不能挂在 clipboard promise 上。** 无用户手势、无权限或 `file://` 下
  `clipboard.writeText` 可能既不 resolve 也不 reject（实测如此），按钮点了完全没反应。
  正确做法是**先同步**给出确定反馈（「已选中，按 ⌘C」），写入成功再升级文案。
- **`Array.prototype.concat` 不会展平 `Uint8Array`。** `[a].concat(head, body)` 里
  `body` 是个 TypedArray 时会被当成**一个元素**塞进去，结果是只有走普通数组的那条
  分支（稀疏编码）看起来正常，稠密分支静默产出垃圾。要用 `Uint8Array.set()` 拼。
  这个 bug 是被「满格谱子往返」那条断言抓出来的 —— 稀疏路径它测不到。
- **写两个编码分支，就必须有分别覆盖两条分支的断言。** 上面那个 bug 活过了整套
  「往返一致」测试，因为典型谱子全都走稀疏分支。测试里要**显式**构造一个密铺到
  满格的谱子，逼编码器切到稠密分支。
- `.ctl-row` 自带 `display: flex`，会**盖掉** `[hidden]` 的 `display: none`
  （作者样式优先于 UA 样式表）—— 隐藏面板必须显式写 `.ctl-row[hidden]`。
- 页面级测试要求「初始网格为空」，而乐谱现在会自动恢复。测试页必须在 **iframe 开始
  加载之前** 清掉 localStorage 的对应键（`test/interaction.html`、`test/large.html`
  里都有这段，位置不能挪到 iframe 后面）。
