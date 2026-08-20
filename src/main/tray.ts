import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";

// Static placeholder icon: filled circle, drawn as raw BGRA (dynamic quota icon comes later).
function createIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 <= r ** 2) {
        const i = (y * size + x) * 4;
        buf[i] = 246; // B
        buf[i + 1] = 130; // G
        buf[i + 2] = 59; // R
        buf[i + 3] = 255; // A
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function popupPosition(trayBounds: Electron.Rectangle, win: BrowserWindow) {
  const { width, height } = win.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - width - 8);
  const y = wa.y + wa.height - height - 8;
  return { x, y };
}

export function createTray(win: BrowserWindow): Tray {
  const tray = new Tray(createIcon());
  tray.setToolTip("Agent Usage");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Quit", click: () => app.quit() }]));

  // Clicking the tray blurs (and hides) the popup before the click event
  // arrives, so a plain isVisible() check would instantly re-show it.
  let hiddenAt = 0;
  win.on("hide", () => (hiddenAt = Date.now()));

  tray.on("click", () => {
    if (win.isVisible() || Date.now() - hiddenAt < 300) {
      win.hide();
      return;
    }
    const { x, y } = popupPosition(tray.getBounds(), win);
    win.setPosition(x, y);
    win.show();
    win.focus();
  });

  return tray;
}
