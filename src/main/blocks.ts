import { detectRuntime, Range, rangeSince } from "./cost";
import { assistantMessagesSince, pricing, messageCost } from "./tools";

// Cost/tokens spent per rolling 5-hour metering window, rolled up from Claude
// Code's local JSONL transcripts. Like the tool and project breakdowns, this is
// Claude Code only — other agents store sessions in other formats and never
// write ~/.claude/projects logs.
export interface Block {
  start: number; // ms, block window start (clock-aligned to a 5h step)
  cost: number;
  tokens: number;
  active: boolean; // the window containing Date.now()
}

export interface BlockState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  blocks: Block[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialBlockState: BlockState = {
  status: "error",
  blocks: [],
  totalCost: 0,
  refreshing: true,
  fetchedAt: null,
};

const BLOCK_MS = 5 * 60 * 60_000; // Anthropic meters usage in rolling 5-hour blocks.

// Most recent N blocks, so the popup doesn't grow unbounded (a 30d range spans
// ~144 windows). 8 covers roughly the last ~40h of activity.
const MAX_BLOCKS = 8;

// Clock-aligned block start containing ts: floor to a 5h step from the UNIX
// epoch. Simple and deterministic. ponytail: names the ceiling — real Anthropic
// blocks start at first activity, so clock-aligned boundaries are an approximation.
export function blockStart(ts: number): number {
  return Math.floor(ts / BLOCK_MS) * BLOCK_MS;
}

function usageTokens(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

// Pure bucketing core (kept separate so the 5h alignment can be asserted without
// spawning tokscale): group pre-costed items into clock-aligned 5h windows, flag
// the window containing `now` active, sort most-recent-first, cap the list.
export function bucketBlocks(items: { ts: number; cost: number; tokens: number }[], now: number): Block[] {
  const byStart = new Map<number, Block>();
  for (const it of items) {
    const start = blockStart(it.ts);
    const b = byStart.get(start) ?? { start, cost: 0, tokens: 0, active: false };
    b.cost += it.cost;
    b.tokens += it.tokens;
    byStart.set(start, b);
  }
  const activeStart = blockStart(now);
  for (const b of byStart.values()) b.active = b.start === activeStart;
  return [...byStart.values()].sort((a, b) => b.start - a.start).slice(0, MAX_BLOCKS);
}

export function startBlocks(intervalMs: number, onState: (s: BlockState) => void) {
  let state = initialBlockState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;
  let range: Range = "today";

  const emit = (patch: Partial<BlockState>) => {
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
      const items: { ts: number; cost: number; tokens: number }[] = [];
      for (const msg of msgs) {
        const rates = await pricing(runtime, msg.model);
        items.push({ ts: msg.ts, cost: rates ? messageCost(msg.usage, rates) : 0, tokens: usageTokens(msg.usage) });
      }
      const blocks = bucketBlocks(items, Date.now());
      emit({
        status: blocks.length > 0 ? "ok" : "no-data",
        blocks,
        totalCost: blocks.reduce((n, b) => n + b.cost, 0),
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
