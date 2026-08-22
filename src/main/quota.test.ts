// Runnable check for Codex usage parsing. Not imported by the app.
// Run: npx esbuild src/main/quota.test.ts --bundle --platform=node --external:electron --outfile="%TEMP%/quota.test.js" && node "%TEMP%/quota.test.js"
import { parseBuckets, parseCodexUsage } from "./quota";

// Absolute reset, 5h + weekly windows; role derived from duration, not name.
const abs = parseCodexUsage({
  rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: "2026-08-22T20:00:00Z" },
    secondary_window: { used_percent: 71, limit_window_seconds: 604800, reset_at: "2026-08-29T00:00:00Z" },
  },
});
console.assert(abs.length === 2, `len=${abs.length}`);
console.assert(abs[0].provider === "codex" && abs[0].kind === "session", `kind0=${abs[0].kind}`);
console.assert(abs[0].percent === 42, `pct0=${abs[0].percent}`);
console.assert(abs[0].resetsAt === "2026-08-22T20:00:00Z", `reset0=${abs[0].resetsAt}`);
console.assert(abs[1].kind === "weekly_all", `kind1=${abs[1].kind}`);

// Relative reset (seconds) → converted to ISO; alt field names (pct/window_secs).
const rel = parseCodexUsage({
  rate_limit: { primary_window: { pct: 10, window_secs: 18000, resets_in_seconds: 3600 } },
});
console.assert(rel.length === 1, `rel len=${rel.length}`);
console.assert(typeof rel[0].resetsAt === "string" && rel[0].resetsAt!.endsWith("Z"), `rel reset=${rel[0].resetsAt}`);

// Missing percent → window dropped; empty body → no buckets.
console.assert(parseCodexUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }).length === 0, "no-pct not dropped");
console.assert(parseCodexUsage({}).length === 0, "empty not zero");

console.log("quota codex parse: OK");

// Anthropic: scoped weekly labeled by its own scope model; credits from spend.
const anth = parseBuckets({
  limits: [
    { kind: "session", percent: 9, resets_at: "2026-08-23T01:00:00Z", scope: null },
    { kind: "weekly_all", percent: 24, resets_at: "2026-08-26T12:00:00Z", scope: null },
    { kind: "weekly_scoped", percent: 36, resets_at: "2026-08-26T12:00:00Z", scope: { model: { display_name: "Fable" } } },
  ],
  spend: {
    enabled: true,
    percent: 1,
    used: { amount_minor: 667, exponent: 2 },
    limit: { amount_minor: 100000, exponent: 2 },
  },
});
console.assert(anth.length === 4, `anth len=${anth.length}`);
console.assert(anth[2].label === "Weekly Fable", `scoped label=${anth[2].label}`);
const credits = anth[3];
console.assert(credits.kind === "credits" && credits.percent === 1, `credits=${JSON.stringify(credits)}`);
console.assert(credits.note === "$6.67 / $1,000", `credits note=${credits.note}`);

// Credits skipped when the plan doesn't have them enabled.
console.assert(
  parseBuckets({ limits: [{ kind: "session", percent: 5 }], spend: { enabled: false } }).length === 1,
  "credits leaked while disabled",
);

console.log("quota anthropic parse: OK");
