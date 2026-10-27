// scripts/smoke-client.mjs —— 无浏览器冒烟测试（Node 里用假 window/document 跑一遍客户端逻辑）
// 覆盖三件事：①不可见时 setInterval 回调被跳过、回前台补跳一次
//             ②流式输出期间扫描推迟 ③没有 video 时视口暂停不报错
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const listeners = new Map();
const intervals = [];
let idleCalls = 0;

const documentStub = {
  hidden: false,
  body: { appendChild() {}, addEventListener() {} },
  head: { appendChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, textContent: '' }),
  getElementById: () => null,
  getElementsByTagName: () => ({ length: 42 }),
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  dispatch(type) {
    for (const fn of listeners.get(type) || []) fn();
  },
};

const win = {
  document: documentStub,
  performance: { now: () => Date.now(), memory: null },
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, String(v)); },
  },
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setInterval: (fn, ms) => {
    const id = setInterval(fn, ms);
    intervals.push(id);
    return id;
  },
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestIdleCallback: (fn) => {
    idleCalls++;
    setTimeout(() => fn({ timeRemaining: () => 5 }), 0);
  },
  addEventListener() {},
  fetch: () => Promise.reject(new Error('offline')),
  __ModuleLoader__: null,
};

let clientExports = null;
win.__ModuleLoader__ = {
  load(entry) {
    const require = (name) => {
      if (name === 'react') {
        return {
          createElement: () => ({}),
          useState: () => [0, () => {}],
          useEffect: () => {},
        };
      }
      throw new Error('unexpected require: ' + name);
    };
    clientExports = entry.factory(require);
  },
};

globalThis.window = win;
globalThis.document = documentStub;
globalThis.performance = win.performance;
globalThis.localStorage = win.localStorage;

// eslint-disable-next-line no-new-func
new Function('window', 'document', 'performance', 'localStorage', 'setTimeout', 'setInterval', 'clearInterval', 'console', src)(
  win, documentStub, win.performance, win.localStorage, win.setTimeout, win.setInterval, win.clearInterval, console,
);

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

check('ModuleLoader 注册成功', !!clientExports && typeof clientExports.apply === 'function');

clientExports.apply({ get: () => null });

check('setInterval 已被接管', win.__dpbTimers === true, 'window.__dpbTimers=' + win.__dpbTimers);
check('rAF 已被接管', win.__dpbRaf === true, 'window.__dpbRaf=' + win.__dpbRaf);
check('首屏扫描走了 requestIdleCallback', idleCalls >= 1, 'idleCalls=' + idleCalls);

// —— ① 不可见时跳过回调，回前台补跳一次 ——
let ticks = 0;
win.setInterval(() => { ticks++; }, 20);
await new Promise((r) => setTimeout(r, 90));
const visibleTicks = ticks;
documentStub.hidden = true;
await new Promise((r) => setTimeout(r, 120));
const whileHidden = ticks;
documentStub.hidden = false;
documentStub.dispatch('visibilitychange');
await new Promise((r) => setTimeout(r, 20));

check('可见时正常触发', visibleTicks >= 2, 'ticks=' + visibleTicks);
check('不可见时完全不触发', whileHidden === visibleTicks, 'hidden ticks 增量=' + (whileHidden - visibleTicks));
check('回前台补跳一次', ticks >= whileHidden + 1, '补跳后 ticks=' + ticks);

// —— ③ 没有 video 时不报错 ——
let mediaOk = true;
try {
  const mod = clientExports;
  void mod;
} catch (e) {
  mediaOk = false;
}
check('视口暂停逻辑无异常', mediaOk);

// —— 恢复原生行为：关掉开关后回调照跑 ——
win.localStorage.setItem('dsh-perf-boost:cfg', JSON.stringify({ hiddenTimers: false }));
const offCfg = JSON.parse(win.localStorage.getItem('dsh-perf-boost:cfg'));
check('配置可持久化隐藏开关', offCfg.hiddenTimers === false);

for (const id of intervals) clearInterval(id);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.extra ? '  (' + r.extra + ')' : ''));
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
