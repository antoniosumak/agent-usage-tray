// Runnable check for section sanitize (order kept, unknown dropped, new appended).
// Run (settings.ts imports electron, so stub it — the test never calls app.getPath):
//   echo module.exports={app:{getPath:()=>'.'}}; > "%TEMP%/estub.js"
//   npx esbuild src/main/settings.test.ts --bundle --platform=node --alias:electron="%TEMP%/estub.js" --outfile="%TEMP%/settings.test.js" && node "%TEMP%/settings.test.js"
import { sanitizeSettings, SECTION_IDS } from "./settings";

// Missing/invalid → all sections, default order, visible.
const def = sanitizeSettings({}).sections;
console.assert(def.length === SECTION_IDS.length, "all sections by default");
console.assert(def.every((s) => s.visible), "visible by default");
console.assert(def.map((s) => s.id).join() === SECTION_IDS.join(), "default order");

// Custom order + a hidden one + an unknown id + a duplicate. Unknown/dupe dropped,
// user order preserved, and any omitted section appended visible at the end.
const raw = [
  { id: "burn", visible: false },
  { id: "cost", visible: true },
  { id: "burn", visible: true }, // duplicate → ignored
  { id: "bogus", visible: true }, // unknown → dropped
];
const out = sanitizeSettings({ sections: raw }).sections;
console.assert(out[0].id === "burn" && out[0].visible === false, "kept order + hidden");
console.assert(out[1].id === "cost", "second stays cost");
console.assert(!out.some((s) => s.id === "bogus"), "unknown dropped");
console.assert(out.filter((s) => s.id === "burn").length === 1, "no duplicate");
console.assert(out.length === SECTION_IDS.length, "missing sections appended");
console.assert(
  out.slice(2).every((s) => s.visible),
  "appended sections visible",
);

// quotaProvider: default null, valid string kept, non-string ignored.
console.assert(sanitizeSettings({}).quotaProvider === null, "quotaProvider default null");
console.assert(sanitizeSettings({ quotaProvider: "codex" }).quotaProvider === "codex", "quotaProvider kept");
console.assert(sanitizeSettings({ quotaProvider: 7 }).quotaProvider === null, "quotaProvider non-string ignored");

console.log("settings.test ok");
