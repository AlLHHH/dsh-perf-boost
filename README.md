# dsh-perf-boost

DeepSeek Harness 桌面端的客户端渲染优化插件，全部改动只发生在渲染进程。

Client-side rendering optimizations for DSH Desktop.

设置入口：**设置 → 性能优化**


## 开关

按默认状态排序，前六项默认开启，对观感没有可见影响。

| 开关 | 默认 | 影响视觉 | 作用 |
| --- | --- | --- | --- |
| 长对话省渲染 | 开 | 无 | 列表子项加 `content-visibility: auto`，占位高度取该列表实测平均子项高度；末尾 4 项与正在流式输出的消息不处理，超过 300px 的代码块同样跳过 |
| 窗口隐藏不排帧 | 开 | 无 | 页面不可见时 `schedule()` 直接返回；切回时有 `visibilitychange` 钩子恢复，每秒看门狗兜底 |
| 空闲降帧 | 开 | 无 | 20 秒无输入将 rAF 驱动的动画降到 30fps，有输入立即恢复 |
| 媒体懒加载 | 开 | 无 | 图片加 `loading=lazy`、`decoding=async`，视频加 `preload=metadata` |
| 后台暂停定时器 | 开 | 无 | 页面不可见时跳过 `setInterval` 回调，不销毁也不重置周期；回到前台各补跳一次 |
| 视口外暂停视频 | 开 | 无 | 仅处理静音视频：滚出视口暂停解码，滚回续播 |
| 会话列表节流 | 开 | 无 | 流式输出时把「只有 token 计数变了」的列表发布攒到每秒一次；可见字段变了立刻放行 |
| 大会话预热 | 开（宿主侧） | 无 | 启动 15 秒后把最近 10 个 8MB 以上会话分段读进系统文件缓存，只读，跳过 10 分钟内改过的会话 |
| 关闭背景模糊 | 关 | 有 | 全局 `backdrop-filter: none`，浮层由磨砂改为纯色底 |
| 减少动画 | 关 | 有 | 动画与过渡时长置 0.001ms，弹窗不再逐帧动 |
| 帧率角标 | 关 | 有 | 右下角显示 `NN fps` |

每个开关的说明里都标了副作用，这里汇总一次：

| 开关 | 副作用 |
| --- | --- |
| 长对话省渲染 | 快速滚动时，被跳过的行可能空白一瞬，紧接着补上 |
| 窗口隐藏不排帧 | 后台标签页里的动画会停，切回前台补一帧 |
| 空闲降帧 | 长时间不动，动画看起来变慢；动一下鼠标立刻恢复 |
| 媒体懒加载 | 快速拖到很远处的图片可能先白一下再出来 |
| 后台暂停定时器 | 隐藏期间攒下的轮询只补一次，个别插件会看到一次跳变 |
| 视口外暂停视频 | 滚回来时可能黑一下或重新缓冲 |
| 会话列表节流 | 侧栏 token 数字最多晚 1 秒才跳 |
| 大会话预热 | 读盘那几十秒里机械盘/低配机器打开会话可能反而慢一点，磁盘占用升高 |

不提供预设档位。

## 验证

- 「长对话省渲染」行下方显示 `已生效：N 个列表，跳过 M 项渲染（共 K 项）`
- 打开「帧率角标」，右下角出现 fps 小方块
- 控制台 `window.__dpbRaf`、`window.__dpbTimers` 为 `true`，表示 rAF 与定时器接管成功

角标读数为浏览器实际送帧数，上限等于显示器刷新率。帧时、DOM 节点等细分数据请用 DevTools 的 Performance 面板录制，插件不做常驻采样。

## 实测

Windows 桌面端，200Hz 显示器，缩放 100%：

| 场景 | 帧率 | p50 帧时（DevTools） |
| --- | --- | --- |
| 空白页（同机 Edge） | 187–200 | 5.0 ms |
| DSH 页面（新会话，DOM 1218） | 200 | 5.0 ms |
| DSH 桌面端（2.3 万事件会话） | 约 156 | ≈6.4 ms |

页面代码本身可以跑满刷新率，差距来自长会话的 DOM 体量与 Electron 窗口合成。

## 安装

```bash
pnpm add dsh-perf-boost
pnpm add github:AlLHHH/dsh-perf-boost
pnpm add file:./dsh-perf-boost
```

将 `dsh-perf-boost` 加入 profile 的 `dsh.profile.bundles`，重启应用生效；卸载时从 bundles 移除并重启。

## 实现说明

- 只修改当前渲染进程：不改宿主代码，不落盘配置，不发送遥测。配置存于 `localStorage['dsh-perf-boost:cfg']`。
- 唯一的网络请求是「检查更新」：页面 POST 到 `/api/dsh-perf-boost/update-check`，由宿主查询 npm 的 latest（CSP 限制页面不能直接跨域）。查询失败显示「未查到」，不影响功能。
- `requestAnimationFrame` 仅在启用「窗口隐藏不排帧」或「空闲降帧」时接管，否则保持原生实现。

## 已知限制

- 窗口的 `transparent` / `vibrancy` 由应用自身（`app.asar` 的 `lib/main.js`）决定，Windows 分支不透明，插件无法修改。
- 省渲染只减少布局与绘制，消息节点仍在内存中，超长会话的滚动开销依然存在。
- 媒体懒加载只修改属性，不改动 DOM 结构，已加载的图片不会被回收。

## 兼容

- `engines.dsh >= 0.2.0-0`，实测 0.2.1-rc.2（桌面版 0.2.1.0）
- peer `@deepseek-ai/cordis ^4.0.1`，实测 4.0.5
- 依赖客户端插件 API：`window.__ModuleLoader__.load`、`slots`（`settings.section`）、`require('react')`

## 许可

MIT
