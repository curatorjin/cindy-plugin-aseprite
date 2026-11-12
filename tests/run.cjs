'use strict';

/**
 * 测试总入口：node tests/run.cjs
 * 先跑不依赖环境的纯函数单测，再跑依赖 aseprite.exe / 样本文件的端到端冒烟。
 * 输出 PASS / FAIL / SKIP，任一 FAIL 时退出码 1。
 *
 * 可用环境变量：
 *   ASEPRITE_PATH  指定 aseprite.exe（不给就自动搜索，含 Steam 库）
 *   ASE_SAMPLE     指定冒烟用的样本 .aseprite（不给则整段端到端冒烟打印 SKIP）
 */

const { runAll, summary, reset, state } = require('./lib/harness.cjs');
const unit = require('./unit.test.cjs');
const e2e = require('./e2e.test.cjs');

async function main() {
  console.log('=== 单测（纯函数，不依赖 aseprite.exe）===');
  unit.register();
  unit.registerProtocol();
  unit.registerHostBootstrap();
  await runAll();
  const unitFails = summary('单测');
  const unitCounts = { ...state };
  reset();

  console.log('');
  console.log('=== 端到端冒烟（真机 aseprite.exe，缺环境自动 SKIP）===');
  e2e.register();
  await runAll();
  const e2eFails = summary('端到端');
  const e2eCounts = { ...state };

  console.log('');
  console.log('合计：PASS ' + (unitCounts.pass + e2eCounts.pass) + ' / FAIL ' + (unitFails + e2eFails) + ' / SKIP ' + (unitCounts.skip + e2eCounts.skip));
  const failed = unitFails + e2eFails;
  console.log(failed === 0 ? '全部通过（FAIL 0）' : '有失败用例，见上');
  // 必须显式退出：残留的子进程 / readline 句柄会把事件循环挂住（实测会卡到被外部 timeout 杀掉）
  finish(failed === 0 ? 0 : 1);
}

/** 兜底：任何情况下 120 秒内都要有结果并退出，绝不吊死调用方 */
const watchdog = setTimeout(() => {
  console.error('测试运行超过 120 秒，强制退出（exit 1）');
  process.exit(1);
}, 120000);
if (watchdog.unref) watchdog.unref();

function finish(code) {
  clearTimeout(watchdog);
  // 给 stdout 一点刷盘时间再硬退出
  process.stdout.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
}

main().catch((err) => {
  console.error('测试运行器自身出错：', err);
  finish(1);
});
