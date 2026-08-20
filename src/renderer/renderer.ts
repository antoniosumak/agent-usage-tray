interface QuotaBucket {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

interface QuotaState {
  status: "ok" | "no-token" | "relogin" | "unavailable";
  buckets: QuotaBucket[];
  fetchedAt: number | null;
}

interface Snapshot {
  quota: QuotaState;
}

declare global {
  interface Window {
    api: {
      onState(cb: (snapshot: Snapshot) => void): void;
      refresh(): void;
    };
  }
}

let snapshot: Snapshot | null = null;

function countdown(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets soon";
  const mins = Math.ceil(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function barColor(percent: number): string {
  return percent < 60 ? "bg-green-500" : percent < 85 ? "bg-yellow-500" : "bg-red-500";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusLine(text: string): string {
  return `<div class="text-neutral-500 dark:text-neutral-400">${text}</div>`;
}

function renderQuota(quota: QuotaState): string {
  if (quota.status === "no-token" || quota.status === "relogin") return statusLine("Sign in via Claude Code");
  if (quota.status === "unavailable" || quota.buckets.length === 0) return statusLine("Quota unavailable");
  return quota.buckets
    .map((b) => {
      const pct = Math.min(Math.max(b.percent, 0), 100);
      return `
        <div>
          <div class="flex justify-between mb-1">
            <span>${esc(b.label)}</span>
            <span class="text-neutral-500 dark:text-neutral-400">${pct}%</span>
          </div>
          <div class="h-2 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
            <div class="h-full rounded-full ${barColor(pct)}" style="width: ${pct}%"></div>
          </div>
          <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">${countdown(b.resetsAt)}</div>
        </div>`;
    })
    .join("");
}

function render(): void {
  if (!snapshot) return;
  document.getElementById("quota")!.innerHTML = renderQuota(snapshot.quota);
}

window.api.onState((s) => {
  snapshot = s;
  render();
});

// Keep countdowns fresh between polls.
setInterval(render, 60_000);

// Popup shown → ask main for a fresh poll.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) window.api.refresh();
});

export {};
