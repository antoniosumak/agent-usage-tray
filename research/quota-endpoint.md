# Anthropic OAuth Usage Endpoint — Implementation Reference

Source: `usage-monitor-for-claude` (github.com/jens-duttke/usage-monitor-for-claude, `usage_monitor_for_claude/api.py`, `claude_cli.py`, `cache.py`) plus a live verification request made 2026-08-20 from this machine (HTTP 200).

## Endpoints

| Purpose | Method | URL |
|---|---|---|
| Usage/quota | GET | `https://api.anthropic.com/api/oauth/usage` |
| Account profile | GET | `https://api.anthropic.com/api/oauth/profile` |

No query params, no request body.

## Required headers

```
Authorization: Bearer <accessToken from .credentials.json>
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/<installed CLI version>   (fallback: claude-code/2.1.204)
```

The reference app derives the User-Agent version from `claude --version`; a hardcoded recent version works.

## Credentials file

Path: `%CLAUDE_CONFIG_DIR%\.credentials.json`, defaulting to `~/.claude/.credentials.json`. Verified shape on this machine (values redacted):

```jsonc
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat…",        // string, ~108 chars, prefix sk-ant-oat
    "refreshToken": "sk-ant-ort…",       // string, ~108 chars, prefix sk-ant-ort
    "expiresAt": 1787266570027,           // unix epoch MILLISECONDS
    "refreshTokenExpiresAt": 1787630559027, // unix epoch ms
    "scopes": ["user:file_upload", "user:inference", "user:mcp_servers",
               "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "team",
    "rateLimitTier": "default_claude_max_5x"
  },
  "mcpOAuth": { /* per-MCP-server tokens — irrelevant, ignore */ }
}
```

Read only `claudeAiOauth.accessToken`. Treat read errors (file rewritten concurrently on token rotation / account switch) as "no token right now", not fatal — retry on next poll.

## Real response (live 200, 2026-08-20, Max 5x team account)

```json
{
  "five_hour":  { "utilization": 11.0, "resets_at": "2026-08-20T21:50:00.139263+00:00",
                  "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
  "seven_day":  { "utilization": 13.0, "resets_at": "2026-08-26T13:00:00.139283+00:00",
                  "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "seven_day_cowork": null,
  "seven_day_omelette": null,
  "tangelo": null, "iguana_necktie": null, "omelette_promotional": null,
  "nimbus_quill": { "utilization": 0.0, "resets_at": null, "limit_dollars": null,
                    "used_dollars": null, "remaining_dollars": null },
  "cinder_cove": null, "amber_ladder": null,
  "extra_usage": {
    "is_enabled": true, "monthly_limit": 100000, "used_credits": 667.0,
    "utilization": 0.667, "currency": "USD", "decimal_places": 2,
    "disabled_reason": null, "user_disabled": false,
    "spend_limit_reached": false, "credits_ever_enabled": true,
    "daily": null, "weekly": null
  },
  "limits": [
    { "kind": "session",       "group": "session", "percent": 11, "severity": "normal",
      "resets_at": "2026-08-20T21:50:00.139263+00:00", "scope": null, "is_active": false },
    { "kind": "weekly_all",    "group": "weekly",  "percent": 13, "severity": "normal",
      "resets_at": "2026-08-26T13:00:00.139283+00:00", "scope": null, "is_active": false },
    { "kind": "weekly_scoped", "group": "weekly",  "percent": 24, "severity": "normal",
      "resets_at": "2026-08-26T13:00:00.139494+00:00",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
      "is_active": true }
  ],
  "spend": {
    "used":  { "amount_minor": 667,    "currency": "USD", "exponent": 2 },
    "limit": { "amount_minor": 100000, "currency": "USD", "exponent": 2 },
    "percent": 1, "severity": "normal", "enabled": true, "disabled_reason": null,
    "cap": { "money": null, "credits": { "amount_minor": 100000, "exponent": 2 } },
    "balance": null, "auto_reload": null,
    "disclaimer": "Usage credits cover you when you hit your plan limits. [Learn more](...)",
    "can_purchase_credits": false, "can_toggle": false
  },
  "member_dashboard_available": false
}
```

### Schema notes

- **Quota bucket objects** (`five_hour`, `seven_day`, `seven_day_opus`, …): `{ utilization: float 0–100, resets_at: ISO-8601 string with offset | null, limit_dollars/used_dollars/remaining_dollars: null }`. Any of the top-level buckets can be `null` — always null-check.
- **Legacy vs. new**: per-model weekly quotas used to appear as top-level fields (`seven_day_opus`, `seven_day_sonnet`); on newer responses they are `null` and the data lives only in the `limits` array under `scope.model`. Codename fields (`tangelo`, `nimbus_quill`, `cinder_cove`, …) appear/disappear — don't hardcode; auto-detect any top-level dict with a `utilization` key.
- **`limits` array** is the modern, preferred source: `kind` (`session` | `weekly_all` | `weekly_scoped`), `group` (`session` | `weekly`), `percent` (int 0–100), `severity` (`normal` | presumably `warning`/`exceeded`), `resets_at` (ISO-8601), `scope` (`null` for account-wide; `{model: {id, display_name}, surface}` for model-scoped), `is_active` (bool — whether the window is currently running).
- The reference app merges scoped limits into synthetic top-level fields: it maps `group` → period prefix by matching the non-scoped limit's `resets_at` against an existing top-level bucket's `resets_at`, then creates `"{prefix}_{slug(display_name)}"` (e.g. `seven_day_fable`) with `{utilization: percent, resets_at}` — never overwriting a real top-level field.
- **`extra_usage` / `spend`**: pay-as-you-go overflow credits. `monthly_limit`/`used_credits` and `spend.*.amount_minor` are in minor currency units (`exponent: 2` → cents; 667 = $6.67 of $1000).
- **Profile endpoint** returns account/org info (email, display name, plan) — same headers.

## Token expiry & refresh

The app does **not** refresh the OAuth token itself (no use of `refreshToken`). Strategy:

1. On 401 (`auth_error`), re-read `.credentials.json` — Claude Code may have already rotated the token (any running Claude Code session refreshes it).
2. If the token is unchanged, run `claude update` as a subprocess (60 s timeout, `CREATE_NO_WINDOW` on Windows) — a side effect of the CLI running is that it renews the expired token in the credentials file. Then re-read the file.
3. If the token changed, retry the fetch once. If refresh failed or the token is unchanged, remember the failed token and don't hammer the API with it (surface "re-login needed" in UI).

`expiresAt` (epoch ms) can be checked proactively to skip a doomed request, but the file is the source of truth — re-read it before every request rather than caching the token.

## Error handling

| Status | Handling |
|---|---|
| 401 | Auth expired → refresh flow above; flag `auth_error` in UI |
| 429 | Parse `Retry-After` header (integer seconds); back off `max(retry_after, poll_interval)` capped at `MAX_BACKOFF` (900 s default). Without the header: exponential backoff `poll_interval * 2^(errors-1)`, same cap |
| 5xx | Generic server error, retry with backoff |
| Connection error | Generic, retry next poll |

Error bodies are JSON: `{"error": {"message": "..."}}` — the reference app strips the trailing "Please try again later." suffix before display.

## Polling defaults (reference app)

`poll_interval` 180 s normal, `poll_fast` 120 s (when a limit is near/active), `max_backoff` 900 s. Skips a poll when a quota reset is imminent so the reset is picked up live.
