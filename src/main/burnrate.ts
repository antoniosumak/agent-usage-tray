import { detectRuntime } from "./cost";
import { assistantMessagesSince, messageCost, pricing } from "./tools";

// Burn is always measured over the most recent slice of activity, so it's
// range-independent (no setRange) — "how hard am I going right now".
const WINDOW_MS = 30 * 60_000; // look back ~30 min for recent activity
const MIN_SPAN_MS = 3 * 60_000; // ETA needs samples spanning at least a few minutes

export interface BurnState {
  status: "ok" | "idle" | "runtime-missing" | "error";
  tokensPerMin: number;
  dollarsPerHour: number;
  etaMinutes: number | null; // session-cap projection; filled in by main, poller leaves it null
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialBurnState: BurnState = {
  status: "error",
  tokensPerMin: 0,
  dollarsPerHour: 0,
  etaMinutes: null,
  refreshing: true,
  fetchedAt: null,
};

// Turn a window's total tokens+cost into rates. Divide by the span between the
// first and last message (not the full 30 min) so a short burst reads as a
// burst rather than being averaged down by the idle minutes around it. A single
// message (or zero span) has no span to measure, so fall back to the window.
export function burnRate(
  tokens: number,
  cost: number,
  spanMs: number,
  windowMs: number,
): { tokensPerMin: number; dollarsPerHour: number } {
  const span = spanMs > 0 ? spanMs : windowMs;
  const minutes = span / 60_000;
  const hours = span / 3_600_000;
  return {
    tokensPerMin: minutes > 0 ? tokens / minutes : 0,
    dollarsPerHour: hours > 0 ? cost / hours : 0,
  };
}

// Least-squares fit of session percent over time → minutes until it hits 100%.
// ponytail: usage is bursty, so this straight-line extrapolation is a rough
// projection, not a promise — we only surface it with >=2 samples spanning a
// few minutes and a positive (climbing) slope; anything else returns null.
export function etaFromSamples(samples: { t: number; pct: number }[]): number | null {
  if (samples.length < 2) return null;
  const span = samples[samples.length - 1].t - samples[0].t;
  if (span < MIN_SPAN_MS) return null;
  // Work in minutes so the numbers stay well-conditioned.
  const pts = samples.map((s) => ({ x: (s.t - samples[0].t) / 60_000, y: s.pct }));
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  if (den === 0) return null;
  const slope = num / den; // percent per minute
  if (slope <= 0) return null; // flat or falling → no exhaustion in sight
  const current = pts[n - 1].y;
  if (current >= 100) return 0;
  return (100 - current) / slope;
}

function msgTokens(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

export function startBurn(intervalMs: number, onState: (s: BurnState) => void) {
  let state = initialBurnState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;

  const emit = (patch: Partial<BurnState>) => {
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
      const msgs = await assistantMessagesSince(Date.now() - WINDOW_MS);
      if (msgs.length === 0) {
        emit({ status: "idle", tokensPerMin: 0, dollarsPerHour: 0, refreshing: false, fetchedAt: Date.now() });
        return;
      }
      let tokens = 0;
      let cost = 0;
      let minTs = Infinity;
      let maxTs = -Infinity;
      for (const m of msgs) {
        tokens += msgTokens(m.usage);
        const rates = await pricing(runtime, m.model);
        if (rates) cost += messageCost(m.usage, rates);
        if (m.ts < minTs) minTs = m.ts;
        if (m.ts > maxTs) maxTs = m.ts;
      }
      const { tokensPerMin, dollarsPerHour } = burnRate(tokens, cost, maxTs - minTs, WINDOW_MS);
      emit({ status: "ok", tokensPerMin, dollarsPerHour, refreshing: false, fetchedAt: Date.now() });
    } catch {
      // Keep the last good reading (renderer shows it as stale via fetchedAt).
      emit({ status: state.fetchedAt ? state.status : "error", refreshing: false });
    } finally {
      running = false;
    }
  }

  void refresh();
  let timer = setInterval(() => void refresh(), intervalMs);
  return {
    refreshNow: () => void refresh(),
    setIntervalMs(ms: number) {
      clearInterval(timer);
      timer = setInterval(() => void refresh(), ms);
    },
  };
}
