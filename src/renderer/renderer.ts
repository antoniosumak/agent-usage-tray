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

interface AgentCost {
  client: string;
  tokens: number;
  cost: number;
}

interface CostState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  agents: AgentCost[];
  totalTokens: number;
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface Snapshot {
  quota: QuotaState;
  cost: CostState;
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

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function renderCost(cost: CostState): string {
  if (cost.status === "runtime-missing") return statusLine("Install Bun or Node.js to see agent costs");
  if (cost.status === "error" && !cost.fetchedAt)
    return statusLine(cost.refreshing ? "Loading costs…" : "Cost data unavailable");
  const header = `
    <div class="flex justify-between mb-2">
      <span class="font-semibold">Today</span>
      <span class="text-xs text-neutral-500 dark:text-neutral-400">${cost.refreshing ? "refreshing…" : ""}</span>
    </div>`;
  if (cost.status === "no-data") return header + statusLine("No usage today");
  const row = (label: string, tokens: number, usd: number, cls = "") => `
    <tr class="${cls}">
      <td class="py-0.5">${esc(label)}</td>
      <td class="py-0.5 text-right tabular-nums">${fmtTokens(tokens)}</td>
      <td class="py-0.5 text-right tabular-nums">$${usd.toFixed(2)}</td>
    </tr>`;
  return `${header}
    <table class="w-full">
      <thead>
        <tr class="text-xs text-neutral-500 dark:text-neutral-400">
          <th class="text-left font-normal">Agent</th>
          <th class="text-right font-normal">Tokens</th>
          <th class="text-right font-normal">Cost</th>
        </tr>
      </thead>
      <tbody>
        ${cost.agents.map((a) => row(a.client, a.tokens, a.cost)).join("")}
        ${row("Total", cost.totalTokens, cost.totalCost, "font-semibold border-t border-neutral-200 dark:border-neutral-700")}
      </tbody>
    </table>`;
}

function render(): void {
  if (!snapshot) return;
  document.getElementById("quota")!.innerHTML = renderQuota(snapshot.quota);
  document.getElementById("cost")!.innerHTML = renderCost(snapshot.cost);
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
