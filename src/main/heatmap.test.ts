// Runnable check for hour-of-day token bucketing. Not imported by the app.
// Run: npx esbuild src/main/heatmap.test.ts --bundle --platform=node --external:electron --outfile="%TEMP%/heatmap.test.js" && node "%TEMP%/heatmap.test.js"
import { bucketByHour } from "./heatmap";
import { Msg } from "./tools";

// Local-time timestamps so new Date(ts).getHours() lands in a known bucket.
const at = (hour: number, usage: any): Msg => ({
  ts: new Date(2026, 0, 15, hour, 30, 0).getTime(),
  model: "claude",
  usage,
  names: [],
  project: "p",
});

const full = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }; // = 10

const hours = bucketByHour([
  at(9, { input_tokens: 5 }),
  at(9, full), // hour 9 also gets 10 → 15 total
  at(14, full), // hour 14 → 10
  at(0, {}), // hour 0, no usage → 0
]);

console.assert(hours.length === 24, `len=${hours.length}`);
console.assert(hours[9] === 15, `hours[9]=${hours[9]}`);
console.assert(hours[14] === 10, `hours[14]=${hours[14]}`);
console.assert(hours[0] === 0, `hours[0]=${hours[0]}`);
console.assert(hours[3] === 0, `hours[3]=${hours[3]}`); // untouched bucket
console.assert(hours.reduce((n, t) => n + t, 0) === 25, `total=${hours.reduce((n, t) => n + t, 0)}`);

console.log("heatmap.ts self-check ok");
