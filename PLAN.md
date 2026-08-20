# Agent Usage — Build Plan

Windows-only Electron tray app combining tokscale (cross-agent token/cost tracking) with
usage-monitor-for-claude's form factor (tray icon + popup with live Claude quota bars).

All decisions below were confirmed with the user via /grill-me on 2026-08-20. Do not re-ask them.

## Confirmed decisions

| Decision | Answer |
|---|---|
| Scope | Both: live Claude quotas AND cross-agent cost tracking |
| Platform | Windows-only (Win 10/11) |
| Stack | Electron + TypeScript; popup UI in vanilla HTML/TS (no React) styled with Tailwind CSS (v4, CLI build — no PostCSS config needed), esbuild or vite for bundling |
| Cost data | Shell out to `bunx tokscale` (fallback `npx tokscale`) — do NOT reimplement session-file parsing |
| Quota data | Reuse Claude Code OAuth token from `~/.claude/.credentials.json`, poll `api.anthropic.com` usage endpoint (same approach as usage-monitor-for-claude). Unofficial — must degrade gracefully |
| Tray icon | Dynamic: session-quota fill/ring, green→yellow→red |
| Popup | One screen, no tabs. Top: all quota bars API returns (session/weekly/per-model) with reset countdowns. Bottom: today's tokens + cost per agent (from tokscale) |
| Refresh | User-configurable interval, default 5 min, applies to both pipelines |
| Settings (v1) | refresh interval, launch at Windows startup, warning-threshold toast notification, agent selection (filter which agents shown) |
| Distribution | Portable unsigned .exe via electron-builder `portable` target, GitHub releases, in-app "update available" check against GitHub API (no auto-updater). ~80-100MB accepted |
| Name/repo | "Agent Usage", repo = C:\Projects\agent-usage (init git here; public GitHub later) |

## Accepted defaults (user saw these, didn't object)

- Warning threshold default: 80% of session quota → Windows toast
- "Today" = local midnight
- Theme follows system dark/light
- Config JSON in `%APPDATA%\agent-usage\settings.json`

## Architecture

```
main process (Electron)
├─ tray.ts        — Tray icon, dynamic icon rendering (canvas → nativeImage), click opens popup
├─ quota.ts       — reads ~/.claude/.credentials.json → OAuth token; polls Anthropic usage
│                   endpoint; handles 401 (token refreshed by Claude Code — re-read file),
│                   429 (honor retry-after, back off), malformed credentials (treat as
│                   "no token", don't crash)
├─ cost.ts        — spawn `bunx tokscale <json-flag>` on interval + on popup open;
│                   parse stdout; cache last good result; if bun AND npx missing → flag
│                   "runtime missing" state for popup hint
├─ settings.ts    — load/save %APPDATA%\agent-usage\settings.json; defaults:
│                   { refreshMinutes: 5, launchAtStartup: false, warnThresholdPct: 80,
│                     enabledAgents: null (= all) }
├─ notify.ts      — toast when session quota crosses threshold (fire once per window,
│                   reset when quota resets)
└─ updates.ts     — check GitHub releases API for newer tag on startup + daily
renderer (popup window)
└─ vanilla HTML/TS + Tailwind CSS — quota bars w/ countdown, cost table, settings section
   inline. Tailwind v4 via `@tailwindcss/cli` (input.css with `@import "tailwindcss"` →
   built output.css); dark mode via `prefers-color-scheme` (theme follows system)
IPC: main pushes state snapshots to renderer; renderer sends settings changes
```

Popup window: frameless, positioned near tray, hides on blur (standard tray-popup pattern).

## Facts still to verify at build time (do NOT assume)

1. **tokscale CLI JSON output**: exact flag (`--json`? `graph` export?), output schema,
   how per-agent + today's totals are represented. Run `bunx tokscale --help` first.
   Repo: https://github.com/junhoyeo/tokscale (Rust core + TS CLI, Bun runtime).
2. **Anthropic usage endpoint**: usage-monitor-for-claude (Python, source public at
   https://github.com/jens-duttke/usage-monitor-for-claude) shows the exact endpoint,
   request shape, and response fields (quota names like Session/Weekly/Opus, utilization,
   reset timestamps). Read their source instead of guessing.
3. **credentials.json shape on Windows**: `claudeAiOauth` object; check token + refresh
   behavior. Claude Code refreshes the token itself — app only ever reads, never writes.
4. tokscale runtime detection: check `bun` then `npx` on PATH via `where`.

## Build order

1. `npm init`, Electron + TS + esbuild scaffold, git init. Static tray icon + empty popup working.
2. Quota pipeline: credentials read → API poll → data model. Verify against real account.
3. Popup quota bars + countdowns; dynamic tray icon from session %.
4. Cost pipeline: tokscale spawn + parse → popup cost table.
5. Settings (file + UI section + launch-at-startup via `app.setLoginItemSettings`).
6. Threshold toast notification.
7. Update check.
8. electron-builder portable target; test exe on clean machine; GitHub repo + first release.

Each step ends runnable. Steps 1–4 are the core; 5–8 are polish/release.

## Risks / guardrails

- Unofficial API: quota section must show "unavailable" (never crash) if endpoint changes;
  cost section keeps working independently.
- Never transmit the OAuth token anywhere except api.anthropic.com. Never log it.
- Spawning tokscale every interval: 5 min default makes cost acceptable; also refresh on
  popup open. Serialize spawns (never two concurrent).
- Single-instance lock (`app.requestSingleInstanceLock`).
