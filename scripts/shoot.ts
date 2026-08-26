import { app, BrowserWindow, nativeTheme } from "electron";
import * as path from "path";
import * as fs from "fs";
import { fakeState } from "../src/main/fake";
import { defaultSettings } from "../src/main/settings";

// Standalone screenshot driver. Reuses the built dist/ assets + canned fake
// state to grab README/website shots without a real ~/.claude or a token.
// 3x device scale => high-res PNGs suitable for a marketing site.
const SCALE = 6; // display scale bends this; measured dpr (~half) drives the real res
app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
app.commandLine.appendSwitch("high-dpi-support", "1");

const dist = path.join(__dirname, "..", "dist");
const out = path.join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });

const f = fakeState(1); // tick 1 => session 45%, all buckets populated
const snapshot = { ...f, settings: defaultSettings, update: null, range: "today", version: app.getVersion() };

const load = (win: BrowserWindow, file: string) =>
  new Promise<void>((res) => {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("state", snapshot);
      setTimeout(res, 600); // let the render + width transitions settle
    });
    win.loadFile(path.join(dist, file));
  });

const shoot = async (win: BrowserWindow, name: string) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), img.toPNG());
  console.log("wrote", name, `${img.getSize().width}x${img.getSize().height}`);
};

// Sections in the scroller + the quota card at the top. Keyed to the selectors
// the renderer uses; label drives the output filename.
const SECTIONS: [string, string][] = [
  ["#quota", "section-quota"],
  ['[data-section="cost"]', "section-cost"],
  ['[data-section="burn"]', "section-burn"],
  ['[data-section="blocks"]', "section-blocks"],
  ['[data-section="heatmap"]', "section-heatmap"],
  ['[data-section="tools"]', "section-tools"],
  ['[data-section="projects"]', "section-projects"],
];

// Full popup + per-section crops for one theme. Uses a tall window so every
// section is laid out and unclipped by the scroller before cropping.
const shootTheme = async (theme: "light" | "dark") => {
  nativeTheme.themeSource = theme;
  const pre = { preload: path.join(dist, "preload.js") };

  const popup = new BrowserWindow({ width: 360, height: 560, show: false, frame: false, webPreferences: pre });
  await load(popup, "index.html");
  await shoot(popup, `popup-${theme}.png`);

  // Settings view.
  await popup.webContents.executeJavaScript("document.getElementById('open-settings').click(); true");
  await new Promise((r) => setTimeout(r, 400));
  await shoot(popup, `settings-${theme}.png`);

  // Back to main; drop the scroller's edge-fade mask + let it lay out as one
  // column so every section sits at its true document position.
  await popup.webContents.executeJavaScript(`
    document.getElementById('close-settings').click();
    document.querySelectorAll('[data-scroll-fade]').forEach(e => { e.style.maskImage='none'; e.style.webkitMaskImage='none'; });
    document.getElementById('scroller').style.overflow='visible';
    true`);
  const h = await popup.webContents.executeJavaScript(
    "Math.ceil(document.getElementById('view-main').scrollHeight)",
  );
  popup.setContentSize(360, Math.max(560, h + 8));
  await new Promise((r) => setTimeout(r, 500));

  // One full-page capture; crop sections out of it in-process via nativeImage.crop
  // (coords are DIP × device scale). Avoids per-rect capturePage returning blank
  // for below-the-fold regions and avoids resize churn that crashed the GPU.
  const full = await popup.webContents.capturePage();
  fs.writeFileSync(path.join(out, `popup-full-${theme}.png`), full.toPNG());
  console.log("wrote", `popup-full-${theme}.png`, `${full.getSize().width}x${full.getSize().height}`);

  const rects = await popup.webContents.executeJavaScript(`(() => {
    const sels = ${JSON.stringify(SECTIONS.map(([s]) => s))};
    return sels.map(s => { const el = document.querySelector(s); if (!el) return null;
      const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
  })()`);
  // capturePage renders at the page's real devicePixelRatio, which the OS display
  // scale can bend away from force-device-scale-factor (here 3 -> 1.5). Crop in
  // image pixels = CSS rect × the measured dpr, not the requested SCALE.
  const dpr: number = await popup.webContents.executeJavaScript("devicePixelRatio");
  const PAD = 6; // < the 8px inter-card gap, so a crop never catches a neighbour
  SECTIONS.forEach(([, name], i) => {
    const r = rects[i];
    if (!r || r.width === 0) { console.log("skip (empty)", name); return; }
    const rect = {
      x: Math.max(0, Math.round((r.x - PAD) * dpr)),
      y: Math.max(0, Math.round((r.y - PAD) * dpr)),
      width: Math.round((r.width + PAD * 2) * dpr),
      height: Math.round((r.height + PAD * 2) * dpr),
    };
    const crop = full.crop(rect);
    fs.writeFileSync(path.join(out, `${name}-${theme}.png`), crop.toPNG());
    console.log("wrote", `${name}-${theme}.png`, `${crop.getSize().width}x${crop.getSize().height}`);
  });
  // Don't destroy() — a window created after a destroy hangs on did-finish-load
  // (Windows offscreen quirk). Leave it; app.quit() cleans up at the end.
  popup.hide();
};

app.whenReady().then(async () => {
  await shootTheme("light");
  await shootTheme("dark");

  // Widget — transparent surface, carries its own dark chrome.
  const widget = new BrowserWindow({ width: 212, height: 40, show: false, frame: false, transparent: true, webPreferences: { preload: path.join(dist, "preload.js") } });
  await load(widget, "widget.html");
  await shoot(widget, "widget.png");

  app.quit();
});
