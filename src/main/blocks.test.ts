// Runnable check for 5h-block bucketing. Not imported by the app.
// Run: npx esbuild src/main/blocks.test.ts --bundle --platform=node --external:electron --outfile="%TEMP%/blocks.test.js" && node "%TEMP%/blocks.test.js"
import { blockStart, bucketBlocks } from "./blocks";

const H = 60 * 60_000;
const BLOCK = 5 * H;

// Clock-aligned floor: two timestamps in the same 5h window share a start.
const base = blockStart(Date.parse("2026-08-21T12:00:00Z")); // some window start
console.assert(blockStart(base + 1) === base, "start of window");
console.assert(blockStart(base + BLOCK - 1) === base, "end of window");
console.assert(blockStart(base + BLOCK) === base + BLOCK, "next window");
console.assert(base % BLOCK === 0, "aligned to 5h step from epoch");

// Two messages in one window sum; a third in the next window is its own block.
const now = base + 2 * H; // "now" sits inside the `base` window
const blocks = bucketBlocks(
  [
    { ts: base + 1 * H, cost: 1.0, tokens: 100 },
    { ts: base + 3 * H, cost: 0.5, tokens: 50 },
    { ts: base + BLOCK + 1 * H, cost: 2.0, tokens: 200 }, // next (future) window
  ],
  now,
);

console.assert(blocks.length === 2, `blocks=${blocks.length}`);
// Sorted most-recent-first: future window leads.
console.assert(blocks[0].start === base + BLOCK && blocks[1].start === base, "sorted desc");
// Costs/tokens sum per block.
console.assert(Math.abs(blocks[1].cost - 1.5) < 1e-9 && blocks[1].tokens === 150, "base block sums");
console.assert(Math.abs(blocks[0].cost - 2.0) < 1e-9 && blocks[0].tokens === 200, "next block");
// Only the window containing `now` is active.
console.assert(blocks[1].active === true && blocks[0].active === false, "active flag");

// Cap: 20 windows collapse to the 8 most recent.
const many = Array.from({ length: 20 }, (_, i) => ({ ts: base + i * BLOCK, cost: 1, tokens: 1 }));
console.assert(bucketBlocks(many, now).length === 8, "capped to 8");

console.log("blocks.ts self-check ok");
