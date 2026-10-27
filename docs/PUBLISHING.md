# 发布手册

三处门面各自独立，按需做：

| 门面 | 作用 | 更新来源 |
| --- | --- | --- |
| npm 包 | 「插件 → 已安装」里的更新按钮 | npm 的 `latest` 标签 |
| GitHub 仓库 | 主页、issue、源码；市场也能按 git commit 更新 | 仓库的 `main` 分支 |
| 市场目录 | 「插件 → 发现」里能被搜到 | 索引 JSON |

## 1. 先自测

```powershell
# 语法
node --check lib\index.js
node --check lib\client.js

# 同步到本地 profile，装好并体检
pwsh -File scripts\sync.ps1 -Install

# 应用菜单 → 重启应用，然后看 设置 → 性能优化
```

`node D:\deep\dsh-desktop\tools\dsh-doctor.mjs` 要 15 ok / 0 fail 再往下走。

## 2. 改版本

semver：修 bug 打补丁位，加开关/档位打次版本，改数据结构才动主版本。
`package.json` 与 `CHANGELOG.md` 必须同时改，否则市场里看不出更新了什么。

## 3. 发 npm

```bash
npm login                                  # 一次就够
npm pack --dry-run                         # 看 files 白名单有没有漏
npm publish --registry https://registry.npmjs.org
```

已发过的话，`npm version patch` 之后再 `npm publish`。国内网络发不上去时：

```bash
npm publish --registry https://registry.npmmirror.com
```

（npmmirror 是镜像，发布要走官方源；发不动就挂代理，别指望镜像收包。）

发完验证：

```bash
npm view dsh-perf-boost version --registry https://registry.npmjs.org
```

市场读的就是这个 `latest`，插件设置页的「检查更新」也读它（先问 npmmirror，
失败再问 npmjs，10 分钟缓存）。

## 4. 推 GitHub

```bash
git init
git add -A
git commit -m "feat: dsh-perf-boost 0.1.0"
git branch -M main
git remote add origin git@github.com:AlLHHH/dsh-perf-boost.git
git push -u origin main
git tag v0.1.0 && git push --tags
```

`package.json` 里的 `repository` / `homepage` / `bugs` 要指向真实地址，市场卡片会读。

## 5. 进市场目录

市场（`dshmarket`）本身不收集插件，它读索引。搜索走的索引是
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（format 1，15 秒超时），
另外还有 `https://awesome-dsh-plugin.com/plugins.json`、`https://awesome-dsh-plugin.com/index.json`、
`https://dshmarket.com/index.json` 几个源。

收录方式：往 `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，在清单里加一行：

```json
{
  "name": "dsh-perf-boost",
  "repo": "AlLHHH/dsh-perf-boost",
  "npm": "dsh-perf-boost",
  "description": "DSH 桌面端性能优化：长对话省渲染、后台暂停定时器、会话列表节流、大会话预热。",
  "keywords": ["performance", "fps", "rendering"]
}
```

PR 里带上：一句话说明、更新方式（npm 还是 git）、有没有原生依赖（本插件没有）、
是否只支持 Windows（否）。

索引更新有延迟，合并后 `插件 → 发现` 里搜得到就算成功。也可以自己搭索引：
索引地址填进 `插件 → 发现 → 索引源`，格式照上面的 `index.json`。

## 5.5 自建索引源（不用等别人收录）

仓库根目录的 `index.json` 就是一份合法的市场索引（format 1，DSH 自带校验器能过）。
推上去之后，任何人都能在 `插件 → 发现 → 索引源` 里加：

```
https://raw.githubusercontent.com/<owner>/<repo>/main/index.json
```

索引里钉的是 **git commit**，所以每次发版都要重新生成：

```powershell
node scripts\build-index.mjs    # 版本取 package.json，commit 取 HEAD
node scripts\check-index.mjs    # 用 DSH 的 parseMarketIndex 验一遍
```

安装时 `marketInstallTarget()` 会拼成
`git+https://github.com/<owner>/<repo>.git#<40位commit>`，
所以索引里的 commit 必须真实存在于远端，否则装不上。顺序上先推代码、再推索引。

这就是「本地目录不支持更新」的正解：`file:` 依赖在市场里恒为 `linked`，不回源、
不比对版本；走索引 + 固定 commit 才是可更新的形态。


## 6. 更新链路

市场服务端（桌面端 `127.0.0.1:<port>`，同一 origin 下 `/dsh-market/api/v1/*`）：

- `GET /capabilities` — 协议版本 `dsh-market/update-api/v1`，`features.restart` 在桌面端是
  **false**（由 desktop-host 托管），所以更新完必须提示用户点「重启应用」。
- `GET /updates/summary` — `{checked, updatable, packages[]}`。
- `GET /updates?name=dsh-perf-boost` — 单包详情，`source` 会是 `npm` 或 `linked`
  （`file:` 依赖一律 `linked`，`latestVersion` 为空，所以本地开发时不显示可更新）。
- `POST /updates {packageName}` → `202 {operationId}`，再轮询 `GET /operations?operationId=`。

失败码：`DOWNGRADE_DETECTED`、`RESOLVED_VERSION_MISMATCH`、`RELEASE_TOO_FRESH`（发布太新，
等 pnpm 的 `minimumReleaseAge` 过）、`VERSION_UNCHANGED`。

要让自己出现在这条链路上，唯一条件是：**以 npm 包方式安装**且 `latest` 比已装版本高。

## 7. 自查清单

- [ ] `node --check` 两个文件都过
- [ ] `scripts\sync.ps1 -Install` 后 doctor 15 ok / 0 fail
- [ ] 重启后 设置 → 性能优化 能打开，开关即时生效
- [ ] 帧率角标读数与 DevTools Performance 里录到的帧率量级一致（差 2 倍说明统计写错了）
- [ ] README 的实测表数字是本人机器新测的，不是编的
- [ ] `npm pack --dry-run` 里没有 node_modules、没有 log
- [ ] `package.json` 的 repository / homepage / bugs 已改成真实地址
