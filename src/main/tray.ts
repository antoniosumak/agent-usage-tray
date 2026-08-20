import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import type { QuotaState } from "./quota";

// Quota ring icon drawn as raw BGRA: arc fills clockwise from 12 o'clock with
// the session-quota percentage; null percent renders an empty gray ring.
function createIcon(percent: number | null): Electron.NativeImage {
  const size = 32; // rendered at 2x, shown as 16 DIP
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size / 2 - 1;
  const rInner = rOuter - 6;
  const frac = percent === null ? 0 : Math.min(Math.max(percent, 0), 100) / 100;
  const [r, g, b] =
    percent === null ? [156, 163, 175] : percent < 60 ? [34, 197, 94] : percent < 85 ? [234, 179, 8] : [239, 68, 68];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > rOuter || dist < rInner) continue;
      let angle = Math.atan2(dx, -dy); // clockwise from 12 o'clock
      if (angle < 0) angle += Math.PI * 2;
      const i = (y * size + x) * 4;
      if (angle <= frac * Math.PI * 2) {
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
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

export function updateTray(tray: Tray, quota: QuotaState): void {
  const session = quota.buckets.find((b) => b.kind === "session");
  tray.setImage(createIcon(quota.status === "ok" && session ? session.percent : null));
  if (quota.status === "ok" && quota.buckets.length > 0) {
    const parts: string[] = [];
    if (session) parts.push(`Session ${session.percent}%`);
    const weekly = quota.buckets.find((b) => b.kind === "weekly_all");
    if (weekly) parts.push(`Weekly ${weekly.percent}%`);
    tray.setToolTip(parts.join(" · ") || "Agent Usage");
  } else {
    tray.setToolTip("Agent Usage — quota unavailable");
  }
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
  const tray = new Tray(createIcon(null));
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
