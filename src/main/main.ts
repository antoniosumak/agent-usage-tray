import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { createTray, updateTray } from "./tray";
import { initialQuotaState, startQuota, QuotaState } from "./quota";
import { initialCostState, startCost, CostState } from "./cost";

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
    let cost: CostState = initialCostState;
    const push = () => {
      win.webContents.send("state", { quota, cost });
      updateTray(tray, quota);
    };

    const quotaPoller = startQuota(POLL_INTERVAL_MS, (s) => {
      quota = s;
      push();
    });
    const costPoller = startCost(POLL_INTERVAL_MS, (s) => {
      cost = s;
      push();
    });

    ipcMain.on("refresh", () => {
      quotaPoller.refreshNow();
      costPoller.refreshNow();
    });
    win.webContents.on("did-finish-load", push);
  });

  // tray app: keep running with no windows visible
  app.on("window-all-closed", () => {});
}
