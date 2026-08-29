import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 900_000;

export type QuotaStatus = "ok" | "no-token" | "relogin" | "unavailable";

export interface QuotaBucket {
  provider: string; // adapter id: "anthropic" | "codex" | "copilot" | "cursor" | "gemini"
  kind: string; // session | weekly_all | weekly_scoped | credits | monthly | ...
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
  let raw: string | null = null;
  try {
    raw = await fs.readFile(path.join(dir, ".credentials.json"), "utf8");
  } catch {
    // macOS Claude Code keeps the blob in Keychain (same JSON shape); first run
    // prompts once — "Always Allow". Missing item exits 44 → no token.
    if (process.platform === "darwin") raw = await readKeychain("Claude Code-credentials");
  }
  if (!raw) return null;
  try {
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function readKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("security", ["find-generic-password", "-s", service, "-w"], (err, out) => {
      resolve(err ? null : out.trim() || null);
    });
  });
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
    // Electron's net.fetch (Chromium stack), not global fetch: the ChatGPT
    // backend sits behind Cloudflare bot protection that 403s Node's undici TLS
    // fingerprint. Chromium passes, same as the real Codex CLI. Lazy require so
    // the unit tests can import the pure parse helpers without loading Electron.
    const { net } = require("electron") as typeof import("electron");
    const res = await net.fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        originator: "codex_cli_rs",
        "User-Agent": `codex_cli_rs/0.0.0 (${process.platform === "darwin" ? "Mac OS" : "Windows 11"}) x86_64`,
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

// ---- GitHub Copilot ---------------------------------------------------------
// Copilot plans meter "premium requests" per calendar month (Free also meters
// chat + completions). The internal user endpoint accepts any GitHub OAuth user
// token: the one copilot.vim/Neovim/JetBrains keep in github-copilot/apps.json,
// or the gh CLI login (VS Code keeps its token in secret storage, so gh is the
// practical path for VS Code users). Verified live with `gh auth token`.
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

async function readCopilotToken(): Promise<string | null> {
  const dir =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "github-copilot")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "github-copilot");
  for (const file of ["apps.json", "hosts.json"]) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
      // keys look like "github.com" or "github.com:Iv1.b507a08c87ecfe98"
      for (const [host, v] of Object.entries<any>(j ?? {})) {
        if (host.startsWith("github.com") && typeof v?.oauth_token === "string" && v.oauth_token) return v.oauth_token;
      }
    } catch {
      /* try next */
    }
  }
  return ghAuthToken();
}

// `gh auth token` prints the stored github.com token (keyring or hosts.yml); no gh → null.
function ghAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5000, windowsHide: true }, (err, out) => {
      const t = err ? "" : out.trim();
      resolve(/^gh[a-z]_\w+$/.test(t) ? t : null);
    });
  });
}

const COPILOT_LABEL: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

// Pure: quota_snapshots → one monthly bucket per metered snapshot. Skips
// unlimited ones and ones the plan doesn't include at all (Free reports
// premium_interactions with has_quota:false, entitlement:0).
export function parseCopilotUser(body: any): QuotaBucket[] {
  const snaps = body?.quota_snapshots;
  if (!snaps || typeof snaps !== "object") return [];
  const resetsAt =
    typeof body?.quota_reset_date_utc === "string"
      ? body.quota_reset_date_utc
      : typeof body?.quota_reset_date === "string"
        ? new Date(`${body.quota_reset_date}T00:00:00Z`).toISOString()
        : null;
  const out: QuotaBucket[] = [];
  // premium first: that's the number people watch
  const order = ["premium_interactions", ...Object.keys(snaps).filter((k) => k !== "premium_interactions")];
  for (const key of order) {
    const q = snaps[key];
    if (!q || q.unlimited === true || q.has_quota === false) continue;
    const ent = Number(q.entitlement);
    if (Number.isFinite(ent) && ent <= 0) continue;
    const rem = Number(q.remaining);
    let percent: number | null = null;
    if (typeof q.percent_remaining === "number") percent = 100 - q.percent_remaining;
    else if (Number.isFinite(ent) && ent > 0 && Number.isFinite(rem)) percent = ((ent - rem) / ent) * 100;
    if (percent === null) continue;
    const note =
      Number.isFinite(ent) && Number.isFinite(rem)
        ? `${Math.max(0, ent - rem).toLocaleString("en-US")} / ${ent.toLocaleString("en-US")}`
        : undefined;
    out.push({ provider: "copilot", kind: "monthly", label: COPILOT_LABEL[key] ?? key, percent: Math.max(0, percent), resetsAt, note });
  }
  return out;
}

export const copilotProvider: QuotaProvider = {
  id: "copilot",
  label: "Copilot",
  async poll() {
    const token = await readCopilotToken();
    if (!token) return { status: "no-token", buckets: [] };
    const res = await fetch(COPILOT_USER_URL, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.104.0",
        "Editor-Plugin-Version": "copilot-chat/0.31.0",
        "User-Agent": "GitHubCopilotChat/0.31.0",
      },
    });
    if (res.status === 401) return { status: "relogin", buckets: [] };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "ok", buckets: parseCopilotUser(await res.json()) };
  },
};

// ---- Cursor -----------------------------------------------------------------
// Cursor keeps its WorkOS session JWT in the editor's SQLite state DB. The
// dashboard reads plan usage from cursor.com with that JWT as a cookie:
// usage-summary (current plans: included $ per billing cycle) and the older
// per-model request counters (legacy 500-request plans).
const CURSOR_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_USAGE_URL = "https://cursor.com/api/usage";

function cursorDbPath(): string {
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

// ponytail: regex over the raw SQLite file instead of a SQLite driver. The row
// is "cursorAuth/accessToken" immediately followed by the JWT text; take the
// one that expires last (stale copies linger in freed pages). Swap for sql.js
// if Cursor ever compresses/encrypts the store.
export function extractCursorJwt(raw: string): { jwt: string; sub: string; exp: number } | null {
  let best: { jwt: string; sub: string; exp: number } | null = null;
  for (const m of raw.matchAll(/cursorAuth\/accessToken(eyJ[\w-]+\.([\w-]+)\.[\w-]+)/g)) {
    try {
      const p = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8"));
      if (typeof p?.sub !== "string" || typeof p?.exp !== "number") continue;
      if (!best || p.exp > best.exp) best = { jwt: m[1], sub: p.sub, exp: p.exp };
    } catch {
      /* not a JWT */
    }
  }
  return best;
}

async function readCursorAuth(): Promise<{ jwt: string; userId: string } | null> {
  let raw: string;
  try {
    raw = (await fs.readFile(cursorDbPath())).toString("latin1");
  } catch {
    return null;
  }
  const t = extractCursorJwt(raw);
  if (!t || t.exp * 1000 < Date.now()) return null; // expired: Cursor mints a new one when it next runs
  return { jwt: t.jwt, userId: t.sub.split("|").pop() ?? t.sub };
}

function plusOneMonth(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

// Pure: usage-summary → "Included usage" ($ used of plan $ this cycle) plus
// on-demand spend when a limit is set. Amounts arrive in cents.
export function parseCursorSummary(body: any): QuotaBucket[] {
  const out: QuotaBucket[] = [];
  const resetsAt = typeof body?.billingCycleEnd === "string" ? body.billingCycleEnd : null;
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const push = (label: string, u: any) => {
    const used = Number(u?.used);
    const limit = Number(u?.limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return;
    out.push({ provider: "cursor", kind: "monthly", label, percent: (used / limit) * 100, resetsAt, note: `${usd(used)} / ${usd(limit)}` });
  };
  push("Included usage", body?.individualUsage?.plan);
  push("On-demand", body?.individualUsage?.onDemand);
  return out;
}

// Pure: legacy per-model counters → one "Requests" bucket from the metered model.
export function parseCursorUsage(body: any): QuotaBucket[] {
  const m = body?.["gpt-4"];
  const used = Number(m?.numRequestsTotal ?? m?.numRequests);
  const max = Number(m?.maxRequestUsage);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return [];
  const start = typeof body?.startOfMonth === "string" ? body.startOfMonth : null;
  return [
    {
      provider: "cursor",
      kind: "monthly",
      label: "Requests",
      percent: (used / max) * 100,
      resetsAt: start ? plusOneMonth(start) : null,
      note: `${used.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`,
    },
  ];
}

export const cursorProvider: QuotaProvider = {
  id: "cursor",
  label: "Cursor",
  async poll() {
    const auth = await readCursorAuth();
    if (!auth) return { status: "no-token", buckets: [] };
    // Chromium fetch: cursor.com sits behind the same Cloudflare bot check as ChatGPT.
    const { net } = require("electron") as typeof import("electron");
    const headers = {
      Cookie: `WorkosCursorSessionToken=${auth.userId}%3A%3A${auth.jwt}`,
      "Content-Type": "application/json",
      Origin: "https://cursor.com",
      Referer: "https://cursor.com/dashboard?tab=usage",
    };
    const sum = await net.fetch(CURSOR_SUMMARY_URL, { headers });
    if (sum.status === 401 || sum.status === 403) return { status: "relogin", buckets: [] };
    if (sum.ok) {
      const buckets = parseCursorSummary(await sum.json());
      if (buckets.length) return { status: "ok", buckets };
    }
    const res = await net.fetch(`${CURSOR_USAGE_URL}?user=${encodeURIComponent(auth.userId)}`, { headers });
    if (res.status === 401 || res.status === 403) return { status: "relogin", buckets: [] };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "ok", buckets: parseCursorUsage(await res.json()) };
  },
};

// ---- Gemini CLI (Google account / Code Assist) ------------------------------
// Gemini CLI meters requests per user per day (1000 free / 1500 Pro / 2000
// Ultra), aggregated across models; the Code Assist backend reports it per
// model as remainingFraction + resetTime. Auth is the CLI's own OAuth blob in
// ~/.gemini/oauth_creds.json. Access tokens live 1h, so refresh with the
// installed-app client (public by design, same constants gemini-cli ships).
// API-key / Vertex modes have no quota rollup and yield nothing here.
const GEMINI_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET = "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";

async function readGeminiToken(): Promise<string | null> {
  const dir = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), ".gemini");
  let j: any;
  try {
    j = JSON.parse(await fs.readFile(path.join(dir, "oauth_creds.json"), "utf8"));
  } catch {
    return null;
  }
  const fresh = typeof j?.expiry_date === "number" && j.expiry_date > Date.now() + 60_000;
  if (fresh && typeof j.access_token === "string" && j.access_token) return j.access_token;
  if (typeof j?.refresh_token !== "string" || !j.refresh_token) return null;
  // ponytail: refreshed token is not written back; gemini-cli re-mints its own on next run.
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: j.refresh_token,
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json())?.access_token;
  return typeof t === "string" && t ? t : null;
}

// Project id the quota is scoped to. Cached for the process: it never changes
// for a signed-in account, and loadCodeAssist is the slow half of the poll.
let geminiProject: string | null = null;
async function geminiProjectId(token: string): Promise<string | null> {
  if (geminiProject) return geminiProject;
  if (process.env.GOOGLE_CLOUD_PROJECT) return (geminiProject = process.env.GOOGLE_CLOUD_PROJECT);
  const res = await fetch(`${GEMINI_BASE}:loadCodeAssist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = (await res.json())?.cloudaicompanionProject;
  return (geminiProject = typeof p === "string" && p ? p : null);
}

function geminiModelName(id: string): string {
  if (/flash-lite/i.test(id)) return "Flash-Lite";
  if (/flash/i.test(id)) return "Flash";
  if (/pro/i.test(id)) return "Pro";
  return id;
}

// Pure: one bucket per model (worst of its token types), worst-first so the
// widget's two rows show what will actually block you. Buckets without a
// fraction carry no signal and are dropped.
export function parseGeminiQuota(body: any): QuotaBucket[] {
  const byModel = new Map<string, QuotaBucket>();
  for (const b of body?.buckets ?? []) {
    if (typeof b?.remainingFraction !== "number") continue;
    const model = typeof b.modelId === "string" && b.modelId ? b.modelId : "gemini";
    const percent = Math.min(100, Math.max(0, (1 - b.remainingFraction) * 100));
    const prev = byModel.get(model);
    if (prev && prev.percent >= percent) continue;
    byModel.set(model, {
      provider: "gemini",
      kind: "gemini_daily",
      label: `Daily · ${geminiModelName(model)}`,
      percent,
      resetsAt: typeof b.resetTime === "string" ? b.resetTime : null,
    });
  }
  return [...byModel.values()].sort((a, b) => b.percent - a.percent);
}

export const geminiProvider: QuotaProvider = {
  id: "gemini",
  label: "Gemini",
  async poll() {
    const token = await readGeminiToken();
    if (!token) return { status: "no-token", buckets: [] };
    const project = await geminiProjectId(token);
    const res = await fetch(`${GEMINI_BASE}:retrieveUserQuota`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(project ? { project } : {}),
    });
    // 403 = deprecated consumer tier (June 2026 shutdown) or wrong project; same fix: log in again.
    if (res.status === 401 || res.status === 403) return { status: "relogin", buckets: [] };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "ok", buckets: parseGeminiQuota(await res.json()) };
  },
};

// Secondary providers polled alongside Anthropic. Empty results are ignored, so
// an unconfigured provider is safe to leave here. Their status never flips the
// top-level status.
const EXTRA_PROVIDERS: QuotaProvider[] = [codexProvider, copilotProvider, cursorProvider, geminiProvider];

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
        // Extras still show: a Copilot/Cursor user without Claude Code sees their quota.
        if (r.status === "unavailable") {
          errors++;
          const backoff = r.retryAfterMs ?? Math.min(intervalMs * 2 ** (errors - 1), MAX_BACKOFF_MS);
          emit({ status: r.status, buckets: extraBuckets });
          schedule(Math.max(backoff, intervalMs));
        } else {
          emit({ status: r.status, buckets: extraBuckets, fetchedAt: extraBuckets.length ? Date.now() : state.fetchedAt });
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
