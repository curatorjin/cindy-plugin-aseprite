'use strict';

/**
 * 端到端冒烟：真机跑 aseprite.exe。
 * 环境不具备（找不到 exe / 找不到样本文件）时打印 SKIP，不算 FAIL。
 *
 * 约定：
 *  - 所有导出都写进 仓库的 tmp/ 或系统临时目录，跑完清理；
 *  - 样本文件只读：跑完比对 md5，并比对样本目录的文件清单，确认一个字节都没动；
 *  - 不会往样本文件所在目录写任何东西。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, skipped, assert, equal, deepEqual } = require('./lib/harness.cjs');
const { WorkerClient } = require('./lib/worker-client.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'aseprite-cli');
const WORKER = path.join(PLUGIN, 'node', 'worker.cjs');
process.env.ASE_WORKER_NO_AUTOSTART = '1';
const w = require(path.join(PLUGIN, 'node', 'worker.cjs'));

// 样本必须由外部指定：仓库里不写任何本机路径，也不自带任何用户的 .aseprite
const SAMPLE = process.env.ASE_SAMPLE || '';
const OUT_ROOT = path.join(ROOT, 'tmp', 'e2e');

function hashFile(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function dirListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
  } catch {
    return [];
  }
}

function countTempDirs(prefix) {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 拍平图层树：只取真正有像素的图层（分组层不参与断言，避免依赖 Aseprite 的分组导出行为） */
function imageLayers(list, out = []) {
  for (const l of list || []) {
    if (l.children && l.children.length) imageLayers(l.children, out);
    else out.push(l);
  }
  return out;
}

const FIXTURE_LUA = `-- 生成一个带分组、切片、标签、tileset 的测试 sprite（只写 tmp/ 里）
local out = __OUT__
local spr = Sprite(32, 32, ColorMode.RGB)
spr.filename = out
spr:newEmptyFrame(2)
spr.frames[1].duration = 0.12
spr.frames[2].duration = 0.25
local img = Image(32, 32, ColorMode.RGB)
img:clear(1, 2, 3, 255)
local l0 = spr.layers[1]
l0.name = "bg"
spr:newCel(l0, 1, img, Point(0, 0))
local g = spr:newGroup()
g.name = "body"
local head = spr:newLayer()
head.name = "head"
head.parent = g
head.opacity = 128
local arm = spr:newLayer()
arm.name = "arm"
arm.parent = g
arm.isVisible = false
local imgA = Image(32, 32, ColorMode.RGB)
imgA:clear(255, 0, 0, 255)
spr:newCel(head, 1, imgA, Point(0, 0))
local imgArm = Image(32, 32, ColorMode.RGB)
imgArm:clear(0, 0, 255, 255)
spr:newCel(arm, 1, imgArm, Point(0, 0))
local s1 = spr:newSlice()
s1.name = "ninepatch"
s1.bounds = Rectangle(2, 3, 10, 12)
s1.center = Rectangle(4, 5, 4, 6)
s1.pivot = Point(7, 7)
local s2 = spr:newSlice()
s2.name = "plain"
s2.bounds = Rectangle(0, 0, 8, 8)
local t1 = spr:newTag()
t1.name = "loop"
t1.fromFrame = spr.frames[1]
t1.toFrame = spr.frames[2]
t1.aniDir = AniDir.PING_PONG
local ts = spr:newTileset()
ts.name = "tiles"
spr:saveAs(out)
print("FIXTURE OK")
`;

function register() {
  const aseprite = process.env.ASEPRITE_PATH || (w.findAsepriteExecutables(undefined).found[0] || {}).path || null;
  const haveSample = !!SAMPLE && fs.existsSync(SAMPLE);
  const skipReason = !aseprite
    ? '找不到 aseprite.exe（可设 ASEPRITE_PATH）'
    : !SAMPLE
      ? '未设置 ASE_SAMPLE（指向一个 .aseprite 样本才能跑真机冒烟）'
      : !haveSample
        ? '找不到样本文件：' + SAMPLE
        : null;

  const ctx = {
    client: null,
    sampleHashBefore: null,
    sampleDirBefore: null,
    outFrames: null,
    outSheet: null,
    outLayers: null,
    fixturePath: null,
    info: null,
  };

  async function client() {
    if (!ctx.client) ctx.client = new WorkerClient(WORKER);
    return ctx.client;
  }

  function requireEnv() {
    if (skipReason) throw skipped(skipReason);
  }

  test('端到端前置：环境与样本文件就绪', async () => {
    requireEnv();
    rmrf(OUT_ROOT);
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    ctx.sampleHashBefore = hashFile(SAMPLE);
    ctx.sampleDirBefore = dirListing(path.dirname(SAMPLE));
    return 'aseprite=' + aseprite + '，样本=' + SAMPLE + '（' + fs.statSync(SAMPLE).size + ' 字节）';
  });

  test('ase_doctor：真机版本与参数齐全', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/doctor', { asepritePath: aseprite });
    equal(res.ready, true, 'ready 应为 true');
    assert(/^1\.3\./.test(res.aseprite.version), '版本号应形如 1.3.x，实际 ' + res.aseprite.version);
    equal(res.cli.missingFlags.length, 0, '缺少参数：' + res.cli.missingFlags.join(' '));
    equal(res.cli.exitCodeReliable, false, 'exitCodeReliable 应如实标记为 false');
    return res.aseprite.version + ' @ ' + res.aseprite.path;
  });

  test('ase_doctor：设置里写错路径时自动回退并明确告警', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/doctor', { asepritePath: 'Z:\\definitely\\not\\here\\aseprite.exe' });
    equal(res.ready, true, '仍应可用（自动搜索兜底）');
    const bad = res.checks.find((x) => x.name === '设置里的路径可用');
    assert(bad && bad.ok === false, '应有一条“设置里的路径可用 = false”的检查项');
    assert(res.guidance.length > 0, '应给出修复指引');
  });

  test('ase_info：样本的真实结构（全部与帧表/图层树自洽）', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/info', { asepritePath: aseprite, source: SAMPLE });
    const info = res.info;
    ctx.info = info;

    // 不写死任何具体数值：样本由 ASE_SAMPLE 决定，断言的是内部一致性与字段齐全
    const spr = info.sprite;
    assert(spr.width > 0 && spr.height > 0, '画布尺寸应 > 0');
    assert(spr.frameCount >= 1, '至少 1 帧');
    equal(info.frames.length, spr.frameCount, '逐帧数据条数应等于帧数');
    const durSum = info.frames.reduce((n, f) => n + f.durationMs, 0);
    equal(spr.totalDurationMs, durSum, '总时长应等于各帧时长之和');
    for (const f of info.frames) assert(f.durationMs > 0, '每帧时长应 > 0');
    equal(info.layerCount, info.layers.length, 'layerCount 应等于顶层图层数');
    assert(info.layers.length >= 1, '至少 1 个图层');
    for (const l of info.layers) assert(typeof l.name === 'string' && l.name.length > 0, '图层名非空');
    for (const t of info.tags) {
      assert(t.from >= 1, '标签起始帧应为 1 起，实际 ' + t.from);
      assert(t.to >= t.from && t.to <= spr.frameCount, '标签结束帧越界：' + t.to);
    }
    equal(info.palette.colors.length, info.palette.size, '调色板条目数应等于 size');
    assert(Array.isArray(info.slices), 'slices 应是数组');
    assert(Array.isArray(info.tilesets), 'tilesets 应是数组');

    // 记下来给后面的用例用（不再硬编码任何具体样本特征）
    const leaves = imageLayers(info.layers);
    ctx.frameCount = spr.frameCount;
    ctx.width = spr.width;
    ctx.height = spr.height;
    ctx.visibleLayerNames = leaves.filter((l) => l.visible !== false).map((l) => l.name);
    ctx.hiddenLayerNames = leaves.filter((l) => l.visible === false).map((l) => l.name);
    // 优先挑一个不是从第 1 帧开始的标签：这样才能验证「标签内序号 → 全局帧号」的换算
    ctx.tag = info.tags.find((t) => t.from > 1) || info.tags[0] || null;
    return spr.width + '×' + spr.height + ' / ' + spr.frameCount + ' 帧 / ' + info.layerCount + ' 图层 / ' + info.tags.length + ' 标签 / ' + info.palette.size + ' 色';
  });

  /** 后面的用例都依赖上一条取到的结构 */
  function requireInfo() {
    requireEnv();
    if (!ctx.info) throw skipped('样本结构未取到（ase_info 那条用例没跑）');
  }

  test('ase_preview：导出单帧 PNG 且能读出尺寸', async () => {
    requireInfo();
    const c = await client();
    const frame = Math.min(2, ctx.frameCount);
    const beforeDirs = countTempDirs('cindy-aseprite-preview-');
    const res = await c.callOk('ase/preview', { asepritePath: aseprite, source: SAMPLE, frame });
    const buf = Buffer.from(res.imageBase64, 'base64');
    const size = w.pngSize(buf);
    equal(size.width, ctx.width, '预览宽应与画布一致');
    equal(size.height, ctx.height, '预览高应与画布一致');
    equal(res.frame, frame, '帧号');
    equal(res.frame1, frame, 'frame1 就是入参的 1 基帧号');
    equal(res.frame0, frame - 1, 'frame0 是 CLI 的 0 基编号');
    equal(res.frameCount, ctx.frameCount, '总帧数');
    assert(buf.length > 100, 'PNG 太小了，可能是空图');
    equal(countTempDirs('cindy-aseprite-preview-'), beforeDirs, '临时目录必须清理干净');
    return buf.length + ' 字节 PNG';
  });

  test('ase_preview：放大 4 倍', async () => {
    requireInfo();
    const c = await client();
    const res = await c.callOk('ase/preview', { asepritePath: aseprite, source: SAMPLE, frame: 1, scale: 4 });
    const size = w.pngSize(Buffer.from(res.imageBase64, 'base64'));
    equal(size.width, ctx.width * 4, '放大后宽');
    equal(size.height, ctx.height * 4, '放大后高');
  });

  test('ase_preview：超出帧数时报错而不是静默给空图', async () => {
    requireInfo();
    const c = await client();
    const err = await c.callError('ase/preview', { asepritePath: aseprite, source: SAMPLE, frame: ctx.frameCount + 900 });
    equal(err.data.toolErrorCode, 'INVALID_ARGS');
    assert(err.message.includes(String(ctx.frameCount)), '错误里应带总帧数，实际：' + err.message);
  });

  test('ase_export_frames：按帧范围导出（1 起编号）', async () => {
    requireInfo();
    const c = await client();
    const to = Math.min(3, ctx.frameCount);
    const outDir = path.join(OUT_ROOT, 'frames');
    const res = await c.callOk('ase/export_frames', { asepritePath: aseprite, source: SAMPLE, outDir, from: 1, to });
    ctx.outFrames = res;
    equal(res.count, to, '文件数');
    const names = res.files.map((f) => f.name).sort();
    equal(names.length, to);
    assert(names.some((n) => n.endsWith('-1.png')), '应有 -1.png，实际 ' + names.join(','));
    assert(names.some((n) => n.endsWith('-' + to + '.png')), '应有 -' + to + '.png');
    assert(!names.some((n) => n.endsWith('-0.png')), '不应出现 0 帧（帧号是 1 起）');
    for (const f of res.files) assert(f.size > 50, f.name + ' 太小');
    return res.count + ' 个文件 @ ' + res.outDir;
  });

  test('ase_export_frames：按动画标签导出', async () => {
    requireInfo();
    if (!ctx.tag) throw skipped('样本里没有动画标签');
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'frames-tag');
    const res = await c.callOk('ase/export_frames', { asepritePath: aseprite, source: SAMPLE, outDir, tag: ctx.tag.name });
    equal(res.count, ctx.tag.to - ctx.tag.from + 1, '标签「' + ctx.tag.name + '」是第 ' + ctx.tag.from + '–' + ctx.tag.to + ' 帧');
    equal(res.frameMapping.length, res.count, 'frameMapping 条数应等于产物数');
    equal(res.frameMapping[0].frame1, ctx.tag.from, 'tag 导出要把标签内序号换算成全局帧号（起始）');
    equal(res.frameMapping[res.frameMapping.length - 1].frame1, ctx.tag.to, 'tag 导出要把标签内序号换算成全局帧号（结束）');
    for (const m of res.frameMapping) equal(m.frame0, m.frame1 - 1, 'frame0 = frame1 - 1');
    return res.count + ' 个文件';
  });

  test('ase_export_frames：frameMapping 与落盘文件名、帧号三者一致', async () => {
    requireInfo();
    if (ctx.frameCount < 2) throw skipped('样本只有 1 帧，测不了多帧对照');
    const c = await client();
    const to = Math.min(3, ctx.frameCount);
    const outDir = path.join(OUT_ROOT, 'frames-map');
    const res = await c.callOk('ase/export_frames', { asepritePath: aseprite, source: SAMPLE, outDir, from: 1, to });

    equal(res.frameMapping.length, to, 'frameMapping 条数应等于帧数');
    equal(res.count, to, '产物数应等于帧数');
    const onDisk = fs.readdirSync(outDir).sort();
    deepEqual(res.frameMapping.map((m) => m.file).sort(), onDisk, 'frameMapping 的 file 必须是真实落盘文件名');
    res.frameMapping.forEach((m, i) => {
      equal(m.frame1, i + 1, '第 ' + (i + 1) + ' 条应对应第 ' + (i + 1) + ' 帧');
      equal(m.frame0, i, 'frame0 是 0 基编号');
      assert(m.file.includes(String(m.frame1)), '默认模板的文件名里应是 1 基帧号：' + m.file);
      assert(fs.existsSync(path.join(outDir, m.file)), '文件不存在：' + m.file);
    });
    // 关键回归：默认模板是 {frame1}，文件名里绝不应该是 0 基（不该出现 -0.png）
    assert(!res.frameMapping.some((m) => /-0\.png$/.test(m.file)), '默认模板不该产出 0 基文件名');
    assert(
      typeof res.frameMappingNote === 'string' && res.frameMappingNote.includes('{frame1}'),
      'note 要点明 {frame1} 是 1 基：' + res.frameMappingNote
    );

    // 显式要 0 基文件名时，映射要如实跟着变（实测 {frame} 是「导出区间内」的 0 基序号：
    // 从第 2 帧开始导，会得到 zero-0 / zero-1，绝不能拿文件名当全局帧号）
    if (ctx.frameCount >= 3) {
      const zeroDir = path.join(OUT_ROOT, 'frames-map-zero');
      const zero = await c.callOk('ase/export_frames', {
        asepritePath: aseprite,
        source: SAMPLE,
        outDir: zeroDir,
        from: 2,
        to: 3,
        nameTemplate: 'zero-{frame}.png',
      });
      deepEqual(
        zero.frameMapping,
        [
          { file: 'zero-0.png', frame1: 2, frame0: 1, originalName: 'zero-0.png', renamed: false },
          { file: 'zero-1.png', frame1: 3, frame0: 2, originalName: 'zero-1.png', renamed: false },
        ],
        '{frame} 是 0 基：从第 2 帧起的文件叫 zero-0 / zero-1，但它们是第 2 / 3 帧'
      );
      assert(zero.frameMappingNote.includes('导出区间内'), 'note 要说明文件名是区间内序号：' + zero.frameMappingNote);
    }
    return to + ' 帧：' + res.frameMapping.map((m) => m.file + '=' + m.frame1).join('、');
  });

  test('ase_export_frames：name_from_global_frame 关/开 的文件名对照', async () => {
    requireInfo();
    if (ctx.frameCount < 2) throw skipped('样本只有 1 帧，测不了子区间导出');
    const c = await client();
    // 子区间：能取到第 2 帧往后的就从第 2 帧起（这样“区间内序号”与全局帧号必然不同）
    const from = ctx.frameCount >= 3 ? 2 : 1;
    const to = Math.min(from + 1, ctx.frameCount);
    const frames = [];
    for (let n = from; n <= to; n += 1) frames.push(n);
    const title = w.spriteTitle(SAMPLE);

    // 1) 默认（false）：文件名里的帧号从 1 重新数，就是 Aseprite 原生行为
    const relDir = path.join(OUT_ROOT, 'frames-global-off');
    const off = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: SAMPLE,
      outDir: relDir,
      from,
      to,
      nameFromGlobalFrame: false,
    });
    equal(off.nameFromGlobalFrame, false, '默认必须是 false（跟随 Aseprite）');
    equal(off.count, frames.length, '产物数');
    equal(off.frameMapping.length, frames.length, 'frameMapping 条数');
    const offNames = off.frameMapping.map((m) => m.file);
    deepEqual(offNames, frames.map((_, i) => title + '-' + (i + 1) + '.png'), 'false 时文件名从 1 起（区间内序号）');
    off.frameMapping.forEach((m, i) => {
      equal(m.frame1, frames[i], 'frame1 仍是 Studio 全局帧号');
      equal(m.frame0, frames[i] - 1, 'frame0 = frame1 - 1');
      equal(m.originalName, m.file, 'false 时原始名 = 最终名');
      equal(m.renamed, false, 'false 时不改名');
      assert(fs.existsSync(path.join(relDir, m.file)), '文件应落盘：' + m.file);
    });
    assert(!off.frameMappingNote.includes('已按全局帧号重命名'), 'false 时不该声称重命名过：' + off.frameMappingNote);

    // 2) 开启：文件名直接等于全局帧号
    const onDir = path.join(OUT_ROOT, 'frames-global-on');
    const on = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: SAMPLE,
      outDir: onDir,
      from,
      to,
      nameFromGlobalFrame: true,
    });
    equal(on.nameFromGlobalFrame, true, '开关要如实回报');
    equal(on.count, frames.length, '产物数应与关闭时一致');
    deepEqual(
      on.frameMapping.map((m) => m.file),
      frames.map((n) => title + '-' + n + '.png'),
      'true 时文件名等于全局帧号'
    );
    deepEqual(on.frameMapping.map((m) => m.frame1), frames, 'frameMapping 的 frame1 是全局帧号');
    on.frameMapping.forEach((m, i) => {
      equal(m.frame1, frames[i], 'frame1');
      equal(m.frame0, frames[i] - 1, 'frame0');
      equal(m.file, title + '-' + m.frame1 + '.png', '文件名里的数字就是 frame1');
      assert(fs.existsSync(path.join(onDir, m.file)), '文件应落盘：' + m.file);
      if (from > 1) {
        equal(m.originalName, title + '-' + (i + 1) + '.png', 'originalName 是 Aseprite 原始产出名');
        equal(m.renamed, true, '改名了就要如实标记');
      }
    });
    assert(on.frameMappingNote.includes('已按全局帧号重命名'), 'note 要写清已按全局帧号重命名：' + on.frameMappingNote);
    // 落盘清单与 frameMapping 完全一致（没有多余/遗留的改名中间文件）
    deepEqual(fs.readdirSync(onDir).sort(), on.frameMapping.map((m) => m.file).sort(), '目录里只能是 frameMapping 里的文件');
    equal(countTempDirs('cindy-aseprite-frames-'), 0, '暂存目录必须清理干净');
    return (
      '第 ' + from + '–' + to + ' 帧 → 关：' + off.frameMapping.map((m) => m.file).join('、') +
      '；开：' + on.frameMapping.map((m) => m.file).join('、')
    );
  });

  test('ase_export_frames：name_from_global_frame 配 {frame} 模板也按全局帧号', async () => {
    requireInfo();
    if (ctx.frameCount < 3) throw skipped('样本不足 3 帧，测不了子区间 + {frame} 模板');
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'frames-global-zero');
    const res = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: SAMPLE,
      outDir,
      from: 2,
      to: 3,
      nameTemplate: 'z-{frame}.png',
      nameFromGlobalFrame: true,
    });
    deepEqual(res.frameMapping.map((m) => m.file), ['z-1.png', 'z-2.png'], '{frame} 是全局帧号 - 1');
    deepEqual(res.frameMapping.map((m) => m.frame1), [2, 3], 'frame1 仍是全局帧号');
    deepEqual(res.frameMapping.map((m) => m.originalName), ['z-0.png', 'z-1.png'], 'originalName 记录 Aseprite 原名');
    return res.frameMapping.map((m) => m.originalName + ' → ' + m.file).join('、');
  });

  test('ase_export_frames：全部帧', async () => {
    requireInfo();
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'frames-all');
    const res = await c.callOk('ase/export_frames', { asepritePath: aseprite, source: SAMPLE, outDir });
    equal(res.count, ctx.frameCount, '应导出全部 ' + ctx.frameCount + ' 帧');
    return res.count + ' 个文件';
  });

  test('ase_export_sheet：图集 + 帧表', async () => {
    requireInfo();
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'sheet');
    const res = await c.callOk('ase/export_sheet', {
      asepritePath: aseprite,
      source: SAMPLE,
      outDir,
      sheetType: 'horizontal',
      shapePadding: 1,
      format: 'json-array',
    });
    ctx.outSheet = res;
    assert(fs.existsSync(res.sheet.path), '图集 PNG 不存在');
    assert(fs.existsSync(res.data.path), '帧表 JSON 不存在');
    const meta = JSON.parse(fs.readFileSync(res.data.path, 'utf8'));
    assert(Array.isArray(meta.frames), 'json-array 的 frames 应是数组');
    equal(meta.frames.length, ctx.frameCount, '帧表帧数');
    const expectW = ctx.frameCount * ctx.width + (ctx.frameCount - 1);
    equal(meta.meta.size.w, expectW, '横排 + 帧间 padding 1：帧数×宽 + (帧数-1) 条缝');
    equal(meta.meta.size.h, ctx.height, '总高应等于单帧高');
    equal(res.data.frameCount, ctx.frameCount, 'result 里的帧数');
    equal(res.data.frameTags.length, ctx.info.tags.length, '帧表里应带全部标签');
    equal(res.sheet.width, expectW, 'result 里的宽');
    return res.sheet.width + '×' + res.sheet.height + ' PNG + ' + res.data.bytes + ' 字节 JSON';
  });

  test('ase_export_sheet：packed 布局 + json-hash', async () => {
    requireInfo();
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'sheet-packed');
    const res = await c.callOk('ase/export_sheet', {
      asepritePath: aseprite,
      source: SAMPLE,
      outDir,
      sheetType: 'packed',
      format: 'json-hash',
      borderPadding: 2,
      scale: 2,
    });
    const meta = JSON.parse(fs.readFileSync(res.data.path, 'utf8'));
    assert(!Array.isArray(meta.frames), 'json-hash 的 frames 应是对象');
    equal(Object.keys(meta.frames).length, ctx.frameCount, '帧表帧数');
    equal(res.data.format, 'json-hash');
    return res.sheet.width + '×' + res.sheet.height;
  });

  test('ase_export_layers：逐层导出', async () => {
    requireInfo();
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'layers');
    const res = await c.callOk('ase/export_layers', { asepritePath: aseprite, source: SAMPLE, outDir });
    ctx.outLayers = res;
    // 只导出可见层：张数必是帧数的整数倍，且可见图层各至少一张
    equal(res.count % ctx.frameCount, 0, '张数应是帧数的整数倍');
    assert(res.count >= ctx.frameCount, '至少每个可见层 × 帧数');
    const names = res.files.map((f) => f.name);
    for (const n of ctx.visibleLayerNames) {
      if (ctx.hiddenLayerNames.includes(n)) continue;
      assert(names.some((x) => x.includes('-' + n + '-')), '应包含可见层「' + n + '」');
    }
    for (const n of ctx.hiddenLayerNames) assert(!names.some((x) => x.includes('-' + n + '-')), '隐藏层「' + n + '」不该出现');
    return res.count + ' 个文件（' + res.count / ctx.frameCount + ' 层 × ' + ctx.frameCount + ' 帧）';
  });

  test('ase_export_layers：隐藏层（即使有内容）不会被导出', async () => {
    requireInfo();
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'layers-hidden');
    const res = await c.callOk('ase/export_layers', { asepritePath: aseprite, source: SAMPLE, outDir });
    const names = res.files.map((f) => f.name);
    for (const n of ctx.hiddenLayerNames) assert(!names.some((x) => x.includes('-' + n + '-')), '隐藏层「' + n + '」不该出现在导出里');
    if (ctx.outLayers) equal(res.count, ctx.outLayers.count, '与上一次逐层导出结果一致');
    return '隐藏层未导出（' + res.count + ' 个文件）';
  });

  test('ase_info：自建 fixture 覆盖分组/切片/九宫格/轴心/tileset', async () => {
    requireEnv();
    const c = await client();
    const fixDir = path.join(OUT_ROOT, 'fixture');
    fs.mkdirSync(fixDir, { recursive: true });
    const target = path.join(fixDir, 'fixture.aseprite');
    const luaPath = path.join(fixDir, 'mkfix.lua');
    fs.writeFileSync(luaPath, FIXTURE_LUA.replace('__OUT__', JSON.stringify(w.toPosix(target))), 'utf8');

    const mk = await c.callOk('ase/doctor', { asepritePath: aseprite });
    assert(mk.ready, 'aseprite 应可用');
    const { execFileSync } = require('node:child_process');
    execFileSync(aseprite, ['-b', '--script', w.toPosix(luaPath)], { stdio: 'pipe' });
    assert(fs.existsSync(target), 'fixture 没有生成');

    const res = await c.callOk('ase/info', { asepritePath: aseprite, source: target });
    const info = res.info;
    ctx.fixturePath = target;
    equal(info.sprite.frameCount, 2, 'fixture 帧数');
    equal(info.layerCount, 2, '顶层图层数（bg + body 组）');
    const group = info.layers.find((l) => l.type === 'group');
    assert(group, '应有分组图层');
    equal(group.name, 'body');
    equal(group.children.length, 2, '组内两个子层');
    equal(group.children[0].name, 'head');
    equal(group.children[0].opacity, 128, '子层不透明度');
    equal(group.children[1].visible, false, '子层可见性');
    equal(info.frames[0].durationMs, 120, '第 1 帧时长');
    equal(info.frames[1].durationMs, 250, '第 2 帧时长');
    const slice = info.slices.find((s) => s.name === 'ninepatch');
    assert(slice, '应有 ninepatch 切片');
    equal(slice.bounds.width, 10, '切片宽');
    equal(slice.center.width, 4, '九宫格中心宽');
    equal(slice.pivot.x, 7, '轴心 x');
    equal(info.tags[0].direction, 'pingpong', '标签方向应为 pingpong');
    equal(info.tilesets.length, 1, '应有 1 个 tileset');
    equal(info.tilesets[0].tileWidth, 16, 'tileset 单块宽');
    return '分组/切片/轴心/方向/tileset 全部读到';
  });

  test('ase_export_layers：分组连带子层各出一张，隐藏子层不导', async () => {
    requireEnv();
    if (!ctx.fixturePath) throw skipped('fixture 未生成');
    const c = await client();
    const outDir = path.join(OUT_ROOT, 'fixture-layers');
    const res = await c.callOk('ase/export_layers', { asepritePath: aseprite, source: ctx.fixturePath, outDir });
    const names = res.files.map((f) => f.name);
    assert(names.some((n) => n.includes('-bg-')), '应包含 bg 层');
    assert(names.some((n) => n.includes('-body-')), '分组 body 自己也应该出一张');
    assert(names.some((n) => n.includes('-head-')), '组内 head 应单独出一张');
    assert(!names.some((n) => n.includes('-arm-')), '隐藏且有内容的 arm 仍然不导出');
    equal(res.count, 3 * 2, '3 张图 × 2 帧');
    return 'bg / body(组) / head 各 2 帧，arm 未导出';
  });

  // ---- 落点规则（按份数自动判定）+ 同名不覆盖 ------------------------------
  // 用样本的副本跑，避免往样本所在目录写东西；判定的就是“文件真实落在哪”
  const LOCALITY = path.join(OUT_ROOT, 'locality');
  let localCopy = null;

  test('落点前置：把样本复制到 tmp 里（保证不写样本所在目录）', async () => {
    requireEnv();
    fs.mkdirSync(LOCALITY, { recursive: true });
    localCopy = path.join(LOCALITY, 'sample-copy.aseprite');
    fs.copyFileSync(SAMPLE, localCopy);
    equal(fs.statSync(localCopy).size, fs.statSync(SAMPLE).size, '副本大小应与样本一致');
    return localCopy;
  });

  test('落点 auto：只出 1 个文件 → 源文件同目录（不进 exports/）', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 1,
      exportDirMode: 'auto',
    });
    equal(res.count, 1, '单帧只出 1 个文件');
    equal(res.exportDirMode, 'auto');
    equal(res.outDir, LOCALITY, '单份应落在源文件同目录');
    equal(path.dirname(res.files[0].path), LOCALITY);
    equal(fs.existsSync(path.join(LOCALITY, 'exports')), false, '单份时不该创建 exports/');
    return res.files[0].name + ' → ' + res.outDir;
  });

  test('落点 auto：出 2 个文件 → 源目录下的 exports/', async () => {
    requireEnv();
    if (ctx.frameCount < 2) throw skipped('样本只有 1 帧，测不了多份落点');
    const c = await client();
    const res = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 2,
      exportDirMode: 'auto',
    });
    const exportsDir = path.join(LOCALITY, 'exports');
    equal(res.count, 2);
    equal(res.outDir, exportsDir, '多份应落在 exports/');
    for (const f of res.files) equal(path.dirname(f.path), exportsDir);
    return res.count + ' 个 → ' + res.outDir;
  });

  test('落点 always：即使只有 1 份也进 exports/', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 1,
      exportDirMode: 'always',
    });
    equal(res.outDir, path.join(LOCALITY, 'exports'), 'always 不看份数');
    return res.outDir;
  });

  test('落点 same：即使有多份也留在源文件同目录', async () => {
    requireEnv();
    if (ctx.frameCount < 3) throw skipped('样本不足 3 帧，测不了“多份留在源目录”');
    const c = await client();
    const res = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 3,
      exportDirMode: 'same',
    });
    equal(res.count, 3);
    equal(res.outDir, LOCALITY, 'same 模式留在源目录');
    for (const f of res.files) equal(path.dirname(f.path), LOCALITY);
    return res.count + ' 个 → ' + res.outDir;
  });

  test('同名不覆盖：再导一次会加 -2 后缀并报告改名', async () => {
    requireEnv();
    if (ctx.frameCount < 2) throw skipped('样本只有 1 帧，测不了多个同名文件');
    const c = await client();
    const first = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 2,
      exportDirMode: 'same',
      nameTemplate: 'dup-{frame1}.png',
    });
    equal(first.renamed.length, 0, '第一次不该有改名');
    const second = await c.callOk('ase/export_frames', {
      asepritePath: aseprite,
      source: localCopy,
      from: 1,
      to: 2,
      exportDirMode: 'same',
      nameTemplate: 'dup-{frame1}.png',
    });
    equal(second.renamed.length, 2, '第二次两个文件都要改名');
    const names = second.files.map((f) => f.name).sort();
    deepEqual(names, ['dup-1-2.png', 'dup-2-2.png'], '应加 -2 而不是覆盖');
    for (const r of second.renamed) assert(r.to.endsWith('-2.png'), '改名要落地：' + JSON.stringify(r));
    // 第一批文件仍然在
    assert(fs.existsSync(path.join(LOCALITY, 'dup-1.png')), '原文件不能被覆盖掉');
    assert(fs.existsSync(path.join(LOCALITY, 'dup-1-2.png')), '新文件要在');
    return 'dup-1.png 保留，新文件 dup-1-2.png / dup-2-2.png';
  });

  test('落点 auto：图集固定 2 个文件 → exports/，同名时 png/json 成对改名', async () => {
    requireEnv();
    const c = await client();
    const exportsDir = path.join(LOCALITY, 'exports');
    const first = await c.callOk('ase/export_sheet', { asepritePath: aseprite, source: localCopy, exportDirMode: 'auto' });
    equal(first.outDir, exportsDir, '图集默认进 exports/');
    equal(path.dirname(first.sheet.path), exportsDir);
    equal(path.dirname(first.data.path), exportsDir);

    const second = await c.callOk('ase/export_sheet', { asepritePath: aseprite, source: localCopy, exportDirMode: 'auto' });
    assert(second.sheet.path !== first.sheet.path, '第二次不能覆盖第一次的图集');
    equal(second.renamed.length, 1, '应报告一对改名');
    const stem = path.basename(second.sheet.path).replace(/\.png$/, '');
    equal(path.basename(second.data.path), stem + '.json', 'json 必须跟着 png 一起改名');
    const meta = JSON.parse(fs.readFileSync(second.data.path, 'utf8'));
    equal(meta.meta.image, stem + '.png', '帧表里的 meta.image 要同步改成新文件名');
    return stem + '.png / .json';
  });

  test('落点 auto：逐层导出（多份）也进 exports/', async () => {
    requireEnv();
    const c = await client();
    const res = await c.callOk('ase/export_layers', { asepritePath: aseprite, source: localCopy, exportDirMode: 'auto' });
    equal(res.outDir, path.join(LOCALITY, 'exports'));
    assert(res.count > 1, '逐层导出必然多份');
    for (const f of res.files) equal(path.dirname(f.path), path.join(LOCALITY, 'exports'));
    return res.count + ' 个 → ' + res.outDir;
  });

  test('落点：暂存目录用完即删（不残留 cindy-aseprite-*）', async () => {
    requireEnv();
    for (const prefix of ['cindy-aseprite-frames-', 'cindy-aseprite-sheet-', 'cindy-aseprite-layers-', 'cindy-aseprite-preview-', 'cindy-aseprite-info-', 'cindy-aseprite-count-']) {
      equal(countTempDirs(prefix), 0, '临时目录没清干净：' + prefix);
    }
  });

  test('落点：样本所在目录里没有出现 exports/（全程没往那边写）', async () => {
    requireEnv();
    equal(fs.existsSync(path.join(path.dirname(SAMPLE), 'exports')), false, '样本所在目录下不该冒出 exports/');
    const after = dirListing(path.dirname(SAMPLE));
    equal(JSON.stringify(after), JSON.stringify(ctx.sampleDirBefore), '样本目录清单必须一字不变');
  });

  test('只读保证：样本文件与样本目录一字未动', async () => {
    requireEnv();
    equal(hashFile(SAMPLE), ctx.sampleHashBefore, '样本文件 sha256 变了！');
    const after = dirListing(path.dirname(SAMPLE));
    equal(JSON.stringify(after), JSON.stringify(ctx.sampleDirBefore), '样本目录清单变了（有文件被写进去）');
    return 'sha256 与目录清单均未变';
  });

  test('清理：tmp/ 里的测试产物可以整目录删掉', async () => {
    requireEnv();
    rmrf(OUT_ROOT);
    equal(fs.existsSync(OUT_ROOT), false, 'tmp/e2e 应已删除');
    return '已清理 ' + OUT_ROOT;
  });

  test('收尾：worker 进程关闭', async () => {
    if (ctx.client) ctx.client.close();
    ctx.client = null;
  });
}

module.exports = { register };
