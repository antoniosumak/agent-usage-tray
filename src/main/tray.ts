import { execFile } from "node:child_process";
import * as path from "path";
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import type { QuotaState } from "./quota";

// Tray icon drawn as raw BGRA. Pinned to taskbar: session percentage as big
// color-coded digits above a thin weekly bar. In the overflow flyout: session
// percentage as white digits on a solid threshold-colored badge. Null renders
// gray.
const isMac = process.platform === "darwin";

function barColor(percent: number): [number, number, number] {
  return percent < 60 ? [34, 197, 94] : percent < 85 ? [234, 179, 8] : [239, 68, 68];
}

// 3x5 pixel font, one 3-bit value per row, bit 2 = leftmost pixel.
const FONT: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7],
  "1": [2, 6, 2, 2, 7],
  "2": [7, 1, 7, 4, 7],
  "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7],
  "6": [7, 4, 7, 5, 7],
  "7": [7, 1, 2, 2, 2],
  "8": [7, 5, 7, 5, 7],
  "9": [7, 5, 7, 1, 7],
  "-": [0, 0, 7, 0, 0],
};

function toImage(buf: Buffer, size: number): Electron.NativeImage {
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

// Blit `text` in the 3x5 FONT, horizontally centered at row y0, scaled up and
// tinted [r, g, b]. Writes opaque pixels only where a glyph bit is set.
function drawText(
  buf: Buffer,
  size: number,
  text: string,
  scale: number,
  y0: number,
  [r, g, b]: [number, number, number],
): void {
  const textW = text.length * 3 * scale + (text.length - 1) * scale;
  let x0 = Math.round((size - textW) / 2);
  for (const ch of text) {
    const glyph = FONT[ch];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (!(glyph[gy] & (4 >> gx))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = ((y0 + gy * scale + dy) * size + x0 + gx * scale + dx) * 4;
            buf[i] = b;
            buf[i + 1] = g;
            buf[i + 2] = r;
            buf[i + 3] = 255;
          }
        }
      }
    }
    x0 += 4 * scale;
  }
}

function createBarsIcon(sessionPct: number | null, weeklyPct: number | null): Electron.NativeImage {
  const size = 32; // rendered at 2x, shown as 16 DIP
  const buf = Buffer.alloc(size * size * 4);

  // Session % as big color-coded digits filling the top; scale 4 gives a 20px
  // tall glyph, legible at 16 DIP. ponytail: two digits max — 100% shows as 99.
  const text =
    sessionPct === null ? "--" : String(Math.min(Math.max(Math.round(sessionPct), 0), 99));
  const digitColor = sessionPct === null ? [156, 163, 175] : barColor(sessionPct);
  drawText(buf, size, text, 4, 3, digitColor as [number, number, number]);

  // Weekly usage as a thin bar along the bottom, color-coded and filled to %.
  const barTop = 27;
  const barH = 4;
  const frac = weeklyPct === null ? 0 : Math.min(Math.max(weeklyPct, 0), 100) / 100;
  const fillW = Math.round(frac * size);
  const [r, g, b] = weeklyPct === null ? [156, 163, 175] : barColor(weeklyPct);
  for (let y = barTop; y < barTop + barH; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (x < fillW) {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
      } else {
        buf[i] = 128;
        buf[i + 1] = 128;
        buf[i + 2] = 128;
        buf[i + 3] = 96;
      }
    }
  }
  return toImage(buf, size);
}

function createBadgeIcon(sessionPct: number | null): Electron.NativeImage {
  const size = 32; // rendered at 2x, shown as 16 DIP
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = sessionPct === null ? [156, 163, 175] : barColor(sessionPct);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = b;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = r;
    buf[i * 4 + 3] = 255;
  }
  // ponytail: two digits max — 100% shows as 99, close enough for a 16px badge
  const text =
    sessionPct === null ? "--" : String(Math.min(Math.max(Math.round(sessionPct), 0), 99));
  const scale = 4;
  drawText(buf, size, text, scale, Math.round((size - 5 * scale) / 2), [255, 255, 255]);
  return toImage(buf, size);
}

// Windows 11 records per-icon pin state in the registry; there is no Electron
// API for it. IsPromoted=1 means the icon sits on the taskbar; absent or 0
// means it lives in the "Show hidden icons" flyout.
function isPinned(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Control Panel\\NotifyIconSettings", "/s"],
      { windowsHide: true },
      (err, out) => {
        if (err) return resolve(false);
        const exe = process.execPath.toLowerCase();
        const block = out.split(/\r?\n\r?\n/).find((blk) => blk.toLowerCase().includes(exe));
        resolve(!!block && /IsPromoted\s+REG_DWORD\s+0x1/i.test(block));
      },
    );
  });
}

export function updateTray(tray: Tray, quota: QuotaState): void {
  const session = quota.buckets.find((b) => b.kind === "session");
  const weekly = quota.buckets.find((b) => b.kind === "weekly_all");
  const ok = quota.status === "ok";
  const sessionPct = ok && session ? session.percent : null;
  const weeklyPct = ok && weekly ? weekly.percent : null;
  // darwin: the image comes from the offscreen widget.html renderer (createMenuBarRenderer)
  if (!isMac)
    void isPinned().then((pinned) => {
      if (tray.isDestroyed()) return;
      tray.setImage(pinned ? createBarsIcon(sessionPct, weeklyPct) : createBadgeIcon(sessionPct));
    });
  if (quota.status === "ok" && quota.buckets.length > 0) {
    const parts: string[] = [];
    if (session) parts.push(`Session ${session.percent}%`);
    if (weekly) parts.push(`Weekly ${weekly.percent}%`);
    tray.setToolTip(parts.join(" · ") || "Agent Usage");
  } else {
    tray.setToolTip("Agent Usage — quota unavailable");
  }
}

export function popupPosition(trayBounds: Electron.Rectangle, win: BrowserWindow) {
  const { width, height } = win.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - width - 8);
  // mac menu bar sits on top → popup hangs below it; Windows taskbar is at the bottom
  const y = isMac ? trayBounds.y + trayBounds.height + 4 : wa.y + wa.height - height - 8;
  return { x, y };
}

export function createTray(win: BrowserWindow): Tray {
  const tray = new Tray(createBadgeIcon(null));
  tray.setToolTip("Agent Usage");
  const menu = Menu.buildFromTemplate([{ label: "Quit", click: () => app.quit() }]);
  // macOS opens a set context menu on *left* click too, which would swallow the popup toggle
  if (isMac) tray.on("right-click", () => tray.popUpContextMenu(menu));
  else tray.setContextMenu(menu);

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

// macOS menu bar item: widget.html rendered offscreen, every repaint becomes the
// tray image (two rows: 5h / 7d). `paint` only fires on content change, so the
// frame-rate cap is not a poll. Never shown — main.ts feeds it state exactly like
// the Windows taskbar widget.
export const MENU_BAR_W = 124;
export const MENU_BAR_H = 22;

export function createMenuBarRenderer(tray: Tray): BrowserWindow {
  const off = new BrowserWindow({
    show: false,
    width: MENU_BAR_W,
    height: MENU_BAR_H,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, "preload.js") },
  });
  off.loadFile(path.join(__dirname, "widget.html"));
  off.webContents.setFrameRate(2);
  off.webContents.on("paint", (_e, _dirty, image) => {
    if (tray.isDestroyed()) return;
    // Retina: if the frame arrives as raw 2x pixels flagged 1x, re-tag it so the
    // menu bar shows it at 124 DIP instead of 248.
    const { width, height } = image.getSize();
    const sf = width / MENU_BAR_W;
    tray.setImage(
      sf > 1
        ? nativeImage.createFromBitmap(image.toBitmap(), { width, height, scaleFactor: sf })
        : image,
    );
  });
  return off;
}
