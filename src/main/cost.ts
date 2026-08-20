import { spawn } from "child_process";

const SPAWN_TIMEOUT_MS = 60_000; // first run downloads packages

export interface AgentCost {
  client: string;
  tokens: number;
  cost: number;
}

export interface CostState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  agents: AgentCost[];
  totalTokens: number;
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialCostState: CostState = {
  status: "error",
  agents: [],
  totalTokens: 0,
  totalCost: 0,
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

async function detectRuntime(): Promise<string[] | null> {
  if (await commandExists("bun")) return ["bunx", "tokscale@4"];
  if (await commandExists("npx")) return ["npx", "-y", "tokscale@4"];
  return null;
}

// bunx/npx are .cmd shims on Windows, so shell: true is required. The command
// is a single static string (no user input), which also avoids DEP0190.
function runTokscale(runtime: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn([...runtime, "--json", "--today", "--no-spinner"].join(" "), {
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

function parseAgents(json: string): AgentCost[] {
  const entries = JSON.parse(json)?.entries;
  if (!Array.isArray(entries)) throw new Error("unexpected tokscale output");
  const byClient = new Map<string, AgentCost>();
  for (const e of entries) {
    const client = String(e?.client ?? "unknown");
    const agg = byClient.get(client) ?? { client, tokens: 0, cost: 0 };
    agg.tokens += (e?.input ?? 0) + (e?.output ?? 0) + (e?.cacheRead ?? 0) + (e?.cacheWrite ?? 0);
    agg.cost += e?.cost ?? 0;
    byClient.set(client, agg);
  }
  return [...byClient.values()].sort((a, b) => b.cost - a.cost);
}

export function startCost(intervalMs: number, onState: (s: CostState) => void) {
  let state = initialCostState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;

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
      const agents = parseAgents(await runTokscale(runtime));
      emit({
        status: agents.length > 0 ? "ok" : "no-data",
        agents,
        totalTokens: agents.reduce((n, a) => n + a.tokens, 0),
        totalCost: agents.reduce((n, a) => n + a.cost, 0),
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
  setInterval(() => void refresh(), intervalMs);
  return { refreshNow: () => void refresh() };
}
