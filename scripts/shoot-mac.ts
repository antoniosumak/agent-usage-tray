import { app, BrowserWindow, nativeTheme, screen, Tray } from "electron";
import { execFileSync } from "node:child_process";
import * as path from "path";
import * as fs from "fs";
import { fakeState } from "../src/main/fake";
import { defaultSettings } from "../src/main/settings";
import { createMenuBarRenderer, createTray, popupPosition, MENU_BAR_H, MENU_BAR_W } from "../src/main/tray";

// macOS screenshot driver. Mounts the real menu bar item (offscreen widget.html
// -> tray image) with canned state, then:
//   mac-menubar.png        real menu bar via `screencapture`, item among system icons
//   mac-popup.png          real menu bar + popup hanging below it (neutral backdrop)
//   mac-menubar-item-*.png the transparent 2x item bitmap, light + dark ink
//   mac-menubar-strip-*.png the item on a plain menu-bar-coloured strip, light + dark
// The real shots use the system's current appearance: macOS picks menu bar ink
// from the wallpaper, not from dark mode, so we don't toggle anything.
// Needs Screen Recording permission for the terminal running it.
//   npx esbuild scripts/shoot-mac.ts --bundle --platform=node --external:electron --outfile=dist/shoot-mac.js && npx electron dist/shoot-mac.js
const dist = path.join(__dirname, "..", "dist");
const out = path.join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });

const f = fakeState(1); // session 45%
const snapshot = { ...f, settings: defaultSettings, update: null, range: "today", version: app.getVersion() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const grab = (name: string, r: { x: number; y: number; width: number; height: number }) => {
  execFileSync("screencapture", ["-x", "-t", "png", `-R${r.x},${r.y},${r.width},${r.height}`, path.join(out, name)]);
  console.log("wrote", name, `${r.width}x${r.height}pt`);
};
const write = (name: string, img: Electron.NativeImage) => {
  fs.writeFileSync(path.join(out, name), img.toPNG());
  console.log("wrote", name, `${img.getSize().width}x${img.getSize().height}`);
};

const load = (win: BrowserWindow, file: string) =>
  new Promise<void>((res) => {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("state", snapshot);
      setTimeout(res, 800);
    });
    win.loadFile(path.join(dist, file));
  });

app.whenReady().then(async () => {
  app.dock?.hide();
  const popup = new BrowserWindow({
    width: 360, height: 560, show: false, frame: false, resizable: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(dist, "preload.js") },
  });
  const tray: Tray = createTray(popup);
  const off = createMenuBarRenderer(tray);
  let lastPaint: Electron.NativeImage | null = null;
  const firstPaint = new Promise<void>((res) => off.webContents.once("paint", () => res()));
  off.webContents.on("paint", (_e, _d, img) => (lastPaint = img));
  await Promise.all([load(popup, "index.html"), load(off, "widget.html"), firstPaint]);
  await sleep(700); // the state-fed repaint lands after the first (empty) frame; let the bar re-layout

  // --- real shots, system appearance ---
  const tb = tray.getBounds();
  const menuBarH = tb.y * 2 + tb.height; // item is vertically centred in the bar
  const PAD = 160; // neighbouring system icons for context
  grab("mac-menubar.png", { x: tb.x - PAD, y: 0, width: tb.width + PAD * 2, height: menuBarH });

  // Neutral backdrop under the popup so the shot doesn't pick up whatever
  // windows happen to be open.
  const disp = screen.getPrimaryDisplay();
  const backdrop = new BrowserWindow({ ...disp.bounds, show: false, frame: false, focusable: false, hasShadow: false });
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark
    ? "radial-gradient(120% 90% at 30% 0%, #3b3f5c 0%, #1a1c26 55%, #0e0f14 100%)"
    : "radial-gradient(120% 90% at 30% 0%, #fde7d9 0%, #e9e4f3 55%, #cfd9ea 100%)";
  await backdrop.loadURL(`data:text/html,<body style="margin:0;height:100vh;background:${encodeURIComponent(bg)}"></body>`);
  backdrop.showInactive();
  const { x, y } = popupPosition(tb, popup);
  popup.setPosition(x, y);
  popup.show();
  await sleep(900);
  const pb = popup.getBounds();
  const left = Math.min(pb.x, tb.x) - 24;
  const right = Math.max(pb.x + pb.width, tb.x + tb.width) + 24;
  grab("mac-popup.png", { x: left, y: 0, width: right - left, height: pb.y + pb.height + 24 });
  popup.hide();
  backdrop.hide();

  // --- rendered item + strip, both inks ---
  const strip = new BrowserWindow({ width: 320, height: menuBarH, show: false, frame: false, webPreferences: { zoomFactor: 1 } });
  for (const theme of ["light", "dark"] as const) {
    nativeTheme.themeSource = theme;
    await sleep(700); // offscreen renderer repaints on the scheme change
    if (!lastPaint) continue;
    write(`mac-menubar-item-${theme}.png`, lastPaint);
    const data = lastPaint.toPNG().toString("base64");
    const stripBg = theme === "dark" ? "#26262b" : "#e9e2df";
    await strip.loadURL(
      `data:text/html,` +
        encodeURIComponent(
          `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:${stripBg}">` +
            `<img src="data:image/png;base64,${data}" style="width:${MENU_BAR_W}px;height:${MENU_BAR_H}px"></body>`,
        ),
    );
    await sleep(300);
    write(`mac-menubar-strip-${theme}.png`, await strip.webContents.capturePage());
  }
  nativeTheme.themeSource = "system";
  app.quit();
});
