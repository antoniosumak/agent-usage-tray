import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { createTray, updateTray } from "./tray";
import { initialQuotaState, startQuota, QuotaState } from "./quota";
import { initialCostState, startCost, CostState } from "./cost";
import { applyLoginItem, loadSettings, sanitizeSettings, saveSettings } from "./settings";
import { checkThreshold } from "./notify";
import { openReleasePage, startUpdates, UpdateInfo } from "./updates";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("io.bozic.agent-usage"); // Windows toasts need an AUMID
  app.whenReady().then(() => {
    let settings = loadSettings();
    applyLoginItem(settings);
    const intervalMs = () => settings.refreshMinutes * 60_000;

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
    let update: UpdateInfo | null = null;
    const push = () => {
      win.webContents.send("state", { quota, cost, settings, update });
      updateTray(tray, quota);
    };

    startUpdates((u) => {
      update = u;
      push();
    });
    ipcMain.on("open-update", openReleasePage);

    const quotaPoller = startQuota(intervalMs(), (s) => {
      quota = s;
      checkThreshold(quota, settings.warnThresholdPct);
      push();
    });
    const costPoller = startCost(intervalMs(), (s) => {
      cost = s;
      push();
    });

    ipcMain.on("refresh", () => {
      quotaPoller.refreshNow();
      costPoller.refreshNow();
    });
    ipcMain.on("set-settings", (_event, patch) => {
      settings = sanitizeSettings({ ...settings, ...(patch ?? {}) });
      saveSettings(settings);
      applyLoginItem(settings);
      quotaPoller.setIntervalMs(intervalMs());
      costPoller.setIntervalMs(intervalMs());
      push();
    });
    win.webContents.on("did-finish-load", push);
  });

  // tray app: keep running with no windows visible
  app.on("window-all-closed", () => {});
}
