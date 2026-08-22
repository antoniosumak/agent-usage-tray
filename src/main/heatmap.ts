import { detectRuntime, Range, rangeSince } from "./cost";
import { assistantMessagesSince, Msg } from "./tools";

// Token volume bucketed by local hour-of-day (0–23), parsed from Claude Code's
// local JSONL transcripts. This is Claude Code only — other agents store
// sessions in other formats. No pricing involved: we only sum raw token counts.
export interface HeatmapState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  hours: number[]; // 24 entries: total tokens per local hour-of-day
  totalTokens: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialHeatmapState: HeatmapState = {
  status: "error",
  hours: new Array(24).fill(0),
  totalTokens: 0,
  refreshing: true,
  fetchedAt: null,
};

// Sum input+output+cacheRead+cacheWrite for one message's usage block.
function usageTokens(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

// Bucket token totals by local hour-of-day (0–23). Pure so the self-check can
// exercise it directly against messages at known timestamps.
export function bucketByHour(msgs: Msg[]): number[] {
  const hours = new Array(24).fill(0);
  for (const m of msgs) hours[new Date(m.ts).getHours()] += usageTokens(m.usage);
  return hours;
}

export function startHeatmap(intervalMs: number, onState: (s: HeatmapState) => void) {
  let state = initialHeatmapState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;
  let range: Range = "today";

  const emit = (patch: Partial<HeatmapState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  async function refresh(): Promise<void> {
    if (running) return;
    running = true;
    emit({ refreshing: true });
    try {
      // Heatmap reads raw JSONL directly and needs no tokscale, but we mirror
      // the sibling pollers' runtime gate for a consistent "install a runtime"
      // status across sections.
      if (runtime === undefined) runtime = await detectRuntime();
      if (runtime === null) {
        emit({ status: "runtime-missing", refreshing: false });
        return;
      }
      const msgs = await assistantMessagesSince(rangeSince(range));
      const hours = bucketByHour(msgs);
      const totalTokens = hours.reduce((n, t) => n + t, 0);
      emit({
        status: msgs.length > 0 ? "ok" : "no-data",
        hours,
        totalTokens,
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
