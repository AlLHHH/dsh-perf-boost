// 大会话预热：把「最近用过的大会话」的文件先读一遍，让系统文件缓存里已经摊开，
// 这样你点进去时读的是内存而不是硬盘。只读、分段、可中断，完全不碰会话数据本身。
//
// 为什么不做「直接热投影」：投影缓存属于宿主内部实现（sessionProjections /
// sessionProjectionCache），上游没给预热接口。硬塞进去一旦签名变化就会在启动时
// 抛错，违背「稳定性别变差」。这里只做没有任何耦合面的文件缓存预热。

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULTS = {
  minBytes: 8 * 1024 * 1024,   // 只预热 8MB 以上的会话（本机 39 个）
  maxSessions: 10,             // 最多 10 个
  maxBytes: 400 * 1024 * 1024, // 一次最多读 400MB，到量就停
  maxWarmMs: 180 * 1000,       // 最多占用 3 分钟（可中断）
  chunkBytes: 4 * 1024 * 1024,
  pauseMs: 40,                 // 每读完一块歇一下，别跟正常使用抢 IO
  delayMs: 15 * 1000,          // 启动后等 15 秒再开始，避开首屏高峰
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function settingsFrom(config) {
  return {
    minBytes: num(config?.minBytes, DEFAULTS.minBytes),
    maxSessions: num(config?.maxSessions, DEFAULTS.maxSessions),
    maxBytes: num(config?.maxBytes, DEFAULTS.maxBytes),
    maxWarmMs: num(config?.maxWarmMs, DEFAULTS.maxWarmMs),
    chunkBytes: num(config?.chunkBytes, DEFAULTS.chunkBytes),
    pauseMs: num(config?.pauseMs, DEFAULTS.pauseMs),
    delayMs: num(config?.delayMs, DEFAULTS.delayMs),
  };
}

const SESSION_FILE = /^session\.[\w.-]+\.(jsonl|zstd|jsonl\.zstd)$/;

async function collectCandidates(root, minBytes, limit) {
  const found = [];
  const now = Date.now();
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    const sessions = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const entry of sessions) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectDir, entry.name);
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !SESSION_FILE.test(file.name)) continue;
        const path = join(dir, file.name);
        const info = await stat(path).catch(() => null);
        if (!info || info.size < minBytes) continue;
        // 最近十分钟还在写的文件就是当前会话：这时候读它只会和首屏、流式落盘抢磁盘。
        if (now - info.mtimeMs < 10 * 60 * 1000) continue;
        found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return found.slice(0, limit);
}

async function warmOne(path, size, options, deadline) {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return 0;
  const buffer = Buffer.allocUnsafe(Math.min(options.chunkBytes, 8 * 1024 * 1024));
  let read = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) break;
      const result = await handle.read(buffer, 0, buffer.length, read).catch(() => null);
      if (!result || result.bytesRead <= 0) break;
      read += result.bytesRead;
      if (read >= size) break;
      await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return read;
}

/**
 * @param {{ ctx: any, logger: any, config: any }} options
 */
export function createWarmup({ ctx, logger, config }) {
  const options = settingsFrom(config);
  let timer = null;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function run() {
    if (stopped) return;
    const root = join(homedir(), '.dsh', 'sessions');
    const candidates = await collectCandidates(root, options.minBytes, options.maxSessions);
    if (candidates.length === 0) {
      logger.info?.('warmup: 没有需要预热的大会话');
      return;
    }
    const deadline = Date.now() + options.maxWarmMs;
    let total = 0;
    let done = 0;
    for (const candidate of candidates) {
      if (stopped || Date.now() > deadline) break;
      if (total >= options.maxBytes) break;
      const bytes = await warmOne(candidate.path, candidate.size, options, deadline);
      total += bytes;
      if (bytes > 0) done += 1;
    }
    if (total > 0) {
      logger.info?.(`warmup: 已预热 ${(total / 1024 / 1024).toFixed(0)}MB（${done} 个大会话）`);
    }
  }

  return {
    start() {
      // 宿主关闭时清掉定时器，别留下悬空的句柄。
      try {
        if (ctx && typeof ctx.on === 'function') ctx.on('dispose', stop);
      } catch (error) {
        void error;
      }
      timer = setTimeout(() => {
        timer = null;
        run().catch((error) => logger.warn?.('warmup 失败:', error?.message ?? error));
      }, options.delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop,
    options,
  };
}

export const warmupDefaults = DEFAULTS;
