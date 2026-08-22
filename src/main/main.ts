import { app, BrowserWindow, ipcMain, Menu } from "electron";
import * as path from "path";
import { createTray, popupPosition, updateTray } from "./tray";
import { createWidget, watchWidgetClicks } from "./widget";
import { initialQuotaState, startQuota, QuotaState } from "./quota";
import { initialCostState, startCost, CostState, Range } from "./cost";
import { initialToolState, startTools, ToolState } from "./tools";
import { initialHeatmapState, startHeatmap, HeatmapState } from "./heatmap";
import { initialProjectState, startProjects, ProjectState } from "./projects";
import { initialBlockState, startBlocks, BlockState } from "./blocks";
import { initialBurnState, startBurn, etaFromSamples, BurnState } from "./burnrate";
import { applyLoginItem, loadSettings, sanitizeSettings, saveSettings } from "./settings";
import { checkThreshold } from "./notify";
import { installUpdate, startUpdates, UpdateInfo } from "./updates";

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
    const widget = createWidget();

    let quota: QuotaState = initialQuotaState;
    let cost: CostState = initialCostState;
    let tools: ToolState = initialToolState;
    let heatmap: HeatmapState = initialHeatmapState;
    let projects: ProjectState = initialProjectState;
    let blocks: BlockState = initialBlockState;
    let burn: BurnState = initialBurnState;
    let update: UpdateInfo | null = null;
    let range: Range = "today";

    // In-memory ring of recent session-quota readings. The usage API only gives
    // a current percent (no history), so we sample it here over time and fit a
    // line to extrapolate a session-cap ETA. ponytail: bursty signal, rough guide.
    const RING_MS = 60 * 60_000; // keep ~last hour of samples
    let sessionRing: { t: number; pct: number }[] = [];
    let sessionEta: number | null = null;
    const recordSessionPct = (q: QuotaState) => {
      const b = q.buckets.find((x) => x.kind === "session");
      if (!b) return;
      const now = Date.now();
      sessionRing.push({ t: now, pct: b.percent });
      sessionRing = sessionRing.filter((s) => now - s.t <= RING_MS);
      sessionEta = etaFromSamples(sessionRing);
    };

    const push = () => {
      const snapshot = { quota, cost, tools, heatmap, projects, blocks, burn, settings, update, range, version: app.getVersion() };
      win.webContents.send("state", snapshot);
      widget.webContents.send("state", snapshot);
      updateTray(tray, quota);
    };

    // Widget click mirrors a tray click: toggle the popup, anchored to the widget.
    let hiddenAtWidget = 0;
    win.on("hide", () => (hiddenAtWidget = Date.now()));
    const toggleFromWidget = () => {
      if (win.isVisible() || Date.now() - hiddenAtWidget < 300) {
        win.hide();
        return;
      }
      const { x, y } = popupPosition(widget.getBounds(), win);
      win.setPosition(x, y);
      win.show();
      win.focus();
    };
    watchWidgetClicks(widget, (button) => {
      if (button === "left") toggleFromWidget();
      else
        Menu.buildFromTemplate([{ label: "Quit", click: () => app.quit() }]).popup({
          window: win,
        });
    });

    startUpdates((u) => {
      update = u;
      push();
    });
    ipcMain.on("open-update", installUpdate);

    const quotaPoller = startQuota(intervalMs(), (s) => {
      quota = s;
      checkThreshold(quota, settings.warnThresholdPct);
      recordSessionPct(quota); // feeds the session-cap ETA extrapolation
      burn = { ...burn, etaMinutes: sessionEta };
      push();
    });
    const costPoller = startCost(intervalMs(), (s) => {
      cost = s;
      push();
    });
    const toolPoller = startTools(intervalMs(), (s) => {
      tools = s;
      push();
    });
    const heatmapPoller = startHeatmap(intervalMs(), (s) => {
      heatmap = s;
      push();
    });
    const projectPoller = startProjects(intervalMs(), (s) => {
      projects = s;
      push();
    });
    const blockPoller = startBlocks(intervalMs(), (s) => {
      blocks = s;
      push();
    });
    // Burn is range-independent (always "recent"), so no setRange. Main merges
    // the session-cap ETA in, since the ring buffer lives where quota lands.
    const burnPoller = startBurn(intervalMs(), (s) => {
      burn = { ...s, etaMinutes: sessionEta };
      push();
    });

    ipcMain.on("set-range", (_event, r: Range) => {
      if (r !== "today" && r !== "7d" && r !== "30d") return;
      range = r;
      costPoller.setRange(r);
      toolPoller.setRange(r);
      heatmapPoller.setRange(r);
      projectPoller.setRange(r);
      blockPoller.setRange(r);
      push();
    });
    ipcMain.on("refresh", () => {
      quotaPoller.refreshNow();
      costPoller.refreshNow();
      toolPoller.refreshNow();
      heatmapPoller.refreshNow();
      projectPoller.refreshNow();
      blockPoller.refreshNow();
      burnPoller.refreshNow();
    });
    ipcMain.on("set-settings", (_event, patch) => {
      settings = sanitizeSettings({ ...settings, ...(patch ?? {}) });
      saveSettings(settings);
      applyLoginItem(settings);
      quotaPoller.setIntervalMs(intervalMs());
      costPoller.setIntervalMs(intervalMs());
      toolPoller.setIntervalMs(intervalMs());
      heatmapPoller.setIntervalMs(intervalMs());
      projectPoller.setIntervalMs(intervalMs());
      blockPoller.setIntervalMs(intervalMs());
      burnPoller.setIntervalMs(intervalMs());
      push();
    });
    win.webContents.on("did-finish-load", push);
    widget.webContents.on("did-finish-load", push);
  });

  // tray app: keep running with no windows visible
  app.on("window-all-closed", () => {});
}
