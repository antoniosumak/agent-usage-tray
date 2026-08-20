import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 900_000;

export interface QuotaBucket {
  kind: string; // session | weekly_all | weekly_scoped | ...
  label: string;
  percent: number;
  resetsAt: string | null; // ISO-8601
}

export interface QuotaState {
  status: "ok" | "no-token" | "relogin" | "unavailable";
  buckets: QuotaBucket[];
  fetchedAt: number | null;
}

export const initialQuotaState: QuotaState = { status: "unavailable", buckets: [], fetchedAt: null };

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
      return model ? `Weekly (${model})` : "Weekly";
    default:
      return model ? `${limit.kind} (${model})` : String(limit?.kind ?? "?");
  }
}

function parseBuckets(body: any): QuotaBucket[] {
  if (Array.isArray(body?.limits) && body.limits.length > 0) {
    return body.limits.map((l: any) => ({
      kind: String(l?.kind ?? "?"),
      label: bucketLabel(l),
      percent: typeof l?.percent === "number" ? l.percent : 0,
      resetsAt: typeof l?.resets_at === "string" ? l.resets_at : null,
    }));
  }
  // Legacy fallback: top-level buckets (older accounts without a limits array).
  const legacy: [string, string, string][] = [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly_all", "Weekly (all models)"],
  ];
  const buckets: QuotaBucket[] = [];
  for (const [key, kind, label] of legacy) {
    const b = body?.[key];
    if (b && typeof b.utilization === "number") {
      buckets.push({ kind, label, percent: b.utilization, resetsAt: b.resets_at ?? null });
    }
  }
  return buckets;
}

export function startQuota(intervalMs: number, onState: (s: QuotaState) => void) {
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
      const token = await readToken();
      if (!token) {
        emit({ status: "no-token" });
        schedule(intervalMs);
        return;
      }
      let res = await fetchUsage(token);
      if (res.status === 401) {
        // Claude Code may have rotated the token since our read — retry once.
        const fresh = await readToken();
        if (fresh && fresh !== token) res = await fetchUsage(fresh);
        if (res.status === 401) {
          emit({ status: "relogin" });
          schedule(intervalMs);
          return;
        }
      }
      if (res.status === 429) {
        errors++;
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
            : Math.min(intervalMs * 2 ** (errors - 1), MAX_BACKOFF_MS);
        emit({ status: "unavailable" });
        schedule(Math.max(backoff, intervalMs));
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      errors = 0;
      emit({ status: "ok", buckets: parseBuckets(body), fetchedAt: Date.now() });
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
  };
}
