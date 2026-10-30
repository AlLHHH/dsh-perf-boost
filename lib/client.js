// lib/client.js —— DSH 性能优化（客户端侧）
//
// 设计前提：只做「看不出差别」的事。默认开的四项都没有视觉行为；
// 会改观感的三项（关模糊 / 减动画 / 帧率角标）默认关，由用户自己点。
//
//   ① 长对话省渲染：消息列表与其他长滚动列表的子项标 content-visibility:auto，
//      contain-intrinsic-size 按该列表实测平均高度给，滚动条不跳。
//   ② 窗口隐藏不排帧：最小化/切走时不再往合成器送帧。
//   ③ 空闲降帧：20 秒无输入把 JS 驱动的 rAF 降到 30fps（CSS 动画不受影响）。
//   ④ 媒体懒加载：图片 loading=lazy + decoding=async，视频 preload=metadata。
//   ⑤ 后台暂停定时器：页面不可见时，所有 setInterval 回调直接跳过（不计时、不重绘），
//      回到前台再各自补跳一次，逻辑状态不会漏掉。
//   ⑥ 视口外暂停视频：静音视频滚出视口就暂停，滚回来自动续播（有声音的一律不碰）。
//   ⑦ 会话列表节流：流式输出时列表常因「只有 token 计数变了」整树重渲染，
//      这里把这类只改身份的发布攒到每秒一次；可见内容真变了照旧立刻发布。
//
// 兼容性约定：只「添加」不「替换」——给元素加 inline style / 属性，
// 关闭时按记录逐项还原；不删节点、不改别人的 class、不动别的插件结构。
window.__ModuleLoader__.load({
  id: 'dsh-perf-boost',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var NAME = 'dsh-perf-boost';
    var STORE = 'dsh-perf-boost:cfg';
    var STYLE_ID = 'dpb-style';
    var CV_CLASS = 'dpb-cv'; // 挂在滚动列表容器上，子项的 content-visibility 交给 CSS
    var CV_VAR = '--dpb-cis';
    var VERSION = '0.2.2';
    // 更新公告：只用「新增了…的功能 / 修复了…的问题 / 优化了…的效果」三种句式。
    var RELEASE_NOTES = [
      {
        version: '0.2.2',
        items: [
          '优化了长对话省渲染的实现，改成一条 CSS 规则接管，新消息进来自动生效的效果',
          '修复了流式输出时每来一条消息就扫一遍页面的问题，改成一分钟几十次的空闲巡检',
        ],
      },
      {
        version: '0.2.1',
        items: [
          '新增了大会话预热的开关，可以直接在设置里关掉的功能',
          '新增了浅色模式的配色，开关和边框在浅色主题下也看得清的效果',
          '优化了开关说明的文字，统一说成「可能会导致…」的效果',
          '新增了百分比改成最近 1 分钟窗口，长时间使用不会越用越低的功能',
          '优化了开关列表的顺序，默认开启的排在前面、默认关闭的放在后面的效果',
        ],
      },
      {
        version: '0.2.0',
        items: [
          '新增了设置页「更新详情」，能直接看到每个版本改了什么的功能',
          '新增了滚动时让路，滚动过程中不再扫列表、停手后再补的效果',
          '新增了长任务让路，超过 50 毫秒的卡顿之后等主线程缓过来再扫的效果',
          '新增了视口外图片低优先级解码，把带宽留给看得见的图的效果',
          '新增了窗口不可见时暂停 CSS 动画，合成器不再空转的效果',
          '修复了大会话预热会去读正在写入的会话文件的问题',
          '优化了列表观察范围，从盯整页收窄到只盯消息列表的效果',
          '优化了每个开关的说明，把副作用写清楚的效果',
        ],
      },
    ];
    var BADGE_ID = 'dpb-fps-badge';
    var IDLE_FPS = 30;
    var IDLE_AFTER_MS = 20000;

    var DEFAULTS = {
      // 默认开：不影响观感
      lazyList: true,
      hiddenPause: true,
      idleThrottle: true,
      mediaLazy: true,
      hiddenTimers: true,
      mediaPause: true,
      listGate: true,
      // 默认关：会改观感或动画
      noBlur: false,
      reduceMotion: false,
      showFps: false,
    };

    var cfg = readCfg();
    var subs = [];

    // ————————————————— 版本检查 —————————————————
    var update = { state: 'idle', installed: '', latest: null, available: false, source: '', checkedAt: null, error: '' };
    var UPDATE_ROUTE = '/api/dsh-perf-boost/update-check';
    var WARM_ROUTE = '/api/dsh-perf-boost/warmup';

    // 大会话预热跑在宿主里，开关状态存在宿主侧的文件，这里只是替它传话。
    // 不带 enabled = 查询；带 enabled = 改并持久化。失败一律当「不知道」，不动界面。
    function warmupCall(enabled) {
      var body = typeof enabled === 'boolean' ? JSON.stringify({ enabled: enabled }) : '{}';
      return fetch(WARM_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: body,
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (j) { return j && j.value ? !!j.value.enabled : null; })
        .catch(function () { return null; });
    }

    function checkUpdate() {
      if (window.__dpbUpdating) return;
      window.__dpbUpdating = true;
      update.state = 'checking';
      notify();
      var ctl = null;
      try { ctl = typeof AbortController === 'function' ? new AbortController() : null; } catch (e) { ctl = null; }
      var guard = ctl ? window.setTimeout(function () { try { ctl.abort(); } catch (e) { void e; } }, 9000) : null;
      fetch(UPDATE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: ctl ? ctl.signal : undefined,
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (j) {
          var v = j && j.value ? j.value : null;
          if (!v) throw new Error('空响应');
          update.installed = v.installed || '';
          update.latest = v.latest === undefined ? null : v.latest;
          update.available = !!v.updateAvailable;
          update.source = v.source || '';
          update.checkedAt = v.checkedAt || null;
          update.error = v.error || '';
          // error 有值就是没问到答案（未发布 / 网络不通），别当成「已是最新」。
          update.state = update.error ? 'unknown' : 'done';
        })
        .catch(function (e) {
          update.state = 'failed';
          update.error = String(e && e.message ? e.message : e);
        })
        .then(function () {
          if (guard) window.clearTimeout(guard);
          window.__dpbUpdating = false;
          notify();
        });
    }

    function readCfg() {
      var out = {};
      for (var k in DEFAULTS) out[k] = DEFAULTS[k];
      try {
        var raw = window.localStorage.getItem(STORE);
        if (raw) {
          var j = JSON.parse(raw);
          for (var k2 in DEFAULTS) {
            if (j && typeof j[k2] === typeof DEFAULTS[k2]) out[k2] = j[k2];
          }
        }
      } catch (e) { void e; }
      return out;
    }

    function writeCfg() {
      try { window.localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) { void e; }
    }

    // 上次跑出来的实测结果：刚启动时样本不够，就先拿这个顶上，别显示「—」。
    var LAST_KEY = 'dsh-perf-boost:last';
    function readLast() {
      try {
        var raw = window.localStorage.getItem(LAST_KEY);
        if (!raw) return null;
        var v = JSON.parse(raw);
        if (!v || typeof v.pct !== 'number' || !isFinite(v.pct)) return null;
        if (typeof v.at !== 'number' || Date.now() - v.at > 30 * 24 * 3600 * 1000) return null;
        return v;
      } catch (e) { return null; }
    }
    // 页面端口每次启动都变，localStorage 留不住，所以同时存一份到宿主文件里。
    var remoteLast = null;
    var lastRemoteAt = 0;
    var LAST_ROUTE = '/api/dsh-perf-boost/last-run';

    function loadLastRun() {
      try {
        fetch(LAST_ROUTE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: '{}',
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.value && typeof j.value.pct === 'number') {
              remoteLast = j.value;
              notify();
            }
          })
          .catch(function () { /* 宿主没提供就只用本地数据 */ });
      } catch (e) { void e; }
    }

    function saveLastRemote(record) {
      try {
        fetch(LAST_ROUTE, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(record),
        }).catch(function () { /* 路由还没注册（未重启）时就是 404，忽略 */ });
      } catch (e) { void e; }
    }

    function saveLast(pct, saved, busy) {
      var at = Date.now();
      var record = { pct: pct, saved: Math.round(saved), busy: Math.round(busy), at: at };
      try {
        var prev = readLast();
        if (!prev || prev.pct !== pct || Math.abs((prev.saved || 0) - saved) >= 5000) {
          window.localStorage.setItem(LAST_KEY, JSON.stringify(record));
        }
      } catch (e) { void e; }
      // 宿主文件最多一分钟写一次，省得每 5 秒一次磁盘写。
      if (at - lastRemoteAt < 60000) return;
      lastRemoteAt = at;
      saveLastRemote(record);
    }

    function notify() {
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) { void e; } }
    }

    function setCfg(patch) {
      var dirty = false;
      var touchedGate = false;
      for (var k in patch) {
        if (cfg[k] !== patch[k]) {
          cfg[k] = patch[k];
          dirty = true;
          if (k === 'listGate') touchedGate = true;
        }
      }
      if (!dirty) return;
      writeCfg();
      applyAll();
      if (touchedGate) {
        if (cfg.listGate) { applyListGate(); }
        else if (gate) { gate.dispose(); gate = null; }
      }
      notify();
    }

    function subscribe(fn) {
      subs.push(fn);
      return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    }

    // ————————————————— 真实开销计量 —————————————————
    // 不摆预设权重：每次「我们经手的」回调都实测耗时，攒起「实际跑了多少」与
    // 「拦下多少」，百分比就是这两堆真实毫秒算出来的比值。样本不够就返回 null，
    // 让人看到「—」而不是一个编出来的数。
    var MET = {
      at: Date.now(),
      rafMs: 0, rafRuns: 0, rafSkipped: 0, rafIdle: 0,
      timerMs: 0, timerRuns: 0, timerSkipped: 0,
      setMs: 0, setRuns: 0, setMerged: 0,
      lazyItems: 0, mediaPaused: 0, mediaLazy: 0,
    };
    function metPer(x, n) { return n > 0 ? x / n : 0; }
    // rAF 那部分不算「省下」：页面隐藏时压住回调只是推迟，回到前台会一次性补跑，
    // 毫秒照样要花。真正不再发生的是被跳过的定时器回调和合并掉的发布。
    function metSavedMs() {
      return MET.timerSkipped * metPer(MET.timerMs, MET.timerRuns)
        + MET.setMerged * metPer(MET.setMs, MET.setRuns)
        + MET.rafIdle * metPer(MET.rafMs, MET.rafRuns);
    }
    // 百分比按「最近 60 秒」算：累计值在活跃一会儿之后一定会被摊薄，
    // 而窗口值只反映当下——闲着时降帧省下的和实际跑的都在这 60 秒里比。
    var SNAP = [];                 // 每秒一条 { t, s, b } 累计快照
    var SNAP_MS = 60000;
    function snapNow() {
      var t = Date.now();
      SNAP.push({ t: t, s: metSavedMs(), b: MET.rafMs + MET.timerMs + MET.setMs });
      while (SNAP.length > 2 && t - SNAP[0].t > SNAP_MS) SNAP.shift();
    }
    function metPercent() {
      var saved = metSavedMs();
      var busy = MET.rafMs + MET.timerMs + MET.setMs;
      if (saved + busy < 120) return null;   // 样本太少就不下结论
      if (SNAP.length >= 2) {
        var first = SNAP[0];
        var ds = saved - first.s;
        var db = busy - first.b;
        if (ds + db >= 120 && ds >= 0 && db >= 0) {
          return Math.min(99, Math.round((ds / (ds + db)) * 100));
        }
      }
      return Math.min(99, Math.round((saved / (saved + busy)) * 100));
    }

    // ————————————————— 空闲检测 —————————————————
    var lastInput = Date.now();
    var lastBusyAt = 0;          // 最近一次滚动 / 长任务的时间点，用来给扫描让路
    function markInput() { lastInput = Date.now(); }
    function idleNow() { return !!cfg.idleThrottle && Date.now() - lastInput > IDLE_AFTER_MS; }
    function effectiveCap() { return idleNow() ? IDLE_FPS : 0; }
    function markBusy() { lastBusyAt = Date.now(); }
    function watchBusy() {
      // 滚动时别扫：滚动本身就在吃主线程。
      window.addEventListener('scroll', markBusy, { passive: true, capture: true });
      // 长任务（>50ms）之后也让一让，等主线程缓过来再扫。
      if (typeof PerformanceObserver !== 'function') return;
      try {
        var po = new PerformanceObserver(function (list) {
          if (list && list.getEntries && list.getEntries().length) markBusy();
        });
        po.observe({ entryTypes: ['longtask'] });
        window.__dpbLongTask = po;
      } catch (e) { void e; }
    }

    // ————————————————— rAF 接管 —————————————————
    var nativeRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
    var nativeCAF = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : function () {};
    var queue = [];
    var pending = false;
    var nextId = 1e9;   // 避开接管前发出去的原生 id（那些都很小），否则 cancel 会取消错对象
    var live = new Map();
    var lastFrameTs = 0;

    function runFrame(ts) {
      pending = false;
      lastFrameTs = ts;
      var batch = queue;
      queue = [];
      for (var i = 0; i < batch.length; i++) {
        var entry = batch[i];
        if (!entry || entry.cancelled) continue;
        live.delete(entry.id);
        var t0 = performance.now();
        try { entry.cb(ts); } catch (e) { /* 单个回调出错不影响整帧 */ }
        MET.rafMs += performance.now() - t0;
        MET.rafRuns++;
      }
      if (queue.length) schedule();
    }

    function schedule() {
      if (!nativeRAF || pending) return;
      if (cfg.hiddenPause && document.hidden) {
        // 浏览器本来就不在隐藏时送帧；跳过计数在注册那一侧按次累加，这里不重复算。
        return;
      }
      pending = true;
      var cap = effectiveCap();
      if (!cap) { nativeRAF(runFrame); return; }
      var waitMs = (1000 / cap) - (performance.now() - lastFrameTs);
      if (waitMs <= 2) { nativeRAF(runFrame); return; }
      MET.rafIdle++;   // 空闲降帧压住的一帧：这一轮的动画回调确实没跑
      window.setTimeout(function () { if (nativeRAF) nativeRAF(runFrame); }, waitMs);
    }

    // 从隐藏切回前台时必须重启队列：schedule() 在 document.hidden 时直接返回，
    // 若此刻队列里还压着回调，浏览器恢复出帧后没人再调 schedule()，回调链就永久停住
    //（表现就是「动画突然不动了」）。所以补一个恢复钩子 + 每秒看门狗兜底。
    function resumeFrames() {
      if (!nativeRAF || document.hidden) return;
      if (pending || !queue.length) return;
      schedule();
    }
    document.addEventListener('visibilitychange', resumeFrames);

    function startWatchdog() {
      if (window.__dpbWatchdog) return;
      window.__dpbWatchdog = true;
      window.__dpbWatchdogTimer = window.setInterval(function () {
        if (!nativeRAF || document.hidden || pending) return;
        if (queue.length) schedule();
      }, 1000);
    }

    // ————————————————— 后台暂停定时器 —————————————————
    // 页面不可见时，setInterval 的回调照样一秒一次被调用：插件普遍拿它轮询状态、
    // 走倒计时、刷角标，看不见的时候这些活纯属白烧 CPU。
    // 这里只做一件事：不可见就跳过回调本身（定时器不销毁、周期不重置），
    // 回到前台给每个「漏跳过」的定时器补跳一次，避免状态机原地卡住。
    var timerRecs = [];
    var nativeSetInterval = window.setInterval ? window.setInterval.bind(window) : null;
    var nativeClearInterval = window.clearInterval ? window.clearInterval.bind(window) : null;

    function installTimerPause() {
      if (!nativeSetInterval || window.__dpbTimers) return;
      if (!cfg.hiddenTimers) return;
      window.__dpbTimers = true;

      window.setInterval = function (fn, ms) {
        if (typeof fn !== 'function') return nativeSetInterval(fn, ms);
        var rec = { id: 0, fn: fn, skips: 0, self: this };
        var wrapped = function () {
          // 开关随时可关：每次回调都重新判断，关掉立刻恢复原始行为。
          if (cfg.hiddenTimers && document.hidden) { rec.skips++; MET.timerSkipped++; return undefined; }
          rec.skips = 0;
          var t0 = performance.now();
          try {
            return fn.apply(rec.self || window, arguments);
          } finally {
            MET.timerMs += performance.now() - t0;
            MET.timerRuns++;
          }
        };
        rec.id = nativeSetInterval(wrapped, ms);
        timerRecs.push(rec);
        if (timerRecs.length > 400) timerRecs.splice(0, timerRecs.length - 400);
        return rec.id;
      };

      window.clearInterval = function (id) {
        for (var i = 0; i < timerRecs.length; i++) {
          if (timerRecs[i].id === id) { timerRecs.splice(i, 1); break; }
        }
        return nativeClearInterval(id);
      };
    }

    function flushTimers() {
      if (document.hidden) return;
      for (var i = 0; i < timerRecs.length; i++) {
        var rec = timerRecs[i];
        if (!rec.skips) continue;
        rec.skips = 0;
        try { rec.fn.call(rec.self || window, performance.now()); } catch (e) { void e; }
      }
    }

    // 两个开关都关时完全不接管，帧调度与原生一致。
    function installRafThrottle() {
      if (!nativeRAF || window.__dpbRaf) return;
      if (!cfg.hiddenPause && !cfg.idleThrottle) return;
      window.__dpbRaf = true;
      startWatchdog();
      window.requestAnimationFrame = function (cb) {
        var id = nextId++;
        var entry = { id: id, cb: cb, cancelled: false };
        if (cfg.hiddenPause && document.hidden) {
          // 隐藏期间最多留 200 个待跑回调；再多说明有东西在定时器里狂注册 rAF，
          // 不设上限的话最小化一晚上能攒出几十万个闭包，回前台一次跑完直接卡死。
          MET.rafSkipped++;
          if (queue.length >= 200) {
            var dropped = queue.shift();
            if (dropped) live.delete(dropped.id);
          }
        }
        live.set(id, entry);
        queue.push(entry);
        schedule();
        return id;
      };
      window.cancelAnimationFrame = function (id) {
        var entry = live.get(id);
        if (entry) { entry.cancelled = true; live.delete(id); return; }
        try { nativeCAF(id); } catch (e) { void e; }
      };
    }

    function uninstallRafThrottle() {
      if (!window.__dpbRaf) return;
      window.__dpbRaf = false;
      if (window.__dpbWatchdogTimer) {
        window.clearInterval(window.__dpbWatchdogTimer);
        window.__dpbWatchdogTimer = null;
      }
      window.__dpbWatchdog = false;
      window.requestAnimationFrame = nativeRAF;
      window.cancelAnimationFrame = nativeCAF;
      queue = [];
      live.clear();
      pending = false;
    }

    // ————————————————— 长列表省渲染 —————————————————
    // 目标容器：先用 DSH 自己的结构（消息列表 .wSkVaW_viewArea / conversation.session 槽位），
    // 拿不到再退回启发式（可滚动、子项 >= 12）。每个容器按自己的实测平均高度写
    // contain-intrinsic-size，避免预留高度和真实高度不一致导致滚动条跳动。
    var PREFERRED = [
      '.wSkVaW_scrollBody',
      '.wSkVaW_viewArea',
      '[data-slot="conversation.session"]',
    ];
    var tagged = [];

    function isScrollable(el) {
      if (el.scrollHeight <= el.clientHeight + 40) return false;
      var cs;
      try { cs = window.getComputedStyle(el); } catch (e) { return false; }
      return cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay';
    }

    // 找出「消息列表」这个容器本身：从滚动区往下钻，取子项最多的一层。
    // 不同 DSH 版本层级不一样（scrollBody > viewArea > row > …），
    // 所以不写死某一路径，而是按结构找「谁直接挂着 24 个以上的兄弟」。
    function pickListIn(root) {
      if (!root) return null;
      var best = null, bestKids = 0;
      var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('div,ul,ol,section,main')));
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n.children) continue;
        var k = n.children.length;
        if (k < 24 || k <= bestKids) continue;
        best = n;
        bestKids = k;
      }
      return best;
    }

    function scrollRoots() {
      var out = [];
      var i, el;
      for (i = 0; i < PREFERRED.length; i++) {
        var found;
        try { found = document.querySelectorAll(PREFERRED[i]); } catch (e) { continue; }
        for (var j = 0; j < found.length; j++) {
          el = found[j];
          if (el && out.indexOf(el) < 0) out.push(el);
        }
      }
      if (!out.length) {
        // 兜底：可滚动且子项够多
        var all = document.querySelectorAll('div,ul,ol,section,main');
        for (i = 0; i < all.length; i++) {
          el = all[i];
          if (!el.children || el.children.length < 12) continue;
          if (!isScrollable(el)) continue;
          out.push(el);
          break;
        }
      }
      return out;
    }

    function collectTargets() {
      var roots = scrollRoots();
      var out = [];
      for (var i = 0; i < roots.length; i++) {
        var list = pickListIn(roots[i]);
        if (list && out.indexOf(list) < 0) out.push(list);
      }
      return out;
    }

    function avgChildHeight(el) {
      var n = Math.min(el.children.length, 30);
      var sum = 0, cnt = 0;
      for (var i = 0; i < n; i++) {
        var h = 0;
        try { h = el.children[i].getBoundingClientRect().height; } catch (e) { h = 0; }
        if (h > 0) { sum += h; cnt++; }
      }
      if (!cnt) return 220;
      return Math.max(48, Math.round(sum / cnt));
    }

    // 容器上挂 class，子项交给 CSS。
    // 逐项打 inline style 等于「每来一条消息就把整个列表摸一遍」，长会话里这笔开销
    // 比省下来的渲染还贵；改成一处分样式后，新消息天然被覆盖，JS 只负责找容器。
    function markContainer(el) {
      if (el.children.length < 24) return;
      try {
        if (!el.classList.contains(CV_CLASS)) el.classList.add(CV_CLASS);
        var h = avgChildHeight(el);
        if (el.style.getPropertyValue(CV_VAR) !== h + 'px') el.style.setProperty(CV_VAR, h + 'px');
      } catch (e) { void e; }
    }

    function unmark(el) {
      try {
        el.classList.remove(CV_CLASS);
        el.style.removeProperty(CV_VAR);
      } catch (e) { void e; }
    }

    function clearAll() {
      for (var i = 0; i < tagged.length; i++) unmark(tagged[i]);
      tagged = [];
    }

    function applyLazyList() {
      if (!cfg.lazyList) { clearAll(); return; }
      var targets = collectTargets();
      for (var i = tagged.length - 1; i >= 0; i--) {
        if (targets.indexOf(tagged[i]) < 0 || !document.contains(tagged[i])) {
          unmark(tagged[i]);
          tagged.splice(i, 1);
        }
      }
      for (var t = 0; t < targets.length; t++) {
        var el = targets[t];
        if (tagged.indexOf(el) < 0) tagged.push(el);
        try { markContainer(el); } catch (e) { void e; }
      }
      var n = 0;
      for (var m = 0; m < tagged.length; m++) n += Math.max(0, tagged[m].children.length - 4);
      MET.lazyItems = n;
    }

    // 给设置页用的一句话状态：开了没有、找到几个列表、跳过多少项。
    function lazyStatus() {
      if (!cfg.lazyList) return '已关闭。';
      var total = 0, lists = 0, kids = 0;
      for (var i = 0; i < tagged.length; i++) {
        if (!document.contains(tagged[i])) continue;
        lists++;
        total += Math.max(0, tagged[i].children.length - 4);
        kids += tagged[i].children.length;
      }
      if (!lists) {
        var targets = [];
        try { targets = collectTargets(); } catch (e) { targets = []; }
        if (!targets.length) return '开着，但当前页面没有够长的消息列表（聊天列表 ≥ 24 条才动手）。';
        kids = targets[0].children.length;
        return '开着，找到列表（' + kids + ' 项），不足 24 项或刚打开还没应用，滚一下即生效。';
      }
      if (!total) return '开着，列表 ' + kids + ' 项，暂时没有需要跳过的（末尾 4 项和正在生成的会保留）。';
      return '已生效：' + lists + ' 个列表，跳过 ' + total + ' 项渲染（共 ' + kids + ' 项）。';
    }

    // ————————————————— 扫描调度 —————————————————
    // 扫描要遍历 DOM，赶在首屏渲染或流式输出时跑就是跟用户抢帧。
    // 规则：只在空闲时跑；正在流式输出就往后推，最多推 6 次（约 9 秒）再硬跑。
    function isStreaming() {
      try { return !!document.querySelector('[aria-busy="true"],[data-streaming="true"]'); }
      catch (e) { return false; }
    }

    function idleRun(fn, delay, attempt) {
      var tries = attempt || 0;
      var run = function () {
        if (document.hidden) return;
        // 正在滚动 / 刚跑过长任务时别插队：这时候主线程本来就紧，再扫一遍只是雪上加霜。
        if (Date.now() - lastBusyAt < 250) {
          if (tries < 8) window.setTimeout(function () { idleRun(fn, delay, tries + 1); }, 400);
          return;
        }
        if (isStreaming() && tries < 6) {
          window.setTimeout(function () { idleRun(fn, delay, tries + 1); }, 1500);
          return;
        }
        try { fn(); } catch (e) { void e; }
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: (delay || 800) + 1200 });
      } else {
        window.setTimeout(run, delay || 800);
      }
    }

    // 只做「容器换没换」的巡检。子项由 CSS 自己跟上，所以不必盯整棵 DOM——
    // 盯子树会在流式输出时被每一条新消息唤醒，那笔开销反而比省下来的大。
    function watchLazyList() {
      if (window.__dpbWatcher) return;
      window.__dpbWatcher = true;
      window.setInterval(function () {
        if (document.hidden) return;
        if (!cfg.lazyList && !cfg.mediaLazy && !cfg.mediaPause) return;
        idleRun(function () {
          try { applyLazyList(); } catch (e) { void e; }
          try { applyMediaLazy(); } catch (e) { void e; }
          try { applyViewportMedia(); } catch (e) { void e; }
        }, 400);
      }, 2500);
    }

    // ————————————————— 媒体懒加载 —————————————————
    // 只补属性、不动结构：图片快进视口才解码，视频只取元数据。
    function clearMedia() {
      var list = document.querySelectorAll('[data-dpb-lazy]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        try {
          if (el.getAttribute('loading') === 'lazy') el.removeAttribute('loading');
          if (el.getAttribute('decoding') === 'async') el.removeAttribute('decoding');
          if (el.tagName === 'VIDEO' && el.getAttribute('preload') === 'metadata') el.removeAttribute('preload');
          el.removeAttribute('data-dpb-lazy');
        } catch (e) { void e; }
      }
    }

    function inViewport(el) {
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { return true; }
      if (!r) return true;
      var h = window.innerHeight || 0;
      var w = window.innerWidth || 0;
      return r.bottom > -400 && r.top < h + 400 && r.right > -400 && r.left < w + 400;
    }

    function applyMediaLazy() {
      if (!cfg.mediaLazy) { clearMedia(); return; }
      var list = document.querySelectorAll('img:not([data-dpb-lazy]),video:not([data-dpb-lazy]),iframe:not([data-dpb-lazy])');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        try {
          if (el.tagName === 'IMG') {
            if (!el.getAttribute('loading')) el.setAttribute('loading', 'lazy');
            if (!el.getAttribute('decoding')) el.setAttribute('decoding', 'async');
            if (!el.getAttribute('fetchpriority') && !inViewport(el)) el.setAttribute('fetchpriority', 'low');
          } else if (el.tagName === 'VIDEO') {
            if (!el.getAttribute('preload')) el.setAttribute('preload', 'metadata');
          } else if (!el.getAttribute('loading')) {
            el.setAttribute('loading', 'lazy');
          }
          el.setAttribute('data-dpb-lazy', '1');
          MET.mediaLazy++;
        } catch (e) { void e; }
      }
    }

    // ————————————————— 视口外暂停视频 —————————————————
    // 只在「静音」视频上动手：滚出视口暂停解码，滚回来自动续播。
    // 有声音的一律不碰（突然没声比掉帧更让人火）。
    var mediaObserver = null;
    var pausedByUs = null;

    function clearViewportMedia() {
      if (mediaObserver) {
        try { mediaObserver.disconnect(); } catch (e) { void e; }
        mediaObserver = null;
      }
      var vids = document.querySelectorAll('[data-dpb-vp]');
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        try {
          v.removeAttribute('data-dpb-vp');
          if (pausedByUs && pausedByUs.has(v)) {
            pausedByUs.delete(v);
            var p = v.play();
            if (p && p.catch) p.catch(function () {});
          }
        } catch (e) { void e; }
      }
    }

    function applyViewportMedia() {
      if (!cfg.mediaPause) { clearViewportMedia(); return; }
      if (typeof IntersectionObserver !== 'function' || typeof WeakSet !== 'function') return;
      if (!pausedByUs) pausedByUs = new WeakSet();
      var vids = document.querySelectorAll('video:not([data-dpb-vp])');
      if (!vids.length) return;
      if (!mediaObserver) {
        mediaObserver = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var en = entries[i];
            var v = en.target;
            try {
              if (en.isIntersecting) {
                if (pausedByUs.has(v)) {
                  pausedByUs.delete(v);
                  var p = v.play();
                  if (p && p.catch) p.catch(function () {});
                }
              } else if (!v.paused && (v.muted || v.volume === 0)) {
                pausedByUs.add(v);
                v.pause();
                MET.mediaPaused++;
              }
            } catch (e) { void e; }
          }
        }, { rootMargin: '240px' });
      }
      for (var k = 0; k < vids.length; k++) {
        vids[k].setAttribute('data-dpb-vp', '1');
        try { mediaObserver.observe(vids[k]); } catch (e) { void e; }
      }
    }

    // ————————————————— 会话列表节流 —————————————————
    // 流式输出时，会话列表经常「内容没变、只有 token 计数变了」也要整棵树重渲染。
    // 这里包一层 store.set：可见字段真变了立刻放行；只有投影身份变了就先攒着，
    // 最多每秒发一次。用户看不出差别，但重渲染次数从每秒几十次降到 1 次。
    var GATE_MS = 1000;
    var gate = null;

    function sameEntry(a, b) {
      if (a === b) return true;
      if (a === undefined || b === undefined) return false;
      var keys = {};
      var k;
      for (k in a) keys[k] = 1;
      for (k in b) keys[k] = 1;
      delete keys.projectionValues;      // 投影身份：侧栏并不显示，变了不算可见变化
      for (k in keys) { if (!Object.is(a[k], b[k])) return false; }
      return true;
    }

    function sameRecord(a, b) {
      if (a === b) return true;
      if (a === undefined || b === undefined) return false;
      var ka = Object.keys(a);
      var kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        var key = ka[i];
        if (!(key in b)) return false;
        if (!Object.is(a[key], b[key])) return false;
      }
      return true;
    }

    function sameVisible(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      if (!Object.is(a.current, b.current)) return false;
      if (!Object.is(a.phase, b.phase)) return false;
      if (!Object.is(a.currentAddress, b.currentAddress)) return false;
      var ai = a.ids || [];
      var bi = b.ids || [];
      if (ai.length !== bi.length) return false;
      for (var i = 0; i < ai.length; i++) { if (ai[i] !== bi[i]) return false; }
      var ab = a.byId || {};
      var bb = b.byId || {};
      var ak = Object.keys(ab);
      if (ak.length !== Object.keys(bb).length) return false;
      for (var j = 0; j < ak.length; j++) { if (!sameEntry(ab[ak[j]], bb[ak[j]])) return false; }
      return sameRecord(a.subagentsByParent, b.subagentsByParent) && sameRecord(a.jobsBySession, b.jobsBySession);
    }

    function installListGate(store) {
      if (!store || typeof store.set !== 'function' || typeof store.getSnapshot !== 'function') return null;
      if (store.__dpbGate) return store.__dpbGate;
      var originalSet = store.set.bind(store);
      var counts = { published: 0, coalesced: 0 };
      // 每次真正落地的发布都计时，合并掉的那次按平均发布耗时折算成「省下的毫秒」。
      function publish(next) {
        var t0 = performance.now();
        try { return originalSet(next); } finally {
          MET.setMs += performance.now() - t0;
          MET.setRuns++;
        }
      }
      var pending = null;
      var timer = null;

      function clearTimer() {
        if (timer) { window.clearTimeout(timer); timer = null; }
      }
      function flush() {
        clearTimer();
        if (pending === null) return;
        var next = pending;
        pending = null;
        counts.published++;
        publish(next);
      }
      var g = {
        counts: counts,
        set: function (next) {
          if (!cfg.listGate) { counts.published++; return publish(next); }
          var current = null;
          try { current = store.getSnapshot(); } catch (e) { current = null; }
          if (!sameVisible(current, next)) {
            pending = null;
            clearTimer();
            counts.published++;
            return publish(next);
          }
          pending = next;
          counts.coalesced++;
          MET.setMerged++;
          if (!timer) timer = window.setTimeout(flush, GATE_MS);
        },
        flush: flush,
        dispose: function () {
          flush();
          if (store.__dpbGate === g) {
            delete store.__dpbGate;
            try { store.set = originalSet; } catch (e) { void e; }
          }
        },
      };
      store.set = g.set;
      store.__dpbGate = g;
      try { window.__dpbGate = g; } catch (e) { void e; }  // 自检用：只放句柄，不放数据
      return g;
    }

    function safeService(name) {
      // 没注入就 get 会抛 "cannot get property without inject"，这里吞掉当没有。
      var ctx = window.__dpbCtx;
      if (!ctx || typeof ctx.get !== 'function') return null;
      try { return ctx.get(name); } catch (e) { return null; }
    }

    function applyListGate() {
      if (gate || !cfg.listGate) return;
      var sessions = safeService('sessions');
      var store = sessions && sessions.list ? sessions.list : null;
      if (!store) {
        // sessions 服务可能比插件晚注册：每秒再试一次，最多 10 次。
        var tries = (window.__dpbGateTries || 0) + 1;
        window.__dpbGateTries = tries;
        if (tries <= 10) {
          window.setTimeout(function () { try { applyListGate(); } catch (e) { void e; } }, 1000);
        }
        return;
      }
      window.__dpbGateTries = 0;
      gate = installListGate(store);
      if (gate) { try { console.log('[perf-boost] 会话列表节流已挂载'); } catch (e) { void e; } }
    }

    // ————————————————— 样式 —————————————————
    function cssText() {
      var out = [
        '.dpb-wrap{display:flex;flex-direction:column;gap:12px;padding:2px 0 28px}',
        '.dpb-card{border:1px solid color-mix(in oklab,currentColor 14%,transparent);border-radius:10px;padding:14px 16px}',
        '.dpb-card h3{margin:0 0 10px;font-size:13px;font-weight:600}',
        '.dpb-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid color-mix(in oklab,currentColor 8%,transparent)}',
        '.dpb-row:first-of-type{border-top:0;padding-top:0}',
        '.dpb-l{font-size:13px}',
        '.dpb-d{font-size:11.5px;opacity:.5;margin-top:3px;line-height:1.5;max-width:420px}',
        '.dpb-sw{position:relative;width:38px;height:21px;flex:0 0 38px;border-radius:999px;border:1px solid color-mix(in oklab,currentColor 32%,transparent);background:color-mix(in oklab,currentColor 12%,transparent);cursor:pointer;transition:background .15s}',
        '.dpb-sw[data-on="1"]{background:var(--dsw-accent,#4d6bfe);border-color:transparent}',
        '.dpb-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:color-mix(in oklab,currentColor 92%,transparent);transition:transform .15s;box-shadow:0 0 0 1px color-mix(in oklab,currentColor 10%,transparent)}',
        '.dpb-sw[data-on="1"] .dpb-knob{transform:translateX(17px);background:#fff}',
        '.dpb-quiet *, .dpb-quiet *::before, .dpb-quiet *::after{animation-play-state:paused!important}',
        // 子项：滚出视口就不渲染；末尾 4 项和正在生成的那条保持正常渲染。
        '.' + CV_CLASS + ' > *{content-visibility:auto;contain-intrinsic-size:auto var(' + CV_VAR + ',220px)}',
        '.' + CV_CLASS + ' > :nth-last-child(-n+4){content-visibility:visible}',
        '.' + CV_CLASS + ' > [aria-busy="true"]{content-visibility:visible}',
        // 大代码块单独跳过：一条消息里有几千行 pre 时，救的是这一条。
        '.' + CV_CLASS + ' pre{content-visibility:auto;contain-intrinsic-size:auto 300px;overflow-anchor:none}',
      '.dpb-notes{margin:12px 2px 0;font-size:12px;line-height:1.8;opacity:.78}',
      '.dpb-notes b{font-weight:600;opacity:1}',
      '.dpb-note{margin:10px 2px 0;font-size:12px;line-height:1.7;opacity:.72}',
      '.dpb-stat{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;opacity:.75}',
        '.dpb-stat b{font-weight:600;opacity:1}',
        '.dpb-score{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
        '.dpb-score-num{font:700 30px/1 ui-monospace,Consolas,monospace;color:var(--dsw-accent,#4d6bfe)}',
        '.dpb-score-title{font-size:13px;font-weight:600}',
        '.dpb-btn{font:inherit;font-size:12px;line-height:1;padding:7px 11px;border-radius:7px;border:1px solid color-mix(in oklab,currentColor 20%,transparent);background:transparent;color:inherit;cursor:pointer}',
        '.dpb-btn:hover{border-color:color-mix(in oklab,currentColor 45%,transparent)}',
        '#' + BADGE_ID + '{position:fixed;right:10px;bottom:10px;z-index:2147483000;font:600 12px/1 ui-monospace,Consolas,monospace;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#6fe3c4;pointer-events:none}',
      ];
      if (cfg.reduceMotion) {
        out.push('*,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;scroll-behavior:auto !important}');
      }
      if (cfg.noBlur) {
        out.push('*,*::before,*::after{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}');
      }
      return out.join('\n');
    }

    function applyStyle() {
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = cssText();
    }

    // ————————————————— 读数 —————————————————
    var lastFps = 0;

    function startBadge() {
      var el = document.getElementById(BADGE_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = BADGE_ID;
        document.body.appendChild(el);
      }
      el.style.display = cfg.showFps ? 'block' : 'none';
      if (window.__dpbBadge) return;
      window.__dpbBadge = true;
      var frames = 0, t0 = 0;
      var loop = function (ts) {
        frames++;
        if (!t0) t0 = ts;
        if (ts - t0 >= 1000) {
          lastFps = Math.round((frames * 1000) / (ts - t0));
          frames = 0;
          t0 = ts;
          var node = document.getElementById(BADGE_ID);
          if (node && cfg.showFps) node.textContent = lastFps + ' fps';
          notify();
        }
        window.requestAnimationFrame(loop);
      };
      window.requestAnimationFrame(loop);
    }

    // ————————————————— 设置页 —————————————————
    function Sw(props) {
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-label': props.label,
        className: 'dpb-sw', 'data-on': props.value ? '1' : '0',
        onClick: function () { props.onChange(!props.value); },
      }, React.createElement('span', { className: 'dpb-knob' }));
    }

    function Row(props) {
      return React.createElement('div', { className: 'dpb-row' },
        React.createElement('div', null,
          React.createElement('div', { className: 'dpb-l' }, props.label),
          props.hint ? React.createElement('div', { className: 'dpb-d' }, props.hint) : null),
        props.children);
    }

    function Panel() {
      // 自检用：数一下这个面板到底渲染了几次（正常应该是「打开 1 次 + 数字变化时才加」）。
      try { window.__dpbPanelRenders = (window.__dpbPanelRenders || 0) + 1; } catch (e) { void e; }
      var t = React.useState(0);
      var bump = t[1];
      React.useEffect(function () {
        // 打开设置页时才问一次版本，别在启动时和后台定时器里白花网络请求。
        if (update.state === 'idle') { try { checkUpdate(); } catch (e) { void e; } }
      }, []);
      React.useEffect(function () {
        // 只在「数字真的变了」时才重渲染：页面在后台不动，前台最长 5 秒看一眼。
        // 之前是每秒无条件 bump，设置页开着就等于每秒一次 React 重渲染，纯属自找开销。
        var last = '';
        var sig = function () {
          var g = window.__dpbGate ? window.__dpbGate.counts : null;
          return [
            metPercent(), Math.round(metSavedMs() / 100),
            MET.rafSkipped, MET.timerSkipped,
            g ? g.published : 0, g ? g.coalesced : 0,
            MET.lazyItems, MET.mediaLazy, MET.mediaPaused,
          ].join('|');
        };
        var tick = function () {
          if (document.hidden) return;
          snapNow();
          var now = metPercent();
          if (now !== null) saveLast(now, metSavedMs(), MET.rafMs + MET.timerMs + MET.setMs);
          var s = sig();
          if (s === last) return;
          last = s;
          bump(function (n) { return n + 1; });
        };
        last = sig();
        var off = subscribe(tick);
        var timer = window.setInterval(tick, 5000);
        return function () { off(); window.clearInterval(timer); };
      }, []);

      var warmup = React.useState(null);
      var warmupOn = warmup[0];
      var setWarmupOn = warmup[1];
      React.useEffect(function () {
        if (warmupOn !== null) return;
        warmupCall().then(function (v) { if (v !== null) setWarmupOn(v); });
      }, [warmupOn]);

      var live = metPercent();
      var saved = metSavedMs();
      var busy = MET.rafMs + MET.timerMs + MET.setMs;
      var cached = live === null ? (readLast() || remoteLast) : null;
      var pct = live !== null ? live : (cached ? cached.pct : null);


      return React.createElement('div', { className: 'dpb-wrap' },

        React.createElement('div', { className: 'dpb-card' },
          React.createElement('div', { className: 'dpb-score' },
            React.createElement('div', { className: 'dpb-score-num' }, pct === null ? '—' : (pct === 0 && saved < 1 ? '—' : '≈' + pct + '%')),
            React.createElement('div', null,
              React.createElement('div', { className: 'dpb-score-title' },
                '最近 1 分钟省下的主线程时间')))),

        React.createElement('div', { className: 'dpb-card' },
          React.createElement('h3', null, '开关'),
          React.createElement(Row, { label: '长对话省渲染', hint: lazyStatus() + ' 可能会导致被跳过的行滚进屏幕时空白一瞬，很快就补上。' },
            React.createElement(Sw, { label: '长对话省渲染', value: !!cfg.lazyList, onChange: function (v) { setCfg({ lazyList: v }); } })),
          React.createElement(Row, { label: '窗口隐藏不排帧', hint: '最小化或切走后不再送帧。可能会导致后台标签页里的动画停住，切回前台补一帧。默认开。' },
            React.createElement(Sw, { label: '窗口隐藏不排帧', value: !!cfg.hiddenPause, onChange: function (v) { setCfg({ hiddenPause: v }); } })),
          React.createElement(Row, { label: '空闲降帧', hint: '20 秒没操作把 JS 动画降到 30fps，CSS 动画不受影响。可能会导致看着觉得动画变慢，动一下鼠标立刻恢复。默认开。' },
            React.createElement(Sw, { label: '空闲降帧', value: !!cfg.idleThrottle, onChange: function (v) { setCfg({ idleThrottle: v }); } })),
          React.createElement(Row, { label: '媒体懒加载', hint: '图片快进视口才解码，视频只取元数据。可能会导致快速拖到很远处的图片先白一下再出来。默认开。' },
            React.createElement(Sw, { label: '媒体懒加载', value: !!cfg.mediaLazy, onChange: function (v) { setCfg({ mediaLazy: v }); } })),
          React.createElement(Row, { label: '后台暂停定时器', hint: '窗口不可见时，插件的每秒轮询全部跳过；回到前台补跳一次。可能会导致隐藏期间攒下的轮询只补一次，个别插件会看到一次跳变。默认开。' },
            React.createElement(Sw, { label: '后台暂停定时器', value: !!cfg.hiddenTimers, onChange: function (v) { setCfg({ hiddenTimers: v }); } })),
          React.createElement(Row, { label: '视口外暂停视频', hint: '静音视频滚出屏幕就暂停解码，滚回来继续播。可能会导致滚回来时黑一下或重新缓冲。有声音的不动。默认开。' },
            React.createElement(Sw, { label: '视口外暂停视频', value: !!cfg.mediaPause, onChange: function (v) { setCfg({ mediaPause: v }); } })),
          React.createElement(Row, { label: '会话列表节流', hint: '流式输出时列表只因 token 计数变化就整树重渲染；这里把它压到每秒一次，可见内容真变了立刻放行。可能会导致侧栏 token 数字最多晚 1 秒才跳。默认开。' },
            React.createElement(Sw, { label: '会话列表节流', value: !!cfg.listGate, onChange: function (v) { setCfg({ listGate: v }); } })),
          React.createElement(Row, { label: '大会话预热', hint: '启动 15 秒后在后台把最近 10 个 8MB 以上会话读进系统文件缓存。可能会导致读盘那几十秒里打开会话稍慢、磁盘占用高一点。' + (warmupOn === false ? '当前已关闭。' : '') },
            React.createElement(Sw, {
              label: '大会话预热',
              value: warmupOn !== false,
              onChange: function (v) {
                setWarmupOn(v);
                warmupCall(v).then(function (real) { if (real !== null) setWarmupOn(real); });
              },
            })),
          React.createElement(Row, { label: '关闭背景模糊', hint: '浮层从磨砂变纯色底，能看出来。默认关。' },
            React.createElement(Sw, { label: '关闭背景模糊', value: !!cfg.noBlur, onChange: function (v) { setCfg({ noBlur: v }); } })),
          React.createElement(Row, { label: '减少动画', hint: '关掉 CSS 动画和过渡，弹窗不再逐帧动。默认关。' },
            React.createElement(Sw, { label: '减少动画', value: !!cfg.reduceMotion, onChange: function (v) { setCfg({ reduceMotion: v }); } })),
          React.createElement(Row, { label: '帧率角标', hint: '右下角常驻一个 fps 小方块，看数据用。默认关。' },
            React.createElement(Sw, { label: '帧率角标', value: !!cfg.showFps, onChange: function (v) { setCfg({ showFps: v }); } })),
          ),

        React.createElement('div', { className: 'dpb-card' },
          React.createElement('div', { className: 'dpb-stat' },
            React.createElement('span', null, '版本 ', React.createElement('b', null, update.installed ? 'v' + update.installed : 'v' + VERSION)),
            React.createElement('span', null, '最新 ', React.createElement('b', null,
              update.state === 'checking' ? '检查中…'
                : update.available ? 'v' + update.latest
                  : update.latest ? '已是最新'
                    : update.state === 'unknown' ? (update.error === 'not-published' ? '未发布' : '未查到')
                      : update.state === 'failed' ? '未查到'
                        : '—')),
            React.createElement('button', {
              type: 'button', className: 'dpb-btn',
              onClick: function () { checkUpdate(); },
            }, update.state === 'checking' ? '检查中' : '检查更新')),
          React.createElement('div', { className: 'dpb-notes' },
            React.createElement('b', null, '更新详情'),
            RELEASE_NOTES[0].items.map(function (line, i) {
              return React.createElement('div', { key: 'n' + i }, line);
            }))));
    }

    // ————————————————— 装配 —————————————————
    function applyAll() {
      if (!cfg.hiddenPause && !cfg.idleThrottle) uninstallRafThrottle();
      else installRafThrottle();
      installTimerPause();
      applyStyle();
      // 首屏别抢：等空闲再扫，扫描期间若在流式输出会往后推。
      idleRun(function () {
        try { applyLazyList(); } catch (e) { void e; }
        try { applyMediaLazy(); } catch (e) { void e; }
        try { applyViewportMedia(); } catch (e) { void e; }
      }, 600);
      watchLazyList();
      if (cfg.showFps) startBadge();
      else {
        var el = document.getElementById(BADGE_ID);
        if (el) el.style.display = 'none';
      }
    }

    function applyHiddenClass() {
      var root = document.documentElement;
      if (!root) return;
      if (cfg.hiddenPause && document.hidden) root.classList.add('dpb-quiet');
      else root.classList.remove('dpb-quiet');
    }

    function mount() {
      applyAll();
      // 采样快照自己走：不依赖设置页开着，否则百分比只在打开设置后才更新。
      // 2 秒一条，只往 ring 里放三个数字，隐藏时被上面的定时器接管一起跳过。
      if (!window.__dpbSnapTimer) {
        snapNow();
        window.__dpbSnapTimer = window.setInterval(snapNow, 2000);
      }
      document.addEventListener('visibilitychange', flushTimers);
      document.addEventListener('visibilitychange', applyHiddenClass);
      applyHiddenClass();
      watchBusy();

      ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'].forEach(function (evt) {
        window.addEventListener(evt, markInput, { passive: true, capture: true });
      });

      var ctx = window.__dpbCtx;
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null;
      try { applyListGate(); } catch (e) { void e; }
      if (!slots || typeof slots.inject !== 'function') return;
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: NAME, order: 910, label: function () { return '性能优化'; } },
          function () { return React.createElement(Panel, null); },
        );
      });
    }

    exports.inject = ['slots', 'sessions'];
    exports.apply = function (ctx) {
      window.__dpbCtx = ctx;
      try { loadLastRun(); } catch (e) { void e; }
      try { window.__dpbMet = MET; window.__dpbMetSnapshot = function () { return { saved: metSavedMs(), busy: MET.rafMs + MET.timerMs + MET.setMs, pct: metPercent() }; }; } catch (e) { void e; }
      try { mount(); } catch (e) { try { console.warn('[dsh-perf-boost]', e); } catch (err) { void err; } }
    };

    return module.exports;
  },
});
