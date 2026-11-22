# dsh-perf-boost

[English](./README.en.md) · [中文](./README.md)

Client-side rendering optimizations for the DeepSeek Harness Desktop app. All changes happen in the renderer process only.

Settings entry: **Settings → Performance**

## Update details

### 0.2.3

- Added "Background memory trimming": after the window has been hidden for more than 45 seconds, removes video sources to free buffers, clears resource timings, and stops observers; the settings page can trim immediately and shows the current JS heap usage.

### 0.2.2

- Reworked long-transcript rendering: a single class takes over child items, so new messages apply automatically
- Fixed: during streaming output the page was scanned on every message; it now runs an idle scan a few dozen times a minute

### 0.2.1

- Added the "Large-session warmup" toggle, which can be turned off right in settings
- Added light-mode colors so switches and dividers follow the text color
- Improved toggle descriptions so side effects consistently read "may cause…"
- Changed the percentage to a trailing 1-minute window, so it does not drift down the longer you use it
- Improved toggle ordering: enabled-by-default toggles come first, disabled ones last

### 0.2.0

- Added "Update details" in settings to show what changed in each version
- Added scroll yielding: lists are no longer scanned while scrolling; scanning resumes after you stop
- Added long-task yielding: after a stall longer than 50 ms the scan waits for the main thread to recover
- Added low-priority decoding for off-screen images, leaving bandwidth to visible ones
- Added pausing of CSS animations while the window is hidden, so the compositor stops spinning
- Fixed: large-session warmup no longer reads session files that are still being written
- Improved list observation scope: watches only the message list instead of the whole page
- Improved every toggle description to spell out possible side effects

## Toggles

Sorted by default state: the first six are on by default and have no visible effect on the UI.

| Toggle | Default | Affects visuals | What it does |
| --- | --- | --- | --- |
| Long-transcript rendering | On | No | Adds a class to scroll-list containers; a single CSS rule takes over `content-visibility: auto` for child items (new messages apply automatically, no per-item inline styles). Placeholder height comes from the list's measured average item height. The last 4 items and messages marked `aria-busy` stay fully rendered; code blocks get their own 300px skip. |
| Pause frames when hidden | On | No | `schedule()` returns early while the page is hidden; a `visibilitychange` hook restores on return, with a per-second watchdog as a fallback. |
| Reduce FPS when idle | On | No | After 20 seconds without input, rAF-driven animation drops to 30fps; any input restores it immediately. |
| Lazy-load media | On | No | Images get `loading=lazy` and `decoding=async`; videos get `preload=metadata`. |
| Pause timers in background | On | No | Skips `setInterval` callbacks while the page is hidden without destroying or resetting the interval; each catches up once on return. |
| Pause off-screen videos | On | No | Muted videos only: stops decoding when scrolled out of the viewport, resumes when scrolled back. |
| Throttle session list updates | On | No | During streaming, coalesces list publishes that only change the token count to once per second; visible content changes go through immediately. |
| Warm up large sessions | On (host side) | No | 15 seconds after startup, reads the 10 most recent sessions over 8MB into the OS file cache in chunks; read-only, skips sessions modified in the last 10 minutes. |
| Disable background blur | Off | Yes | Global `backdrop-filter: none`; frosted overlays become solid backgrounds. |
| Reduce motion | Off | Yes | Animation and transition durations are set to 0.001ms; dialogs no longer animate frame by frame. |
| FPS badge | Off | Yes | Shows `NN fps` in the bottom-right corner. |

Every toggle description names possible side effects; here they are in one place:

| Toggle | May cause |
| --- | --- |
| Long-transcript rendering | When scrolling fast, skipped rows may appear blank for a moment before filling in |
| Pause frames when hidden | Animations in background tabs freeze; one frame is rendered on return |
| Reduce FPS when idle | If left untouched for a long time, animation may look slower; moving the mouse restores it immediately |
| Lazy-load media | Images far down the page may flash blank before appearing if you scroll fast |
| Pause timers in background | Accumulated polls fire only once on return; some plugins may see a single jump |
| Pause off-screen videos | A brief black frame or a re-buffer on return |
| Throttle session list updates | The sidebar token count may update up to 1 second late |
| Warm up large sessions | On mechanical disks or low-end machines, opening sessions may be slightly slower during those few seconds, and disk usage rises |

No preset profiles are provided.

## Verification

- Below the "Long-transcript rendering" row: `Active: N list(s), skipping M items (K total)`
- Turn on "FPS badge" and a small fps box appears in the bottom-right corner
- In the console, `window.__dpbRaf` and `window.__dpbTimers` are `true`, meaning the rAF and timer take-over succeeded

The badge reads the browser's actual presented frames; the ceiling equals the display refresh rate. For frame times, DOM nodes, and other details, record with the DevTools Performance panel — the plugin does not sample continuously.

## Measurements

Windows desktop, 200Hz display, 100% scaling:

| Scenario | FPS | p50 frame time (DevTools) |
| --- | --- | --- |
| Blank page (Edge on the same machine) | 187–200 | 5.0 ms |
| DSH page (new session, DOM 1218) | 200 | 5.0 ms |
| DSH Desktop (23k-event session) | ~156 | ≈6.4 ms |

The page code itself can hit the refresh rate; the gap comes from long-session DOM volume and Electron window composition.

## Installation

```bash
pnpm add dsh-perf-boost
pnpm add github:AlLHHH/dsh-perf-boost
pnpm add file:./dsh-perf-boost
```

Add `dsh-perf-boost` to the profile's `dsh.profile.bundles` and restart the app; remove it from bundles and restart to uninstall.

## Implementation notes

- Modifies only the current renderer process: no host code changes, no config written to disk, no telemetry. Config lives in `localStorage['dsh-perf-boost:cfg']`.
- The only network request is "Check for updates": the page POSTs to `/api/dsh-perf-boost/update-check`, and the host queries npm's latest (CSP prevents cross-origin requests from the page). On failure it shows "Not found" and nothing else breaks.
- `requestAnimationFrame` is only taken over when "Pause frames when hidden" or "Reduce FPS when idle" is enabled; otherwise the native implementation is kept.

Large-session warmup can be disabled in the settings page, or in the plugin config with `warmup: false`.

## Language

The settings UI and this README are available in Chinese and English. The UI language follows `navigator.language` automatically: Chinese (`zh`) gets Chinese, everything else gets English. Update details follow the same rule.

## Known limitations

- The window's `transparent` / `vibrancy` is decided by the app itself (`lib/main.js` in `app.asar`); the Windows branch is opaque and the plugin cannot change it.
- Skipped rendering only reduces layout and painting; message nodes stay in memory, so scrolling cost in very long sessions remains.
- Lazy loading only changes attributes, not the DOM structure; already-loaded images are not reclaimed.

## Compatibility

- `engines.dsh >= 0.2.0-0`; tested on 0.2.1-rc.3 (desktop 0.2.1.0)
- peer `@deepseek-ai/cordis ^4.0.1`; tested 4.0.5
- Requires the client plugin API: `window.__ModuleLoader__.load`, `slots` (`settings.section`), `require('react')`

## License

MIT
