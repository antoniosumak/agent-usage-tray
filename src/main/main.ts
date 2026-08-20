import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { createTray, updateTray } from "./tray";
import { initialQuotaState, startQuota, QuotaState } from "./quota";

const POLL_INTERVAL_MS = 5 * 60_000; // hardcoded until settings (step 5)

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 360,
      height: 480,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, "preload.js") },
    });
    win.loadFile(path.join(__dirname, "index.html"));
    win.on("blur", () => win.hide());
    const tray = createTray(win);

    let quota: QuotaState = initialQuotaState;
    const push = () => {
      win.webContents.send("state", { quota });
      updateTray(tray, quota);
    };

    const quotaPoller = startQuota(POLL_INTERVAL_MS, (s) => {
      quota = s;
      push();
    });

    ipcMain.on("refresh", () => quotaPoller.refreshNow());
    win.webContents.on("did-finish-load", push);
  });

  // tray app: keep running with no windows visible
  app.on("window-all-closed", () => {});
}
