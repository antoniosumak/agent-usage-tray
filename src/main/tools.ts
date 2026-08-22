import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { detectRuntime, runTokscale, Range, rangeSince } from "./cost";

// Per-tool spend, parsed from Claude Code's local JSONL transcripts. tokscale
// only rolls up to (client, model); tool/MCP attribution lives in the raw logs.
// This is Claude Code only — other agents store sessions in other formats.
export interface ToolCost {
  name: string;
  calls: number;
  cost: number;
}

export interface ToolState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  tools: ToolCost[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialToolState: ToolState = {
  status: "error",
  tools: [],
  totalCost: 0,
  refreshing: true,
  fetchedAt: null,
};

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Non-tool assistant turns (plain answers, reasoning) go here so tool totals
// reconcile against the day's total spend.
export const RESPONSE_BUCKET = "(text response)";

export function messageCost(usage: any, r: Rates): number {
  return (
    (usage?.input_tokens ?? 0) * r.input +
    (usage?.output_tokens ?? 0) * r.output +
    (usage?.cache_read_input_tokens ?? 0) * r.cacheRead +
    (usage?.cache_creation_input_tokens ?? 0) * r.cacheWrite
  );
}

// One entry per tool_use block (repeats included), so a turn that calls the
// same tool twice splits its cost two ways and counts as two calls.
export function toolNames(content: any): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "tool_use").map((b) => String(b?.name ?? "unknown"));
}

// Cost is billed per message, not per tool call: split each turn's cost evenly
// across the tools it invoked. Approximate — good enough to rank tools/MCP.
export function attribute(cost: number, names: string[], into: Map<string, ToolCost>): void {
  const targets = names.length ? names : [RESPONSE_BUCKET];
  const share = cost / targets.length;
  for (const name of targets) {
    const t = into.get(name) ?? { name, calls: 0, cost: 0 };
    t.calls += 1;
    t.cost += share;
    into.set(name, t);
  }
}

const priceCache = new Map<string, Rates | null>();

export async function pricing(runtime: string[], model: string): Promise<Rates | null> {
  if (priceCache.has(model)) return priceCache.get(model)!;
  let rates: Rates | null = null;
  try {
    const p = JSON.parse(await runTokscale(runtime, ["pricing", model, "--json"]))?.pricing;
    if (p)
      rates = {
        input: p.inputCostPerToken ?? 0,
        output: p.outputCostPerToken ?? 0,
        cacheRead: p.cacheReadInputTokenCost ?? 0,
        cacheWrite: p.cacheCreationInputTokenCost ?? 0,
      };
  } catch {
    rates = null; // unknown model → contributes calls but no cost
  }
  priceCache.set(model, rates);
  return rates;
}

export interface Msg {
  ts: number;
  model: string;
  usage: any;
  names: string[];
  project: string; // ~/.claude/projects/<dir> name this message came from
}

// Parsed transcripts are cached per file, keyed by mtime+size, so a refresh or
// range switch only re-reads files that actually changed. Without this, every
// refresh JSON.parses the entire ~/.claude/projects tree (hundreds of MB).
const fileCache = new Map<string, { mtimeMs: number; size: number; msgs: Msg[] }>();

function parseTranscript(text: string, project: string): Msg[] {
  const msgs: Msg[] = [];
  for (const line of text.split("\n")) {
    // Cheap substring gate before the expensive JSON.parse: user/tool_result
    // lines (the bulk of the bytes) never match and are skipped unparsed.
    if (!line || !line.includes('"assistant"')) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const m = obj?.message;
    if (m?.role !== "assistant" || !m?.usage) continue;
    const ts = Date.parse(obj?.timestamp);
    if (!Number.isFinite(ts)) continue;
    msgs.push({ ts, model: String(m.model ?? "unknown"), usage: m.usage, names: toolNames(m.content), project });
  }
  return msgs;
}

export async function assistantMessagesSince(since: number): Promise<Msg[]> {
  const root = join(homedir(), ".claude", "projects");
  const out: Msg[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const dir = join(root, proj);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(dir, file);
      let mtimeMs: number;
      let size: number;
      try {
        const s = await stat(full);
        mtimeMs = s.mtimeMs;
        size = s.size;
      } catch {
        continue;
      }
      // Newest possible message is at mtime; if that predates the window, skip.
      if (mtimeMs < since) continue;
      let cached = fileCache.get(full);
      if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
        let text: string;
        try {
          text = await readFile(full, "utf8");
        } catch {
          continue;
        }
        cached = { mtimeMs, size, msgs: parseTranscript(text, proj) };
        fileCache.set(full, cached);
      }
      for (const m of cached.msgs) if (m.ts >= since) out.push(m);
    }
  }
  return out;
}

export function startTools(intervalMs: number, onState: (s: ToolState) => void) {
  let state = initialToolState;
  let runtime: string[] | null | undefined;
  let running = false;
  let range: Range = "today";

  const emit = (patch: Partial<ToolState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  async function refresh(): Promise<void> {
    if (running) return;
    running = true;
    emit({ refreshing: true });
    try {
      if (runtime === undefined) runtime = await detectRuntime();
      if (runtime === null) {
        emit({ status: "runtime-missing", refreshing: false });
        return;
      }
      const msgs = await assistantMessagesSince(rangeSince(range));
      const byTool = new Map<string, ToolCost>();
      for (const msg of msgs) {
        const rates = await pricing(runtime, msg.model);
        attribute(rates ? messageCost(msg.usage, rates) : 0, msg.names, byTool);
      }
      const tools = [...byTool.values()].sort((a, b) => b.cost - a.cost);
      emit({
        status: tools.length > 0 ? "ok" : "no-data",
        tools,
        totalCost: tools.reduce((n, t) => n + t.cost, 0),
        refreshing: false,
        fetchedAt: Date.now(),
      });
    } catch {
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
