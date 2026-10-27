# 参与

改动范围很小：`lib/client.js`（渲染进程，设置页与优化逻辑）、`lib/index.js`（宿主侧，只有一条版本检查路由）。

## 本地跑

```powershell
git clone <repo>
cd dsh-perf-boost

node --check lib\index.js
node --check lib\client.js
node --test test\index.test.mjs

# 装进本机 profile 试
pwsh -File scripts\sync.ps1 -Install
```

`sync.ps1` 会把文件同步到 `%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-perf-boost`，
以及 `node_modules` 里那份（pnpm 用硬链接，必须逐文件拷，脚本里已经处理）。
之后在应用里点「重启应用」，去 **设置 → 性能优化** 看效果。

## 改什么算「真优化」

1. 先在设置页「诊断」里看读数：p50 帧时、DOM 节点、长任务/秒。
2. 改完给出**同一台机器、同一页面**的前后对比数字。
3. 没有数字的改动不算优化，宁可不开这个开关。

不要做这些：

- 不要碰宿主配置、不要写文件、不要上报数据。
- 不要为了「看起来快」而跳帧跳过渲染逻辑（会丢正文）。
- 不要在 DOM 上做全局 `*` 规则以外的大范围改写，`content-visibility` 只作用于消息列表容器。

## 提交

- `feat:` / `fix:` / `docs:` / `chore:` 前缀。
- 改了行为就同时改 `CHANGELOG.md` 与 `package.json` 版本（`scripts\release.ps1 -Bump patch` 会一起做）。
- 改了市场相关就重新生成 `index.json`（`node scripts/build-index.mjs`），它会钉住当前 commit。
