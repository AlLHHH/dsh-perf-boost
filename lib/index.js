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
const PACKAGE_NAME = 'dsh-perf-boost';
// npmmirror 优先（国内快），失败再问官方源。
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

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

async function fetchLatest(registry) {
  const url = `${registry}/${PACKAGE_NAME}/latest`;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const version = body?.version;
  if (typeof version !== 'string' || version === '') throw new Error('响应里没有 version');
  return { version, source: registry };
}

async function resolveLatest() {
  const now = Date.now();
  if (cache.at !== 0 && cache.at !== undefined && now - cache.at < CACHE_MS) return cache;
  let lastError = '未连接';
  let notPublished = false;
  let best = null;
  let bestSource = '';
  for (const registry of REGISTRIES) {
    try {
      const { version, source } = await fetchLatest(registry);
      // 镜像可能比官方慢半拍，两边都问，取版本更高的那个，别被慢的镜像带偏。
      if (best === null || isNewer(version, best)) {
        best = version;
        bestSource = source;
      }
    } catch (error) {
      lastError = error?.message ?? String(error);
      // 所有镜像都 404 = 这个包还没发到 npm，不算「网络失败」。
      if (lastError === 'HTTP 404') notPublished = true;
      else notPublished = false;
    }
  }
  if (best !== null) {
    cache = { at: now, latest: best, source: bestSource, error: '' };
    return cache;
  }
  cache = { at: now, latest: null, source: '', error: notPublished ? 'not-published' : lastError };
  return cache;
}

export function apply(ctx, config) {
  // 大会话预热（宿主侧，可关）：把投影冷折叠从首屏挪到后台分片做。
  // 结构不认识时它会自己静默退出，不影响下面这条路由与客户端功能。
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('perf-boost') : { info() {}, warn: console.warn };
    if (!config || config.warmup !== false) {
      const warm = createWarmup({ ctx, logger, config: config || {} });
      warm.start();
    }
  } catch (error) {
    try { console.warn('[perf-boost] warmup 装配失败:', error?.message ?? error); } catch { void 0; }
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

    const handler = async () => {
      const [installed, resolved] = await Promise.all([readInstalledVersion(), resolveLatest()]);
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
