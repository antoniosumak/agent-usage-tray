# tokscale CLI — research findings (2026-08-20, tokscale 4.13.0)

Verified live on this machine (Windows 11, real Claude Code + Codex data). Repo: https://github.com/junhoyeo/tokscale

## Runtimes

- `bun` at `C:\Users\AntonioŠumak\.bun\bin\bun.exe` — present.
- `npx` at `C:\Program Files\Volta\npx.cmd` (also `C:\Program Files\nodejs\npx.cmd`) — present.
- Both `bunx tokscale` and `npx -y tokscale` work. After first-run package install, warm invocations take **~0.7–1.4 s**. Very first `bunx tokscale` run downloads ~28 packages (took a few seconds); budget a longer timeout (60 s+) for the first spawn.
- Detection: `where bun` then `where npx` (in Node: `spawn("where", ["bun"])` or check well-known paths).

## Recommended command (today's per-agent usage)

```
bunx tokscale --json --today --no-spinner
```

Fallback: `npx -y tokscale --json --today --no-spinner` (`-y` avoids npx install prompt).

- Exit code **0** on success (including when there's no data — returns empty `entries` array, zero totals).
- Exit code **1** on bad arguments; error message goes to **stderr** (`Error: ...`).
- JSON goes to **stdout**, clean (no ANSI, pretty-printed, 2-space indent). Nothing on stderr on success. No TTY needed. Always pass `--no-spinner` (help text says it exists "for AI agents and scripts").
- Runtime with real data: **< 1 s** warm (`processingTimeMs` ~350 in output). Spawn timeout of 30 s is generous.
- On Windows spawn via Node: `spawn("bunx", ["tokscale", ...], { shell: true })` or resolve the full path to `bun.exe` and run `bun x tokscale ...`; `bunx`/`npx` are `.cmd`/shim files so `shell: true` (or spawning the `.exe` directly) is required.

## Real output schema — `--json --today` (default `--group-by client,model`)

```json
{
  "groupBy": "client,model",
  "entries": [
    {
      "client": "claude",
      "mergedClients": null,
      "model": "claude-fable-5",
      "provider": "anthropic",
      "input": 572,
      "output": 150366,
      "cacheRead": 23983778,
      "cacheWrite": 1087653,
      "reasoning": 0,
      "messageCount": 286,
      "cost": 45.10346049999998,
      "performance": {
        "msPer1KTokens": 122.55,
        "totalDurationMs": 3090955,
        "timedTokens": 25222369,
        "sampleCount": 286,
        "tokenCoverage": 1.0
      }
    }
  ],
  "totalInput": 770,
  "totalOutput": 205341,
  "totalCacheRead": 29628577,
  "totalCacheWrite": 1570364,
  "totalMessages": 385,
  "totalCost": 52.318168749999984,
  "processingTimeMs": 352
}
```

Parsing notes:

- One entry per **(client, model)** pair. There is **no client-only grouping** (valid `--group-by` values: `model`, `client,model`, `client,provider,model`, `workspace,model`, `session,model`, `client,session,model`). The app must **sum entries by `client`** to get per-agent totals.
- `client` values (the "agent"): `claude`, `codex`, `gemini`, `cursor`, `opencode`, `copilot`, `cline`, `amp`, `droid`, `zed`, `kiro`, `trae`, `warp`, ... (49 possible values; see `--help`). On this machine real data shows `claude` and `codex`.
- Token fields are separate: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`. "Total tokens" for display = sum of all five (that's what `graph`'s `totals.tokens` does).
- `cost` is USD float (unrounded — format for display).
- Empty range → `entries: []`, totals 0, exit 0. Treat as "no usage today", not an error.

## Date filtering / "today"

- `--today` exists — **no client-side date filtering needed**. Also `--yesterday`, `--week`, `--month`, `--since YYYY-MM-DD`, `--until YYYY-MM-DD`, `--year YYYY`.
- "Today" = **local** calendar day: `--today` output matched the `2026-08-20` bucket in `graph` output while local time was 2026-08-20 evening (22:06 CEST = 20:06 UTC). Matches the plan's "today = local midnight" decision.
- `-c/--client claude,codex` filters by client if the app ever wants server-side filtering for the agent-selection setting (simpler to filter in app).

## Alternative: `tokscale graph` (per-day history)

`bunx tokscale graph --week --no-spinner` emits JSON to stdout (no `--json` flag needed; graph is always JSON). Structure:

```json
{
  "meta": { "generatedAt": "2026-08-20T20:06:51Z", "version": "4.13.0",
            "dateRange": { "start": "2026-08-14", "end": "2026-08-20" } },
  "summary": { "totalTokens": 405534120, "totalCost": 615.35, "totalDays": 7,
               "activeDays": 7, "averagePerDay": 87.9, "maxCostInSingleDay": 204.2,
               "clients": ["claude", "codex"],
               "models": ["claude-fable-5", "claude-haiku-4-5", "claude-opus-5", "gpt-5.6-sol"] },
  "years": [ { "year": "2026", "totalTokens": 405534120, "totalCost": 615.35,
               "range": { "start": "2026-08-14", "end": "2026-08-20" } } ],
  "contributions": [
    {
      "date": "2026-08-20",
      "totals": { "tokens": 31770384, "cost": 53.06, "messages": 393 },
      "intensity": 2,
      "tokenBreakdown": { "input": 786, "output": 208957, "cacheRead": 29972830,
                          "cacheWrite": 1587811, "reasoning": 0 },
      "clients": [
        { "client": "claude", "modelId": "claude-fable-5", "providerId": "anthropic",
          "tokens": { "input": 588, "output": 153982, "cacheRead": 24328031,
                      "cacheWrite": 1105100, "reasoning": 0 },
          "cost": 45.85, "messages": 294 }
      ],
      "activeTimeMs": 6647435
    }
  ],
  "timeMetrics": { "totalActiveTimeMs": 72899328, "longestContinuousMs": 6909345,
                   "maxConcurrentSessions": 2, "sessionCount": 160 },
  "mcpServers": ["ado-bozic", "ado-brisk", "pencil"]
}
```

- `contributions[].date` is a local calendar day (`YYYY-MM-DD`); each day has per-(client, model) breakdown under `clients` (note field names differ from the main report: `modelId`/`providerId`, tokens nested under `tokens`).
- `meta.generatedAt` is UTC RFC3339. `graph` supports `--output <file>` to write to a file instead of stdout.
- Use `graph` only if the app later adds history/sparklines; for v1 the main `--json --today` report is simpler.

## Other relevant subcommands / flags (not needed for v1)

- `models --json`, `monthly --json`, `hourly --json` — other report groupings.
- `usage` — subscription quota per AI provider (overlaps with our quota pipeline; untested, likely needs provider login).
- `--home <PATH>` — read session data from an alternate home dir (useful for tests with fixture data).
- `--benchmark`, `--hide-zero`, `--light` — display-oriented, ignore.

## Quirks / edge cases

1. **First-run install delay**: `bunx` resolves and downloads the package on first use (and after cache eviction / version bumps). Use a generous timeout (60 s) and surface a "loading" state rather than an error on the first slow run.
2. `bunx`/`npx` on Windows are shims — spawn with `{ shell: true }` or resolve absolute path.
3. Costs/averages are unrounded floats; round for display.
4. `entries` order is not guaranteed sorted (observed insertion-ish order); sort in app.
5. Between two invocations seconds apart, today's numbers grow (live session files are re-scanned each run) — expected, not a parsing problem.
6. tokscale has cloud/social features (`login`, `submit`, `autosubmit`) — all local report commands work **without any login**; never invoke the network-facing subcommands.
7. Version pinning: consider `bunx tokscale@4` (or exact `4.13.0`) to protect the parser from breaking schema changes; unpinned bunx will pick up new majors automatically.
