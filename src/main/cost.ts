import { spawn } from "child_process";

const SPAWN_TIMEOUT_MS = 60_000; // first run downloads packages

export interface AgentCost {
  client: string;
  tokens: number;
  cost: number;
}

export interface ModelCost {
  model: string;
  tokens: number;
  cost: number;
}

export type Range = "today" | "7d" | "30d";

// tokscale flags per range. 30d has no preset, so compute the start date.
export function rangeArgs(range: Range): string[] {
  if (range === "today") return ["--today"];
  if (range === "7d") return ["--week"];
  const d = new Date();
  d.setDate(d.getDate() - 29);
  return ["--since", d.toISOString().slice(0, 10)];
}

// Start-of-window in ms, for the tools scan (which reads raw JSONL, not tokscale).
export function rangeSince(range: Range): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range !== "today") d.setDate(d.getDate() - (range === "7d" ? 6 : 29));
  return d.getTime();
}

export interface CostState {
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

export const initialCostState: CostState = {
  status: "error",
  agents: [],
  models: [],
  totalTokens: 0,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  refreshing: true,
  fetchedAt: null,
};

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("where.exe", [cmd], { windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

export async function detectRuntime(): Promise<string[] | null> {
  if (await commandExists("bun")) return ["bunx", "tokscale@4"];
  if (await commandExists("npx")) return ["npx", "-y", "tokscale@4"];
  return null;
}

// bunx/npx are .cmd shims on Windows, so shell: true is required. args come
// from a fixed set of static strings (no user input), which also avoids DEP0190.
export function runTokscale(runtime: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn([...runtime, ...args].join(" "), {
      shell: true,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("tokscale timed out"));
    }, SPAWN_TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `tokscale exited with ${code}`));
    });
  });
}

// tokscale --group-by client,model gives one entry per (client, model), so a
// single call yields both the per-agent and per-model rollups.
function parseCost(json: string): {
  agents: AgentCost[];
  models: ModelCost[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const entries = JSON.parse(json)?.entries;
  if (!Array.isArray(entries)) throw new Error("unexpected tokscale output");
  const byClient = new Map<string, AgentCost>();
  const byModel = new Map<string, ModelCost>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const e of entries) {
    const input = e?.input ?? 0;
    const output = e?.output ?? 0;
    const cacheRead = e?.cacheRead ?? 0;
    const cacheWrite = e?.cacheWrite ?? 0;
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    const tokens = input + output + cacheRead + cacheWrite;
    const cost = e?.cost ?? 0;
    const client = String(e?.client ?? "unknown");
    const agent = byClient.get(client) ?? { client, tokens: 0, cost: 0 };
    agent.tokens += tokens;
    agent.cost += cost;
    byClient.set(client, agent);
    const model = String(e?.model ?? "unknown");
    const m = byModel.get(model) ?? { model, tokens: 0, cost: 0 };
    m.tokens += tokens;
    m.cost += cost;
    byModel.set(model, m);
  }
  const byCost = (a: { cost: number }, b: { cost: number }) => b.cost - a.cost;
  return {
    agents: [...byClient.values()].sort(byCost),
    models: [...byModel.values()].sort(byCost),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function startCost(intervalMs: number, onState: (s: CostState) => void) {
  let state = initialCostState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;
  let range: Range = "today";

  const emit = (patch: Partial<CostState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  async function refresh(): Promise<void> {
    if (running) return; // never two concurrent tokscale spawns
    running = true;
    emit({ refreshing: true });
    try {
      if (runtime === undefined) runtime = await detectRuntime();
      if (runtime === null) {
        emit({ status: "runtime-missing", refreshing: false });
        return;
      }
      const { agents, models, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = parseCost(
        await runTokscale(runtime, ["--json", ...rangeArgs(range), "--no-spinner"]),
      );
      emit({
        status: agents.length > 0 ? "ok" : "no-data",
        agents,
        models,
        totalTokens: agents.reduce((n, a) => n + a.tokens, 0),
        totalCost: agents.reduce((n, a) => n + a.cost, 0),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        refreshing: false,
        fetchedAt: Date.now(),
      });
    } catch {
      // Keep the last good result (renderer shows it as stale via fetchedAt).
      emit({ status: state.fetchedAt ? state.status : "error", refreshing: false });
    } finally {
      running = false;
    }
  }

  void refresh();
  let timer = setInterval(() => void refresh(), intervalMs);
  return {
    refreshNow: () => void refresh(),
    setRange(r: Range) {
      range = r;
      void refresh();
    },
    setIntervalMs(ms: number) {
      clearInterval(timer);
      timer = setInterval(() => void refresh(), ms);
    },
  };
}
