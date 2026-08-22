import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 900_000;

export type QuotaStatus = "ok" | "no-token" | "relogin" | "unavailable";

export interface QuotaBucket {
  provider: string; // adapter id: "anthropic" | "codex" | "cursor"
  kind: string; // session | weekly_all | weekly_scoped | credits | ...
  label: string;
  percent: number;
  resetsAt: string | null; // ISO-8601
  note?: string; // shown in place of the reset countdown (e.g. "$6.67 / $1,000" for credits)
}

export interface QuotaState {
  status: QuotaStatus; // reflects the primary (Anthropic) provider — drives tray + header
  buckets: QuotaBucket[]; // merged across all providers
  fetchedAt: number | null;
}

export const initialQuotaState: QuotaState = { status: "unavailable", buckets: [], fetchedAt: null };

// One quota source. `poll` is self-contained (its own auth, fetch, parse) so a
// provider can be added without touching the loop. retryAfterMs lets a provider
// ask for a longer backoff (e.g. HTTP 429); the loop honors the primary's hint.
export interface ProviderResult {
  status: QuotaStatus;
  buckets: QuotaBucket[];
  retryAfterMs?: number;
}
export interface QuotaProvider {
  id: string;
  label: string;
  poll(): Promise<ProviderResult>;
}

// ---- Anthropic (primary) ---------------------------------------------------

// Claude Code rotates the token, so re-read the file before every request; a
// read error just means "no token right now" (file may be mid-rewrite).
async function readToken(): Promise<string | null> {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const raw = await fs.readFile(path.join(dir, ".credentials.json"), "utf8");
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function fetchUsage(token: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.204",
    },
  });
}

function bucketLabel(limit: any): string {
  const model = limit?.scope?.model?.display_name;
  switch (limit?.kind) {
    case "session":
      return "Session";
    case "weekly_all":
      return "Weekly (all models)";
    case "weekly_scoped":
      return model ? `Weekly ${model}` : "Weekly";
    default:
      return model ? `${limit.kind} (${model})` : String(limit?.kind ?? "?");
  }
}

// "$6.67 / $1,000" from the spend block's minor-unit amounts.
function fmtUsd(amountMinor: number, exponent: number): string {
  return (amountMinor / 10 ** exponent).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Usage credits (spend beyond the plan). Only when the plan has them enabled.
export function creditsBucket(spend: any): QuotaBucket | null {
  if (!spend || spend.enabled !== true) return null;
  const u = spend.used;
  const l = spend.limit;
  const note =
    u && l ? `$${fmtUsd(u.amount_minor, u.exponent ?? 2)} / $${fmtUsd(l.amount_minor, l.exponent ?? 2)}` : undefined;
  return {
    provider: "anthropic",
    kind: "credits",
    label: "Usage credits",
    percent: typeof spend.percent === "number" ? spend.percent : 0,
    resetsAt: null,
    note,
  };
}

export function parseBuckets(body: any): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  if (Array.isArray(body?.limits) && body.limits.length > 0) {
    buckets.push(
      ...body.limits.map((l: any) => ({
        provider: "anthropic",
        kind: String(l?.kind ?? "?"),
        label: bucketLabel(l),
        percent: typeof l?.percent === "number" ? l.percent : 0,
        resetsAt: typeof l?.resets_at === "string" ? l.resets_at : null,
      })),
    );
  } else {
    // Legacy fallback: top-level buckets (older accounts without a limits array).
    const legacy: [string, string, string][] = [
      ["five_hour", "session", "Session"],
      ["seven_day", "weekly_all", "Weekly (all models)"],
    ];
    for (const [key, kind, label] of legacy) {
      const b = body?.[key];
      if (b && typeof b.utilization === "number") {
        buckets.push({ provider: "anthropic", kind, label, percent: b.utilization, resetsAt: b.resets_at ?? null });
      }
    }
  }
  const credits = creditsBucket(body?.spend);
  if (credits) buckets.push(credits);
  return buckets;
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",
  label: "Claude",
  async poll() {
    const token = await readToken();
    if (!token) return { status: "no-token", buckets: [] };
    let res = await fetchUsage(token);
    if (res.status === 401) {
      // Claude Code may have rotated the token since our read — retry once.
      const fresh = await readToken();
      if (fresh && fresh !== token) res = await fetchUsage(fresh);
      if (res.status === 401) return { status: "relogin", buckets: [] };
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
          : undefined;
      return { status: "unavailable", buckets: [], retryAfterMs };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "ok", buckets: parseBuckets(await res.json()) };
  },
};

// ---- Codex (OpenAI, ChatGPT-plan auth) -------------------------------------
// The Codex CLI stores its ChatGPT OAuth tokens in ~/.codex/auth.json and reads
// rate limits from the ChatGPT backend. We mirror that: read the access token +
// account id, call the usage endpoint, and map its two rate-limit windows into
// session/weekly buckets. API-key mode has no usage rollup, so it yields none.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

interface CodexAuth {
  accessToken: string;
  accountId: string | null;
}

async function readCodexAuth(): Promise<CodexAuth | null> {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const raw = await fs.readFile(path.join(dir, "auth.json"), "utf8");
    const j = JSON.parse(raw);
    const accessToken = j?.tokens?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;
    return { accessToken, accountId: j?.tokens?.account_id ?? null };
  } catch {
    return null;
  }
}

// Window role is derived from its duration, not the backend's primary/secondary
// naming (the two can swap). Reuse Anthropic's kinds so bucketName renders them
// the same way; `provider` keeps them distinct in the DOM.
function codexWindow(secs: number | undefined): { kind: string; label: string } {
  if (!secs) return { kind: "codex_window", label: "Limit" };
  if (secs <= 6 * 3600) return { kind: "session", label: "Session" };
  if (secs <= 36 * 3600) return { kind: "codex_daily", label: "Daily" };
  if (secs <= 8 * 86400) return { kind: "weekly_all", label: "Weekly" };
  if (secs <= 32 * 86400) return { kind: "codex_monthly", label: "Monthly" };
  return { kind: "codex_window", label: "Limit" };
}

// reset may arrive absolute (reset_at/resets_at, ISO) or relative (in seconds).
function codexReset(w: any): string | null {
  const at = w?.reset_at ?? w?.resets_at;
  if (typeof at === "string") return at;
  const inSecs = w?.resets_in_seconds ?? w?.reset_after_seconds ?? w?.resets_in;
  return typeof inSecs === "number" ? new Date(Date.now() + inSecs * 1000).toISOString() : null;
}

function codexBucket(w: any): QuotaBucket | null {
  if (!w) return null;
  const percent = w.used_percent ?? w.usedPercent ?? w.pct;
  if (typeof percent !== "number") return null;
  const { kind, label } = codexWindow(w.limit_window_seconds ?? w.window_secs);
  return { provider: "codex", kind, label, percent, resetsAt: codexReset(w) };
}

// Pure: map a usage response body's rate_limit into buckets. Exported for the
// self-check; poll() wraps it with auth + fetch.
export function parseCodexUsage(body: any): QuotaBucket[] {
  const rl = body?.rate_limit ?? {};
  return [codexBucket(rl.primary_window), codexBucket(rl.secondary_window)].filter(
    (b): b is QuotaBucket => b !== null,
  );
}

export const codexProvider: QuotaProvider = {
  id: "codex",
  label: "Codex",
  async poll() {
    const auth = await readCodexAuth();
    if (!auth) return { status: "no-token", buckets: [] };
    const res = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
    });
    if (res.status === 401) return { status: "relogin", buckets: [] };
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      return {
        status: "unavailable",
        buckets: [],
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
            : undefined,
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "ok", buckets: parseCodexUsage(await res.json()) };
  },
};

// ---- Cursor (stub) ---------------------------------------------------------
// Cursor's usage lives behind its team/admin API (request counts, usage-based
// billing), team-only and not a session/weekly percent — needs a token and a
// derived percent before it can produce buckets.
export const cursorProvider: QuotaProvider = {
  id: "cursor",
  label: "Cursor",
  async poll() {
    return { status: "unavailable", buckets: [] };
  },
};

// Secondary providers polled alongside Anthropic. Empty results are ignored, so
// an unconfigured provider is safe to leave here. Their status never flips the
// top-level status.
const EXTRA_PROVIDERS: QuotaProvider[] = [codexProvider];

export function startQuota(
  intervalMs: number,
  onState: (s: QuotaState) => void,
  primary: QuotaProvider = anthropicProvider,
  extras: QuotaProvider[] = EXTRA_PROVIDERS,
) {
  let state = initialQuotaState;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  let errors = 0;

  const emit = (patch: Partial<QuotaState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, ms);
  };

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      // Extras run in parallel and never throw the loop — a broken adapter just
      // contributes no buckets. Only the primary drives status/backoff.
      const extraBuckets = (
        await Promise.all(
          extras.map((p) => p.poll().then((r) => r.buckets).catch(() => [] as QuotaBucket[])),
        )
      ).flat();

      const r = await primary.poll();
      if (r.status !== "ok") {
        // Non-ok primary: back off on unavailable, plain reschedule otherwise.
        if (r.status === "unavailable") {
          errors++;
          const backoff = r.retryAfterMs ?? Math.min(intervalMs * 2 ** (errors - 1), MAX_BACKOFF_MS);
          emit({ status: r.status });
          schedule(Math.max(backoff, intervalMs));
        } else {
          emit({ status: r.status });
          schedule(intervalMs);
        }
        return;
      }
      errors = 0;
      emit({ status: "ok", buckets: [...r.buckets, ...extraBuckets], fetchedAt: Date.now() });
      schedule(intervalMs);
    } catch {
      errors++;
      emit({ status: "unavailable" });
      schedule(Math.min(intervalMs * 2 ** (errors - 1), MAX_BACKOFF_MS));
    } finally {
      polling = false;
    }
  }

  void poll();
  return {
    refreshNow() {
      if (!polling) void poll();
    },
    setIntervalMs(ms: number) {
      intervalMs = ms;
      if (!polling) schedule(ms);
    },
  };
}
