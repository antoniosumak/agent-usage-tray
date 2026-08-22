// Runnable check for burn-rate + ETA-slope math. Not imported by the app.
// Run: npx esbuild src/main/burnrate.test.ts --bundle --platform=node --external:electron --outfile="$TMPDIR/burnrate.test.js" && node "$TMPDIR/burnrate.test.js"
// (Windows: use %TEMP% in place of $TMPDIR — the outfile just must NOT be dist/.)
import { burnRate, etaFromSamples } from "./burnrate";

const WINDOW = 30 * 60_000;

// 1000 tokens / $6 over a 10-min span → 100 tok/min, $36/hr.
const b = burnRate(1000, 6, 10 * 60_000, WINDOW);
console.assert(Math.abs(b.tokensPerMin - 100) < 1e-9, `tokensPerMin=${b.tokensPerMin}`);
console.assert(Math.abs(b.dollarsPerHour - 36) < 1e-9, `dollarsPerHour=${b.dollarsPerHour}`);

// Zero span (single message / burst) falls back to the full window: 3000 / 30min = 100.
const f = burnRate(3000, 0, 0, WINDOW);
console.assert(Math.abs(f.tokensPerMin - 100) < 1e-9, `fallback tokensPerMin=${f.tokensPerMin}`);

// Rising 10% → 50% over 20 min → slope 2%/min, 50% left → ETA ~25 min.
const eta = etaFromSamples([
  { t: 0, pct: 10 },
  { t: 20 * 60_000, pct: 50 },
]);
console.assert(eta !== null && Math.abs(eta - 25) < 1e-9, `eta=${eta}`);

// Least-squares tolerates a noisy middle sample yet still lands near 25.
const etaNoisy = etaFromSamples([
  { t: 0, pct: 10 },
  { t: 10 * 60_000, pct: 32 },
  { t: 20 * 60_000, pct: 50 },
]);
console.assert(etaNoisy !== null && Math.abs(etaNoisy - 25) < 2, `etaNoisy=${etaNoisy}`);

// Guards: too few samples, too short a span, and a flat/falling slope → null.
console.assert(etaFromSamples([{ t: 0, pct: 10 }]) === null, "single sample");
console.assert(etaFromSamples([{ t: 0, pct: 10 }, { t: 60_000, pct: 20 }]) === null, "span too short");
console.assert(
  etaFromSamples([{ t: 0, pct: 50 }, { t: 20 * 60_000, pct: 40 }]) === null,
  "falling slope",
);

console.log("burnrate.ts self-check ok");
