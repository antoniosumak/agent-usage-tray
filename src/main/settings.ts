import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface Settings {
  refreshMinutes: number;
  launchAtStartup: boolean;
  warnThresholdPct: number;
  enabledAgents: string[] | null; // null = all agents
}

export const defaultSettings: Settings = {
  refreshMinutes: 5,
  launchAtStartup: false,
  warnThresholdPct: 80,
  enabledAgents: null,
};

// userData = %APPDATA%\agent-usage (app name from package.json)
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

// Validate each field independently so one bad value doesn't discard the rest.
export function sanitizeSettings(raw: any): Settings {
  const s = { ...defaultSettings };
  if (typeof raw?.refreshMinutes === "number" && Number.isFinite(raw.refreshMinutes))
    s.refreshMinutes = Math.min(Math.max(Math.round(raw.refreshMinutes), 1), 120);
  if (typeof raw?.launchAtStartup === "boolean") s.launchAtStartup = raw.launchAtStartup;
  if (typeof raw?.warnThresholdPct === "number" && Number.isFinite(raw.warnThresholdPct))
    s.warnThresholdPct = Math.min(Math.max(Math.round(raw.warnThresholdPct), 1), 100);
  if (Array.isArray(raw?.enabledAgents)) s.enabledAgents = raw.enabledAgents.map(String);
  return s;
}

export function loadSettings(): Settings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(settingsFile(), "utf8")));
  } catch {
    return { ...defaultSettings }; // missing or malformed file
  }
}

export function saveSettings(s: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch {}
}

export function applyLoginItem(s: Settings): void {
  // Portable exe re-extracts itself; register the real file, not the temp copy.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings({ openAtLogin: s.launchAtStartup, ...(exe ? { path: exe } : {}) });
}
