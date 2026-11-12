'use strict';

/** 极简 JSON-RPC stdio 客户端：把随包 worker 当子进程启动并逐行收发 */

const { spawn } = require('node:child_process');

class WorkerClient {
  constructor(scriptPath) {
    this.child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 测试进程会设 ASE_WORKER_NO_AUTOSTART=1，子进程必须显式关掉才自启
      env: { ...process.env, ASE_WORKER_NO_AUTOSTART: '0' },
    });
    this.buffer = '';
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.seq = 0;
    this.exited = false;

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          throw new Error('worker 输出了非 JSON 行：' + line.slice(0, 200));
        }
        if (msg.id === undefined || msg.id === null) {
          this.notifications.push(msg);
          continue;
        }
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.on('exit', () => {
      this.exited = true;
      for (const [, resolver] of this.pending) resolver({ error: { message: 'worker 提前退出：' + this.stderr.slice(0, 300) } });
      this.pending.clear();
    });
  }

  call(method, params) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callOk(method, params) {
    const res = await this.call(method, params);
    if (!res || !res.result || res.result.ok !== true) {
      const err = new Error('worker 调用失败：' + JSON.stringify(res && (res.error || res)));
      err.response = res;
      throw err;
    }
    return res.result;
  }

  async callError(method, params) {
    const res = await this.call(method, params);
    if (res && res.result && res.result.ok === true) {
      throw new Error('期望失败但成功了：' + JSON.stringify(res.result).slice(0, 200));
    }
    return res && res.error;
  }

  close() {
    if (!this.exited) this.child.kill();
  }
}

module.exports = { WorkerClient };
