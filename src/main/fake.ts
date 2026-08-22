import type { QuotaState } from "./quota";
import type { CostState } from "./cost";
import type { ToolState } from "./tools";
import type { HeatmapState } from "./heatmap";
import type { ProjectState } from "./projects";
import type { BlockState } from "./blocks";
import type { BurnState } from "./burnrate";

// Canned state for eyeballing the tray/widget/popup without a token, tokscale,
// or real ~/.claude logs. Gated by AGENT_USAGE_FAKE in main.ts. `tick` cycles
// the session % through the color thresholds so the tray icon + widget visibly
// change: green (<60) -> yellow (<85) -> red.
export function fakeState(tick: number): {
  quota: QuotaState;
  cost: CostState;
  tools: ToolState;
  heatmap: HeatmapState;
  projects: ProjectState;
  blocks: BlockState;
  burn: BurnState;
} {
  const now = Date.now();
  const sessionPct = [12, 45, 72, 91, 99][tick % 5];
  const iso = (minsAhead: number) => new Date(now + minsAhead * 60_000).toISOString();

  return {
    quota: {
      status: "ok",
      fetchedAt: now,
      buckets: [
        { provider: "anthropic", kind: "session", label: "Session", percent: sessionPct, resetsAt: iso(90) },
        { provider: "anthropic", kind: "weekly_all", label: "Weekly (all models)", percent: 63, resetsAt: iso(60 * 72) },
        { provider: "anthropic", kind: "weekly_scoped", label: "Weekly Fable", percent: 41, resetsAt: iso(60 * 72) },
        { provider: "anthropic", kind: "credits", label: "Usage credits", percent: 1, resetsAt: null, note: "$6.67 / $1,000" },
        { provider: "codex", kind: "session", label: "Session", percent: 58, resetsAt: iso(70) },
        { provider: "codex", kind: "weekly_all", label: "Weekly", percent: 34, resetsAt: iso(60 * 96) },
      ],
    },
    cost: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      agents: [
        { client: "claude-code", tokens: 8_420_000, cost: 12.47 },
        { client: "codex", tokens: 3_110_000, cost: 4.83 },
        { client: "cursor", tokens: 1_760_000, cost: 2.19 },
      ],
      models: [
        { model: "claude-opus-4-8", tokens: 7_900_000, cost: 15.12 },
        { model: "gpt-5-codex", tokens: 3_110_000, cost: 4.83 },
        { model: "claude-sonnet-5", tokens: 2_080_000, cost: 1.34 },
      ],
      totalTokens: 13_290_000,
      totalCost: 19.49,
      inputTokens: 640_000,
      outputTokens: 410_000,
      cacheReadTokens: 11_800_000,
      cacheWriteTokens: 440_000,
    },
    tools: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      totalCost: 12.47,
      tools: [
        { name: "Edit", calls: 214, cost: 3.9 },
        { name: "Bash", calls: 188, cost: 3.1 },
        { name: "Read", calls: 402, cost: 2.4 },
        { name: "Grep", calls: 96, cost: 1.2 },
        { name: "(text response)", calls: 531, cost: 1.87 },
      ],
    },
    heatmap: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      // Busy 9–18, quiet overnight.
      hours: Array.from({ length: 24 }, (_, h) =>
        h >= 9 && h <= 18 ? 400_000 + h * 20_000 : 20_000,
      ),
      totalTokens: 13_290_000,
    },
    projects: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      totalCost: 19.49,
      projects: [
        { name: "agent-usage", cost: 11.2, tokens: 7_100_000 },
        { name: "lia", cost: 5.4, tokens: 3_900_000 },
        { name: "afbis", cost: 2.89, tokens: 2_290_000 },
      ],
    },
    blocks: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      totalCost: 19.49,
      blocks: Array.from({ length: 4 }, (_, i) => ({
        start: now - (3 - i) * 5 * 60 * 60_000,
        cost: [4.1, 6.7, 3.2, 5.49][i],
        tokens: [2_600_000, 4_400_000, 2_100_000, 4_190_000][i],
        active: i === 3,
      })),
    },
    burn: {
      status: "ok",
      refreshing: false,
      fetchedAt: now,
      tokensPerMin: 84_000,
      dollarsPerHour: 6.4,
      etaMinutes: 37,
    },
  };
}
