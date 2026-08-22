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

interface ModelCost {
  model: string;
  tokens: number;
  cost: number;
}

interface CostState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  agents: AgentCost[];
  models: ModelCost[];
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface ToolCost {
  name: string;
  calls: number;
  cost: number;
}

interface ToolState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  tools: ToolCost[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface HeatmapState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  hours: number[];
  totalTokens: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface ProjectCost {
  name: string;
  cost: number;
  tokens: number;
}

interface ProjectState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  projects: ProjectCost[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface Block {
  start: number;
  cost: number;
  tokens: number;
  active: boolean;
}

interface BlockState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  blocks: Block[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface BurnState {
  status: "ok" | "idle" | "runtime-missing" | "error";
  tokensPerMin: number;
  dollarsPerHour: number;
  etaMinutes: number | null;
  refreshing: boolean;
  fetchedAt: number | null;
}

interface Settings {
  refreshMinutes: number;
  launchAtStartup: boolean;
  warnThresholdPct: number;
  enabledAgents: string[] | null;
}

type Range = "today" | "7d" | "30d";

interface Snapshot {
  quota: QuotaState;
  cost: CostState;
  tools: ToolState;
  heatmap: HeatmapState;
  projects: ProjectState;
  blocks: BlockState;
  burn: BurnState;
  settings: Settings;
  update: { version: string; status: "downloading" | "downloaded"; percent?: number } | null;
  range: Range;
}

declare global {
  interface Window {
    api: {
      onState(cb: (snapshot: Snapshot) => void): void;
      refresh(): void;
      setRange(range: Range): void;
      setSettings(patch: Partial<Settings>): void;
      openUpdate(): void;
    };
  }
}

let snapshot: Snapshot | null = null;

const MUTED = "text-[#6f6f6f] dark:text-neutral-400";
const LABEL = "text-xs font-semibold text-[#616161] dark:text-neutral-400";

// Compact reset countdown: largest unit only ("2h", "4d", "35m").
function countdown(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor(mins / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${mins}m`;
}

function bucketName(b: QuotaBucket): string {
  return b.kind === "session" ? "Session" : b.kind === "weekly_all" ? "Weekly" : b.label;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const BAR_BLUE = "bg-[#005bd3] dark:bg-blue-500";
const QUOTA_FILL = `h-full rounded-full ${BAR_BLUE} transition-[width] duration-300 ease-out`;
const COST_FILL = `h-full rounded-full ${BAR_BLUE} transition-[width] duration-300 ease-out`;

const CHEVRON = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 text-[#9a9a9a] dark:text-neutral-500 transition-transform duration-200 group-open:rotate-90"><path d="M6 4 L10 8 L6 12"/></svg>`;

// Collapsible section (native <details>, open by default). Open state survives
// data-only updates because render() keeps the DOM unless the row set changes.
function accordion(label: string, body: string): string {
  return `<details open class="group space-y-2">
    <summary class="flex items-center justify-between gap-2 py-1 -mx-1 px-1 rounded-md cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
      <span class="${LABEL}">${label}</span>${CHEVRON}
    </summary>
    <div class="space-y-2">${body}</div>
  </details>`;
}

function statusLine(text: string): string {
  return `<div class="text-xs ${MUTED}">${text}</div>`;
}

const CRITICAL_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

function pctHtml(pct: number, reset: string): string {
  const value = `${Math.round(pct)}%`;
  const core =
    pct >= 85
      ? `<span class="inline-flex items-center gap-1 text-[#d72c0d] dark:text-red-400">${CRITICAL_ICON}${value}</span>`
      : value;
  return `${core}${reset ? ` <span class="font-normal ${MUTED}">· resets in ${reset}</span>` : ""}`;
}

function renderQuota(quota: QuotaState): string {
  const header = `<div class="${LABEL}">Claude quota</div>`;
  if (quota.status === "no-token" || quota.status === "relogin") return header + statusLine("Sign in via Claude Code");
  if (quota.status === "unavailable" || quota.buckets.length === 0) return header + statusLine("Quota unavailable");
  const rows = quota.buckets
    .map((b) => {
      const pct = Math.min(Math.max(b.percent, 0), 100);
      return `
        <div class="space-y-1.5" data-bucket="${esc(b.kind)}" title="${esc(b.label)}">
          <div class="flex items-baseline justify-between">
            <span class="text-xs">${esc(bucketName(b))}</span>
            <span class="text-xs font-semibold tabular-nums select-text cursor-text" data-pct>${pctHtml(pct, countdown(b.resetsAt))}</span>
          </div>
          <div class="h-1.5 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(bucketName(b))}">
            <div class="${QUOTA_FILL}" data-fill style="width:${pct}%"></div>
          </div>
        </div>`;
    })
    .join("");
  return header + rows;
}

function updateQuota(el: HTMLElement, quota: QuotaState): void {
  for (const b of quota.buckets) {
    const row = el.querySelector<HTMLElement>(`[data-bucket="${CSS.escape(b.kind)}"]`);
    if (!row) continue;
    const pct = Math.min(Math.max(b.percent, 0), 100);
    row.querySelector<HTMLElement>("[data-pct]")!.innerHTML = pctHtml(pct, countdown(b.resetsAt));
    const fill = row.querySelector<HTMLElement>("[data-fill]")!;
    fill.className = QUOTA_FILL;
    fill.style.width = `${pct}%`;
    fill.parentElement!.setAttribute("aria-valuenow", String(Math.round(pct)));
  }
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Cache hit rate = share of prompt input served from cache vs freshly sent:
// cacheReadTokens / (cacheReadTokens + inputTokens). Empty → "—" (no divide-by-zero).
function cacheHitRate(cost: CostState): string {
  const denom = cost.cacheReadTokens + cost.inputTokens;
  return denom > 0 ? `${Math.round((cost.cacheReadTokens / denom) * 100)}%` : "—";
}

// Compact token-split tile: four small stats + cache hit rate. data-* attrs let
// updateCost() mutate the numbers in place on background refreshes (same pattern
// as the agent rows), so the tile survives without a full re-render.
function costTile(cost: CostState): string {
  const stat = (label: string, attr: string, value: string) => `
    <span class="flex flex-col gap-0.5 min-w-0">
      <span class="text-[10px] uppercase tracking-wide ${MUTED}">${label}</span>
      <span class="text-xs tabular-nums" ${attr}>${value}</span>
    </span>`;
  return `<div class="flex items-baseline justify-between gap-2">
      ${stat("In", "data-stat-in", fmtTokens(cost.inputTokens))}
      ${stat("Out", "data-stat-out", fmtTokens(cost.outputTokens))}
      ${stat("Cache read", "data-stat-cread", fmtTokens(cost.cacheReadTokens))}
      ${stat("Cache write", "data-stat-cwrite", fmtTokens(cost.cacheWriteTokens))}
      ${stat("Hit rate", "data-stat-hit", cacheHitRate(cost))}
    </div>`;
}

function visibleAgents(cost: CostState, settings: Settings): AgentCost[] {
  return settings.enabledAgents
    ? cost.agents.filter((a) => settings.enabledAgents!.includes(a.client))
    : cost.agents;
}

function agentMeta(a: { tokens: number; cost: number }): string {
  return `${fmtTokens(a.tokens)} <span class="font-semibold text-[#1a1a1a] dark:text-neutral-100">$${a.cost.toFixed(2)}</span>`;
}

// Brand logos from svgl.app. Claude/Gemini carry their own colors; the rest are
// monochrome via currentColor so they adapt to the light/dark popup. Sized to 1rem.
const SVG = 'class="size-4 shrink-0" aria-hidden="true"';
const CLIENT_SVG: { re: RegExp; svg: string; mono?: boolean }[] = [
  {
    re: /claude/i,
    svg: `<svg ${SVG} viewBox="0 0 256 257" xmlns="http://www.w3.org/2000/svg"><path fill="#D97757" d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>`,
  },
  {
    re: /codex|openai|gpt/i,
    mono: true,
    svg: `<svg ${SVG} fill="currentColor" viewBox="0 0 256 260" xmlns="http://www.w3.org/2000/svg"><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/></svg>`,
  },
  {
    re: /gemini/i,
    svg: `<svg ${SVG} viewBox="0 0 296 298" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill="#3186FF" d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"/></svg>`,
  },
  {
    re: /cursor/i,
    mono: true,
    svg: `<svg ${SVG} fill="currentColor" viewBox="0 0 466.73 532.09" xmlns="http://www.w3.org/2000/svg"><path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>`,
  },
  {
    re: /copilot/i,
    mono: true,
    svg: `<svg ${SVG} fill="currentColor" viewBox="0 0 256 208" xmlns="http://www.w3.org/2000/svg"><path d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z"/></svg>`,
  },
];
// ponytail: brand SVG when known; hashed letter badge otherwise (covers new agents).
function clientIcon(client: string): string {
  const hit = CLIENT_SVG.find((b) => b.re.test(client));
  if (hit) {
    const tone = hit.mono ? ' class="inline-flex text-[#1a1a1a] dark:text-neutral-100"' : "";
    return `<span${tone}>${hit.svg}</span>`;
  }
  let h = 0;
  for (const ch of client) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = (client.trim()[0] ?? "?").toUpperCase();
  return `<span class="inline-flex items-center justify-center size-4 rounded shrink-0 text-[9px] font-bold text-white" style="background:hsl(${h % 360} 55% 45%)" aria-hidden="true">${esc(t)}</span>`;
}

const RANGE_LABEL: Record<Range, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

function renderCost(cost: CostState, settings: Settings, label: string): string {
  if (cost.status === "runtime-missing")
    return `<div class="${LABEL}">${label}</div>` + statusLine("Install Bun or Node.js to see agent costs");
  if (cost.status === "error" && !cost.fetchedAt)
    return (
      `<div class="${LABEL}">${label}</div>` +
      `<div class="text-xs ${MUTED}" data-cost-status>${cost.refreshing ? "Loading costs…" : "Cost data unavailable"}</div>`
    );
  const agents = visibleAgents(cost, settings);
  const totalTokens = agents.reduce((n, a) => n + a.tokens, 0);
  const totalCost = agents.reduce((n, a) => n + a.cost, 0);
  const header = `
    <div class="flex items-center justify-between">
      <span class="${LABEL}">${label}</span>
      <span class="text-[11px] tabular-nums ${MUTED}" data-cost-meta>${
        cost.refreshing ? "Refreshing…" : `${fmtTokens(totalTokens)} tokens`
      }</span>
    </div>`;
  if (cost.status === "no-data") return header + statusLine("No usage in range");
  if (agents.length === 0) return header + statusLine("All agents hidden in settings");
  const maxCost = Math.max(...agents.map((a) => a.cost), 0.01);
  const rows = agents
    .map(
      (a) => `
      <div class="space-y-1" data-agent-row="${esc(a.client)}">
        <div class="flex items-baseline justify-between">
          <span class="flex items-center gap-1.5 min-w-0">${clientIcon(a.client)}<span class="text-xs truncate">${esc(a.client)}</span></span>
          <span class="text-xs tabular-nums shrink-0 text-[#616161] dark:text-neutral-400 select-text cursor-text" data-agent-meta>${agentMeta(a)}</span>
        </div>
        <div class="h-1 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" aria-hidden="true">
          <div class="${COST_FILL}" data-fill style="width:${Math.max((a.cost / maxCost) * 100, 1.5)}%"></div>
        </div>
      </div>`,
    )
    .join("");
  const models = cost.models ?? [];
  const maxModel = Math.max(...models.map((m) => m.cost), 0.01);
  const modelRows = models
    .map(
      (m) => `
      <div class="space-y-1" data-model-row="${esc(m.model)}" title="${esc(m.model)}">
        <div class="flex items-baseline justify-between">
          <span class="text-xs truncate">${esc(m.model)}</span>
          <span class="text-xs tabular-nums shrink-0 text-[#616161] dark:text-neutral-400 select-text cursor-text" data-model-meta>${agentMeta(m)}</span>
        </div>
        <div class="h-1 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" aria-hidden="true">
          <div class="${COST_FILL}" data-fill style="width:${Math.max((m.cost / maxModel) * 100, 1.5)}%"></div>
        </div>
      </div>`,
    )
    .join("");
  // Single model == the total, so the breakdown only earns its space at 2+.
  const modelsBlock = models.length > 1 ? `<div class="pt-1">${accordion("Models", modelRows)}</div>` : "";
  return `${header}
    <div class="flex items-baseline gap-1.5">
      <span class="text-[22px] font-semibold tabular-nums tracking-tight select-text cursor-text" data-total-cost>$${totalCost.toFixed(2)}</span>
      <span class="text-[11px] ${MUTED}">across ${agents.length} agent${agents.length === 1 ? "" : "s"}</span>
    </div>
    ${costTile(cost)}
    <div class="space-y-2.5">${rows}</div>
    ${modelsBlock}`;
}

function updateCost(el: HTMLElement, cost: CostState, settings: Settings): void {
  const agents = visibleAgents(cost, settings);
  const statusEl = el.querySelector<HTMLElement>("[data-cost-status]");
  if (statusEl) statusEl.textContent = cost.refreshing ? "Loading costs…" : "Cost data unavailable";
  const meta = el.querySelector<HTMLElement>("[data-cost-meta]");
  if (meta)
    meta.textContent = cost.refreshing
      ? "Refreshing…"
      : `${fmtTokens(agents.reduce((n, a) => n + a.tokens, 0))} tokens`;
  const total = el.querySelector<HTMLElement>("[data-total-cost]");
  if (total) total.textContent = `$${agents.reduce((n, a) => n + a.cost, 0).toFixed(2)}`;
  const setStat = (attr: string, value: string) => {
    const s = el.querySelector<HTMLElement>(`[${attr}]`);
    if (s) s.textContent = value;
  };
  setStat("data-stat-in", fmtTokens(cost.inputTokens));
  setStat("data-stat-out", fmtTokens(cost.outputTokens));
  setStat("data-stat-cread", fmtTokens(cost.cacheReadTokens));
  setStat("data-stat-cwrite", fmtTokens(cost.cacheWriteTokens));
  setStat("data-stat-hit", cacheHitRate(cost));
  const maxCost = Math.max(...agents.map((a) => a.cost), 0.01);
  for (const a of agents) {
    const row = el.querySelector<HTMLElement>(`[data-agent-row="${CSS.escape(a.client)}"]`);
    if (!row) continue;
    row.querySelector<HTMLElement>("[data-agent-meta]")!.innerHTML = agentMeta(a);
    row.querySelector<HTMLElement>("[data-fill]")!.style.width = `${Math.max((a.cost / maxCost) * 100, 1.5)}%`;
  }
  const models = cost.models ?? [];
  const maxModel = Math.max(...models.map((m) => m.cost), 0.01);
  for (const m of models) {
    const row = el.querySelector<HTMLElement>(`[data-model-row="${CSS.escape(m.model)}"]`);
    if (!row) continue;
    row.querySelector<HTMLElement>("[data-model-meta]")!.innerHTML = agentMeta(m);
    row.querySelector<HTMLElement>("[data-fill]")!.style.width = `${Math.max((m.cost / maxModel) * 100, 1.5)}%`;
  }
}

// mcp__figma__get_code -> "figma · get_code"; leaves builtin tool names as-is.
function prettyTool(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

function toolMeta(t: ToolCost): string {
  return `${t.calls} call${t.calls === 1 ? "" : "s"} <span class="font-semibold text-[#1a1a1a] dark:text-neutral-100">$${t.cost.toFixed(2)}</span>`;
}

function renderTools(tools: ToolState): string {
  const header = `<div class="${LABEL}">Spend by tool &amp; MCP</div>`;
  if (tools.status === "runtime-missing") return "";
  if (tools.status === "error" && !tools.fetchedAt)
    return header + statusLine(tools.refreshing ? "Loading tools…" : "Tool data unavailable");
  if (tools.status === "no-data") return header + statusLine("No tool calls in range");
  const max = Math.max(...tools.tools.map((t) => t.cost), 0.01);
  const rows = tools.tools
    .map(
      (t) => `
      <div class="space-y-1" data-tool-row="${esc(t.name)}" title="${esc(t.name)}">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-xs truncate">${esc(prettyTool(t.name))}</span>
          <span class="text-xs tabular-nums shrink-0 text-[#616161] dark:text-neutral-400 select-text cursor-text" data-tool-meta>${toolMeta(t)}</span>
        </div>
        <div class="h-1 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" aria-hidden="true">
          <div class="${COST_FILL}" data-fill style="width:${Math.max((t.cost / max) * 100, 1.5)}%"></div>
        </div>
      </div>`,
    )
    .join("");
  return accordion("Spend by tool &amp; MCP", rows);
}

function updateTools(el: HTMLElement, tools: ToolState): void {
  const max = Math.max(...tools.tools.map((t) => t.cost), 0.01);
  for (const t of tools.tools) {
    const row = el.querySelector<HTMLElement>(`[data-tool-row="${CSS.escape(t.name)}"]`);
    if (!row) continue;
    row.querySelector<HTMLElement>("[data-tool-meta]")!.innerHTML = toolMeta(t);
    row.querySelector<HTMLElement>("[data-fill]")!.style.width = `${Math.max((t.cost / max) * 100, 1.5)}%`;
  }
}

// Opacity for one hour cell: linear ramp tokens/max over a faint→full BAR_BLUE
// wash. A small floor keeps a low-but-nonzero hour visible above the track;
// exactly-zero hours stay at 0 so they read as the empty track color.
function hourOpacity(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0;
  return Math.max(tokens / max, 0.15);
}

// "14:00 · 3.2K" hover detail.
function hourTitle(hour: number, tokens: number): string {
  return `${String(hour).padStart(2, "0")}:00 · ${fmtTokens(tokens)}`;
}

// Compact 24-cell strip: one flex cell per local hour-of-day, a BAR_BLUE wash
// over the track scaled to that hour's share of the busiest hour. Cells mutate
// in place on refresh (data-hour fill opacity), like the bars in updateCost.
function renderHeatmap(heatmap: HeatmapState): string {
  if (heatmap.status !== "ok") return "";
  const max = Math.max(...heatmap.hours, 0);
  const cells = heatmap.hours
    .map(
      (t, h) => `
      <span class="flex-1 h-6 rounded-sm relative overflow-hidden bg-[#ebebeb] dark:bg-neutral-800" title="${hourTitle(h, t)}">
        <span class="absolute inset-0 ${BAR_BLUE} transition-opacity duration-300 ease-out" data-hour="${h}" style="opacity:${hourOpacity(t, max)}"></span>
      </span>`,
    )
    .join("");
  // Sparse hour ticks (0, 6, 12, 18) aligned under the 24 equal cells.
  const labels = Array.from({ length: 24 }, (_, h) =>
    `<span class="flex-1 text-center text-[9px] tabular-nums ${MUTED}">${h % 6 === 0 ? h : ""}</span>`,
  ).join("");
  const strip = `<div class="space-y-1">
      <div class="flex gap-0.5">${cells}</div>
      <div class="flex gap-0.5">${labels}</div>
    </div>`;
  return accordion("Activity by hour", strip);
}

function updateHeatmap(el: HTMLElement, heatmap: HeatmapState): void {
  const max = Math.max(...heatmap.hours, 0);
  heatmap.hours.forEach((t, h) => {
    const fill = el.querySelector<HTMLElement>(`[data-hour="${h}"]`);
    if (fill) fill.style.opacity = String(hourOpacity(t, max));
  });
}

function projectMeta(p: ProjectCost): string {
  return `${fmtTokens(p.tokens)} <span class="font-semibold text-[#1a1a1a] dark:text-neutral-100">$${p.cost.toFixed(2)}</span>`;
}

function renderProjects(projects: ProjectState): string {
  if (projects.status === "runtime-missing") return "";
  if (projects.status === "error" && !projects.fetchedAt)
    return `<div class="${LABEL}">Spend by project</div>` +
      statusLine(projects.refreshing ? "Loading projects…" : "Project data unavailable");
  if (projects.status === "no-data")
    return `<div class="${LABEL}">Spend by project</div>` + statusLine("No usage in range");
  const max = Math.max(...projects.projects.map((p) => p.cost), 0.01);
  const rows = projects.projects
    .map(
      (p) => `
      <div class="space-y-1" data-project-row="${esc(p.name)}" title="${esc(p.name)}">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-xs truncate">${esc(p.name)}</span>
          <span class="text-xs tabular-nums shrink-0 text-[#616161] dark:text-neutral-400 select-text cursor-text" data-project-meta>${projectMeta(p)}</span>
        </div>
        <div class="h-1 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" aria-hidden="true">
          <div class="${COST_FILL}" data-fill style="width:${Math.max((p.cost / max) * 100, 1.5)}%"></div>
        </div>
      </div>`,
    )
    .join("");
  return accordion("Spend by project", rows);
}

function updateProjects(el: HTMLElement, projects: ProjectState): void {
  const max = Math.max(...projects.projects.map((p) => p.cost), 0.01);
  for (const p of projects.projects) {
    const row = el.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(p.name)}"]`);
    if (!row) continue;
    row.querySelector<HTMLElement>("[data-project-meta]")!.innerHTML = projectMeta(p);
    row.querySelector<HTMLElement>("[data-fill]")!.style.width = `${Math.max((p.cost / max) * 100, 1.5)}%`;
  }
}

const BLOCK_MS = 5 * 60 * 60_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Compact block window label: "09:00–14:00" for today, "Mon 09:00–14:00" for an
// earlier day. Times are local; clock-aligned starts land on :00 in whole-hour
// offset zones (ponytail: half-hour zones show the true minutes, still readable).
function blockLabel(start: number): string {
  const d = new Date(start);
  const end = new Date(start + BLOCK_MS);
  const day = d.toDateString() === new Date().toDateString() ? "" : `${DAYS[d.getDay()]} `;
  return `${day}${hhmm(d)}–${hhmm(end)}`;
}

// Small accent pill marking the block window containing now.
const NOW_PILL = `<span class="text-[9px] font-semibold uppercase tracking-wide px-1 py-px rounded ${BAR_BLUE} text-white shrink-0">now</span>`;

function blockMeta(b: Block): string {
  return `${fmtTokens(b.tokens)} <span class="font-semibold text-[#1a1a1a] dark:text-neutral-100">$${b.cost.toFixed(2)}</span>`;
}

// Recent 5-hour metering windows, newest first, bar relative to the priciest
// block (reusing COST_FILL like the tool/project rows). Claude Code only.
function renderBlocks(blocks: BlockState): string {
  if (blocks.status === "runtime-missing") return "";
  if (blocks.status === "error" && !blocks.fetchedAt)
    return `<div class="${LABEL}">Cost by 5-hour block</div>` +
      statusLine(blocks.refreshing ? "Loading blocks…" : "Block data unavailable");
  if (blocks.status === "no-data")
    return `<div class="${LABEL}">Cost by 5-hour block</div>` + statusLine("No usage in range");
  const max = Math.max(...blocks.blocks.map((b) => b.cost), 0.01);
  const rows = blocks.blocks
    .map(
      (b) => `
      <div class="space-y-1" data-block-row="${b.start}">
        <div class="flex items-baseline justify-between gap-2">
          <span class="flex items-center gap-1.5 min-w-0 text-xs tabular-nums truncate ${b.active ? "font-medium text-[#1a1a1a] dark:text-neutral-100" : ""}">${esc(blockLabel(b.start))}${b.active ? NOW_PILL : ""}</span>
          <span class="text-xs tabular-nums shrink-0 text-[#616161] dark:text-neutral-400 select-text cursor-text" data-block-meta>${blockMeta(b)}</span>
        </div>
        <div class="h-1 rounded-full bg-[#ebebeb] dark:bg-neutral-800 overflow-hidden" aria-hidden="true">
          <div class="${COST_FILL}" data-fill style="width:${Math.max((b.cost / max) * 100, 1.5)}%"></div>
        </div>
      </div>`,
    )
    .join("");
  return accordion("Cost by 5-hour block", rows);
}

function updateBlocks(el: HTMLElement, blocks: BlockState): void {
  const max = Math.max(...blocks.blocks.map((b) => b.cost), 0.01);
  for (const b of blocks.blocks) {
    const row = el.querySelector<HTMLElement>(`[data-block-row="${b.start}"]`);
    if (!row) continue;
    row.querySelector<HTMLElement>("[data-block-meta]")!.innerHTML = blockMeta(b);
    row.querySelector<HTMLElement>("[data-fill]")!.style.width = `${Math.max((b.cost / max) * 100, 1.5)}%`;
  }
}

// $/hr: cents matter at low spend, whole dollars once it's large.
function fmtDollarsPerHour(d: number): string {
  return d >= 100 ? `$${Math.round(d)}/hr` : `$${d.toFixed(2)}/hr`;
}

// Largest-unit ETA label ("~40m", "~1h 5m") mirroring the quota countdown.
function etaLabel(etaMinutes: number): string {
  const mins = Math.max(1, Math.round(etaMinutes));
  return mins >= 60 ? `~${Math.floor(mins / 60)}h ${mins % 60}m` : `~${mins}m`;
}

function burnRateText(burn: BurnState): string {
  return `${fmtTokens(burn.tokensPerMin)} tok/min · ${fmtDollarsPerHour(burn.dollarsPerHour)}`;
}

// Compact burn tile: current rate + (when we can project it) an ETA to the
// session cap. Hidden entirely when idle/unavailable so a "0 tok/min" tile
// never lingers. Numbers refresh in place via data-* attrs (like updateCost).
function renderBurn(burn: BurnState): string {
  if (burn.status !== "ok") return "";
  const eta =
    burn.etaMinutes !== null
      ? `<div class="text-[11px] ${MUTED}" data-burn-eta>Session cap in ${etaLabel(burn.etaMinutes)}</div>`
      : "";
  return `
    <div class="${LABEL}">Burn rate</div>
    <div class="flex items-baseline gap-1.5">
      <span class="text-[#008060] dark:text-emerald-400" aria-hidden="true">▲</span>
      <span class="text-[15px] font-semibold tabular-nums tracking-tight select-text cursor-text" data-burn-rate>${burnRateText(burn)}</span>
    </div>
    ${eta}`;
}

function updateBurn(el: HTMLElement, burn: BurnState): void {
  const rate = el.querySelector<HTMLElement>("[data-burn-rate]");
  if (rate) rate.textContent = burnRateText(burn);
  const eta = el.querySelector<HTMLElement>("[data-burn-eta]");
  if (eta && burn.etaMinutes !== null) eta.textContent = `Session cap in ${etaLabel(burn.etaMinutes)}`;
}

const CARD =
  "bg-white dark:bg-neutral-900 border border-[#e3e3e3] dark:border-neutral-800 rounded-xl shadow-[0_1px_2px_rgba(26,26,26,0.05)]";
const ROW = "flex items-center justify-between px-3.5 py-3";
const DIVIDE = "divide-y divide-[#f1f1f1] dark:divide-neutral-800";

const numberInput = (id: string, value: number, min: number, max: number, unit: string) => `
  <span class="flex items-center gap-1 border border-[#d4d4d4] dark:border-neutral-700 rounded-lg px-2 py-1 bg-white dark:bg-neutral-900 focus-within:border-[#005bd3] focus-within:ring-2 focus-within:ring-[#005bd3]/25 dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400/25">
    <input id="${id}" type="number" min="${min}" max="${max}" value="${value}"
      class="w-9 text-right text-xs tabular-nums bg-transparent outline-none">
    <span class="text-[11px] ${MUTED}">${unit}</span>
  </span>`;

const TOGGLE =
  "appearance-none cursor-pointer relative w-8 h-[18px] rounded-full bg-neutral-300 dark:bg-neutral-700 " +
  "checked:bg-[#1a1a1a] dark:checked:bg-neutral-100 transition-colors " +
  "before:content-[''] before:absolute before:top-[2px] before:left-[2px] before:w-3.5 before:h-3.5 before:rounded-full " +
  "before:bg-white dark:before:bg-neutral-900 before:transition-transform checked:before:translate-x-[14px]";

function renderSettings(settings: Settings, cost: CostState): string {
  const enabled = (client: string) =>
    settings.enabledAgents === null || settings.enabledAgents.includes(client);
  const settingRow = (label: string, sub: string, control: string) => `
    <label class="${ROW} cursor-pointer">
      <span class="flex flex-col gap-px">
        <span class="text-xs">${label}</span>
        ${sub ? `<span class="text-[11px] ${MUTED}">${sub}</span>` : ""}
      </span>
      ${control}
    </label>`;
  const agentRows = cost.agents
    .map(
      (a) => `
      <label class="${ROW} cursor-pointer">
        <span class="text-xs">${esc(a.client)}</span>
        <input type="checkbox" data-agent="${esc(a.client)}" ${enabled(a.client) ? "checked" : ""}
          class="w-4 h-4 accent-[#1a1a1a] dark:accent-neutral-100 cursor-pointer">
      </label>`,
    )
    .join("");
  return `
    <div class="space-y-2">
      <div class="${CARD} ${DIVIDE}">
        ${settingRow("Refresh interval", "How often quota is polled", numberInput("set-refresh", settings.refreshMinutes, 1, 120, "min"))}
        ${settingRow("Warn at session usage", "Notifies once per quota window", numberInput("set-threshold", settings.warnThresholdPct, 1, 100, "%"))}
        ${settingRow("Launch at startup", "", `<input id="set-startup" type="checkbox" ${settings.launchAtStartup ? "checked" : ""} class="${TOGGLE}">`)}
      </div>
      ${
        cost.agents.length > 0
          ? `<div class="${CARD}">
              <div class="${LABEL} px-3.5 pt-3 pb-1">Agents shown</div>
              <div class="${DIVIDE}">${agentRows}</div>
            </div>`
          : ""
      }
    </div>`;
}

function fmtUpdated(fetchedAt: number | null): string {
  if (!fetchedAt) return "";
  const mins = Math.floor((Date.now() - fetchedAt) / 60_000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  return `Updated ${Math.floor(mins / 60)}h ago`;
}

// Settings inputs are only re-rendered when their data changes, so a state
// push mid-typing doesn't steal focus from a number input.
let settingsKey = "";
// Quota/cost sections keep their DOM between pushes so bar widths can
// transition; innerHTML is only re-set when the row structure changes.
let quotaKey = "";
let burnKey = "";
let costKey = "";
let toolsKey = "";
let heatmapKey = "";
let projectsKey = "";
let blocksKey = "";

function render(): void {
  if (!snapshot) return;
  const quotaEl = document.getElementById("quota")!;
  const qk = JSON.stringify([snapshot.quota.status, snapshot.quota.buckets.map((b) => [b.kind, b.label])]);
  if (qk !== quotaKey) {
    quotaKey = qk;
    quotaEl.innerHTML = renderQuota(snapshot.quota);
  } else updateQuota(quotaEl, snapshot.quota);
  if (pending === snapshot.range && !snapshot.cost.refreshing && !snapshot.tools.refreshing) pending = null;
  renderRange(snapshot.range);
  const burnEl = document.getElementById("burn")!;
  const burnHtml = renderBurn(snapshot.burn);
  burnEl.classList.toggle("hidden", burnHtml === "");
  // Structure (whether the ETA line exists) is keyed; the numbers update in place.
  const bk = JSON.stringify([snapshot.burn.status, snapshot.burn.etaMinutes !== null]);
  if (bk !== burnKey) {
    burnKey = bk;
    burnEl.innerHTML = burnHtml;
  } else updateBurn(burnEl, snapshot.burn);
  const costEl = document.getElementById("cost")!;
  const ck = JSON.stringify([
    snapshot.cost.status,
    !!snapshot.cost.fetchedAt,
    snapshot.range,
    visibleAgents(snapshot.cost, snapshot.settings).map((a) => a.client),
    (snapshot.cost.models ?? []).map((m) => m.model),
  ]);
  if (ck !== costKey) {
    costKey = ck;
    costEl.innerHTML = renderCost(snapshot.cost, snapshot.settings, RANGE_LABEL[snapshot.range]);
  } else updateCost(costEl, snapshot.cost, snapshot.settings);
  const toolsEl = document.getElementById("tools")!;
  const html = renderTools(snapshot.tools);
  toolsEl.classList.toggle("hidden", html === "");
  const tk = JSON.stringify([
    snapshot.tools.status,
    !!snapshot.tools.fetchedAt,
    snapshot.tools.tools.map((t) => t.name),
  ]);
  if (tk !== toolsKey) {
    toolsKey = tk;
    toolsEl.innerHTML = html;
  } else updateTools(toolsEl, snapshot.tools);
  const heatmapEl = document.getElementById("heatmap")!;
  const heatmapHtml = renderHeatmap(snapshot.heatmap);
  heatmapEl.classList.toggle("hidden", heatmapHtml === "");
  // Structure (the 24 cells) is fixed once rendered; only the fill opacities
  // change, so key on status alone and mutate the cells in place otherwise.
  const hk = JSON.stringify([snapshot.heatmap.status, !!snapshot.heatmap.fetchedAt]);
  if (hk !== heatmapKey) {
    heatmapKey = hk;
    heatmapEl.innerHTML = heatmapHtml;
  } else updateHeatmap(heatmapEl, snapshot.heatmap);
  const projectsEl = document.getElementById("projects")!;
  const projectsHtml = renderProjects(snapshot.projects);
  projectsEl.classList.toggle("hidden", projectsHtml === "");
  const pk = JSON.stringify([
    snapshot.projects.status,
    !!snapshot.projects.fetchedAt,
    snapshot.projects.projects.map((p) => p.name),
  ]);
  if (pk !== projectsKey) {
    projectsKey = pk;
    projectsEl.innerHTML = projectsHtml;
  } else updateProjects(projectsEl, snapshot.projects);
  const blocksEl = document.getElementById("blocks")!;
  const blocksHtml = renderBlocks(snapshot.blocks);
  blocksEl.classList.toggle("hidden", blocksHtml === "");
  // Structure keyed on the row set + which block is active (active shifts the
  // "now" pill/label styling); bar widths and $ update in place otherwise.
  const blk = JSON.stringify([
    snapshot.blocks.status,
    !!snapshot.blocks.fetchedAt,
    snapshot.blocks.blocks.map((b) => [b.start, b.active]),
  ]);
  if (blk !== blocksKey) {
    blocksKey = blk;
    blocksEl.innerHTML = blocksHtml;
  } else updateBlocks(blocksEl, snapshot.blocks);
  // Merged card: hide the shared box only when both halves are empty.
  document.getElementById("activity")!.classList.toggle("hidden", blocksHtml === "" && heatmapHtml === "");
  document.getElementById("updated")!.textContent = fmtUpdated(snapshot.quota.fetchedAt);
  const key = JSON.stringify([snapshot.settings, snapshot.cost.agents.map((a) => a.client)]);
  if (key !== settingsKey) {
    settingsKey = key;
    document.getElementById("settings")!.innerHTML = renderSettings(snapshot.settings, snapshot.cost);
  }
  const u = snapshot.update;
  document.getElementById("update")!.innerHTML = !u
    ? ""
    : u.status === "downloaded"
      ? `<button class="text-[11px] font-medium text-[#005bd3] dark:text-blue-400 hover:underline cursor-pointer px-1.5 py-2 -mx-1.5 -my-2 rounded-md active:scale-[0.96] transition-transform">Restart to update · v${esc(u.version)}</button>`
      : `<span class="text-[11px] text-[#6f6f6f] dark:text-neutral-400 px-1.5 py-2">Downloading update… ${u.percent ?? 0}%</span>`;
  updateScrollFades();
}

// Scrollbar is hidden (it stole width); fade the clipped edge instead so
// "more below/above" stays visible. Fades only appear when actually overflowing.
function updateScrollFades(): void {
  const el = document.getElementById("scroller");
  if (!el) return;
  const top = el.scrollTop > 2;
  const bot = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  const mask = `linear-gradient(to bottom, ${top ? "transparent" : "#000"} 0, #000 14px, #000 calc(100% - 14px), ${bot ? "transparent" : "#000"} 100%)`;
  el.style.maskImage = mask;
  el.style.webkitMaskImage = mask;
}

const RANGE_ACTIVE = "bg-white dark:bg-neutral-900 text-[#1a1a1a] dark:text-neutral-100 shadow-sm";
const RANGE_INACTIVE = "text-[#616161] dark:text-neutral-400 hover:text-[#1a1a1a] dark:hover:text-neutral-100";

const SPINNER = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" class="inline animate-spin ml-1 -mt-px" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-opacity="0.25"/><path d="M8 2 a6 6 0 0 1 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// Only true while a range *switch* is in flight — not during interval polls, so
// content doesn't flicker on every background refresh.
let pending: Range | null = null;

function renderRange(range: Range): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#range button")) {
    const active = b.dataset.range === range;
    const busy = active && pending !== null;
    b.className = `flex-1 py-1 rounded-md cursor-pointer transition-colors ${active ? RANGE_ACTIVE : RANGE_INACTIVE}`;
    const short = { today: "Today", "7d": "7 days", "30d": "30 days" }[b.dataset.range as Range];
    b.innerHTML = short + (busy ? SPINNER : "");
  }
  document.getElementById("scroller")!.classList.toggle("opacity-50", pending !== null);
}

document.getElementById("range")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
  if (!b || b.dataset.range === pending) return;
  pending = b.dataset.range as Range;
  renderRange(pending); // optimistic: highlight + spinner before data lands
  window.api.setRange(pending);
});

function showSettings(open: boolean): void {
  document.getElementById("view-main")!.classList.toggle("hidden", open);
  const s = document.getElementById("view-settings")!;
  s.classList.toggle("hidden", !open);
  s.classList.toggle("flex", open);
}

document.getElementById("open-settings")!.addEventListener("click", () => showSettings(true));
document.getElementById("close-settings")!.addEventListener("click", () => showSettings(false));
document.getElementById("refresh")!.addEventListener("click", () => window.api.refresh());

const scroller = document.getElementById("scroller")!;
scroller.addEventListener("scroll", updateScrollFades, { passive: true });
// <details> collapse changes content height; toggle doesn't bubble, so capture it.
scroller.addEventListener("toggle", updateScrollFades, true);
document.getElementById("update")!.addEventListener("click", () => window.api.openUpdate());

document.getElementById("settings")!.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "set-refresh") window.api.setSettings({ refreshMinutes: Number(t.value) });
  else if (t.id === "set-threshold") window.api.setSettings({ warnThresholdPct: Number(t.value) });
  else if (t.id === "set-startup") window.api.setSettings({ launchAtStartup: t.checked });
  else if (t.dataset.agent !== undefined) {
    const boxes = [...document.querySelectorAll<HTMLInputElement>("#settings input[data-agent]")];
    window.api.setSettings({
      enabledAgents: boxes.every((b) => b.checked)
        ? null
        : boxes.filter((b) => b.checked).map((b) => b.dataset.agent!),
    });
  }
});

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
