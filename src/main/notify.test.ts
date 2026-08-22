// Runnable check for the once-per-episode notification dedup.
// Run: npx esbuild src/main/notify.test.ts --bundle --platform=node --external:electron --outfile="%TEMP%/notify.test.js" && node "%TEMP%/notify.test.js"
// (macOS/Linux: use $TMPDIR in place of %TEMP% — the outfile just must NOT be dist/.)
import { shouldNotify } from "./notify";

const W = "2026-08-22T12:00:00Z";
const T = 80;

// Crosses threshold once → fires once, then stays quiet while still above.
console.assert(shouldNotify(85, W, T) === true, "first cross fires");
console.assert(shouldNotify(86, W, T) === false, "still above, same window: quiet");
console.assert(shouldNotify(99, W, T) === false, "still above: quiet");

// Drops below → re-arms → firing again on the next cross.
console.assert(shouldNotify(50, W, T) === false, "below threshold: no fire");
console.assert(shouldNotify(85, W, T) === true, "re-armed after drop: fires");

// New window (different resets_at) re-arms even without dropping below.
console.assert(shouldNotify(90, "2026-08-22T17:00:00Z", T) === true, "new window fires");
console.assert(shouldNotify(90, "2026-08-22T17:00:00Z", T) === false, "same new window: quiet");

// null resets_at still dedups (the original jitter bug).
shouldNotify(10, null, T); // re-arm
console.assert(shouldNotify(88, null, T) === true, "null window fires once");
console.assert(shouldNotify(88, null, T) === false, "null window: quiet after");

console.log("notify.test.ts OK");
