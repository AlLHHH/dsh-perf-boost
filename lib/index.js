// lib/index.js —— 宿主半边。
//
// 插件的能力绝大部分在客户端（渲染进程）实现：帧率上限、长对话省渲染、动画开关。
// 宿主侧只做两件事：
//
//   1. 提供一个挂载点，让 cordis.patch.yml 把插件插进 profile，从而把 lib/client.js
//      作为客户端 bundle 下发；
//   2. 提供一条同源路由 `POST /api/dsh-perf-boost/update-check`，代替页面去问 npm
//      上的最新版本（页面自己请求跨域会被 CSP 拦掉，读不到 npm registry）。
//
// 路由只读、无副作用：只取 `latest` 标签的版本号，不下载、不安装、不落盘。
// 网络不可用时返回 `latest: null`，页面显示「未查到」，其余功能不受影响。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createWarmup } from './host/warmup.js';

export const name = 'dsh-perf-boost';

// 不声明 inject：宿主侧只读文件、不依赖任何服务，少一个依赖就少一种启动失败的方式。

const ROUTE = '/api/dsh-perf-boost/update-check';
const LAST_ROUTE = '/api/dsh-perf-boost/last-run';
// 页面每次启动端口都不一样（localhost:随机端口），localStorage 跟着端口走，
// 所以要跨启动留一份「上次实测」只能落到宿主侧的文件里。
const LAST_FILE = join(homedir(), '.dsh', 'perf-boost-last.json');
// 大会话预热开关：客户端只在设置页里改，宿主要能持久化，重启后仍然是你的选择。
const WARM_ROUTE = '/api/dsh-perf-boost/warmup';
const WARM_FILE = join(homedir(), '.dsh', 'perf-boost-warmup.json');
const PACKAGE_NAME = 'dsh-perf-boost';
// npmmirror 优先（国内快），失败再问官方源。
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
// 复用连接：第一次握手 200ms 上下，之后 40ms 上下。宿主里的全局 fetch 首次常常
// 要 3-4 秒（undici 独立连接池 + 冷 DNS），本机实测差 20 倍。
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });

let cache = { at: 0, latest: null, source: '', error: '' };

async function readInstalledVersion() {
  try {
    const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(text);
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent: AGENT, family: 4, headers: { accept: 'application/json' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('响应不是 JSON'));
        }
      });
      response.on('error', reject);
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function fetchLatest(registry) {
  const body = await httpsJson(`${registry}/${PACKAGE_NAME}/latest`);
  const version = body?.version;
  if (typeof version !== 'string' || version === '') throw new Error('响应里没有 version');
  return { version, source: registry };
}

async function resolveLatest(force = false) {
  const now = Date.now();
  if (!force && cache.at !== 0 && cache.at !== undefined && now - cache.at < CACHE_MS) return cache;
  let lastError = '未连接';
  let notPublished = false;
  // 先问第一个源，拿到就回；失败才轮到下一个。
  // 之前是「两边都问、取更高的版本」，多花一次跨洋往返（本机实测 2.0-2.5 秒），
  // 为的只是防止镜像比官方慢半拍；版本号差半分钟不影响点「检查更新」这件事。
  for (const registry of REGISTRIES) {
    try {
      const { version, source } = await fetchLatest(registry);
      cache = { at: now, latest: version, source, error: '' };
      return cache;
    } catch (error) {
      lastError = error?.message ?? String(error);
      // 这个源说 404 = 它上面没有这个包，换下一个源继续试。
      notPublished = lastError === 'HTTP 404';
    }
  }
  cache = { at: now, latest: null, source: '', error: notPublished ? 'not-published' : lastError };
  return cache;
}

async function readWarmSetting() {
  try {
    const parsed = JSON.parse(await readFile(WARM_FILE, 'utf8'));
    if (typeof parsed?.enabled === 'boolean') return parsed.enabled;
  } catch {
    // 没有文件 / 文件坏了：用默认值（开）
  }
  return true;
}

async function writeWarmSetting(enabled) {
  try {
    await mkdir(join(homedir(), '.dsh'), { recursive: true });
    await writeFile(WARM_FILE, JSON.stringify({ enabled: !!enabled }), 'utf8');
  } catch {
    // 写不进去只影响「下次启动还记得吗」，本次开关照旧生效
  }
}

export function apply(ctx, config) {
  // 大会话预热（宿主侧，可关）：把投影冷折叠从首屏挪到后台分片做。
  // 结构不认识时它会自己静默退出，不影响下面这条路由与客户端功能。
  let warm = null;
  let warmSetting = true; // 落盘的开关状态，和 warm 实例分开记
  const warmBlocked = config?.warmup === false;
  const warmLogger = (() => {
    try {
      return typeof ctx.logger === 'function' ? ctx.logger('perf-boost') : { info() {}, warn: console.warn };
    } catch {
      return { info() {}, warn: console.warn };
    }
  })();

  function startWarm() {
    if (warmBlocked || warm !== null) return;
    try {
      warm = createWarmup({ ctx, logger: warmLogger, config: config || {} });
      warm.start();
    } catch (error) {
      warm = null;
      try { console.warn('[perf-boost] warmup 装配失败:', error?.message ?? error); } catch { void 0; }
    }
  }

  function stopWarm() {
    if (warm === null) return;
    try { warm.stop(); } catch { void 0; }
    warm = null;
  }

  if (!warmBlocked) {
    readWarmSetting()
      .then((on) => { warmSetting = on; if (on) startWarm(); })
      .catch(() => { void 0; });
  }

  // 启动后先在后台问一次，设置页打开时直接命中缓存（失败无所谓，路由里还会再试）。
  try {
    const warmTimer = setTimeout(() => { resolveLatest().catch(() => { void 0; }); }, 3000);
    if (typeof warmTimer?.unref === 'function') warmTimer.unref();
  } catch {
    // 拿不到定时器就算了，只是第一次打开设置页慢一点。
  }

  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection');
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined;
    if (register === undefined) return;

    // 读/写上一条实测结果。写只接受四个数字字段，不落任何别的东西。
    const lastHandler = async (request) => {
      let body = null;
      try {
        const text = typeof request?.text === 'function' ? await request.text() : '';
        if (text) body = JSON.parse(text);
      } catch {
        body = null;
      }
      const wantWrite = body && typeof body.pct === 'number';
      if (wantWrite) {
        const round = (n) => (Number.isFinite(n) ? Math.round(n) : 0);
        const record = {
          pct: Math.max(0, Math.min(100, round(body.pct))),
          saved: Math.max(0, round(body.saved)),
          busy: Math.max(0, round(body.busy)),
          at: Number.isFinite(body.at) ? Math.round(body.at) : Date.now(),
        };
        try {
          await mkdir(join(homedir(), '.dsh'), { recursive: true });
          await writeFile(LAST_FILE, JSON.stringify(record), 'utf8');
        } catch {
          // 写不进去不影响使用，下一次再试。
        }
        return Response.json({ ok: true, value: record }, { headers: { 'cache-control': 'no-store' } });
      }
      let value = null;
      try {
        const text = await readFile(LAST_FILE, 'utf8');
        const parsed = JSON.parse(text);
        if (typeof parsed?.pct === 'number') value = parsed;
      } catch {
        value = null;
      }
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
    };

    try {
      c.effect(
        () => register({ path: LAST_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: lastHandler }),
        'dsh-perf-boost: /api/dsh-perf-boost/last-run',
      );
    } catch {
      // 注册失败只是少一条缓存读取，面板会退回到只显示本次数据。
    }

    // 预热开关：读/写都走这一条，写会落盘，重启后保持。
    const warmHandler = async (request) => {
      let body = null;
      try {
        const text = typeof request?.text === 'function' ? await request.text() : '';
        if (text) body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (body && typeof body.enabled === 'boolean') {
        warmSetting = body.enabled;
        await writeWarmSetting(body.enabled);
        if (body.enabled) startWarm();
        else stopWarm();
      } else {
        warmSetting = await readWarmSetting();
        if (!warmBlocked && warmSetting && warm === null) startWarm();
      }
      return Response.json({ ok: true, value: { enabled: warmSetting && !warmBlocked } }, { headers: { 'cache-control': 'no-store' } });
    };

    try {
      c.effect(
        () => register({ path: WARM_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: warmHandler }),
        'dsh-perf-boost: /api/dsh-perf-boost/warmup',
      );
    } catch {
      // 注册失败只是设置页那个开关不出现，预热仍按配置文件走。
    }

    const handler = async (request) => {
      let force = false;
      try {
        const text = typeof request?.text === 'function' ? await request.text() : '';
        // 手动点「检查更新」要拿最新答案，不能被 10 分钟缓存挡住；自动检查仍走缓存。
        if (text) force = JSON.parse(text)?.force === true;
      } catch {
        force = false;
      }
      const startedAt = Date.now();
      const [installed, resolved] = await Promise.all([readInstalledVersion(), resolveLatest(force)]);
      const latest = resolved.latest;
      return Response.json(
        {
          ok: true,
          value: {
            installed,
            latest,
            updateAvailable: latest === null ? false : isNewer(latest, installed),
            source: resolved.source,
            checkedAt: new Date(resolved.at === 0 ? Date.now() : resolved.at).toISOString(),
            error: latest === null ? resolved.error : '',
            elapsedMs: Date.now() - startedAt,
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    };

    try {
      c.effect(
        () => register({ path: ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
        'dsh-perf-boost: /api/dsh-perf-boost/update-check',
      );
    } catch {
      // 注册失败只影响版本检查，插件其余功能照旧。
    }
  });
}

export default { name, apply };
