import { execFile, spawn } from "node:child_process";
import { app, BrowserWindow, screen } from "electron";
import * as path from "path";

const W = 190;
const H = 40;

// C# P/Invoke helper run via PowerShell: reparents the widget HWND into
// Shell_TrayWnd (the taskbar) as a WS_CHILD, same trick CodeZeno's monitor
// uses. As a taskbar child it shares the taskbar's z-order, so the overflow
// flyout and taskbar clicks can no longer push it behind. Also positions it
// just left of TrayNotifyWnd (the tray cluster) in taskbar-client pixels.
const EMBED_CS = `
using System;
using System.Runtime.InteropServices;
public static class TB {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static string Embed(long hwndRaw, int w, int h) {
    SetProcessDPIAware();
    IntPtr hwnd = new IntPtr(hwndRaw);
    IntPtr tb = FindWindow("Shell_TrayWnd", null);
    if (tb == IntPtr.Zero) return "no-taskbar";
    IntPtr tray = FindWindowEx(tb, IntPtr.Zero, "TrayNotifyWnd", null);
    RECT tbr, trr;
    GetWindowRect(tb, out tbr);
    if (tray == IntPtr.Zero || !GetWindowRect(tray, out trr)) { trr = tbr; trr.L = tbr.R - 200; }
    int style = GetWindowLong(hwnd, -16);
    unchecked { style = (style & (int)~0x80000000u) | 0x40000000 | 0x04000000; } // -POPUP +CHILD +CLIPSIBLINGS
    SetWindowLong(hwnd, -16, style);
    int ex = GetWindowLong(hwnd, -20);
    ex = (ex | 0x80 | 0x08000000) & ~0x8; // +TOOLWINDOW +NOACTIVATE -TOPMOST
    SetWindowLong(hwnd, -20, ex);
    SetParent(hwnd, tb);
    int x = trr.L - tbr.L - w - 8;
    int y = (tbr.B - tbr.T - h) / 2;
    // HWND_TOP among taskbar children: above the XAML input host, else it eats our clicks
    SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, 0x0070); // NOACTIVATE|FRAMECHANGED|SHOWWINDOW
    return x + "," + y;
  }
}
`;

function embed(widget: BrowserWindow): void {
  if (widget.isDestroyed()) return;
  const hwnd = widget.getNativeWindowHandle().readBigUInt64LE(0);
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const w = Math.round(W * scale);
  const h = Math.min(Math.round(H * scale), physicalTaskbarSafeHeight(scale));
  const script = `Add-Type @'${EMBED_CS}'@; [TB]::Embed(${hwnd}, ${w}, ${h})`;
  execFile(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
    (err, out) => {
      if (err || out.includes("no-taskbar")) widget.hide();
    },
  );
}

// ponytail: assume standard Win11 bottom taskbar ≈48 DIP; only used as a cap
function physicalTaskbarSafeHeight(scale: number): number {
  const d = screen.getPrimaryDisplay();
  const taskbarDip = d.bounds.y + d.bounds.height - (d.workArea.y + d.workArea.height);
  return Math.max(Math.round((taskbarDip - 6) * scale), 20);
}

// Win11 routes taskbar pointer input through its XAML input stack, so the
// embedded child HWND never receives WM_*BUTTON* messages. A global
// WH_MOUSE_LL hook (persistent PowerShell helper) sees every click; main
// filters to clicks inside the widget's screen rect.
const HOOK_CS = `
using System;
using System.Runtime.InteropServices;
public static class MH {
  delegate IntPtr HookProc(int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern int GetMessage(IntPtr m, IntPtr h, uint a, uint b);
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  static HookProc keep; // root the delegate so GC never collects it
  public static void Run() {
    keep = delegate(int n, IntPtr w, IntPtr l) {
      if (n >= 0) {
        long m = w.ToInt64();
        if (m == 0x0202 || m == 0x0205) { // WM_LBUTTONUP / WM_RBUTTONUP
          MSLL s = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
          Console.WriteLine((m == 0x0202 ? "L" : "R") + "," + s.x + "," + s.y);
        }
      }
      return CallNextHookEx(IntPtr.Zero, n, w, l);
    };
    SetWindowsHookEx(14, keep, GetModuleHandle(null), 0); // WH_MOUSE_LL
    IntPtr msg = Marshal.AllocHGlobal(64);
    while (GetMessage(msg, IntPtr.Zero, 0, 0) > 0) {}
  }
}
`;

export function watchWidgetClicks(
  widget: BrowserWindow,
  onClick: (button: "left" | "right") => void,
): void {
  const script = `Add-Type @'${HOOK_CS}'@; [MH]::Run()`;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
  });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop()!;
    for (const line of lines) {
      const [btn, xs, ys] = line.trim().split(",");
      if ((btn !== "L" && btn !== "R") || widget.isDestroyed() || !widget.isVisible()) continue;
      const pt = screen.screenToDipPoint({ x: Number(xs), y: Number(ys) }); // hook reports physical px
      const b = widget.getBounds();
      if (pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height)
        onClick(btn === "L" ? "left" : "right");
    }
  });
  child.on("error", () => {}); // ponytail: no powershell → widget stays display-only
  app.on("will-quit", () => child.kill());
}

export function createWidget(): BrowserWindow {
  const widget = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  widget.loadFile(path.join(__dirname, "widget.html"));
  // Clicks come from watchWidgetClicks (global hook), not the renderer.
  widget.once("ready-to-show", () => {
    widget.showInactive();
    embed(widget);
  });
  // Tray cluster width changes as icons come and go; re-anchor periodically.
  // Re-embedding is idempotent (SetParent to same parent is a no-op).
  setInterval(() => embed(widget), 30_000);
  screen.on("display-metrics-changed", () => embed(widget));
  return widget;
}
