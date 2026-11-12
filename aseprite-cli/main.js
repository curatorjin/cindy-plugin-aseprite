/**
 * Aseprite 工具箱 · 电子脑（main.js）
 *
 * 这个文件跑在 Cindy 的浏览器沙箱里：读不了本地任意路径，也不传子进程。
 * 真正的文件读写与 aseprite.exe 调用都在随包 Node 工作进程（node/worker.cjs）里完成，
 * 这里只负责：读设置 → 下发参数 → 收结果 → 把预览图寄存进媒体库交给聊天。
 */

const CHANNEL = 'aseprite-cli';

const TOOL_METHODS = {
  ase_doctor: 'ase/doctor',
  ase_info: 'ase/info',
  ase_preview: 'ase/preview',
  ase_export_frames: 'ase/export_frames',
  ase_export_sheet: 'ase/export_sheet',
  ase_export_layers: 'ase/export_layers',
};

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function readConfig() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return {};
    const cfg = await res.json();
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/** 旧设置（exportSubdir 布尔）迁移到新设置（exportDirMode 三档） */
function readExportDirMode(cfg) {
  const raw = cfg.exportDirMode;
  if (raw === 'auto' || raw === 'always' || raw === 'same') return raw;
  if (cfg.exportSubdir !== undefined) return asBool(cfg.exportSubdir, false) ? 'always' : 'same';
  return 'auto';
}

/** 设置页 → 工作进程的参数（设置只影响默认值，工具参数优先） */
function configToWorkerParams(cfg, args) {
  const params = {
    asepritePath: (cfg.asepritePath || '').trim() || undefined,
    exportDirMode: readExportDirMode(cfg),
    scale: asNumber(cfg.scale, 1),
    sheetType: cfg.sheetType || 'horizontal',
    shapePadding: asNumber(cfg.shapePadding, 0),
    borderPadding: asNumber(cfg.borderPadding, 0),
  };
  if (args.out_dir) params.outDir = String(args.out_dir);
  if (args.scale !== undefined) params.scale = args.scale;
  if (args.sheet_type !== undefined) params.sheetType = args.sheet_type;
  if (args.padding !== undefined) params.shapePadding = args.padding;
  if (args.border_padding !== undefined) params.borderPadding = args.border_padding;
  if (args.format !== undefined) params.format = args.format;
  if (args.name_template !== undefined) params.nameTemplate = args.name_template;
  if (args.from !== undefined) params.from = args.from;
  if (args.to !== undefined) params.to = args.to;
  if (args.tag !== undefined) params.tag = args.tag;
  if (args.trim !== undefined) params.trim = asBool(args.trim, false);
  params.source = String(args.path || args.source || '').trim();
  return params;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function baseNameOf(p) {
  const s = String(p || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function dirModeText(result) {
  const map = {
    auto: '落点=自动（本次产出 ≥2 个文件就用源目录下的 exports/，只 1 个就落在源文件同目录）',
    always: '落点=一律放在源目录下的 exports/',
    same: '落点=一律放在源文件同目录',
    out_dir: '落点=你指定的 out_dir',
  };
  return map[result.exportDirMode] || ('落点=' + String(result.exportDirMode));
}

function renamedText(result) {
  const r = result.renamed || [];
  if (!r.length) return null;
  const shown = r.slice(0, 6).map((x) => x.from + ' → ' + x.to);
  return '同名文件已存在，' + r.length + ' 个改名为新文件名：' + shown.join('、') + (r.length > 6 ? ' …' : '');
}

function fileLines(files, limit) {
  const shown = files.slice(0, limit || 12);
  const lines = shown.map((f) => '- ' + f.name + ' (' + formatBytes(f.size) + ')');
  if (files.length > shown.length) lines.push('- … 还有 ' + (files.length - shown.length) + ' 个文件');
  return lines;
}

// ---------------------------------------------------------------------------
// 各工具的文本结果（模型直接读这段，结构化数据放 result 里）
// ---------------------------------------------------------------------------

function textDoctor(result) {
  const lines = [];
  if (result.aseprite && result.aseprite.path) {
    lines.push('aseprite.exe：' + result.aseprite.path);
    if (result.aseprite.version) lines.push('版本：' + result.aseprite.version);
    if (result.aseprite.resolvedBy) lines.push('来源：' + result.aseprite.resolvedBy);
  } else {
    lines.push('没找到 aseprite.exe。');
  }
  lines.push('可用：' + (result.ready ? '是' : '否'));
  for (const c of result.checks || []) {
    lines.push((c.ok ? '✓ ' : '✗ ') + c.name + ' — ' + c.detail);
  }
  if (result.cli) {
    lines.push('实测行为：' + result.cli.frameNumbering + '；' + result.cli.splitLayersWithSheet + '；退出码不可信（' + (result.cli.exitCodeReliable ? '可靠' : '恒为 0') + '）');
  }
  for (const g of result.guidance || []) lines.push('→ ' + g);
  return lines.join('\n');
}

function textInfo(info) {
  const sp = info.sprite || {};
  const lines = [];
  const fileName = baseNameOf(info.file || '');
  lines.push(fileName + '：' + sp.width + '×' + sp.height + '，色彩模式 ' + sp.colorMode + '，' + sp.frameCount + ' 帧，总时长 ' + (sp.totalDurationMs || 0) + 'ms');
  const visible = (info.layers || []).filter((l) => l.visible !== false).length;
  lines.push('图层 ' + info.layerCount + ' 个（可见 ' + visible + '），标签 ' + (info.tags || []).length + ' 个，切片 ' + (info.slices || []).length + ' 个，调色板 ' + (info.palette ? info.palette.size + ' 色' : '无') + '，tileset ' + (info.tilesets || []).length + ' 个');

  if (sp.grid && sp.grid.width) lines.push('网格：' + sp.grid.width + '×' + sp.grid.height);

  if ((info.layers || []).length) {
    lines.push('图层树（自底向上，缩进表示分组）：');
    const walk = (list, depth) => {
      for (const l of list || []) {
        const flags = [];
        if (l.type === 'group') flags.push('组');
        if (l.visible === false) flags.push('隐藏');
        if (l.opacity !== undefined && l.opacity !== 255) flags.push('不透明度 ' + Math.round((l.opacity / 255) * 100) + '%');
        if (l.blendMode && l.blendMode !== 'normal') flags.push('混合 ' + l.blendMode);
        if (l.isBackground) flags.push('背景层');
        lines.push('  '.repeat(depth) + '- ' + l.name + (flags.length ? ' [' + flags.join('，') + ']' : ''));
        if (l.children) walk(l.children, depth + 1);
      }
    };
    walk(info.layers, 1);
  }

  if ((info.tags || []).length) {
    lines.push('动画标签：');
    for (const t of info.tags) {
      lines.push('- ' + t.name + ' 第 ' + t.from + '–' + t.to + ' 帧，' + t.frameCount + ' 帧，方向 ' + t.direction);
    }
  }

  if ((info.slices || []).length) {
    lines.push('切片：');
    for (const s of info.slices) {
      const b = s.bounds || {};
      let line = '- ' + s.name + ' 位置 ' + b.x + ',' + b.y + ' 尺寸 ' + b.width + '×' + b.height;
      if (s.center) line += '，九宫格中心 ' + s.center.x + ',' + s.center.y + ' ' + s.center.width + '×' + s.center.height;
      if (s.pivot) line += '，轴心 ' + s.pivot.x + ',' + s.pivot.y;
      lines.push(line);
    }
  }

  if ((info.tilesets || []).length) {
    lines.push('Tileset：');
    for (const t of info.tilesets) {
      lines.push('- ' + t.name + '：' + t.tileCount + ' 块' + (t.tileWidth ? '，单块 ' + t.tileWidth + '×' + t.tileHeight : '') + '，起始索引 ' + t.baseIndex);
    }
  }

  const uniqueDur = new Set((info.frames || []).map((f) => f.durationMs));
  if (uniqueDur.size === 1 && info.frames && info.frames.length) {
    lines.push('每帧时长统一为 ' + info.frames[0].durationMs + 'ms。');
  } else if (uniqueDur.size > 1) {
    lines.push('每帧时长有 ' + uniqueDur.size + ' 种取值，逐帧数据见 result.info.frames。');
  }

  if ((info.warnings || []).length) lines.push('提示：' + info.warnings.join('；'));
  lines.push('完整 JSON 在 result.info 里（' + JSON.stringify(info).length + ' 字符）。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

async function callWorker(method, params, callId) {
  const response = await cindy.node.request({
    method,
    params,
    callId,
    cancelWithCall: true,
    timeoutMs: 60000,
    maxTotalMs: 600000,
  });
  if (!response || response.ok !== true) {
    const err = new Error((response && response.message) || 'Node 工作进程没有返回结果');
    err.code = 'NODE_REQUEST_FAILED';
    err.toolErrorCode = response && response.error && response.error.data ? response.error.data.toolErrorCode : undefined;
    err.detail = response;
    throw err;
  }
  return response.result;
}

function failureResult(err) {
  const code = (err && (err.toolErrorCode || err.code)) || 'INTERNAL';
  let message = (err && err.message) || '未知错误';
  if (code === 'ASEPRITE_NOT_FOUND') {
    message += '\n下一步：在插件设置页（「Aseprite 可执行文件」）填入 aseprite.exe 的完整路径，或用 $aseprite 让我先跑 ase_doctor 看看候选位置。';
  } else if (code === 'ASEPRITE_TIMEOUT') {
    message += '\n下一步：缩小帧范围或降低 scale 后重试。';
  } else if (code === 'ASEPRITE_SPAWN_FAILED') {
    message += '\n下一步：确认路径指向 aseprite.exe 本体（不是快捷方式），并用 ase_doctor 复检。';
  }
  return { errorCode: code, message };
}

async function runTool(toolName, msg) {
  const args = msg.args || {};
  const cfg = await readConfig();
  const method = TOOL_METHODS[toolName];
  const params = configToWorkerParams(cfg, args);

  if (toolName === 'ase_doctor') {
    const result = await callWorker('ase/doctor', { asepritePath: params.asepritePath, samplePath: args.path }, msg.callId);
    return { text: textDoctor(result), result };
  }

  if (!params.source) {
    const err = new Error('缺少 path 参数：请给出 .aseprite 文件的完整路径');
    err.code = 'INVALID_ARGS';
    throw err;
  }

  if (toolName === 'ase_info') {
    if (args.frame_limit !== undefined) params.frameLimit = args.frame_limit;
    const result = await callWorker('ase/info', params, msg.callId);
    return { text: textInfo(result.info), result };
  }

  if (toolName === 'ase_preview') {
    if (args.frame !== undefined) params.frame = args.frame;
    const result = await callWorker('ase/preview', params, msg.callId);
    const base64 = result.imageBase64;
    delete result.imageBase64;
    const deposit = await cindy.send({
      type: 'cindy-request',
      kind: 'deposit_media',
      data: base64,
      label: 'Aseprite 预览：' + baseNameOf(result.source) + ' 第 ' + result.frame + ' 帧',
      callId: msg.callId,
    });
    if (!deposit || deposit.ok !== true) {
      const err = new Error('预览图没能存进媒体库：' + ((deposit && deposit.message) || '未知原因') + '（导出的 PNG 本身是成功的）');
      err.code = 'DEPOSIT_FAILED';
      throw err;
    }
    result.xdt_image_urls = [deposit.url];
    result.mediaHash = deposit.hash;
    const lines = [
      baseNameOf(result.source) + ' 第 ' + result.frame + (result.frameCount ? ' / ' + result.frameCount : '') + ' 帧',
      '导出尺寸 ' + result.width + '×' + result.height + '，' + formatBytes(result.bytes) + (result.scale !== 1 ? '（缩放 ' + result.scale + '）' : ''),
      '图片已存进媒体库，聊天里可以直接看到；要看别的帧就把 frame 换成对应帧号。',
    ];
    return { text: lines.join('\n'), result };
  }

  if (toolName === 'ase_export_frames') {
    const result = await callWorker('ase/export_frames', params, msg.callId);
    const lines = [
      '逐帧导出完成：' + result.count + ' 个 PNG',
      '目录：' + result.outDir,
      dirModeText(result),
      result.tag ? '筛选：tag ' + result.tag : result.frameRange ? '帧范围：' + result.frameRange.from + '–' + result.frameRange.to : '帧范围：全部',
      '文件名按 1 起的帧号编号（模板 ' + (result.template || '{title}-{frame1}.png') + '）。',
    ];
    const rnFrames = renamedText(result);
    if (rnFrames) lines.push(rnFrames);
    for (const l of fileLines(result.files, 12)) lines.push(l);
    return { text: lines.join('\n'), result };
  }

  if (toolName === 'ase_export_sheet') {
    const result = await callWorker('ase/export_sheet', params, msg.callId);
    const lines = [
      'Sprite sheet 导出完成：' + (result.data.frameCount || '?') + ' 帧',
      dirModeText(result),
      '图片：' + result.sheet.path + '（' + (result.sheet.width || '?') + '×' + (result.sheet.height || '?') + '，' + formatBytes(result.sheet.bytes) + '）',
      '帧表：' + result.data.path + '（' + result.data.format + '，' + formatBytes(result.data.bytes) + '）',
      '布局 ' + result.sheetType + (result.shapePadding ? '，帧间 padding ' + result.shapePadding : '') + (result.borderPadding ? '，边缘 padding ' + result.borderPadding : ''),
    ];
    const rnSheet = renamedText(result);
    if (rnSheet) lines.push(rnSheet);
    if (result.data.frameTags && result.data.frameTags.length) {
      lines.push('帧表里的动画标签：' + result.data.frameTags.map((t) => t.name + '(' + t.from + '–' + t.to + ')').join('、'));
    }
    if (result.warnings && result.warnings.length) lines.push('aseprite 提示：' + result.warnings.join(' | '));
    return { text: lines.join('\n'), result };
  }

  if (toolName === 'ase_export_layers') {
    const result = await callWorker('ase/export_layers', params, msg.callId);
    const lines = ['逐层导出完成：' + result.count + ' 个 PNG', '目录：' + result.outDir, dirModeText(result)];
    for (const l of fileLines(result.files, 12)) lines.push(l);
    const rnLayers = renamedText(result);
    if (rnLayers) lines.push(rnLayers);
    lines.push('隐藏图层不会被导出（实测 --all-layers 也带不出隐藏层）；分组图层会连同子层各出一张。');
    return { text: lines.join('\n'), result };
  }

  const err = new Error('未知工具：' + toolName);
  err.code = 'UNKNOWN_TOOL';
  throw err;
}

// ---------------------------------------------------------------------------
// 宿主消息
// ---------------------------------------------------------------------------

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  const toolName = msg.tool;
  if (!TOOL_METHODS[toolName]) return;

  try {
    const { text, result } = await runTool(toolName, msg);
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: { ...result, note: text },
    });
  } catch (err) {
    const failure = failureResult(err);
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: failure.errorCode,
      message: failure.message,
    });
  }
});

// 设置页的「自动检测」按钮走这里（无 tool-call 上下文，所以不带 callId/cancelWithCall）
try {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (event) => {
    const data = event.data || {};
    if (data.type !== 'ase-doctor-request') return;
    try {
      const cfg = await readConfig();
      const result = await callWorker('ase/doctor', { asepritePath: (cfg.asepritePath || '').trim() || undefined });
      channel.postMessage({ type: 'ase-doctor-result', requestId: data.requestId, ok: true, result });
    } catch (err) {
      channel.postMessage({
        type: 'ase-doctor-result',
        requestId: data.requestId,
        ok: false,
        message: (err && err.message) || '检测失败',
      });
    }
  };
} catch {
  /* 没有 BroadcastChannel 就只在设置页手动填路径 */
}
