// 用 DSH 自己的校验器检查 index.json 是不是合法的索引 format 1。
// 本机有 DSH profile 时才会真正校验；CI 上没有就跳过，不算失败。
//
// 用法：node scripts/check-index.mjs
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'index.json');
const envProfile = process.env.DSH_PROFILE;
const profile = typeof envProfile === 'string' && path.isAbsolute(envProfile)
  ? envProfile
  : path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop');

let parseMarketIndex;
try {
  // 走 profile 的解析规则定位包（package.json 的 exports 会挡住直接 import 子路径），
  // 再把解析出来的文件路径用 import() 打开。
  const require = createRequire(path.join(profile, 'package.json'));
  const resolved = require.resolve('@deepseek-ai/dsh-plugin-market-index', { paths: [profile] });
  const mod = await import(pathToFileURL(resolved).href);
  parseMarketIndex = mod.parseMarketIndex;
} catch (error) {
  console.log('跳过：本机没装 @deepseek-ai/dsh-plugin-market-index（' + (error?.code ?? error?.message ?? error) + '）。');
  process.exit(0);
}

const raw = JSON.parse(await readFile(indexPath, 'utf8'));
const indexUrl = 'https://raw.githubusercontent.com/AlLHHH/dsh-perf-boost/main/index.json';
try {
  const parsed = parseMarketIndex(raw, indexUrl);
  const [entry] = parsed.plugins;
  console.log(`索引合法：${parsed.plugins.length} 个插件`);
  console.log(`  ${entry.name}  ${entry.versions.map((v) => v.version).join(', ')}`);
  for (const v of entry.versions) {
    console.log(`  ${v.version} <- ${v.source.type} ${v.source.type === 'git' ? v.source.commit.slice(0, 8) : v.source.registry ?? ''}`);
  }
} catch (error) {
  console.error('索引不合法：', error?.path ?? '', error?.message ?? error);
  process.exit(1);
}
