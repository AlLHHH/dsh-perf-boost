// 生成市场索引（插件市场 index format 1）。
//
// 生成的 index.json 能被 DSH 的「插件 → 发现 → 索引源」直接添加：
//   索引 URL 填 https://raw.githubusercontent.com/<owner>/<repo>/main/index.json
// 之后就能在发现页里搜到并一键安装，安装的是 git 上钉死到某个 commit 的版本。
//
// 用法：node scripts/build-index.mjs
// 版本号取 package.json，commit 取当前 HEAD，时间戳取生成时刻。
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('读不到 git HEAD：先 git init && git commit');
  }
}

const repoUrl = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git(?:#.*)?$/, '')
  .replace(/^ssh:\/\/git@/, 'https://')
  .replace(/^git@([^:]+):/, 'https://$1/');

if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+/u.test(repoUrl)) {
  throw new Error(`package.json 的 repository.url 不像仓库地址：${repoUrl}`);
}

const commit = gitCommit();
const version = String(pkg.version ?? '');
if (!/^\d+\.\d+\.\d+/u.test(version)) throw new Error(`package.json 版本不合法：${version}`);

const index = {
  format: 1,
  title: { en: 'dsh-perf-boost', zh: 'DSH 性能优化' },
  description: {
    en: 'Client-side rendering optimizations for DSH Desktop: long-transcript content-visibility, background timer pause, list publish coalescing, session warmup.',
    zh: 'DSH 桌面端性能优化：长对话省渲染、后台暂停定时器、会话列表节流、大会话预热，设置页显示实测省下的主线程时间。',
  },
  metadata: {},
  plugins: [
    {
      name: pkg.name,
      title: { en: 'DSH Perf Boost', zh: 'DSH 性能优化' },
      description: {
        en: 'Long-transcript content-visibility, background timer pause, list publish coalescing, media lazy-load, and measured main-thread savings.',
        zh: '长对话省渲染、后台暂停定时器、会话列表节流、媒体懒加载、视口外暂停视频；设置页显示实测省下的主线程时间。',
      },
      icon: 'assets/icon-180.png',
      author: 'AlL',
      homepage: pkg.homepage ?? repoUrl,
      repository: { url: repoUrl },
      metadata: {},
      versions: [
        {
          version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repoUrl, commit },
          engines: pkg.engines?.dsh ? { dsh: pkg.engines.dsh } : {},
        },
      ],
    },
  ],
};

const out = path.join(root, 'index.json');
await writeFile(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`已写 ${out}`);
console.log(`插件 ${pkg.name}@${version}  commit ${commit.slice(0, 8)}  <- ${repoUrl}`);
