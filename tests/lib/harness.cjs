'use strict';

/**
 * 极简测试壳：用例按登记顺序串行执行（端到端用例有前后依赖，必须保序），
 * 每条打印 PASS / FAIL / SKIP，末尾给统计。不引第三方依赖（插件本身也要求零依赖）。
 */

const state = { pass: 0, fail: 0, skip: 0, failures: [] };
let queue = [];

function pass(name, note) {
  state.pass += 1;
  console.log('PASS  ' + name + (note ? '  — ' + note : ''));
}

function fail(name, err) {
  state.fail += 1;
  const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : String(err);
  state.failures.push({ name, detail });
  console.log('FAIL  ' + name);
  console.log('        ' + detail);
}

function skip(name, reason) {
  state.skip += 1;
  console.log('SKIP  ' + name + (reason ? '  — ' + reason : ''));
}

/** 登记一条用例（不会立即执行） */
function test(name, fn, options) {
  queue.push({ name, fn, timeoutMs: options && options.timeoutMs });
}

/** 让某条用例主动 SKIP：在用例体里 throw skipped('原因') */
function skipped(reason) {
  const err = new Error(reason || 'skip');
  err.__skip = true;
  return err;
}

const DEFAULT_TEST_TIMEOUT_MS = 60000;

/**
 * 串行跑完当前登记的队列。
 * 每条用例都套一层超时：spawn 出的子进程提前退出时上层 Promise 可能永不结算，
 * 没有这层保护整个进程会「安静地」掉光句柄退出（实测踩过，看起来像卡死/无输出）。
 */
async function runAll() {
  const current = queue;
  queue = [];
  for (const item of current) {
    try {
      const note = await withTimeout(item.fn(), item.timeoutMs || DEFAULT_TEST_TIMEOUT_MS, item.name);
      pass(item.name, typeof note === 'string' ? note : '');
    } catch (err) {
      if (err && err.__skip) skip(item.name, err.message);
      else fail(item.name, err);
    }
  }
}

function withTimeout(promise, ms, name) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('用例超时（' + Math.round(ms / 1000) + 's 未结算）：' + name)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message ? message + '：' : '') + '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((message ? message + '：' : '') + '期望 ' + b + '，实际 ' + a);
}

function arrayEqual(actual, expected, message) {
  if (!Array.isArray(actual)) throw new Error((message || '') + '：结果不是数组');
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((message ? message + '：' : '') + '参数拼装不符\n      期望：' + b + '\n      实际：' + a);
}

function throws(fn, expectedCode, message) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error((message || '') + '：期望抛错但没有抛');
  if (expectedCode && caught.code !== expectedCode) {
    throw new Error((message ? message + '：' : '') + '期望错误码 ' + expectedCode + '，实际 ' + caught.code + '（' + caught.message + '）');
  }
  return caught;
}

function summary(label) {
  console.log('');
  console.log(
    (label ? label + '：' : '') +
      'PASS ' + state.pass + ' / FAIL ' + state.fail + ' / SKIP ' + state.skip +
      '（共 ' + (state.pass + state.fail + state.skip) + '）'
  );
  if (state.failures.length) {
    console.log('失败用例：');
    for (const f of state.failures) console.log('  - ' + f.name);
  }
  return state.fail;
}

function reset() {
  state.pass = 0;
  state.fail = 0;
  state.skip = 0;
  state.failures = [];
}

module.exports = { test, skipped, assert, equal, deepEqual, arrayEqual, throws, runAll, summary, reset, state };
