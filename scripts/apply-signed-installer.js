// Replace the unsigned installer with the SignPath-signed one and repair the
// electron-updater metadata (latest.yml sha512/size + .blockmap), which the
// signature invalidates.
//
// Usage: node scripts/apply-signed-installer.js <signed-dir> <release-dir>
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

async function main() {
  const latestYmlPath = path.join(releaseDir, "latest.yml");
  let latestYml = fs.readFileSync(latestYmlPath, "utf8");
  const oldSha512 = crypto.createHash("sha512").update(fs.readFileSync(targetExe)).digest("base64");
  const oldSize = fs.statSync(targetExe).size;

  fs.copyFileSync(signedExe, targetExe);

  // Regenerate the differential-update blockmap (electron-builder >= 26 builds
  // it in JS; the standalone .blockmap file is gzip-compressed).
  const blockmapModule = require.resolve("app-builder-lib/out/targets/blockmap/blockmap", {
    paths: [process.cwd(), path.join(__dirname, "..")],
  });
  const { buildBlockMap } = require(blockmapModule);
  const { sha512: newSha512, size: newSize } = await buildBlockMap(targetExe, "gzip", `${targetExe}.blockmap`);

  latestYml = latestYml.split(oldSha512).join(newSha512).split(String(oldSize)).join(String(newSize));
  fs.writeFileSync(latestYmlPath, latestYml);

  console.log(`signed installer applied: ${path.basename(targetExe)}`);
  console.log(`sha512 ${oldSha512.slice(0, 12)}... -> ${newSha512.slice(0, 12)}...`);
  console.log(`size ${oldSize} -> ${newSize}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
