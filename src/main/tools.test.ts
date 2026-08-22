// Runnable check for tool-cost attribution. Not imported by the app.
// Run: npx esbuild src/main/tools.test.ts --bundle --platform=node --external:electron --outfile=dist/tools.test.js && node dist/tools.test.js
import { messageCost, attribute, toolNames, RESPONSE_BUCKET, Rates, ToolCost } from "./tools";

const rates: Rates = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 2 };
const cost = messageCost(
  { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 },
  rates,
);
console.assert(cost === 1 + 10 + 1 + 2, `cost=${cost}`);

console.assert(JSON.stringify(toolNames([{ type: "tool_use", name: "Read" }, { type: "text" }])) === '["Read"]');

const m = new Map<string, ToolCost>();
attribute(10, ["Read", "Bash", "Read"], m); // 3 blocks → 10/3 each, Read twice
console.assert(m.get("Read")!.calls === 2 && Math.abs(m.get("Read")!.cost - 20 / 3) < 1e-9);
console.assert(Math.abs(m.get("Bash")!.cost - 10 / 3) < 1e-9);
attribute(5, [], m); // no tools → response bucket
console.assert(m.get(RESPONSE_BUCKET)!.cost === 5);

console.log("tools.ts self-check ok");
