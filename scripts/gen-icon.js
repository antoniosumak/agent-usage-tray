// Generates build/icon.ico (256px, single PNG-format ICO entry) and
// build/icon.png (1024px; electron-builder converts it to .icns for mac):
// the tray quota-ring design (75% green arc), rendered via nativeImage.
// Run with: npx electron scripts/gen-icon.js
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

function ringPng(size) {
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const c = (size - 1) / 2;
  const rOuter = size / 2 - size / 32;
  const rInner = rOuter - size * 0.28;
  const frac = 0.75;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > rOuter || dist < rInner) continue;
      let angle = Math.atan2(dx, -dy); // clockwise from 12 o'clock
      if (angle < 0) angle += Math.PI * 2;
      const i = (y * size + x) * 4;
      if (angle <= frac * Math.PI * 2) {
        buf[i] = 94; // green-500
        buf[i + 1] = 197;
        buf[i + 2] = 34;
        buf[i + 3] = 255;
      } else {
        buf[i] = 128;
        buf[i + 1] = 128;
        buf[i + 2] = 128;
        buf[i + 3] = 96;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG();
}

function pngToIco(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  header.writeUInt8(size >= 256 ? 0 : size, 6); // width (0 = 256)
  header.writeUInt8(size >= 256 ? 0 : size, 7); // height
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // data offset
  return Buffer.concat([header, png]);
}

const buildDir = path.join(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });
const ico = path.join(buildDir, "icon.ico");
fs.writeFileSync(ico, pngToIco(ringPng(256), 256));
console.log(`wrote ${ico}`);
const png = path.join(buildDir, "icon.png");
fs.writeFileSync(png, ringPng(1024));
console.log(`wrote ${png}`);
app.quit();
