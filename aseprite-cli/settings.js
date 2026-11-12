/* Aseprite 工具箱 · 设置页 */
const $ = (id) => document.getElementById(id);
const channel = new BroadcastChannel('aseprite-cli');
const pending = new Map();
let requestSeq = 0;

const MODE_HINT = {
  auto: '≥2 个文件 → 源目录下的 exports/；只有 1 个 → 源文件同目录',
  always: '无论几份都放进源目录下的 exports/',
  same: '无论几份都放在源文件同目录',
};

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.style.color = isError ? 'var(--danger,#dc2626)' : 'var(--text-secondary,#8a8a84)';
}

function syncModeHint() {
  $('modeHint').textContent = MODE_HINT[$('exportDirMode').value] || '';
}

function readForm() {
  const padding = Number($('shapePadding').value);
  const border = Number($('borderPadding').value);
  const scale = Number($('scale').value);
  return {
    asepritePath: $('asepritePath').value.trim(),
    exportDirMode: $('exportDirMode').value,
    sheetType: $('sheetType').value,
    shapePadding: Number.isFinite(padding) && padding >= 0 ? Math.round(padding) : 0,
    borderPadding: Number.isFinite(border) && border >= 0 ? Math.round(border) : 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

function readExportDirMode(cfg) {
  if (cfg.exportDirMode === 'auto' || cfg.exportDirMode === 'always' || cfg.exportDirMode === 'same') {
    return cfg.exportDirMode;
  }
  // 兼容老设置（布尔开关）：true = 一律 exports/，false = 一律同目录
  if (cfg.exportSubdir === true) return 'always';
  if (cfg.exportSubdir === false) return 'same';
  return 'auto';
}

function fillForm(cfg) {
  $('asepritePath').value = cfg.asepritePath || '';
  $('exportDirMode').value = readExportDirMode(cfg);
  $('sheetType').value = cfg.sheetType || 'horizontal';
  $('shapePadding').value = Number.isFinite(cfg.shapePadding) ? cfg.shapePadding : 0;
  $('borderPadding').value = Number.isFinite(cfg.borderPadding) ? cfg.borderPadding : 0;
  $('scale').value = Number.isFinite(cfg.scale) ? cfg.scale : 1;
  syncModeHint();
}

async function load() {
  try {
    const res = await fetch('/kv');
    const cfg = res.ok ? await res.json() : {};
    fillForm(cfg && typeof cfg === 'object' ? cfg : {});
  } catch {
    setStatus('读取设置失败，可以直接重填再保存', true);
  }
}

$('exportDirMode').onchange = syncModeHint;

$('save').onclick = async () => {
  setStatus('保存中…');
  const body = readForm();
  try {
    const res = await fetch('/kv', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    channel.postMessage({ type: 'settings-changed' });
    setStatus('已保存');
  } catch (err) {
    setStatus('保存失败：' + err.message, true);
  }
};

channel.onmessage = (event) => {
  const data = event.data || {};
  if (data.type !== 'ase-doctor-result') return;
  const resolve = pending.get(data.requestId);
  if (!resolve) return;
  pending.delete(data.requestId);
  resolve(data);
};

function detect() {
  requestSeq += 1;
  const requestId = 'req-' + requestSeq;
  setStatus('检测中…（会真实启动一次 aseprite.exe）');
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    channel.postMessage({ type: 'ase-doctor-request', requestId });
    setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      setStatus('检测超时：请确认 Cindy 里这个插件是启用状态，或手动填路径', true);
      resolve(null);
    }, 40000);
  });
}

$('detect').onclick = async () => {
  const data = await detect();
  if (!data) return;
  if (!data.ok) {
    setStatus('检测失败：' + (data.message || '未知原因'), true);
    return;
  }
  const result = data.result || {};
  if (result.aseprite && result.aseprite.path) {
    $('asepritePath').value = result.aseprite.path;
    const version = result.aseprite.version ? ' v' + result.aseprite.version : '';
    setStatus('找到：' + result.aseprite.path + version + '（记得点保存）');
    if (!result.ready) {
      const bad = (result.checks || []).filter((c) => !c.ok).map((c) => c.name).join('、');
      if (bad) setStatus('找到 ' + result.aseprite.path + version + '，但检查项未通过：' + bad, true);
    }
  } else {
    setStatus('没找到 aseprite.exe，请手动填完整路径', true);
  }
};

load();
