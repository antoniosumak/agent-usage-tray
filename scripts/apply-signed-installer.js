// Replace the unsigned installer with the SignPath-signed one and repair the
// electron-updater metadata (latest.yml sha512/size + .blockmap), which the
// signature invalidates.
//
// Usage: node scripts/apply-signed-installer.js <signed-dir> <release-dir>
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [signedDir, releaseDir] = process.argv.slice(2);
if (!signedDir || !releaseDir) {
  console.error("usage: node scripts/apply-signed-installer.js <signed-dir> <release-dir>");
  process.exit(1);
}

function findExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExe(p);
      if (found) return found;
    } else if (entry.name.endsWith(".exe")) {
      return p;
    }
  }
  return null;
}

const signedExe = findExe(signedDir);
if (!signedExe) throw new Error(`no .exe found under ${signedDir}`);
const targetExe = path.join(releaseDir, path.basename(signedExe));
if (!fs.existsSync(targetExe)) throw new Error(`unsigned counterpart missing: ${targetExe}`);

const latestYmlPath = path.join(releaseDir, "latest.yml");
let latestYml = fs.readFileSync(latestYmlPath, "utf8");
const oldSha512 = crypto.createHash("sha512").update(fs.readFileSync(targetExe)).digest("base64");
const oldSize = fs.statSync(targetExe).size;

fs.copyFileSync(signedExe, targetExe);

// Regenerate the differential-update blockmap with electron-builder's bundled
// app-builder binary.
const { appBuilderPath } = require("app-builder-bin");
execFileSync(appBuilderPath, ["blockmap", "--input", targetExe, "--output", `${targetExe}.blockmap`], {
  stdio: ["ignore", "inherit", "inherit"],
});

const newSha512 = crypto.createHash("sha512").update(fs.readFileSync(targetExe)).digest("base64");
const newSize = fs.statSync(targetExe).size;
latestYml = latestYml.split(oldSha512).join(newSha512).split(String(oldSize)).join(String(newSize));
fs.writeFileSync(latestYmlPath, latestYml);

console.log(`signed installer applied: ${path.basename(targetExe)}`);
console.log(`sha512 ${oldSha512.slice(0, 12)}... -> ${newSha512.slice(0, 12)}...`);
console.log(`size ${oldSize} -> ${newSize}`);
