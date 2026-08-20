import { app, BrowserWindow } from "electron";
import * as path from "path";
import { createTray } from "./tray";

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
    });
    win.loadFile(path.join(__dirname, "index.html"));
    win.on("blur", () => win.hide());
    createTray(win);
  });

  // tray app: keep running with no windows visible
  app.on("window-all-closed", () => {});
}
