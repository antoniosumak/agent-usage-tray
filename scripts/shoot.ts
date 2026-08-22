import { app, BrowserWindow, nativeTheme } from "electron";
import * as path from "path";
import * as fs from "fs";
import { fakeState } from "../src/main/fake";
import { defaultSettings } from "../src/main/settings";

// Standalone screenshot driver. Reuses the built dist/ assets + canned fake
// state to grab README shots without a real ~/.claude or a token.
const dist = path.join(__dirname, "..", "dist");
const out = path.join(__dirname, "..", "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });

const f = fakeState(1); // tick 1 => session 45% (green-ish), other buckets populated
const snapshot = { ...f, settings: defaultSettings, update: null, range: "today", version: app.getVersion() };

const load = (win: BrowserWindow, file: string) =>
  new Promise<void>((res) => {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("state", snapshot);
      setTimeout(res, 500); // let the render + width transitions settle
    });
    win.loadFile(path.join(dist, file));
  });

const shoot = async (win: BrowserWindow, name: string) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), img.toPNG());
  console.log("wrote", name);
};

app.whenReady().then(async () => {
  const pre = { preload: path.join(dist, "preload.js") };

  // Popup — light
  nativeTheme.themeSource = "light";
  const popup = new BrowserWindow({ width: 360, height: 560, show: false, frame: false, webPreferences: pre });
  await load(popup, "index.html");
  await shoot(popup, "popup-light.png");

  // Settings view (same window, toggle via the button)
  await popup.webContents.executeJavaScript(
    "document.getElementById('open-settings').click(); true",
  );
  await new Promise((r) => setTimeout(r, 400));
  await shoot(popup, "settings.png");

  // Popup — dark
  nativeTheme.themeSource = "dark";
  const popupDark = new BrowserWindow({ width: 360, height: 560, show: false, frame: false, webPreferences: pre });
  await load(popupDark, "index.html");
  await shoot(popupDark, "popup-dark.png");

  // Widget — transparent surface, its own dark chrome
  const widget = new BrowserWindow({ width: 212, height: 40, show: false, frame: false, transparent: true, webPreferences: pre });
  await load(widget, "widget.html");
  await shoot(widget, "widget.png");

  app.quit();
});
