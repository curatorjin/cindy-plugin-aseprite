'use strict';

/**
 * 纯函数单测：不依赖 aseprite.exe，任何机器上都能跑。
 * 覆盖参数拼装、帧号换算、落点决策、错误识别、PNG 头解析、清单与 worker 的一致性。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, assert, equal, deepEqual, arrayEqual, throws } = require('./lib/harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'aseprite-cli');
// 本文件在同进程 require worker 是为了拿纯函数；用门控确保它不抢 stdin、不挂事件循环
process.env.ASE_WORKER_NO_AUTOSTART = '1';
const w = require(path.join(PLUGIN, 'node', 'worker.cjs'));

function register() {
  // ---- 帧号换算 -----------------------------------------------------------
  test('resolveFrameRange：都不传 → 全部帧', () => {
    deepEqual(w.resolveFrameRange(undefined, undefined), { from: null, to: null });
    deepEqual(w.resolveFrameRange('', ''), { from: null, to: null });
    deepEqual(w.resolveFrameRange(null, null), { from: null, to: null });
  });

  test('resolveFrameRange：1 起的人话帧号 → 0 起的 CLI 下标', () => {
    deepEqual(w.resolveFrameRange(1, 6), { from: 0, to: 5 });
    deepEqual(w.resolveFrameRange(7, 7), { from: 6, to: 6 });
    deepEqual(w.resolveFrameRange('3', '4'), { from: 2, to: 3 });
  });

  test('resolveFrameRange：只传 from → 单帧', () => {
    deepEqual(w.resolveFrameRange(5, undefined), { from: 4, to: 4 });
    deepEqual(w.resolveFrameRange(undefined, 5), { from: 0, to: 4 });
  });

  test('resolveFrameRange：非法输入按 INVALID_ARGS 拒绝', () => {
    throws(() => w.resolveFrameRange(0, 3), 'INVALID_ARGS', '帧号 0');
    throws(() => w.resolveFrameRange(5, 2), 'INVALID_ARGS', 'to < from');
    throws(() => w.resolveFrameRange(1.5, 3), 'INVALID_ARGS', '小数');
    throws(() => w.resolveFrameRange(-1, 3), 'INVALID_ARGS', '负数');
  });

  test('resolveFrameRange：超出帧数时给出总帧数', () => {
    const err = throws(() => w.resolveFrameRange(1, 99, 59), 'INVALID_ARGS');
    assert(err.message.includes('59'), '错误信息里要带总帧数，实际：' + err.message);
  });

  test('frameRangeArg：拼接 from,to，缺省返回 null', () => {
    equal(w.frameRangeArg({ from: 0, to: 5 }), '0,5');
    equal(w.frameRangeArg({ from: 6, to: 6 }), '6,6');
    equal(w.frameRangeArg({ from: null, to: null }), null);
  });

  // ---- 落点（按份数自动判定）----------------------------------------------
  test('resolveExportDir：auto 按份数决定（≥2 → exports/，1 → 同目录）', () => {
    const src = 'F:/a/b/sprite.aseprite';
    equal(w.resolveExportDir(src, undefined, 'auto', 1), path.resolve('F:/a/b'), '单份落源目录');
    equal(w.resolveExportDir(src, undefined, 'auto', 2), path.join(path.resolve('F:/a/b'), 'exports'), '多份落 exports/');
    equal(w.resolveExportDir(src, undefined, 'auto', 177), path.join(path.resolve('F:/a/b'), 'exports'));
    equal(w.resolveExportDir(src, undefined, undefined, 1), path.resolve('F:/a/b'), '缺省模式=auto');
  });

  test('resolveExportDir：always / same 不看份数', () => {
    const src = 'F:/a/b/sprite.aseprite';
    equal(w.resolveExportDir(src, undefined, 'always', 1), path.join(path.resolve('F:/a/b'), 'exports'));
    equal(w.resolveExportDir(src, undefined, 'always', 9), path.join(path.resolve('F:/a/b'), 'exports'));
    equal(w.resolveExportDir(src, undefined, 'same', 1), path.resolve('F:/a/b'));
    equal(w.resolveExportDir(src, undefined, 'same', 9), path.resolve('F:/a/b'));
  });

  test('resolveExportDir：显式 out_dir 优先于任何模式', () => {
    const src = 'F:/a/b/sprite.aseprite';
    for (const mode of ['auto', 'always', 'same']) {
      equal(w.resolveExportDir(src, 'F:/tmp/out', mode, 1), path.resolve('F:/tmp/out'));
      equal(w.resolveExportDir(src, '  F:/tmp/out  ', mode, 9), path.resolve('F:/tmp/out'));
    }
  });

  test('sanitizeExportDirMode：三档枚举，非法值拒绝', () => {
    equal(w.sanitizeExportDirMode(undefined), 'auto');
    equal(w.sanitizeExportDirMode(''), 'auto');
    equal(w.sanitizeExportDirMode('ALWAYS'), 'always');
    equal(w.sanitizeExportDirMode('same'), 'same');
    throws(() => w.sanitizeExportDirMode('subdir'), 'INVALID_ARGS');
    arrayEqual(w.EXPORT_DIR_MODES, ['auto', 'always', 'same'], '设置页三选项要对上');
  });

  test('uniqueTargetPath：同名不覆盖，自动加 -2/-3 后缀', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ase-unique-'));
    try {
      const first = w.uniqueTargetPath(dir, 'shot.png');
      equal(path.basename(first), 'shot.png', '目录空时保持原名');
      fs.writeFileSync(first, 'a');
      const second = w.uniqueTargetPath(dir, 'shot.png');
      equal(path.basename(second), 'shot-2.png', '已存在时加 -2');
      fs.writeFileSync(second, 'b');
      equal(path.basename(w.uniqueTargetPath(dir, 'shot.png')), 'shot-3.png');
      equal(path.basename(w.uniqueTargetPath(dir, 'other.png')), 'other.png', '别的名字不受影响');
      equal(path.basename(w.uniqueTargetPath(dir, 'noext')), 'noext', '无扩展名也能处理');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validateNameTemplate：必须带占位符、不能带路径分隔符', () => {
    w.validateNameTemplate('{title}-{frame1}.png', ['{frame}', '{frame1}'], 't');
    const err = throws(() => w.validateNameTemplate('{title}.png', ['{frame}', '{frame1}'], 't'), 'INVALID_ARGS');
    assert(err.message.includes('覆盖'), '要说清不加占位符会互相覆盖：' + err.message);
    throws(() => w.validateNameTemplate('sub/{title}-{frame1}.png', ['{frame1}'], 't'), 'INVALID_ARGS');
    const backslash = 'a' + String.fromCharCode(92) + 'b-{frame1}.png';
    equal(backslash.includes(String.fromCharCode(92)), true, '构造的反斜杠模板要对');
    throws(() => w.validateNameTemplate(backslash, ['{frame1}'], 't'), 'INVALID_ARGS');
  });

  // ---- 数值/枚举清洗 -------------------------------------------------------
  test('normalizeScale：缺省 1，拒绝 0/负/超限', () => {
    equal(w.normalizeScale(undefined, 1), 1);
    equal(w.normalizeScale('2', 1), 2);
    equal(w.normalizeScale(0.5, 1), 0.5);
    throws(() => w.normalizeScale(0, 1), 'INVALID_ARGS');
    throws(() => w.normalizeScale(-1, 1), 'INVALID_ARGS');
    throws(() => w.normalizeScale(33, 1), 'INVALID_ARGS');
    throws(() => w.normalizeScale('abc', 1), 'INVALID_ARGS');
  });

  test('sanitizePadding：0–64 整数，越界拒绝', () => {
    equal(w.sanitizePadding(undefined, 'p'), 0);
    equal(w.sanitizePadding('2', 'p'), 2);
    equal(w.sanitizePadding(64, 'p'), 64);
    throws(() => w.sanitizePadding(65, 'p'), 'INVALID_ARGS');
    throws(() => w.sanitizePadding(-1, 'p'), 'INVALID_ARGS');
    throws(() => w.sanitizePadding(1.5, 'p'), 'INVALID_ARGS');
  });

  test('sanitizeSheetType / sanitizeSheetFormat：枚举校验', () => {
    equal(w.sanitizeSheetType(undefined), 'horizontal');
    equal(w.sanitizeSheetType('packed'), 'packed');
    throws(() => w.sanitizeSheetType('strip'), 'INVALID_ARGS');
    equal(w.sanitizeSheetFormat(undefined), 'json-array');
    equal(w.sanitizeSheetFormat('json-hash'), 'json-hash');
    throws(() => w.sanitizeSheetFormat('xml'), 'INVALID_ARGS');
    arrayEqual(w.SHEET_TYPES, ['horizontal', 'vertical', 'rows', 'columns', 'packed'], 'sheet 类型要用实测存在的 5 种');
    arrayEqual(w.SHEET_FORMATS, ['json-array', 'json-hash'], '1.3.18.6 只认这两种 --format');
  });

  test('sanitizeBaseName：清掉文件名非法字符', () => {
    equal(w.sanitizeBaseName('a/b:c*d?e"f<g>h|i', 'x'), 'abcdefghi');
    equal(w.sanitizeBaseName('  ..name..  ', 'x'), 'name');
    equal(w.sanitizeBaseName('.', 'sprite'), 'sprite');
    equal(w.sanitizeBaseName('', 'sprite'), 'sprite');
    equal(w.sanitizeBaseName(undefined, 'sprite'), 'sprite');
  });

  test('colorModeName / blendModeName：数值映射', () => {
    equal(w.colorModeName(0), 'rgb');
    equal(w.colorModeName(1), 'grayscale');
    equal(w.colorModeName(2), 'indexed');
    equal(w.colorModeName(4), 'tilemap');
    equal(w.colorModeName(9), 'mode_9');
    equal(w.blendModeName(3), 'normal');
    equal(w.blendModeName(14), 'multiply');
    equal(w.blendModeName(28), 'hsl_luminosity');
    equal(w.blendModeName(99), 'blend_99');
  });

  // ---- 参数拼装 -----------------------------------------------------------
  test('buildPreviewArgs：单帧 + 可选缩放', () => {
    arrayEqual(w.buildPreviewArgs('F:/a/s.aseprite', 6, 'C:/t/p.png', { scale: 1 }), [
      '-b', 'F:/a/s.aseprite', '--frame-range', '6,6', '--save-as', 'C:/t/p.png',
    ]);
    arrayEqual(w.buildPreviewArgs('F:/a/s.aseprite', 0, 'C:/t/p.png', { scale: 4 }), [
      '-b', 'F:/a/s.aseprite', '--frame-range', '0,0', '--scale', '4', '--save-as', 'C:/t/p.png',
    ]);
  });

  test('buildFramesArgs：全帧最简形式', () => {
    arrayEqual(w.buildFramesArgs('F:/a/s.aseprite', 'F:/o/{title}-{frame1}.png', {}), [
      '-b', 'F:/a/s.aseprite', '--save-as', 'F:/o/{title}-{frame1}.png',
    ]);
  });

  test('buildFramesArgs：帧范围 / tag / 缩放 / trim / 空帧全开', () => {
    const args = w.buildFramesArgs('F:/a/s.aseprite', 'F:/o/t-{frame1}.png', {
      from: 0,
      to: 5,
      tag: 'idle',
      scale: 2,
      trim: true,
      ignoreEmpty: true,
    });
    arrayEqual(args, [
      '-b', 'F:/a/s.aseprite',
      '--frame-range', '0,5',
      '--tag', 'idle',
      '--scale', '2',
      '--trim',
      '--ignore-empty',
      '--save-as', 'F:/o/t-{frame1}.png',
    ], 'save-as 必须是最后一个参数');
    assert(!args.includes('--all-layers'), '--all-layers 实测无效，不应该拼进去');
  });

  test('buildSheetArgs：数据/格式/布局/padding 齐全，且不带帧范围与 tag', () => {
    const args = w.buildSheetArgs('F:/a/s.aseprite', 'F:/o/s.png', 'F:/o/s.json', {
      format: 'json-array',
      sheetType: 'packed',
      shapePadding: 2,
      borderPadding: 1,
      scale: 2,
      trim: false,
      ignoreEmpty: false,
      // 即使调用方误传这两个，也不该被拼进去（1.3.18.6 对 --sheet 无效）
      from: 0,
      to: 5,
      tag: 'idle',
    });
    arrayEqual(args, [
      '-b', 'F:/a/s.aseprite',
      '--sheet', 'F:/o/s.png',
      '--data', 'F:/o/s.json',
      '--format', 'json-array',
      '--sheet-type', 'packed',
      '--shape-padding', '2',
      '--border-padding', '1',
      '--scale', '2',
      '--list-layers', '--list-tags', '--list-slices',
    ]);
  });

  test('buildLayersArgs：--split-layers 必须在 --save-as 之前', () => {
    const args = w.buildLayersArgs('F:/a/s.aseprite', 'F:/o/{title}-{layer}-{frame1}.png', { scale: 1 });
    arrayEqual(args, ['-b', 'F:/a/s.aseprite', '--split-layers', '--save-as', 'F:/o/{title}-{layer}-{frame1}.png']);
    assert(args.indexOf('--split-layers') < args.indexOf('--save-as'), '顺序错了');
  });

  test('buildInfoArgs：-b + --script', () => {
    arrayEqual(w.buildInfoArgs('C:/t/ase_info.lua'), ['-b', '--script', 'C:/t/ase_info.lua']);
  });

  test('buildInfoLua：路径内联、Windows 反斜杠转义、不依赖 --script-param', () => {
    const lua = w.buildInfoLua('D:\\art\\a b\\s.aseprite', 'C:\\tmp\\o.json', 500);
    assert(lua.includes('D:/art/a b/s.aseprite'), '源路径应转成 posix 形式内联');
    assert(lua.includes('C:/tmp/o.json'), '输出路径应内联');
    assert(!lua.includes('--script-param'), '不依赖 --script-param（参数顺序有坑）');
    assert(lua.includes('local LIMIT = 500'), '帧数上限应写入脚本');
    assert(lua.includes('app.open'), '要真的打开 sprite');
    assert(lua.includes('json.encode'), '结果用 aseprite 自带 json.encode');
    // 反斜杠路径也要能正确转义
    const lua2 = w.buildInfoLua('C:\\a\\b.aseprite', 'C:\\c.json', 10);
    assert(lua2.includes('"C:/a/b.aseprite"'), '反斜杠应被规范化');
  });

  // ---- 输出解析 -----------------------------------------------------------
  test('pngSize：读 IHDR 宽高，非 PNG 返回 null', () => {
    const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.png'));
    deepEqual(w.pngSize(png), { width: 3, height: 2 });
    equal(w.pngSize(Buffer.from('not a png at all, really')), null);
    equal(w.pngSize(Buffer.alloc(4)), null);
  });

  test('detectAsepriteErrors：认出藏在 stdout 里的失败文本', () => {
    deepEqual(w.detectAsepriteErrors('File not found: "nope.aseprite"\nA document is needed before --save-as argument', ''), [
      'File not found: "nope.aseprite"',
      'A document is needed before --save-as argument',
    ]);
    deepEqual(w.detectAsepriteErrors('', 'aseprite.exe: Invalid option --padding'), ['aseprite.exe: Invalid option --padding']);
    deepEqual(w.detectAsepriteErrors('normal output\n', ''), []);
    deepEqual(w.detectAsepriteErrors(null, undefined), []);
  });

  test('parseVersion：从 --version / --help 文本里抠版本号', () => {
    equal(w.parseVersion('Aseprite 1.3.18.6-x64'), '1.3.18.6-x64');
    equal(w.parseVersion('Aseprite v1.3.18.6-x64 | A pixel art program'), '1.3.18.6-x64');
    equal(w.parseVersion('nothing here'), null);
  });

  test('candidateAsepritePaths：设置里的路径排第一，含环境变量与 Steam 库', () => {
    const list = w.candidateAsepritePaths('Z:\\Custom\\aseprite.exe');
    const paths = list.map((c) => c.path.toLowerCase());
    equal(paths[0], 'z:\\custom\\aseprite.exe');
    equal(list[0].source, 'setting');
    assert(paths.some((p) => p.includes('steamlibrary')), '应包含 Steam 库候选');
    assert(list.some((c) => c.source === 'PATH'), '应包含 PATH 候选');
    // 去重
    const unique = new Set(paths);
    equal(unique.size, paths.length, '候选路径不应重复');
  });

  test('findAsepriteExecutables：不存在的目录返回空列表而不抛错', () => {
    const res = w.findAsepriteExecutables('Z:\\nope\\aseprite.exe');
    assert(Array.isArray(res.found), 'found 应为数组');
    assert(res.tried > 0, '应报告检查了多少个候选');
    assert(!res.found.some((f) => f.path.toLowerCase().includes('nope')), '不存在的路径不应出现在结果里');
  });

  // ---- 清单与代码一致性 ----------------------------------------------------
  test('ghost.json：合法 JSON，工具契约完整', () => {
    const raw = fs.readFileSync(path.join(PLUGIN, 'ghost.json'), 'utf8');
    const m = JSON.parse(raw);
    equal(m.schemaVersion, 3);
    equal(m.id, 'aseprite-cli');
    equal(m.name, 'Aseprite 工具箱');
    equal(m.entry, 'main.js');
    equal(m.node.entry, 'node/worker.cjs');
    equal(m.node.protocol, 'json-rpc-stdio');
    equal(m.node.lifecycle, 'on-demand');
    equal(m.settingsHtml, 'settings.html');
    deepEqual(m.cindy, { media: ['deposit'] }, '预览要立刻显示必须申请 media deposit');
    equal(m.tools.length, 6);
    for (const t of m.tools) {
      assert(/^ase_/.test(t.name), '工具名前缀：' + t.name);
      assert(t.description.length > 30, t.name + ' 的 description 太短');
      equal(t.parameters.type, 'object', t.name + ' 的 parameters 必须是 JSON Schema');
      assert(t.parameters.properties.path || t.name === 'ase_doctor', t.name + ' 应该要求 path 参数');
    }
    const frameTool = m.tools.find((t) => t.name === 'ase_export_sheet');
    assert(!frameTool.parameters.properties.from, 'sheet 不该暴露 from（1.3.18.6 不支持）');
    assert(!frameTool.parameters.properties.tag, 'sheet 不该暴露 tag（1.3.18.6 不支持）');
    assert(frameTool.parameters.properties.out_dir, 'sheet 也要能指定 out_dir');
    for (const t of m.tools.filter((x) => x.name !== 'ase_doctor' && x.name !== 'ase_info' && x.name !== 'ase_preview')) {
      assert(/exports\//.test(t.description), t.name + ' 的描述里要写清 exports/ 落点规则');
    }
  });

  test('ghost.json 的每个工具在 worker 里都有对应方法', () => {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'ghost.json'), 'utf8'));
    for (const t of m.tools) {
      const method = t.name.replace(/^ase_/, 'ase/');
      assert(typeof w.METHODS[method] === 'function', 'worker 缺方法：' + method);
    }
    equal(Object.keys(w.METHODS).length, m.tools.length, 'worker 方法数与清单工具数应一致');
  });

  test('main.js：覆盖全部工具，且声明了 deposit 与 BroadcastChannel 桥', () => {
    const src = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'ghost.json'), 'utf8'));
    for (const t of m.tools) assert(src.includes(t.name), 'main.js 缺少工具分发：' + t.name);
    assert(src.includes('deposit_media'), 'main.js 要调用 deposit_media');
    assert(src.includes('xdt_image_urls'), '预览结果要带 xdt_image_urls');
    assert(src.includes('cancelWithCall'), 'node 请求要带 cancelWithCall');
    assert(src.includes('aseprite-cli'), '设置页 BroadcastChannel 名称要一致');
    assert(src.includes('exportDirMode'), 'main.js 要把落点模式传给 worker');
    assert(src.includes("!== undefined") && src.includes('exportSubdir'), '老设置 exportSubdir 要能迁移');
  });

  test('settings.js / settings.html：字段与 /kv 键一致', () => {
    const js = fs.readFileSync(path.join(PLUGIN, 'settings.js'), 'utf8');
    const html = fs.readFileSync(path.join(PLUGIN, 'settings.html'), 'utf8');
    for (const key of ['asepritePath', 'exportDirMode', 'sheetType', 'shapePadding', 'borderPadding', 'scale']) {
      assert(js.includes(key), 'settings.js 缺字段：' + key);
      assert(html.includes('id="' + key + '"'), 'settings.html 缺元素：' + key);
    }
    assert(js.includes("fetch('/kv'"), 'settings.js 必须用绝对 /kv 路径');
    assert(html.includes('src="/settings.js"'), '脚本必须外挂（CSP 不放行内联脚本）');
  });

  test('打包物不含 node_modules / 依赖声明', () => {
    assert(!fs.existsSync(path.join(PLUGIN, 'node_modules')), '插件目录不该有 node_modules');
    assert(!fs.existsSync(path.join(PLUGIN, 'package.json')), '零依赖插件不需要 package.json');
  });
}

// ---- worker 协议（不需要 aseprite.exe）-------------------------------------
function registerProtocol() {
  test('worker JSON-RPC：未知方法回 -32601，坏 JSON 回 -32700', async () => {
    const { WorkerClient } = require('./lib/worker-client.cjs');
    const client = new WorkerClient(path.join(PLUGIN, 'node', 'worker.cjs'));
    try {
      const messages = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker 10 秒内没有响应（子进程可能没起来）')), 10000);
        client.child.stdout.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          for (const line of text.split(String.fromCharCode(10))) {
            if (!line.trim()) continue;
            try {
              messages.push(JSON.parse(line));
            } catch {
              /* 不完整行忽略 */
            }
          }
          if (messages.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        client.child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error('worker 提前退出，code=' + code + '（stderr：' + client.stderr.slice(0, 200) + '）'));
        });
        client.child.stdin.write('this is not json' + String.fromCharCode(10));
        client.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ase/nope', params: {} }) + String.fromCharCode(10)
        );
      });
      equal(messages[0].error.code, -32700, '坏 JSON 应回解析错误');
      equal(messages[1].id, 7);
      equal(messages[1].error.code, -32601, '未知方法应回 -32601');
    } finally {
      client.close();
    }
  });
}

// ---- 宿主加载方式回归（require() 入库 + 虚拟 stdin）-----------------------
function registerHostBootstrap() {
  test('worker：按宿主方式 require 加载也能响应（回归：曾因 require.main 判断静默超时）', async () => {
    const script = [
      "const { PassThrough } = require('node:stream');",
      'const stdin = new PassThrough();',
      "Object.defineProperty(process, 'stdin', { configurable: true, enumerable: true, value: stdin });",
      'const entry = ' + JSON.stringify(path.join(PLUGIN, 'node', 'worker.cjs')) + ';',
      "process.argv[1] = 'C:/fake/host-bootstrap.js';",
      'process.argv[2] = entry;',
      'require(entry);',
      "setTimeout(() => stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ase/nope', params: {} }) + String.fromCharCode(10)), 30);",
      'setTimeout(() => process.exit(0), 1200);',
    ].join(String.fromCharCode(10));
    const probe = path.join(os.tmpdir(), 'ase-boot-sim-' + process.pid + '.cjs');
    fs.writeFileSync(probe, script, 'utf8');
    let child = null;
    try {
      const out = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [probe], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ASE_WORKER_NO_AUTOSTART: '0' },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          reject(new Error('模拟宿主加载的探针 10 秒内没有退出（stderr：' + stderr.slice(0, 200) + '）'));
        }, 10000);
        child.stdout.on('data', (b) => {
          stdout += b.toString('utf8');
        });
        child.stderr.on('data', (b) => {
          stderr += b.toString('utf8');
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve({ stdout, stderr });
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      const line = out.stdout.split(String.fromCharCode(10)).find((l) => l.includes('"id":9'));
      assert(line, '宿主式加载时 worker 没有响应（stderr：' + out.stderr.slice(0, 200) + '）');
      equal(JSON.parse(line).error.code, -32601, '应回 -32601');
    } finally {
      if (child && !child.killed) child.kill();
      fs.rmSync(probe, { force: true });
    }
  });

  test('worker：被测试进程 require 时不会抢 stdin', async () => {
    // 本测试文件顶部就 require 了 worker，跑到这里说明进程没被它接管
    assert(typeof w.METHODS === 'object', 'worker 模块导出应可用');
    assert(typeof w.METHODS['ase/info'] === 'function');
  });
}

module.exports = { register, registerProtocol, registerHostBootstrap };
