// Runnable check for the project-dir demangling heuristic. Not imported by the app.
// Run: npx esbuild src/main/projects.test.ts --bundle --platform=node --external:electron --outfile=dist/projects.test.js && node dist/projects.test.js
import { displayName } from "./projects";

// Drive prefix ("C--") stripped; best-effort last "-" segment survives.
console.assert(displayName("C--Projects-agent-usage") === "usage", displayName("C--Projects-agent-usage"));
console.assert(displayName("D--work-app") === "app", displayName("D--work-app"));
// No drive prefix (e.g. a POSIX-mangled name) still yields the last segment.
console.assert(displayName("home-me-proj") === "proj", displayName("home-me-proj"));
// Degenerate input falls back to the raw dir name rather than "".
console.assert(displayName("") === "", `empty=${displayName("")}`);
console.assert(displayName("C--") === "C--", `drive-only=${displayName("C--")}`);

console.log("projects.ts self-check ok");
