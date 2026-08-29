// Runnable check for Codex usage parsing. Not imported by the app.
// Run: npx esbuild src/main/quota.test.ts --bundle --platform=node --external:electron --outfile="%TEMP%/quota.test.js" && node "%TEMP%/quota.test.js"
import { parseBuckets, parseCodexUsage, parseCopilotUser, parseCursorSummary, parseCursorUsage, extractCursorJwt, parseGeminiQuota } from "./quota";

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

// Copilot: premium first, unlimited snapshots skipped, percent from percent_remaining
// or entitlement/remaining; reset date → ISO midnight UTC.
const cop = parseCopilotUser({
  copilot_plan: "individual_pro",
  quota_reset_date: "2026-09-01",
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0 },
    completions: { unlimited: true },
    premium_interactions: { unlimited: false, entitlement: 300, remaining: 87, percent_remaining: 29 },
  },
});
console.assert(cop.length === 1, `copilot len=${cop.length}`);
console.assert(cop[0].provider === "copilot" && cop[0].kind === "monthly" && cop[0].label === "Premium requests", `copilot bucket=${JSON.stringify(cop[0])}`);
console.assert(cop[0].percent === 71, `copilot pct=${cop[0].percent}`);
console.assert(cop[0].note === "213 / 300", `copilot note=${cop[0].note}`);
console.assert(cop[0].resetsAt === "2026-09-01T00:00:00.000Z", `copilot reset=${cop[0].resetsAt}`);
// Real Free-plan body (live probe 2026-08-29): premium not included → skipped, not 100%.
const copLive = parseCopilotUser({
  copilot_plan: "individual",
  access_type_sku: "free_limited_copilot",
  quota_reset_date: "2026-09-01",
  quota_reset_date_utc: "2026-09-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: false, has_quota: true, remaining: 200, entitlement: 200 },
    completions: { percent_remaining: 82.4, unlimited: false, has_quota: true, credits_used: 351, remaining: 1649, entitlement: 2000 },
    premium_interactions: { percent_remaining: 0, unlimited: false, has_quota: false, remaining: 0, entitlement: 0 },
  },
});
console.assert(copLive.length === 2 && copLive.every((b) => b.label !== "Premium requests"), `copilot live=${JSON.stringify(copLive.map((b) => b.label))}`);
console.assert(copLive[1].label === "Completions" && Math.round(copLive[1].percent * 10) === 176 && copLive[1].note === "351 / 2,000", `copilot completions=${JSON.stringify(copLive[1])}`);
console.assert(copLive[0].resetsAt === "2026-09-01T00:00:00.000Z", `copilot live reset=${copLive[0].resetsAt}`);
const copFree = parseCopilotUser({ quota_snapshots: { chat: { entitlement: 50, remaining: 20 }, premium_interactions: { entitlement: 50, remaining: 50 } } });
console.assert(copFree.length === 2 && copFree[0].label === "Premium requests" && copFree[0].percent === 0, `copilot free=${JSON.stringify(copFree)}`);
console.assert(copFree[1].label === "Chat" && copFree[1].percent === 60, `copilot chat=${JSON.stringify(copFree[1])}`);
console.assert(parseCopilotUser({}).length === 0 && parseCopilotUser({ quota_snapshots: null }).length === 0, "copilot empty not zero");

// Cursor: usage-summary in cents → "$ used / $ limit"; on-demand only with a limit.
const cur = parseCursorSummary({
  billingCycleStart: "2026-08-12T00:00:00.000Z",
  billingCycleEnd: "2026-09-12T00:00:00.000Z",
  membershipType: "pro",
  individualUsage: { plan: { used: 920, limit: 2000, remaining: 1080 }, onDemand: { used: 0, limit: 0 } },
});
console.assert(cur.length === 1, `cursor summary len=${cur.length}`);
console.assert(cur[0].provider === "cursor" && cur[0].label === "Included usage" && cur[0].percent === 46, `cursor bucket=${JSON.stringify(cur[0])}`);
console.assert(cur[0].note === "$9.2 / $20" && cur[0].resetsAt === "2026-09-12T00:00:00.000Z", `cursor note/reset=${cur[0].note} ${cur[0].resetsAt}`);
console.assert(parseCursorSummary({}).length === 0, "cursor summary empty not zero");

// Cursor legacy counters: gpt-4 requests of max; reset = startOfMonth + 1 month.
const legacyCur = parseCursorUsage({
  "gpt-4": { numRequests: 123, numRequestsTotal: 123, numTokens: 0, maxRequestUsage: 500, maxTokenUsage: null },
  "gpt-3.5-turbo": { numRequests: 0, maxRequestUsage: null },
  startOfMonth: "2026-08-05T12:00:00.000Z",
});
console.assert(legacyCur.length === 1 && legacyCur[0].percent === 24.6 && legacyCur[0].note === "123 / 500", `cursor legacy=${JSON.stringify(legacyCur)}`);
console.assert(legacyCur[0].resetsAt === "2026-09-05T12:00:00.000Z", `cursor legacy reset=${legacyCur[0].resetsAt}`);
console.assert(parseCursorUsage({ "gpt-4": { numRequests: 5, maxRequestUsage: null } }).length === 0, "cursor unlimited leaked");

// Cursor JWT extraction from raw DB text: latest exp wins, junk ignored.
const jwt = (exp: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "google-oauth2|user_01ABC", exp, type: "session" })).toString("base64url")}.c2ln`;
const raw = `garbage cursorAuth/accessToken${jwt(100)} more cursorAuth/accessToken":1 cursorAuth/accessToken${jwt(200)} tail`;
const got = extractCursorJwt(raw);
console.assert(got?.exp === 200 && got.sub === "google-oauth2|user_01ABC" && got.jwt === jwt(200), `cursor jwt=${JSON.stringify(got)}`);
console.assert(extractCursorJwt("no tokens here") === null, "cursor jwt from nothing");

console.log("quota copilot/cursor parse: OK");

// Gemini: per-model worst token type, used% = 1 - remainingFraction, worst-first; no fraction → dropped.
const gem = parseGeminiQuota({
  buckets: [
    { modelId: "gemini-2.5-flash", tokenType: "REQUESTS", remainingFraction: 0.9, resetTime: "2026-08-31T07:00:00Z" },
    { modelId: "gemini-2.5-pro", tokenType: "REQUESTS", remainingFraction: 0.4, resetTime: "2026-08-31T07:00:00Z" },
    { modelId: "gemini-2.5-pro", tokenType: "TOKENS", remainingFraction: 0.7 },
    { modelId: "gemini-3-pro-preview", tokenType: "REQUESTS" },
  ],
});
console.assert(gem.length === 2, `gemini len=${gem.length}`);
console.assert(gem[0].provider === "gemini" && gem[0].kind === "gemini_daily" && gem[0].label === "Daily · Pro", `gemini0=${JSON.stringify(gem[0])}`);
console.assert(Math.round(gem[0].percent) === 60 && gem[0].resetsAt === "2026-08-31T07:00:00Z", `gemini pct/reset=${gem[0].percent} ${gem[0].resetsAt}`);
console.assert(gem[1].label === "Daily · Flash" && Math.round(gem[1].percent) === 10, `gemini1=${JSON.stringify(gem[1])}`);
console.assert(parseGeminiQuota({}).length === 0, "gemini empty not zero");
console.log("quota gemini parse: OK");
