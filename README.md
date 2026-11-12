# cindy-plugin-aseprite · Aseprite 工具箱

让 Cindy 能读、能导出 Aseprite `.aseprite` 文件。**不解析二进制**：结构化信息靠随包 Lua 脚本在
`aseprite.exe` 里跑出来，导出全部走 `aseprite.exe` 的命令行参数，正确性由 Aseprite 官方保证。

```
cindy-plugin-aseprite/
├── aseprite-cli/            ← 插件源码（= ghost_forge_pack 的目录）
│   ├── ghost.json
│   ├── main.js              ← 电子脑：浏览器沙箱，只做参数转发与媒体寄送
│   ├── settings.html/.js    ← 设置页：aseprite 路径、导出落点、sheet 默认值
│   └── node/worker.cjs      ← 随包 Node 工作进程：所有本机文件读写 + spawn aseprite.exe
├── tests/                   ← 单测 + 真机端到端冒烟（PASS/FAIL/SKIP）
└── tmp/                     ← 测试落点（不入库）
```

## 六个工具

| 工具 | 干什么 | 是否写盘 |
| --- | --- | --- |
| `ase_doctor` | 检查 aseprite.exe 路径、版本、所需 CLI 参数是否齐全 | 否 |
| `ase_info` | 结构 dump 成 JSON：尺寸/色彩模式/帧时长/图层树/标签/切片/调色板/tileset | 否（临时脚本用完即删） |
| `ase_preview` | 导出指定帧为 PNG → 存进 Cindy 媒体库 → 聊天里直接显示 | 仅系统临时目录 |
| `ase_export_frames` | `--frame-range` / `--tag` + `--save-as`，逐帧 PNG | 是（导出目录） |
| `ase_export_sheet` | `--sheet` + `--data`，sprite sheet PNG + 帧表 JSON | 是（导出目录） |
| `ase_export_layers` | `--split-layers` + `--save-as`，逐层 PNG | 是（导出目录） |

### 导出落点（按份数自动判定）

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 本次产出 **≥2 个文件** → `<源文件目录>\exports\`（不存在就建）；**只 1 个** → 源文件同目录 |
| `always` | 一律 `<源文件目录>\exports\` |
| `same` | 一律源文件同目录 |

单次调用还可以用自己的 `out_dir` 参数覆盖上面三者（优先级最高）。

**同名文件不会被静默覆盖**：目标名已存在时自动加 `-2`、`-3` … 后缀，并在工具结果里逐条列出
`原名 → 新名`。同一批导出之间也不会互相撞名——`name_template` 必须带 `{frame}`/`{frame1}`
（逐帧）或 `{layer}`+帧号（逐层），否则直接报错而不是悄悄覆盖。图集是 png + json 两个文件，
重名时成对改名（`<名>-2.png` + `<名>-2.json`），并把帧表里的 `meta.image` 同步改成新文件名。

实现上不是"猜份数"：导出先进系统临时目录的暂存区，数清份数后按规则搬到最终落点——这样
`auto` 的判定永远和真实产出文件数一致。**源文件永远是只读的。** 不做批量。

## 环境要求

- 本机装 Aseprite（实测 1.3.18.6-x64，Steam 版），愿意用它的命令行。
- 路径解析顺序：设置页填的路径 → 环境变量 `ASEPRITE_PATH` → `PATH` → 常见安装目录 → 各盘
  `SteamLibrary` / `Steam` 库扫描。`ase_doctor` 会把命中的路径、来源和缺失参数都列出来。
- 插件零依赖，不联网，不需要单独装 Node。

## 实测确认的 CLI 事实（Aseprite 1.3.18.6-x64）

这些都在真机上用真实的 `.aseprite` 样本跑过，不是抄文档：

**生效**

- `--script`、`--script-param`、`--save-as`、`--sheet`、`--data`、`--format`、`--sheet-type`、
  `--split-layers`、`--split-tags`、`--frame-range`、`--tag`、`--scale`、`--trim`、`--ignore-empty`、
  `--border-padding`、`--shape-padding`、`--inner-padding`、`--list-layers`、`--list-tags`、`--list-slices`
- `--format` 只认 `json-hash`（缺省）和 `json-array`
- `--sheet-type` 只认 `horizontal` / `vertical` / `rows` / `columns` / `packed`
  （同一个多帧样本实测：`horizontal` / `vertical` 分别是 1×N 与 N×1，`rows` / `columns` 给近方形排布，
  `packed` 会重排并可能补留白）
- `--save-as` 占位符：`{title}`、`{frame}`（0 起）、`{frame0}`（0 起，同 `{frame}`）、
  `{frame1}`（1 起）、`{layer}`、`{tag}`、`{tagframe}` / `{tagframe0}`（标签内 0 起）、
  `{tagframe1}`（标签内 1 起）、`{duration}`（该帧时长 ms）。`{layer}` 必须配合 `--split-layers` 才有值
- **一个模板里只能有一个帧号占位符**：实测 `{frame1}__{frame}` 出来是 `1__{frame}.png`——
  先匹配到的那个被替换，后面的原样留在文件名里。`{layer0}` / `{x}` 这类不存在的占位符同样原样保留
- 配 `--tag` 时 `{frame1}` / `{tagframe1}` 都变成**标签内序号**（实测 `--tag walk` + `{title}-{frame1}.png`
  → `<原名>-1.png` … `<原名>-N.png`，N 是该标签内的帧数）；不配 `--tag` 时 `{tag}` 取文档里第一个标签名
- `--frame-range a,b` 与 `{frame}` 一致，**0 起**；只影响 `--save-as` 的导出

**帧号：CLI 是 0 基，工具层是 1 基（最容易整体错一帧的地方）**

- `--frame-range a,b`、`{frame}`、`{frame0}` 都是 **0 基**；只有 `{frame1}` 是 **1 基**
- 踩坑实测：`--frame-range 7,7 --save-as f7.png` 导出的其实是人话的 **第 8 帧**；
  全量 `frame_{frame}.png` 得到 `frame_0` … `frame_18`，其中 `frame_6` 才是第 7 帧。
  **照着文件名猜帧号，会整体错一帧**
- 本插件的策略：**工具入参一律 1 基**（`from` / `to` / `frame`），内部再换算成 CLI 的 0 基；
  默认模板 `{title}-{frame1}.png` 用的是 1 基，所以导出文件名里的帧号与 Studio 里看到的一致。
  想要 0 基文件名，得自己在 `name_template` 里显式写 `{frame}`（或 `{frame0}`）
- 另一个坑：`{frame}` / `{frame0}` / `{frame1}` 的序号都是 **相对本次导出区间**的（2026-11-12 复测：
  `--frame-range 4,5 --save-as q-{frame}.png` → `q-0.png` / `q-1.png`），配 `--tag` 时相对标签。
  也就是说文件名里的数字**不是**全局帧号，只靠文件名永远还原不出来
- `ase_export_frames` 返回里的 `frameMapping`（`[{ file, frame1, frame0 }]`，顺序即帧序）就是
  文件名 ↔ 帧号 的唯一对照：`frame1` 与 Studio 一致，`frame0` 是 CLI 的 0 基编号。
  配 `--tag` 导出时文件名里是标签内序号，`frameMapping` 已换算成全局帧号
- 核对帧内容请用 `ase_preview`（1 基、直接读盘），**不要靠导出文件名反推帧号**

**不存在 / 无效（踩过的坑）**

- `--padding` 不存在 → `Invalid option --padding`（写在 stderr）。可用的是
  `--border-padding`（图集四周）/ `--shape-padding`（帧之间）/ `--inner-padding`（帧内）
- `--frame-range`、`--tag`、`--oneframe` 对 `--sheet` **完全无效**：图集依旧是全 sprite。
  （Lua 的 `app.command.ExportSpriteSheet{ frameRange=…, tags=… }` 同样无效）
- `--split-layers` 配 `--sheet` 静默无效，只认 `--save-as`
- `--all-layers` 实测**没有任何效果**：隐藏图层不会因此被画进合成图，也不会被 `--split-layers` 带出来
- `--oneframe` 对 `--sheet` 无效
- `--data` 与 `--save-as` 同时给时，`--data` 描述的仍是整个 sprite（不是导出的那几帧）
- `--ignore-empty` 不可靠：首轮记录是「sprite 里存在空帧时会让整次导出变成 0 个文件」。
  2026-11-12 用 Lua 现造的 3 帧 sprite（只有第 1 帧有 cel）复测：不加 → 3 个文件，加 → 1 个文件，
  空帧被正常跳过（且保留下来的帧序号重排成 1）。两种结果对不上，故这条仍按「待复核」处理；
  插件**不暴露**该开关
- 非法 `--sheet-type` 不报错，静默退回 `horizontal`
- `--split-tags` 行为随模板变，不可预测（1.3.18.6 实测，多帧多标签样本）：
  模板 `plain.png` → 每帧一个文件，命名 `plain #<tag> <标签内序号0起>.png`；
  模板 `{title}-{frame1}.png` → 每个标签一个文件（`{frame1}` 变成标签序号）；
  模板 `{tag}-{tagframe1}.png` → 每帧一个文件，命名 `<标签名>-1.png` …（标签名 + 标签内 1 起序号）。
  插件不暴露它

**必须当心**

- `aseprite.exe` **无论成功失败退出码都是 0**：`File not found: "x.aseprite"` 写在 **stdout**，
  `Invalid option` 写在 stderr。所以只能靠「文本匹配 + 产物是否真的出现」判定成功
- 帧范围越界不会报错，而是**静默导出一张全透明的空白 PNG**；因此 `ase_preview` /
  `ase_export_frames` 会先用 Lua 数一遍 `#sprite.frames` 做校验（结果按 mtime 缓存）
- `--script-param` **必须写在 `--script` 之前**，否则 `app.params` 读到 nil。
  本插件的 Lua 脚本干脆把输入/输出路径内联进源码，绕开这个顺序坑
- `--script` 的 Lua 里 `print()` 落在 stdout，`io.open` 可写文件，`json.encode` 可用，
  中文路径 UTF-8 正常。Lua 报错时退出码是 127（这是唯一能信退出码的地方）

## Lua 侧读到的 Aseprite API（1.3.18.6）

- `app.open(path)` → Sprite；`sprite.width/height/colorMode/frames/layers/tags/slices/palettes/tilesets/gridBounds`
- 图层：`name`、`isVisible`（**不是** `visible`）、`opacity`、`blendMode`（数值，`BlendMode` 表可反查；
  分组层的 `opacity` / `blendMode` 是 nil）、`isGroup`、`isImage`、`isTilemap`、`isBackground`、`parent`、`layers`
- 标签：`name`、`fromFrame/toFrame`（Frame 对象，取 `.frameNumber`，1 起）、`frames`（帧数）、
  `aniDir`（`AniDir.FORWARD/REVERSE/PING_PONG/PING_PONG_REVERSE` = 0/1/2/3）、`color`。
  没有 `tag.direction`、没有 `tag.repetitions`
- 切片：`name`、`bounds`、`center`（九宫格中心，没有时为 nil）、`pivot`（没有时为 nil）。
  没有 `hasCenter` / `hasPivot`
- 调色板：`#palette` 是色数，`palette:getColor(i)` **0 起**（0 … n-1）
- tileset：`name`、`baseIndex`、`#ts`（块数）、`ts.grid.tileSize.width/height`。
  没有 `getTileCount()` / `tileWidth`
- 帧：`frames[i].duration`（秒，浮点，100ms → 0.1）；没有 `frame.name`
- 颜色：`c.red/green/blue/alpha` 都是 0–255

## 设置（`/kv`）

| 键 | 含义 | 缺省 |
| --- | --- | --- |
| `asepritePath` | aseprite.exe 完整路径，留空则自动搜索 | 空 |
| `exportDirMode` | 导出落点：`auto` / `always` / `same` | `auto` |
| `sheetType` | 图集布局 | `horizontal` |
| `shapePadding` | 帧间距 | `0` |
| `borderPadding` | 图集四周留白 | `0` |
| `scale` | 默认导出缩放 | `1` |

设置页有「自动检测」按钮，经 BroadcastChannel 让电子脑跑一次 `ase_doctor`，把命中路径回填。
老的 `exportSubdir: true/false` 会自动迁移成 `always`/`same`（缺省 `auto`）。

## 权限与边界

- 声明 `node`：工作进程拥有**当前登录账号的本机权限**，能读文件、起进程。所有 aseprite 调用都在这里。
- 声明 `cindy.media: ["deposit"]`：`ase_preview` 把 PNG 寄进媒体库换指纹，聊天里才能直接显示。
- 不声明 `network`：一个外部请求都不发。
- 只读源文件；只写导出目录与系统临时目录（临时文件用完即删）。

## 测试

```bash
node tests/run.cjs
```

- `tests/unit.test.cjs`：参数拼装、帧号换算（1 基 → 0 基边界）、`frameMapping` 生成逻辑、
  落点决策、错误识别、PNG 头解析、清单与代码一致性（不需要 aseprite，任何机器都能跑）
- `tests/e2e.test.cjs`：真机冒烟，用 `ASE_SAMPLE` 指定的 `.aseprite` 跑通六个工具（断言值全部从样本结构
  现算，不写死任何具体数字），含「`frameMapping` 与落盘文件名、帧号三者一致」的核对；并自建一个带分组/切片/
  九宫格/轴心/tileset 的 fixture 验证结构 dump；样本文件和样本目录的 sha256 / 清单前后比对
- 缺环境（找不到 exe 或没设 `ASE_SAMPLE`）时这些用例打印 `SKIP` 而不是 `FAIL`
- 可用 `ASEPRITE_PATH` / `ASE_SAMPLE` 指定 exe 与样本；仓库里不带任何样本文件

## 已知限制

- 图集不支持按帧范围或标签筛选（本机 Aseprite 版本的限制，见上）；要子集请先 `ase_export_frames`。
- `ase_export_layers` 只导可见图层；隐藏层导出在本机版本下没有可用参数。
  分组图层会连同子层各出一张（与 Aseprite 的行为一致）。
- 落点判定看的是**本次实际产出的文件数**（图集恒为 2 → 默认进 `exports/`；单帧预览不落用户盘）。
- 图层名里带 `\ / : * ? " < > |` 时会让文件名非法（`{layer}` 由 Aseprite 直接展开，插件不替换）。
- 单次调用 120 秒沉默超时 / 10 分钟总上限；超大 sprite 请缩小帧范围或降低 `scale`。
- 预览图走 base64 送回电子脑，单张上限约 600KB（超出自动降采样），故意不放大图。
