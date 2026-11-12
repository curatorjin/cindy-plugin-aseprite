'use strict';

/**
 * Aseprite 工具箱 · 随包 Node 工作进程
 *
 * 这里做所有本机文件读写与进程调用：main.js 是浏览器沙箱，读写不了任意本地路径。
 * 所有 Aseprite 结构化信息与导出都通过 aseprite.exe 的命令行完成，不解析 .aseprite 二进制。
 *
 * 协议：stdin/stdout，一行一个 JSON-RPC 2.0 消息。stdout 只写协议消息。
 *
 * 已在本机 Aseprite 1.3.18.6-x64 上实测的 CLI 事实（详见 README「CLI 实测记录」）：
 *   - 退出码恒为 0，失败信息写在 stdout/stderr 的文本里 → 必须靠文本 + 产物存在性判断；
 *   - --frame-range / --save-as 里的 {frame} / {frame0} 是 0 起，{frame1} 是 1 起；
 *   - --script-param 必须写在 --script 之前，否则 app.params 读不到；
 *   - 没有 --padding，只有 --border-padding / --shape-padding / --inner-padding；
 *   - --split-layers 只在 --save-as 下生效，配 --sheet 会静默忽略。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PROTOCOL = 'json-rpc-stdio';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_INFO_FRAMES = 20000;
const MAX_PREVIEW_BYTES = 600 * 1024; // base64 后约 800KB，留在单行 stdout 1MB 以内
const SHEET_TYPES = ['horizontal', 'vertical', 'rows', 'columns', 'packed'];
const SHEET_FORMATS = ['json-array', 'json-hash'];
const EXPORT_DIR_MODES = ['auto', 'always', 'same'];

const COLOR_MODES = { 0: 'rgb', 1: 'grayscale', 2: 'indexed', 4: 'tilemap' };

// gfx::BlendMode 的数值来自 Lua 侧 BlendMode 常量表实测
const BLEND_MODES = {
  0: 'clear',
  1: 'src',
  2: 'dst',
  3: 'normal',
  4: 'dst_over',
  5: 'src_in',
  6: 'dst_in',
  7: 'src_out',
  8: 'dst_out',
  9: 'src_atop',
  10: 'dst_atop',
  11: 'xor',
  12: 'plus',
  13: 'modulate',
  14: 'multiply',
  15: 'screen',
  16: 'overlay',
  17: 'darken',
  18: 'lighten',
  19: 'color_dodge',
  20: 'color_burn',
  21: 'hard_light',
  22: 'soft_light',
  23: 'difference',
  24: 'exclusion',
  25: 'hsl_hue',
  26: 'hsl_saturation',
  27: 'hsl_color',
  28: 'hsl_luminosity',
  29: 'addition',
  30: 'subtract',
  31: 'divide',
};

// Aseprite 把这些失败信息写在普通输出流里，退出码仍是 0
const FAILURE_PATTERNS = [
  /Invalid option/i,
  /Unknown option/i,
  /File not found/i,
  /A document is needed/i,
  /Cannot load file/i,
  /cannot be opened/i,
  /Error loading/i,
  /^Error:/i,
];

// ---------------------------------------------------------------------------
// 纯函数（可单测，不依赖 exe）
// ---------------------------------------------------------------------------

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function colorModeName(id) {
  return COLOR_MODES[id] || 'mode_' + String(id);
}

function blendModeName(id) {
  return BLEND_MODES[id] || 'blend_' + String(id);
}

/** 删除 Windows 文件名非法字符，用于生成的默认文件名 */
function sanitizeBaseName(name, fallback) {
  const cleaned = String(name == null ? fallback : name)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || String(fallback || 'sprite');
}

function normalizeScale(input, fallback) {
  if (input === undefined || input === null || input === '') {
    return fallback === undefined ? 1 : fallback;
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('scale 必须是大于 0 的数字（例如 1、2、0.5）');
    err.code = 'INVALID_ARGS';
    err.field = 'scale';
    throw err;
  }
  if (n > 32) {
    const err = new Error('scale 最大 32（再大请分步导出）');
    err.code = 'INVALID_ARGS';
    err.field = 'scale';
    throw err;
  }
  return n;
}

/**
 * 帧号在工具层统一按「人话」1 起编号，转成 CLI 需要的 0 起。
 * 返回 { from, to } 都是 0 起；两者都可缺省。
 */
function resolveFrameRange(from, to, frameCount) {
  const parse = (v, field) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n)) {
      const err = new Error(field + ' 必须是整数帧号（从 1 开始）');
      err.code = 'INVALID_ARGS';
      err.field = field;
      throw err;
    }
    if (n < 1) {
      const err = new Error(field + ' 从 1 开始计数，最小值 1');
      err.code = 'INVALID_ARGS';
      err.field = field;
      throw err;
    }
    return n;
  };
  let a = parse(from, 'from');
  let b = parse(to, 'to');
  if (a === null && b === null) return { from: null, to: null };
  if (a === null) a = 1;
  if (b === null) b = a;
  if (b < a) {
    const err = new Error('to 不能小于 from（帧号从 1 开始）');
    err.code = 'INVALID_ARGS';
    err.field = 'to';
    throw err;
  }
  if (frameCount && b > frameCount) {
    const err = new Error('帧号超出范围：这个 sprite 只有 ' + frameCount + ' 帧（from/to 都从 1 开始）');
    err.code = 'INVALID_ARGS';
    err.field = 'to';
    throw err;
  }
  return { from: a - 1, to: b - 1 };
}

function frameRangeArg(range) {
  if (range.from === null || range.to === null) return null;
  return String(range.from) + ',' + String(range.to);
}

/** JSON 参数里的布尔开关：缺省 false，认 true/false 与 1/0 之类的字符串 */
function flagOn(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** 源文件 basename 去掉扩展名，就是 Aseprite 的 {title} */
function spriteTitle(sourcePath) {
  const base = path.basename(String(sourcePath == null ? '' : sourcePath));
  const ext = path.extname(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

/**
 * 这一批导出的第一帧在 Studio 里的 1 基帧号。
 * 配了 --tag 时文件名里的帧号是标签内序号，得用标签的 fromFrame 换算回全局帧号；
 * 拿不到标签信息就返回 null（不编造）。
 */
function resolveFrameStart(tagName, tags, range) {
  if (tagName) {
    const hit = (tags || []).find((t) => t.name === tagName);
    return hit && Number.isInteger(hit.from) && hit.from >= 1 ? hit.from : null;
  }
  if (range && range.from !== null) return range.from + 1;
  return 1;
}

/**
 * 导出落点（按份数自动判定）：
 *   - 显式给了 out_dir → 就用它；
 *   - always → 源文件目录下的 exports/；
 *   - same   → 源文件同目录；
 *   - auto（缺省）→ 本次产出 ≥2 个文件就用 exports/，只 1 个就落在源文件同目录。
 */
function resolveExportDir(sourcePath, outDir, mode, fileCount) {
  if (outDir !== undefined && outDir !== null && String(outDir).trim() !== '') {
    return path.resolve(String(outDir).trim());
  }
  const base = path.dirname(path.resolve(sourcePath));
  const resolved = sanitizeExportDirMode(mode);
  if (resolved === 'same') return base;
  if (resolved === 'always') return path.join(base, 'exports');
  return Number(fileCount) >= 2 ? path.join(base, 'exports') : base;
}

function sanitizeExportDirMode(input) {
  if (input === undefined || input === null || input === '') return 'auto';
  const v = String(input).trim().toLowerCase();
  if (!EXPORT_DIR_MODES.includes(v)) {
    const err = new Error('export_dir_mode 只能是 ' + EXPORT_DIR_MODES.join(' / '));
    err.code = 'INVALID_ARGS';
    err.field = 'export_dir_mode';
    throw err;
  }
  return v;
}

/**
 * 同名文件不静默覆盖：已存在就找 <名字>-2 / -3 …
 * （同一批导出之间也不会互相覆盖，因为模板必须带 {frame} / {layer} 占位符）
 */
function uniqueTargetPath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let i = 2;
  while (fs.existsSync(candidate) && i < 1000) {
    candidate = path.join(dir, base + '-' + i + ext);
    i += 1;
  }
  if (fs.existsSync(candidate)) candidate = path.join(dir, base + '-' + Date.now() + ext);
  return candidate;
}

function validateNameTemplate(template, requiredPlaceholders, toolName) {
  if (!template) return;
  if (/[\\/]/.test(template)) {
    const err = new Error('name_template 不能包含路径分隔符（\ 或 /），只写文件名部分；目录用 out_dir 指定');
    err.code = 'INVALID_ARGS';
    err.field = 'name_template';
    throw err;
  }
  if (requiredPlaceholders && requiredPlaceholders.length) {
    const has = requiredPlaceholders.some((ph) => template.includes(ph));
    if (!has) {
      const err = new Error(
        'name_template 必须包含 ' + requiredPlaceholders.join(' 或 ') + ' 中至少一个，否则多个文件会互相覆盖（当前：' + template + '）'
      );
      err.code = 'INVALID_ARGS';
      err.field = 'name_template';
      throw err;
    }
  }
}

function sanitizeSheetType(input) {
  if (input === undefined || input === null || input === '') return 'horizontal';
  const v = String(input).trim();
  if (!SHEET_TYPES.includes(v)) {
    const err = new Error('sheet_type 只能是 ' + SHEET_TYPES.join(' / '));
    err.code = 'INVALID_ARGS';
    err.field = 'sheet_type';
    throw err;
  }
  return v;
}

function sanitizeSheetFormat(input) {
  if (input === undefined || input === null || input === '') return 'json-array';
  const v = String(input).trim();
  if (!SHEET_FORMATS.includes(v)) {
    const err = new Error('format 只能是 ' + SHEET_FORMATS.join(' / '));
    err.code = 'INVALID_ARGS';
    err.field = 'format';
    throw err;
  }
  return v;
}

function sanitizePadding(input, field) {
  if (input === undefined || input === null || input === '') return 0;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > 64) {
    const err = new Error(field + ' 必须是 0–64 的整数');
    err.code = 'INVALID_ARGS';
    err.field = field;
    throw err;
  }
  return n;
}

/** 默认文件名模板：{frame1} 与人类 1 起帧号对齐；{title} / {layer} 由 Aseprite 展开 */
function defaultFrameTemplate() {
  return '{title}-{frame1}.png';
}

function defaultLayerTemplate() {
  return '{title}-{layer}-{frame1}.png';
}

function defaultSheetName() {
  return '{title}-sheet';
}

// --- 帧号 ↔ 文件名对照 -----------------------------------------------------

/** 文件名里的帧号占位符：{frame1} 是 1 起；{frame}/{frame0} 是 0 起（1.3.18.6 实测） */
const FRAME_PLACEHOLDER_RE = /\{frame1\}|\{frame0\}|\{frame\}/g;

const FRAME_NUMBERING_NOTE = '文件名中的 {frame1} 与 Studio 帧号一致（1 基）；{frame}/{frame0} 为 0 基';

/** 文件名里不是全局帧号时用的占位符说明（不承诺“与 Studio 一致”） */
const FRAME_PLACEHOLDER_BASE_NOTE = '占位符约定：{frame1} 是 1 基，{frame}/{frame0} 是 0 基';

/** 模板里恰好一个帧号占位符时返回它（Aseprite 只替换先出现的那个，多个就别猜） */
function framePlaceholderIn(template) {
  const hits = String(template == null ? '' : template).match(FRAME_PLACEHOLDER_RE) || [];
  return hits.length === 1 ? hits[0] : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 --save-as 模板变成匹配实际文件名的正则：帧号占位符抽成捕获组，其它占位符当通配 */
function buildFrameNameRegExp(template) {
  const src = String(template == null ? '' : template);
  const token = /\{([A-Za-z0-9_]+)\}/g;
  let out = '^';
  let last = 0;
  let captures = 0;
  let m;
  while ((m = token.exec(src)) !== null) {
    out += escapeRegExp(src.slice(last, m.index));
    const name = m[1];
    if (name === 'frame' || name === 'frame0' || name === 'frame1') {
      out += '(\\d+)';
      captures += 1;
    } else {
      out += '[\\s\\S]*?';
    }
    last = m.index + m[0].length;
  }
  out += escapeRegExp(src.slice(last)) + '$';
  if (captures !== 1) return null;
  return new RegExp(out);
}

/** 从实际文件名反推 1 起帧号（按模板里那个占位符的语义换算）；抠不出来返回 null */
function frameNumberFromFileName(fileName, template) {
  const ph = framePlaceholderIn(template);
  const re = buildFrameNameRegExp(template);
  if (!ph || !re) return null;
  const m = re.exec(String(fileName == null ? '' : fileName));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0) return null;
  return ph === '{frame1}' ? n : n + 1;
}

/** 文件名按「数字段按数值」比较：frame_2.png 排在 frame_10.png 前面 */
function compareFileNames(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * 帧号对照表：每帧一行 { file, frame1, frame0 }，数组顺序即帧序。
 * names 是本次产物的文件名（按帧序）；startFrame1 是这批第一帧在 Studio 里的 1 基帧号。
 * 优先按文件名反推（模板里带帧号占位符时）；反推不出来、或名字里的序号不是全局帧号
 * （例如配了 --tag 时是标签内序号）就按产物顺序配对；连起始帧都不知道就返回空数组 + note。
 */
function buildFrameMapping(names, template, startFrame1, scopeLabel) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n));
  const base = Number.isInteger(startFrame1) && startFrame1 >= 1 ? startFrame1 : null;
  const ph = framePlaceholderIn(template);
  const scope = scopeLabel || '导出区间内';

  if (list.length === 0) {
    return { frameMapping: [], note: '本次没有产物文件，无法给出帧号对照' };
  }

  if (!ph) {
    if (base === null) {
      return { frameMapping: [], note: '自定义模板未含帧号占位符，无法自动对应（也拿不到起始帧号）' };
    }
    return {
      frameMapping: list.map((file, i) => ({ file, frame1: base + i, frame0: base + i - 1 })),
      note:
        '自定义模板未含帧号占位符，文件名里没有帧号，只能按产物顺序配对：第 ' +
        base +
        '–' +
        (base + list.length - 1) +
        ' 帧；' +
        FRAME_NUMBERING_NOTE,
    };
  }

  const parsed = list.map((f) => frameNumberFromFileName(f, template));
  const parsedAll = parsed.every((n) => Number.isInteger(n));
  // 名字里的帧号必须从 startFrame1 起逐帧递增才算可信
  const namedOk = parsedAll && (base === null || parsed[0] === base) && parsed.every((n, i) => n === parsed[0] + i);
  const first = namedOk ? parsed[0] : base;
  if (first === null) {
    return { frameMapping: [], note: '模板未含可识别的帧号占位符，无法自动对应（也拿不到起始帧号）' };
  }
  const frameMapping = list.map((file, i) => ({ file, frame1: first + i, frame0: first + i - 1 }));
  const span = '本次 ' + frameMapping.length + ' 帧：第 ' + first + '–' + (first + list.length - 1) + ' 帧';
  let note;
  if (namedOk) {
    note = FRAME_NUMBERING_NOTE + '。' + span + '（文件名里的帧号已核对）';
  } else if (parsedAll && parsed[0] === 1) {
    // 文件名里是相对序号（配 --tag 是标签内，限定范围时是区间内），不是 Studio 全局帧号
    note =
      span +
      '；文件名里是' +
      scope +
      '的序号，不是 Studio 全局帧号，已按实际帧序换算。' +
      FRAME_PLACEHOLDER_BASE_NOTE;
  } else {
    note = span + '（模板占位符和文件名对不上，按产物顺序配对）。' + FRAME_PLACEHOLDER_BASE_NOTE;
  }
  return { frameMapping, note };
}

// --- 按全局帧号重命名（name_from_global_frame）----------------------------

/** 把 name_template 拆成文本片段与占位符 token（保序） */
function templateTokens(template) {
  const src = String(template == null ? '' : template);
  const tokens = [];
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) tokens.push({ text: src.slice(last, m.index) });
    tokens.push({ name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ text: src.slice(last) });
  return tokens;
}

function isFramePlaceholder(name) {
  return name === 'frame' || name === 'frame0' || name === 'frame1';
}

/**
 * 按 Studio 全局帧号生成文件名（纯函数，不碰磁盘）。
 *   template      name_template，必须带、且只带一个帧号占位符
 *   frame1        该帧在 Studio 里的 1 基帧号（全局帧号，不是区间内序号）
 *   originalName  Aseprite 实际产出的文件名，用于拆出 {layer} 等占位符的展开结果
 *   title         源文件 basename（去扩展名）
 *
 * 规则：{frame1} → 全局帧号；{frame}/{frame0} → 全局帧号 - 1；{title} → title；
 * 其它占位符（{layer} / {tag} / {duration} …）原样保留 Aseprite 展开的那段文字。
 */
function globalFrameFileName(template, frame1, originalName, title) {
  const n = Number(frame1);
  if (!Number.isInteger(n) || n < 1) {
    throw toolError('INVALID_ARGS', '按全局帧号命名需要 1 基帧号，拿到的是 ' + String(frame1));
  }
  const tokens = templateTokens(template);
  const frameTokens = tokens.filter((t) => t.name && isFramePlaceholder(t.name));
  if (frameTokens.length === 0) {
    throw toolError(
      'INVALID_ARGS',
      'name_from_global_frame 要求 name_template 里带帧号占位符（{frame1} / {frame} / {frame0}），当前模板：' + String(template)
    );
  }
  if (frameTokens.length > 1) {
    throw toolError(
      'INVALID_ARGS',
      'name_template 里有 ' + frameTokens.length + ' 个帧号占位符，Aseprite 只替换第一个，无法按全局帧号命名；请只保留一个'
    );
  }

  const titleText = title === undefined || title === null ? null : String(title);
  // groupNames[k] 是第 k+1 个捕获组对应的占位符名（{title} 已知时直接用字面量，不占捕获组）
  const groupNames = [];
  let pattern = '^';
  for (const t of tokens) {
    if (t.text !== undefined) {
      pattern += escapeRegExp(t.text);
    } else if (t.name === 'title' && titleText !== null) {
      pattern += escapeRegExp(titleText);
    } else if (t.name !== 'title' && isFramePlaceholder(t.name)) {
      pattern += '(\\d+)';
      groupNames.push(t.name);
    } else {
      pattern += '([\\s\\S]*?)';
      groupNames.push(t.name);
    }
  }
  pattern += '$';

  const copyNames = groupNames.filter((nm) => !isFramePlaceholder(nm) && !(nm === 'title' && titleText !== null));
  const extracted = Object.create(null);
  if (copyNames.length) {
    let m = null;
    try {
      m = new RegExp(pattern).exec(String(originalName == null ? '' : originalName));
    } catch {
      m = null;
    }
    if (!m) {
      throw toolError(
        'INVALID_ARGS',
        '无法从原文件名 ' + String(originalName) + ' 里拆出 ' + copyNames.map((nm) => '{' + nm + '}').join('') +
          ' 段，这个 name_template 不支持按全局帧号重命名（把占位符之间加上明确的分隔符，或去掉该占位符）'
      );
    }
    groupNames.forEach((nm, i) => {
      if (isFramePlaceholder(nm) || (nm === 'title' && titleText !== null)) return;
      extracted[nm] = m[i + 1];
    });
    for (const nm of copyNames) {
      if (!extracted[nm]) {
        throw toolError(
          'INVALID_ARGS',
          '原文件名 ' + String(originalName) + ' 里的 {' + nm + '} 段是空的，无法按全局帧号重命名'
        );
      }
    }
  }

  let out = '';
  for (const t of tokens) {
    if (t.text !== undefined) out += t.text;
    else if (t.name === 'frame1') out += String(n);
    else if (t.name === 'frame' || t.name === 'frame0') out += String(n - 1);
    else if (t.name === 'title') out += titleText === null ? extracted.title : titleText;
    else out += extracted[t.name];
  }
  return path.basename(out);
}

/**
 * 在暂存目录里把这一批产物按全局帧号改名。
 * 两段式改名（先改成临时名、再改成目标名）：否则「A 改成 B」的时候
 * B 可能还是本批另一个还没改名的文件，会白白拿到 -2 后缀。
 * 目标名已存在时一律走 uniqueTargetPath，绝不覆盖。
 *
 * items: [{ path, name, frame1 }]，name 是 Aseprite 原产文件名，顺序即帧序
 * 返回 [{ from, to, path }]，顺序与 items 一致
 */
function renameFramesToGlobalName(dir, items, template, title) {
  const stamp = Date.now();
  const plan = items.map((it, i) => ({
    item: it,
    wanted: globalFrameFileName(template, it.frame1, it.name, title),
    tmp: path.join(dir, '.ase-rename-' + i + '-' + stamp + path.extname(it.name)),
  }));
  for (const p of plan) moveFile(p.item.path, p.tmp);
  const out = [];
  for (const p of plan) {
    const target = uniqueTargetPath(dir, p.wanted);
    moveFile(p.tmp, target);
    out.push({ from: p.item.name, to: path.basename(target), path: target });
  }
  return out;
}

// --- 参数拼装 -------------------------------------------------------------

function buildPreviewArgs(source, frameIndex0, outPng, options) {
  const opts = options || {};
  const args = ['-b', source];
  if (opts.tag) args.push('--tag', String(opts.tag));
  args.push('--frame-range', String(frameIndex0) + ',' + String(frameIndex0));
  if (opts.scale && Number(opts.scale) !== 1) args.push('--scale', String(opts.scale));
  args.push('--save-as', outPng);
  return args;
}

function buildFramesArgs(source, template, options) {
  const opts = options || {};
  const args = ['-b', source];
  const range = frameRangeArg({
    from: opts.from === undefined ? null : opts.from,
    to: opts.to === undefined ? null : opts.to,
  });
  if (range) args.push('--frame-range', range);
  if (opts.tag) args.push('--tag', String(opts.tag));
  if (opts.scale && Number(opts.scale) !== 1) args.push('--scale', String(opts.scale));
  if (opts.trim) args.push('--trim');
  if (opts.ignoreEmpty) args.push('--ignore-empty');
  args.push('--save-as', template);
  return args;
}

function buildSheetArgs(source, sheetPath, dataPath, options) {
  const opts = options || {};
  // 实测 1.3.18.6：--frame-range / --tag / --oneframe 对 --sheet 不生效（只影响 --save-as），
  // 所以这里不拼帧范围，避免给人“已经过滤了”的错觉。
  const args = ['-b', source, '--sheet', sheetPath];
  args.push('--data', dataPath);
  args.push('--format', opts.format || 'json-array');
  args.push('--sheet-type', opts.sheetType || 'horizontal');
  if (opts.shapePadding) args.push('--shape-padding', String(opts.shapePadding));
  if (opts.borderPadding) args.push('--border-padding', String(opts.borderPadding));
  if (opts.scale && Number(opts.scale) !== 1) args.push('--scale', String(opts.scale));
  if (opts.trim) args.push('--trim');
  if (opts.ignoreEmpty) args.push('--ignore-empty');
  args.push('--list-layers', '--list-tags', '--list-slices');
  return args;
}

function buildLayersArgs(source, template, options) {
  const opts = options || {};
  const args = ['-b', source, '--split-layers'];
  if (opts.tag) args.push('--tag', String(opts.tag));
  if (opts.scale && Number(opts.scale) !== 1) args.push('--scale', String(opts.scale));
  if (opts.trim) args.push('--trim');
  if (opts.ignoreEmpty) args.push('--ignore-empty');
  args.push('--save-as', template);
  return args;
}

function buildInfoArgs(scriptPath) {
  // 结构 dump 靠 Lua 脚本读文件；--script-param 必须排在 --script 前面（1.3.18.6 实测）
  return ['-b', '--script', scriptPath];
}

// --- 输出解析 -------------------------------------------------------------

/** 从 PNG 字节里读 IHDR 宽高，不引依赖 */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Aseprite 的错误文本：退出码不可信，只能靠文本 */
function detectAsepriteErrors(stdout, stderr) {
  const lines = [];
  const scan = (text) => {
    if (!text) return;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (FAILURE_PATTERNS.some((re) => re.test(line))) lines.push(line);
    }
  };
  scan(stdout);
  scan(stderr);
  return Array.from(new Set(lines)).slice(0, 8);
}

function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// --- Lua 结构 dump 脚本 ----------------------------------------------------

/**
 * 生成 ase_info 用的 Lua 脚本（含 in/out 路径与帧数上限）。
 * 路径直接内联进脚本，不依赖 app.params（--script-param 的解析顺序是个坑）。
 */
function buildInfoLua(sourcePath, outPath, frameLimit) {
  const luaString = (s) => '"' + toPosix(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const limit = Math.max(1, Math.min(MAX_INFO_FRAMES, Number(frameLimit) || 1000));
  return [
    '-- generated by cindy-plugin-aseprite (ase_info)',
    'local OUT = ' + luaString(outPath),
    'local SRC = ' + luaString(sourcePath),
    'local LIMIT = ' + limit,
    '',
    'local function hex(c)',
    '  return string.format("#%02x%02x%02x%02x",',
    '    math.floor(c.red + 0.5), math.floor(c.green + 0.5),',
    '    math.floor(c.blue + 0.5), math.floor(c.alpha + 0.5))',
    'end',
    '',
    'local function rect(t)',
    '  if t == nil then return nil end',
    '  return { x = t.x, y = t.y, width = t.width, height = t.height }',
    'end',
    '',
    'local function buildBlendNames()',
    '  local skip = { CLEAR = true, SRC = true, DST = true, SRC_OVER = true, DST_OVER = true,',
    '    SRC_IN = true, DST_IN = true, SRC_OUT = true, DST_OUT = true, SRC_ATOP = true,',
    '    DST_ATOP = true, XOR = true }',
    '  local map = {}',
    '  for name, id in pairs(BlendMode) do',
    '    if map[id] == nil or skip[map[id]] then',
    '      if not (skip[name] and map[id] ~= nil) then map[id] = name end',
    '    end',
    '  end',
    '  for id, name in pairs(map) do map[id] = string.lower(name) end',
    '  return map',
    'end',
    '',
    'local BLEND = buildBlendNames()',
    'local COLOR_MODE = { [0] = "rgb", [1] = "grayscale", [2] = "indexed", [4] = "tilemap" }',
    'local warnings = {}',
    'local function warn(msg) warnings[#warnings + 1] = msg end',
    'local result = { warnings = warnings, file = SRC }',
    '',
    'local function dump()',
    '  local okOpen, sp = pcall(app.open, SRC)',
    '  if not okOpen or sp == nil then',
    '    result.error = "open_failed"',
    '    result.errorDetail = tostring(sp)',
    '    return',
    '  end',
    '',
    '  local sprite = {',
    '    width = sp.width, height = sp.height,',
    '    colorMode = COLOR_MODE[sp.colorMode] or ("mode_" .. tostring(sp.colorMode)),',
    '    colorModeId = sp.colorMode, frameCount = #sp.frames,',
    '  }',
    '  local okGrid = pcall(function() sprite.grid = rect(sp.gridBounds) end)',
    '  if not okGrid then warn("grid_unreadable") end',
    '  result.sprite = sprite',
    '',
    '  local frames = {}',
    '  local totalMs = 0',
    '  local limit = math.min(#sp.frames, LIMIT)',
    '  for i = 1, limit do',
    '    local fr = sp.frames[i]',
    '    local ms = math.floor(fr.duration * 1000 + 0.5)',
    '    totalMs = totalMs + ms',
    '    frames[#frames + 1] = { frame = i, durationMs = ms }',
    '  end',
    '  if #sp.frames > limit then',
    '    warn("frames_truncated: kept " .. limit .. " of " .. #sp.frames)',
    '  end',
    '  result.frames = frames',
    '  sprite.totalDurationMs = totalMs',
    '',
    '  local function layerNode(l, index)',
    '    local node = { index = index, name = l.name, visible = l.isVisible == true }',
    '    if l.isGroup then node.type = "group"',
    '    elseif l.isTilemap then node.type = "tilemap"',
    '    elseif l.isReference then node.type = "reference"',
    '    else node.type = "image" end',
    '    if l.opacity ~= nil then node.opacity = l.opacity end',
    '    if l.blendMode ~= nil then',
    '      node.blendMode = BLEND[l.blendMode] or ("blend_" .. tostring(l.blendMode))',
    '      node.blendModeId = l.blendMode',
    '    end',
    '    if l.isBackground ~= nil then node.isBackground = l.isBackground == true end',
    '    if l.isGroup then',
    '      local children = {}',
    '      local okc, list = pcall(function() return l.layers end)',
    '      if okc and list then',
    '        for j = 1, #list do children[#children + 1] = layerNode(list[j], j) end',
    '      else',
    '        warn("group_children_unreadable: " .. tostring(node.name))',
    '      end',
    '      node.children = children',
    '    end',
    '    return node',
    '  end',
    '',
    '  local layers = {}',
    '  local okLayers = pcall(function()',
    '    for i = 1, #sp.layers do layers[#layers + 1] = layerNode(sp.layers[i], i) end',
    '  end)',
    '  if not okLayers then warn("layers_unreadable") end',
    '  result.layers = layers',
    '  result.layerCount = #sp.layers',
    '',
    '  local tags = {}',
    '  local okTags = pcall(function()',
    '    for i = 1, #sp.tags do',
    '      local t = sp.tags[i]',
    '      local dirName = "forward"',
    '      if t.aniDir == AniDir.REVERSE then dirName = "reverse"',
    '      elseif t.aniDir == AniDir.PING_PONG then dirName = "pingpong"',
    '      elseif t.aniDir == AniDir.PING_PONG_REVERSE then dirName = "pingpong_reverse" end',
    '      tags[#tags + 1] = {',
    '        name = t.name,',
    '        from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber,',
    '        frameCount = t.frames, direction = dirName, directionId = t.aniDir,',
    '        color = t.color and hex(t.color) or nil,',
    '      }',
    '    end',
    '  end)',
    '  if not okTags then warn("tags_unreadable") end',
    '  result.tags = tags',
    '',
    '  local slices = {}',
    '  local okSlices = pcall(function()',
    '    for i = 1, #sp.slices do',
    '      local s = sp.slices[i]',
    '      slices[#slices + 1] = {',
    '        name = s.name, bounds = rect(s.bounds), center = rect(s.center),',
    '        pivot = s.pivot and { x = s.pivot.x, y = s.pivot.y } or nil,',
    '      }',
    '    end',
    '  end)',
    '  if not okSlices then warn("slices_unreadable") end',
    '  result.slices = slices',
    '',
    '  local okPal = pcall(function()',
    '    local pal = sp.palettes[1]',
    '    if pal == nil then return end',
    '    local colors = {}',
    '    local n = #pal',
    '    local cap = math.min(n, 512)',
    '    for i = 0, cap - 1 do',
    '      local okc, c = pcall(function() return pal:getColor(i) end)',
    '      if okc and c then colors[#colors + 1] = hex(c) end',
    '    end',
    '    result.palette = { size = n, colors = colors }',
    '    if #colors < math.min(n, cap) then warn("palette_colors_unreadable") end',
    '    if n > cap then warn("palette_truncated: kept " .. cap .. " of " .. n) end',
    '  end)',
    '  if not okPal then warn("palette_unreadable") end',
    '',
    '  local tilesets = {}',
    '  local okTs = pcall(function()',
    '    for i = 1, #sp.tilesets do',
    '      local ts = sp.tilesets[i]',
    '      local node = { name = ts.name, baseIndex = ts.baseIndex, tileCount = #ts }',
    '      pcall(function()',
    '        node.tileWidth = ts.grid.tileSize.width',
    '        node.tileHeight = ts.grid.tileSize.height',
    '      end)',
    '      tilesets[#tilesets + 1] = node',
    '    end',
    '  end)',
    '  if not okTs then warn("tilesets_unreadable") end',
    '  result.tilesets = tilesets',
    'end',
    '',
    'pcall(dump)',
    '',
    'local f = io.open(OUT, "w")',
    'if f == nil then',
    '  print("ase_info: cannot write " .. OUT)',
    '  app.exit(1)',
    'else',
    '  f:write(json.encode(result))',
    '  f:close()',
    '  app.exit(0)',
    'end',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 本机执行环境
// ---------------------------------------------------------------------------

function toolError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) err.extra = extra;
  return err;
}

function candidateAsepritePaths(configured) {
  const out = [];
  const push = (p, source) => {
    if (!p) return;
    if (!out.some((x) => x.path.toLowerCase() === String(p).toLowerCase())) {
      out.push({ path: String(p), source });
    }
  };

  push(configured, 'setting');
  push(process.env.ASEPRITE_PATH, 'env:ASEPRITE_PATH');

  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const names = process.platform === 'win32' ? ['aseprite', 'Aseprite'] : ['aseprite', 'Aseprite'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) for (const ext of exts) push(path.join(dir, name + ext), 'PATH');
  }

  if (process.platform === 'win32') {
    const bases = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
      // 宿主只给 worker 传白名单环境变量，ProgramFiles 可能缺；用 SystemDrive 兜底
      process.env.SystemDrive ? process.env.SystemDrive + '\\Program Files' : null,
      process.env.SystemDrive ? process.env.SystemDrive + '\\Program Files (x86)' : null,
    ].filter(Boolean);
    for (const base of bases) {
      push(path.join(base, 'Aseprite', 'Aseprite.exe'), 'common-location');
      push(path.join(base, 'Programs', 'Aseprite', 'Aseprite.exe'), 'common-location');
    }
    // Steam 库：常见盘符 × 常见库目录名（纯候选枚举，不假设任何具体机器）
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const lib of ['SteamLibrary', 'Steam', 'steam']) {
        for (const exe of ['aseprite.exe', 'Aseprite.exe']) {
          push(letter + ':\\' + lib + '\\steamapps\\common\\Aseprite\\' + exe, 'steam-library');
        }
      }
    }
  } else if (process.platform === 'darwin') {
    push('/Applications/Aseprite.app/Contents/MacOS/aseprite', 'common-location');
    push(path.join(os.homedir(), 'Applications/Aseprite.app/Contents/MacOS/aseprite'), 'common-location');
    push('/opt/homebrew/bin/aseprite', 'common-location');
    push('/usr/local/bin/aseprite', 'common-location');
    push(path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite'), 'steam-library');
  } else {
    push('/usr/bin/aseprite', 'common-location');
    push('/usr/local/bin/aseprite', 'common-location');
    push(path.join(os.homedir(), '.local/bin/aseprite'), 'common-location');
    push(path.join(os.homedir(), '.steam/steam/steamapps/common/Aseprite/aseprite'), 'steam-library');
  }
  return out;
}

function findAsepriteExecutables(configured) {
  const candidates = candidateAsepritePaths(configured);
  const found = [];
  const seen = new Set();
  for (const c of candidates) {
    try {
      const st = fs.statSync(c.path);
      if (!st.isFile()) continue;
      const resolved = path.resolve(c.path);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: resolved, source: c.source, size: st.size });
    } catch {
      /* 不存在就跳过 */
    }
  }
  return { found, tried: candidates.length };
}

function resolveAsepritePath(configured) {
  const { found, tried } = findAsepriteExecutables(configured);
  if (found.length > 0) return found[0];
  throw toolError(
    'ASEPRITE_NOT_FOUND',
    '没有找到 aseprite.exe。检查了 ' + tried + ' 个候选位置（设置里的路径 / 环境变量 ASEPRITE_PATH / PATH / 常见安装目录 / Steam 库）。' +
      '请在插件设置页填写 Aseprite 可执行文件的完整路径，例如 <Aseprite 安装目录>\\aseprite.exe。',
    { triedCandidates: candidateAsepritePaths(configured).slice(0, 8).map((c) => c.path) }
  );
}

function requireSourceFile(source) {
  if (!source || typeof source !== 'string' || !source.trim()) {
    throw toolError('INVALID_ARGS', '缺少 path 参数：请给出 .aseprite 文件的完整路径');
  }
  const resolved = path.resolve(source.trim());
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw toolError('SOURCE_NOT_FOUND', '文件不存在：' + resolved + '（请给出 .aseprite 文件的完整路径）');
  }
  if (!st.isFile()) throw toolError('SOURCE_NOT_FOUND', '这不是一个文件：' + resolved);
  return { path: resolved, size: st.size };
}

// 帧数缓存：1.3.18.6 里超范围帧会静默导出一张空白 PNG，所以预览/范围都要先校验帧数
const frameCountCache = new Map();

function buildCountLua(sourcePath) {
  const luaString = '"' + toPosix(sourcePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  // 顺手把标签的起止帧带回来：配 --tag 导出时要把标签内序号换算成 Studio 全局帧号
  return [
    'local ok, sp = pcall(app.open, ' + luaString + ')',
    'if ok and sp ~= nil then',
    '  print("ASEFRAMES " .. tostring(#sp.frames))',
    '  local okTags, encoded = pcall(function()',
    '    local acc = {}',
    '    for i = 1, #sp.tags do',
    '      local t = sp.tags[i]',
    '      acc[#acc + 1] = { name = t.name, from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber }',
    '    end',
    '    return json.encode(acc)',
    '  end)',
    '  if okTags and encoded ~= nil then print("ASETAGS " .. encoded) end',
    'else',
    '  print("ASEFRAMES 0")',
    'end',
    'app.exit(0)',
    '',
  ].join('\n');
}

/** 帧数 + 标签起止帧（同一次 Lua 调用拿回来，一起缓存） */
async function getSpriteMeta(asePath, src) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(src.path).mtimeMs;
  } catch {
    /* 文件刚被删掉也照样走进下面的失败分支 */
  }
  const key = src.path.toLowerCase() + '|' + mtimeMs + '|' + src.size + '|' + asePath.toLowerCase();
  if (frameCountCache.has(key)) return frameCountCache.get(key);

  const tmp = makeTempDir('cindy-aseprite-count');
  try {
    const scriptPath = path.join(tmp, 'count.lua');
    fs.writeFileSync(scriptPath, buildCountLua(src.path), 'utf8');
    const run = await runAseprite(asePath, ['-b', '--script', toPosix(scriptPath)], { timeoutMs: 60000 });
    const m = /ASEFRAMES\s+(\d+)/.exec(run.stdout);
    const count = m ? Number(m[1]) : 0;
    let tags = [];
    const tagMatch = /ASETAGS\s+(\[[^\n]*\])/.exec(run.stdout);
    if (tagMatch) {
      try {
        const parsed = JSON.parse(tagMatch[1]);
        if (Array.isArray(parsed)) {
          tags = parsed.filter(
            (t) => t && typeof t.name === 'string' && Number.isInteger(t.from) && Number.isInteger(t.to)
          );
        }
      } catch {
        /* 标签信息拿不到不影响帧数校验，只是 --tag 导出时无法给出全局帧号 */
      }
    }
    const meta = { frameCount: count, tags };
    if (count > 0) {
      if (frameCountCache.size >= 32) frameCountCache.delete(frameCountCache.keys().next().value);
      frameCountCache.set(key, meta);
    }
    return meta;
  } finally {
    removeDir(tmp);
  }
}

/** 只要帧数时用这个（老的调用点签名不变） */
async function getFrameCount(asePath, src) {
  const meta = await getSpriteMeta(asePath, src);
  return meta.frameCount || 0;
}

// ---------------------------------------------------------------------------
// 进程调用
// ---------------------------------------------------------------------------

let writeStdout = (obj) => {
  const line = JSON.stringify(obj);
  process.stdout.write(line + '\n');
};

/** 跑 aseprite.exe；长任务期间定期发通知，让主机的"沉默窗口"续期 */
function runAseprite(exePath, args, options) {
  const opts = options || {};
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exePath, args, {
        cwd: opts.cwd || path.dirname(exePath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(toolError('ASEPRITE_SPAWN_FAILED', '启动 aseprite.exe 失败：' + e.message));
      return;
    }

    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;

    const heartbeat = setInterval(() => {
      try {
        writeStdout({
          jsonrpc: '2.0',
          method: 'ase/progress',
          params: { elapsedMs: Date.now() - startedAt, args: args.length },
        });
      } catch {
        /* stdout 已关闭 */
      }
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (b) => stdoutChunks.push(b));
    child.stderr.on('data', (b) => stderrChunks.push(b));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      reject(toolError('ASEPRITE_SPAWN_FAILED', '启动 aseprite.exe 失败：' + e.message, { path: exePath }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(
          toolError(
            'ASEPRITE_TIMEOUT',
            'aseprite.exe 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有结束，已强制结束。' +
              '如果文件很大，可以先用较小的帧范围或更小的 scale 重试。',
            { args: args.slice(1) }
          )
        );
        return;
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        errors: detectAsepriteErrors(stdout, stderr),
      });
    });
  });
}

let cachedVersion = null;

async function aseVersion(asePath) {
  if (cachedVersion && cachedVersion.path === asePath) return cachedVersion.version;
  const run = await runAseprite(asePath, ['--version'], { timeoutMs: 30000 });
  const version = parseVersion(run.stdout + run.stderr);
  if (version) cachedVersion = { path: asePath, version };
  return version;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    // 跨盘符 rename 会失败，退回复制+删除
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), prefix + '-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结果 */
  }
}

function listFilesRecursive(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        let st = null;
        try {
          st = fs.statSync(full);
        } catch {
          /* ignore */
        }
        out.push({ path: full, name: path.relative(dir, full) || e.name, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 });
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 各方法实现
// ---------------------------------------------------------------------------

async function methodDoctor(params) {
  const cfg = params || {};
  const { found, tried } = findAsepriteExecutables(cfg.asepritePath);
  const checks = [];
  const guidance = [];

  if (cfg.samplePath) {
    const sample = path.resolve(String(cfg.samplePath));
    let okSample = false;
    let detail = '不存在：' + sample;
    try {
      const st = fs.statSync(sample);
      okSample = st.isFile();
      detail = okSample ? sample + '（' + st.size + ' 字节）' : '这不是文件：' + sample;
    } catch {
      /* 保持默认 detail */
    }
    checks.push({ name: '样本文件可读', ok: okSample, detail });
  }

  if (found.length === 0) {
    guidance.push('在插件设置页「Aseprite 可执行文件」里填写完整路径，再重跑 ase_doctor。');
    guidance.push('Steam 版通常在 <盘符>:\\SteamLibrary\\steamapps\\common\\Aseprite\\aseprite.exe。');
    return {
      ready: false,
      aseprite: { path: null, version: null, resolvedBy: null },
      checks: [{ name: '找到 aseprite.exe', ok: false, detail: '检查了 ' + tried + ' 个候选位置，都不存在' }],
      candidates: candidateAsepritePaths(cfg.asepritePath).slice(0, 6).map((c) => ({ path: c.path, source: c.source })),
      guidance,
    };
  }

  const target = found[0];
  checks.push({ name: '找到 aseprite.exe', ok: true, detail: target.path + '（来源：' + target.source + '）' });

  const configured = cfg.asepritePath ? path.resolve(String(cfg.asepritePath)) : null;
  if (configured && configured.toLowerCase() !== target.path.toLowerCase()) {
    checks.push({
      name: '设置里的路径可用',
      ok: false,
      detail: '设置的路径不存在或不是文件：' + configured + '；已自动回退到 ' + target.path,
    });
    guidance.push('建议把设置页里的「Aseprite 可执行文件」改成自动找到的这个路径，以后就不依赖自动搜索。');
  }

  const versionRun = await runAseprite(target.path, ['--version'], { timeoutMs: 30000 });
  const versionText = (versionRun.stdout + ' ' + versionRun.stderr).trim();
  const version = parseVersion(versionText);
  if (version) cachedVersion = { path: target.path, version };
  checks.push({
    name: '可执行并能报版本',
    ok: Boolean(version),
    detail: version ? versionText.split(/\r?\n/)[0] : '输出：' + versionText.slice(0, 200),
  });
  if (!version) guidance.push('文件存在但跑不起来，可能是权限问题或选错了文件（要选 aseprite.exe 本体）。');

  const helpRun = await runAseprite(target.path, ['--help'], { timeoutMs: 30000 });
  const helpText = helpRun.stdout + '\n' + helpRun.stderr;
  const requiredFlags = [
    '--script',
    '--script-param',
    '--save-as',
    '--sheet',
    '--data',
    '--format',
    '--sheet-type',
    '--split-layers',
    '--frame-range',
    '--tag',
    '--scale',
    '--trim',
    '--ignore-empty',
    '--border-padding',
    '--shape-padding',
    '--list-layers',
    '--list-tags',
    '--list-slices',
  ];
  const supported = requiredFlags.filter((f) => helpText.includes(f));
  const missing = requiredFlags.filter((f) => !helpText.includes(f));
  checks.push({
    name: 'CLI 参数齐全',
    ok: missing.length === 0,
    detail: missing.length === 0 ? requiredFlags.length + '/' + requiredFlags.length + ' 都在' : '缺少：' + missing.join(' '),
  });
  if (missing.length > 0) guidance.push('这个 Aseprite 版本缺少参数 ' + missing.join(' ') + '，对应工具会失败，请升级 Aseprite。');

  // 参数兼容性实测：是否有 --padding（1.3.x 没有，只有三个细分 padding）
  const paddingProbe = await runAseprite(target.path, ['--padding'], { timeoutMs: 20000 });
  const hasLegacyPadding = /Invalid option/.test(paddingProbe.stdout + paddingProbe.stderr) === false;

  return {
    ready: Boolean(version) && missing.length === 0,
    aseprite: {
      path: target.path,
      resolvedBy: target.source,
      version,
      versionRaw: versionText.split(/\r?\n/)[0] || '',
      otherCopies: found.slice(1).map((f) => f.path),
    },
    cli: {
      supportedFlags: supported,
      missingFlags: missing,
      supportsLegacyPaddingOption: hasLegacyPadding,
      frameNumbering:
        '--frame-range 与 {frame}/{frame0} 为 0 起，{frame1} 为 1 起；--save-as 文件名有 0 基陷阱：' +
        '--frame-range 7,7 --save-as f7.png 导出的是第 8 帧，全量 frame_{frame}.png 得到 frame_0…frame_(N-1)，' +
        '照着文件名猜帧号会整体错一帧（本插件工具入参一律 1 基，默认模板用 {frame1}）',
      splitLayersWithSheet: '实测 --split-layers 配 --sheet 不生效，只认 --save-as',
      splitLayersIncludesGroups: '实测分组图层会连同子层各导一张',
      allLayersEffective: false,
      sheetIgnoresFrameFilter: '实测 --frame-range / --tag / --oneframe 对 --sheet 无效（只影响 --save-as）',
      ignoreEmptyReliable: false,
      ignoreEmptyNote: '实测 sprite 里存在空帧时，--ignore-empty 会让 --save-as / --sheet 整次导出变成 0 个文件（1.3.18.6）',
      splitTagsSplitsPerFrame: '实测 --split-tags 仍是每帧一个文件（{tag} 撞名时 Aseprite 自己补帧号），不是每个 tag 一张',
      invalidSheetTypeFallsBack: '实测非法 --sheet-type 不报错，静默退回 horizontal',
      exitCodeReliable: false,
    },
    checks,
    guidance,
  };
}

async function methodInfo(params) {
  const p = params || {};
  const ase = resolveAsepritePath(p.asepritePath);
  const src = requireSourceFile(p.source);
  const frameLimit = p.frameLimit === undefined ? 1000 : Number(p.frameLimit);
  if (!Number.isFinite(frameLimit) || frameLimit < 1) {
    throw toolError('INVALID_ARGS', 'frame_limit 必须是大于 0 的整数');
  }

  const tmp = makeTempDir('cindy-aseprite-info');
  try {
    const scriptPath = path.join(tmp, 'ase_info.lua');
    const jsonPath = path.join(tmp, 'ase_info.json');
    fs.writeFileSync(scriptPath, buildInfoLua(src.path, jsonPath, frameLimit), 'utf8');
    const args = buildInfoArgs(scriptPath);
    const run = await runAseprite(ase.path, args, { timeoutMs: 120000 });
    if (run.errors.length > 0) {
      throw toolError('ASEPRITE_FAILED', 'aseprite.exe 报告错误：' + run.errors.join(' | '), { args });
    }
    let raw;
    try {
      raw = fs.readFileSync(jsonPath, 'utf8');
    } catch {
      throw toolError(
        'ASEPRITE_FAILED',
        'Lua 脚本没有生成结果文件，可能是文件损坏或不是 Aseprite 文档。aseprite 输出：' +
          (run.stdout + run.stderr).slice(0, 400)
      );
    }
    let info;
    try {
      info = JSON.parse(raw);
    } catch (e) {
      throw toolError('ASEPRITE_FAILED', 'Lua 输出不是合法 JSON：' + e.message);
    }
    if (info.error) {
      throw toolError('ASEPRITE_OPEN_FAILED', 'Aseprite 打不开这个文件：' + (info.errorDetail || info.error));
    }
    info.fileSizeBytes = src.size;
    info.aseprite = { path: ase.path, version: await aseVersion(ase.path) };
    info.durationMs = run.durationMs;
    return { info };
  } finally {
    removeDir(tmp);
  }
}

async function methodPreview(params) {
  const p = params || {};
  const ase = resolveAsepritePath(p.asepritePath);
  const src = requireSourceFile(p.source);
  const frame = p.frame === undefined || p.frame === null || p.frame === '' ? 1 : Number(p.frame);
  if (!Number.isInteger(frame) || frame < 1) {
    throw toolError('INVALID_ARGS', 'frame 必须是大于等于 1 的整数帧号');
  }
  const maxBytes = Math.min(Number(p.maxPngBytes) || MAX_PREVIEW_BYTES, MAX_PREVIEW_BYTES);
  let scale = p.scale === undefined || p.scale === null || p.scale === '' ? 1 : normalizeScale(p.scale, 1);

  // 1.3.18.6 对超范围帧会静默导出空白图，所以先拿真实帧数校验
  const frameCount = await getFrameCount(ase.path, src);
  if (frameCount > 0 && frame > frameCount) {
    throw toolError(
      'INVALID_ARGS',
      '第 ' + frame + ' 帧不存在：这个 sprite 只有 ' + frameCount + ' 帧（frame 从 1 开始）。不传 frame 时默认看第 1 帧。',
      { field: 'frame', frameCount }
    );
  }

  const tmp = makeTempDir('cindy-aseprite-preview');
  try {
    let attempt = 0;
    let result = null;
    while (attempt < 6) {
      attempt += 1;
      const outPng = path.join(tmp, 'preview-' + attempt + '.png');
      const args = buildPreviewArgs(src.path, frame - 1, toPosix(outPng), {
        scale,
        tag: p.tag ? String(p.tag) : null,
      });
      const run = await runAseprite(ase.path, args, { timeoutMs: 120000 });
      if (run.errors.length > 0) {
        throw toolError('ASEPRITE_FAILED', 'aseprite.exe 报告错误：' + run.errors.join(' | '), { args });
      }
      let buf = null;
      try {
        buf = fs.readFileSync(outPng);
      } catch {
        throw toolError(
          'NO_OUTPUT_FILE',
          '第 ' + frame + ' 帧没有导出成功：可能这个 sprite 没有这么多帧，或该帧为空。' +
            '先用 ase_info 查看 frameCount 再重试。aseprite 输出：' + (run.stdout + run.stderr).slice(0, 300),
          { args }
        );
      }
      const size = pngSize(buf);
      if (buf.length <= maxBytes || attempt === 6) {
        result = { buf, size, scale, args, run };
        break;
      }
      // 太大就减半重导，保证 base64 之后仍在单行 stdout 限额内
      scale = Math.max(0.05, Math.round(scale * 50) / 100);
    }
    if (!result) throw toolError('PREVIEW_FAILED', '预览导出失败');

    return {
      imageBase64: result.buf.toString('base64'),
      mime: 'image/png',
      bytes: result.buf.length,
      width: result.size ? result.size.width : null,
      height: result.size ? result.size.height : null,
      scale: result.scale,
      frame,
      frame1: frame,
      frame0: frame - 1,
      frameNumbering: 'frame 按 1 基读取，与 Studio 里看到的帧号一致；CLI 的 --frame-range 是 0 基',
      frameCount,
      source: src.path,
      aseprite: { path: ase.path },
    };
  } finally {
    removeDir(tmp);
  }
}

async function methodExportFrames(params) {
  const p = params || {};
  const ase = resolveAsepritePath(p.asepritePath);
  const src = requireSourceFile(p.source);
  const scale = normalizeScale(p.scale, 1);
  const mode = sanitizeExportDirMode(p.exportDirMode);
  const spriteMeta = await getSpriteMeta(ase.path, src);
  const frameCount = spriteMeta.frameCount;
  const range = resolveFrameRange(p.from, p.to, frameCount > 0 ? frameCount : undefined);
  const tagName = p.tag ? String(p.tag) : null;
  const templateName = p.nameTemplate ? String(p.nameTemplate) : defaultFrameTemplate();
  validateNameTemplate(templateName, ['{frame}', '{frame1}', '{frame0}'], 'ase_export_frames');
  if (!/\.png$/i.test(templateName)) {
    throw toolError('INVALID_ARGS', 'name_template 必须以 .png 结尾');
  }

  // 先导到暂存目录，数清楚有几份再决定落到哪里（“按份数自动判定”只能事后才知道）
  const staging = makeTempDir('cindy-aseprite-frames');
  try {
    const args = buildFramesArgs(toPosix(src.path), toPosix(path.join(staging, templateName)), {
      from: range.from,
      to: range.to,
      tag: p.tag ? String(p.tag) : null,
      scale,
      trim: Boolean(p.trim),
      ignoreEmpty: Boolean(p.ignoreEmpty),
    });
    const run = await runAseprite(ase.path, args, { timeoutMs: 120000 });
    const staged = listFilesRecursive(staging);
    if (staged.length === 0) {
      throw toolError(
        'NO_OUTPUT_FILE',
        '没有导出任何帧。' + (run.errors.length ? 'aseprite 报告：' + run.errors.join(' | ') + '。' : '') +
          '常见原因：帧范围超出范围、tag 名不存在，或 --ignore-empty 把空帧全跳过了。',
        { args }
      );
    }
    // 帧号对照必须在改名前算：Aseprite 的原始文件名是唯一可靠的对照来源
    const startFrame1 = resolveFrameStart(tagName, spriteMeta.tags, range);
    const scope = tagName ? '标签内' : '导出区间内';
    const sortedStaged = staged.slice().sort((a, b) => compareFileNames(a.name, b.name));
    const originalNames = sortedStaged.map((f) => path.basename(f.name));
    const wantGlobalName = flagOn(p.nameFromGlobalFrame);
    let mapping = buildFrameMapping(originalNames, templateName, startFrame1, scope);
    let frameMappingNote = mapping.note;
    let batch = staged;

    if (wantGlobalName) {
      if (mapping.frameMapping.length !== originalNames.length) {
        throw toolError(
          'INVALID_ARGS',
          '无法确定这批文件在 Studio 里的全局帧号，不能用 name_from_global_frame 命名。' +
            '下一步：用带单个帧号占位符的 name_template，或用 from/to 明确指定导出区间后重试'
        );
      }
      const firstFrame1 = mapping.frameMapping[0].frame1;
      renameFramesToGlobalName(
        staging,
        sortedStaged.map((f, i) => ({ path: f.path, name: originalNames[i], frame1: mapping.frameMapping[i].frame1 })),
        templateName,
        spriteTitle(src.path)
      );
      batch = listFilesRecursive(staging).sort((a, b) => compareFileNames(a.name, b.name));
      // 改完名再按真实文件名重算一遍，保证 frameMapping 与落盘名一致
      mapping = buildFrameMapping(
        batch.map((f) => path.basename(f.name)),
        templateName,
        firstFrame1,
        scope
      );
      frameMappingNote =
        '已按全局帧号重命名（name_from_global_frame=true）：文件名里的帧号就是 Studio 全局帧号，可直接当帧号用。' +
        mapping.note;
    }

    const placed = placeStagedFiles(staging, batch, src.path, p.outDir, mode);
    // frameMapping 顺序即帧序，与 originalNames / placed.files 一一对应
    const frameMapping = mapping.frameMapping.map((item, i) => {
      const file = placed.files[i] ? placed.files[i].name : item.file;
      const originalName = originalNames[i] === undefined ? file : originalNames[i];
      return { file, frame1: item.frame1, frame0: item.frame0, originalName, renamed: file !== originalName };
    });
    return {
      outDir: placed.outDir,
      exportDirMode: placed.mode,
      files: placed.files,
      count: placed.files.length,
      renamed: placed.renamed,
      nameFromGlobalFrame: wantGlobalName,
      frameRange: range.from === null ? null : { from: range.from + 1, to: range.to + 1 },
      tag: tagName,
      frameMapping,
      frameMappingNote,
      template: templateName,
      scale,
      aseprite: { path: ase.path },
      durationMs: run.durationMs,
      warnings: run.errors,
    };
  } finally {
    removeDir(staging);
  }
}

async function methodExportSheet(params) {
  const p = params || {};
  const ase = resolveAsepritePath(p.asepritePath);
  const src = requireSourceFile(p.source);
  const scale = normalizeScale(p.scale, 1);
  const mode = sanitizeExportDirMode(p.exportDirMode);
  const sheetType = sanitizeSheetType(p.sheetType);
  const format = sanitizeSheetFormat(p.format);
  const shapePadding = sanitizePadding(p.shapePadding, 'shape_padding');
  const borderPadding = sanitizePadding(p.borderPadding, 'border_padding');
  const baseName = sanitizeBaseName(
    p.nameTemplate ? String(p.nameTemplate) : String(path.basename(src.path)).replace(/\.[^.]+$/, ''),
    'sprite'
  );

  // 图集固定出 2 个文件（png + json），所以 auto 模式恒落在 exports/
  const staging = makeTempDir('cindy-aseprite-sheet');
  try {
    const stagedPng = path.join(staging, baseName + '-sheet.png');
    const stagedJson = path.join(staging, baseName + '-sheet.json');
    const args = buildSheetArgs(toPosix(src.path), toPosix(stagedPng), toPosix(stagedJson), {
      format,
      sheetType,
      shapePadding,
      borderPadding,
      scale,
      trim: Boolean(p.trim),
      ignoreEmpty: Boolean(p.ignoreEmpty),
    });

    const run = await runAseprite(ase.path, args, { timeoutMs: 120000 });
    if (!readIfExists(stagedPng) || !readIfExists(stagedJson)) {
      throw toolError(
        'NO_OUTPUT_FILE',
        '图集没有导出成功。' + (run.errors.length ? 'aseprite 报告：' + run.errors.join(' | ') + '。' : '') +
          '先用 ase_doctor 确认 aseprite.exe 可用，再重试。',
        { args }
      );
    }

    const finalDir = resolveExportDir(src.path, p.outDir, mode, 2);
    fs.mkdirSync(finalDir, { recursive: true });

    // png 与 json 必须成对改名，否则 meta.image 会指向一个不存在的文件名
    let stem = baseName + '-sheet';
    let i = 2;
    const taken = (s) => fs.existsSync(path.join(finalDir, s + '.png')) || fs.existsSync(path.join(finalDir, s + '.json'));
    while (taken(stem) && i < 1000) {
      stem = baseName + '-sheet-' + i;
      i += 1;
    }
    if (taken(stem)) stem = baseName + '-sheet-' + Date.now();

    const finalPng = path.join(finalDir, stem + '.png');
    const finalJson = path.join(finalDir, stem + '.json');
    moveFile(stagedPng, finalPng);

    let dataText = fs.readFileSync(stagedJson, 'utf8');
    let meta = null;
    try {
      meta = JSON.parse(dataText);
    } catch {
      /* 解析失败就当纯文本搬过去 */
    }
    if (meta && meta.meta && meta.meta.image !== stem + '.png') {
      meta.meta.image = stem + '.png';
      dataText = JSON.stringify(meta);
    }
    fs.writeFileSync(finalJson, dataText, 'utf8');
    fs.unlinkSync(stagedJson);

    const frames = meta ? (Array.isArray(meta.frames) ? meta.frames : Object.keys(meta.frames || {})).length : null;
    const size = meta && meta.meta && meta.meta.size ? meta.meta.size : null;
    const renamed = [];
    if (stem !== baseName + '-sheet') renamed.push({ from: baseName + '-sheet', to: stem });

    return {
      outDir: finalDir,
      exportDirMode: p.outDir ? 'out_dir' : mode,
      sheet: {
        path: finalPng,
        bytes: fs.statSync(finalPng).size,
        width: size ? size.w : null,
        height: size ? size.h : null,
      },
      data: {
        path: finalJson,
        bytes: Buffer.byteLength(dataText),
        format,
        frameCount: frames,
        frameTags: meta && meta.meta && meta.meta.frameTags ? meta.meta.frameTags : null,
        layers: meta && meta.meta && meta.meta.layers ? meta.meta.layers : null,
        slices: meta && meta.meta && meta.meta.slices ? meta.meta.slices : null,
      },
      renamed,
      sheetType,
      shapePadding,
      borderPadding,
      scale,
      aseprite: { path: ase.path },
      durationMs: run.durationMs,
      warnings: run.errors,
    };
  } finally {
    removeDir(staging);
  }
}

async function methodExportLayers(params) {
  const p = params || {};
  const ase = resolveAsepritePath(p.asepritePath);
  const src = requireSourceFile(p.source);
  const scale = normalizeScale(p.scale, 1);
  const mode = sanitizeExportDirMode(p.exportDirMode);
  const templateName = p.nameTemplate ? String(p.nameTemplate) : defaultLayerTemplate();
  validateNameTemplate(templateName, ['{layer}'], 'ase_export_layers');
  if (!/\{frame\}|\{frame1\}|\{frame0\}/.test(templateName)) {
    throw toolError(
      'INVALID_ARGS',
      'name_template 除了 {layer} 还要带 {frame1} 这类帧号占位符，否则同一图层的多帧会互相覆盖'
    );
  }
  if (!/\.png$/i.test(templateName)) {
    throw toolError('INVALID_ARGS', 'name_template 必须以 .png 结尾');
  }

  const staging = makeTempDir('cindy-aseprite-layers');
  try {
    const args = buildLayersArgs(toPosix(src.path), toPosix(path.join(staging, templateName)), {
      scale,
      trim: Boolean(p.trim),
      ignoreEmpty: Boolean(p.ignoreEmpty),
      tag: p.tag ? String(p.tag) : null,
    });

    const run = await runAseprite(ase.path, args, { timeoutMs: 120000 });
    const staged = listFilesRecursive(staging);
    if (staged.length === 0) {
      throw toolError(
        'NO_OUTPUT_FILE',
        '没有导出任何图层。' + (run.errors.length ? 'aseprite 报告：' + run.errors.join(' | ') + '。' : '') +
          '可能是所有图层都隐藏了（1.3.18.6 的 --split-layers 只导可见图层，--all-layers 也不会带出隐藏层）。' +
          '另注：实测 --split-layers 只配合 --save-as 生效，且分组图层会连同子层各出一张。',
        { args }
      );
    }
    const placed = placeStagedFiles(staging, staged, src.path, p.outDir, mode);
    return {
      outDir: placed.outDir,
      exportDirMode: placed.mode,
      files: placed.files,
      count: placed.files.length,
      renamed: placed.renamed,
      template: templateName,
      scale,
      aseprite: { path: ase.path },
      durationMs: run.durationMs,
      warnings: run.errors,
    };
  } finally {
    removeDir(staging);
  }
}

/**
 * 把暂存目录里导出的文件搬到最终落点：
 * 落点按份数规则决定，同名文件自动加 -2/-3 后缀，返回改名清单。
 */
function placeStagedFiles(stagingDir, staged, sourcePath, outDir, mode) {
  const finalDir = resolveExportDir(sourcePath, outDir, mode, staged.length);
  fs.mkdirSync(finalDir, { recursive: true });
  const files = [];
  const renamed = [];
  // 数字段按数值排序：frame_2 在 frame_10 之前，结果里的 files 顺序即帧序
  const sorted = staged.slice().sort((a, b) => compareFileNames(a.name, b.name));
  for (const f of sorted) {
    const wanted = path.basename(f.name);
    const target = uniqueTargetPath(finalDir, wanted);
    moveFile(f.path, target);
    const name = path.basename(target);
    let bytes = f.size;
    try {
      bytes = fs.statSync(target).size;
    } catch {
      /* 保留暂存时的体积 */
    }
    files.push({ path: target, name, size: bytes });
    if (name !== wanted) renamed.push({ from: wanted, to: name });
  }
  return {
    outDir: finalDir,
    mode: outDir ? 'out_dir' : mode,
    files,
    renamed,
  };
}

function readIfExists(p, encoding) {
  try {
    return fs.readFileSync(p, encoding || null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 入口
// ---------------------------------------------------------------------------

const METHODS = {
  'ase/doctor': methodDoctor,
  'ase/info': methodInfo,
  'ase/preview': methodPreview,
  'ase/export_frames': methodExportFrames,
  'ase/export_sheet': methodExportSheet,
  'ase/export_layers': methodExportLayers,
};

function errorPayload(err) {
  const code = err && err.code ? String(err.code) : 'INTERNAL';
  return {
    code: -32000,
    message: (err && err.message) || '未知错误',
    data: { toolErrorCode: code, field: err && err.field ? err.field : undefined, extra: err && err.extra },
  };
}

async function handleRequest(request) {
  const method = request && request.method;
  const fn = METHODS[method];
  if (!fn) {
    return { jsonrpc: '2.0', id: request && request.id, error: { code: -32601, message: 'Method not found: ' + method } };
  }
  try {
    const result = await fn(request.params || {});
    return { jsonrpc: '2.0', id: request.id, result: { ok: true, ...result } };
  } catch (err) {
    return { jsonrpc: '2.0', id: request.id, error: errorPayload(err) };
  }
}

function start() {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      writeStdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handleRequest(request).then(
      (msg) => writeStdout(msg),
      (err) => writeStdout({ jsonrpc: '2.0', id: request.id, error: errorPayload(err) })
    );
  });
  rl.on('close', () => process.exit(0));
}

/**
 * 什么时候启动服务端？
 *  - 直接 `node node/worker.cjs`（require.main === module）；
 *  - Cindy 主机的启动方式：主机 fork 自己的 nodeRuntimeWorkerProcess.js，再用
 *    `require(entry)` 加载插件入口 —— 此时 require.main 是那个 bootstrap，本模块
 *    的 require.main !== module，argv 里则是 [Cindy.exe, bootstrap, <本文件>]。
 *    所以还要比对 argv，否则 worker 会静默不响应（实测踩过：调用 60 秒超时）。
 *  - 被测试脚本 require 进进程时不启动，避免抢 stdin。
 */
function isEntrypoint() {
  // 测试进程里 require 本文件时用这个门控彻底闭掉自启（spawn 出来的子进程会显式清掉它）
  if (process.env.ASE_WORKER_NO_AUTOSTART === '1') return false;
  if (require.main === module) return true;
  const self = path.resolve(__filename);
  return [process.argv[1], process.argv[2]].some((arg) => {
    if (!arg) return false;
    try {
      return path.resolve(arg) === self;
    } catch {
      return false;
    }
  });
}

if (isEntrypoint()) {
  start();
}

module.exports = {
  PROTOCOL,
  start,
  isEntrypoint,
  SHEET_TYPES,
  SHEET_FORMATS,
  MAX_PREVIEW_BYTES,
  colorModeName,
  blendModeName,
  sanitizeBaseName,
  normalizeScale,
  resolveFrameRange,
  resolveFrameStart,
  frameRangeArg,
  framePlaceholderIn,
  buildFrameNameRegExp,
  frameNumberFromFileName,
  buildFrameMapping,
  globalFrameFileName,
  renameFramesToGlobalName,
  templateTokens,
  flagOn,
  spriteTitle,
  compareFileNames,
  FRAME_NUMBERING_NOTE,
  FRAME_PLACEHOLDER_BASE_NOTE,
  resolveExportDir,
  EXPORT_DIR_MODES,
  sanitizeExportDirMode,
  uniqueTargetPath,
  validateNameTemplate,
  placeStagedFiles,
  moveFile,
  sanitizeSheetType,
  sanitizeSheetFormat,
  sanitizePadding,
  buildPreviewArgs,
  buildFramesArgs,
  buildSheetArgs,
  buildLayersArgs,
  buildInfoArgs,
  buildInfoLua,
  pngSize,
  detectAsepriteErrors,
  parseVersion,
  candidateAsepritePaths,
  findAsepriteExecutables,
  toPosix,
  defaultFrameTemplate,
  defaultLayerTemplate,
  defaultSheetName,
  METHODS,
};
