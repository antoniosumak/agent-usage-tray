import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

// Scroller sections the user can hide/reorder. Order here = default order.
export const SECTION_IDS = ["cost", "burn", "blocks", "heatmap", "tools", "projects"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionPref {
  id: SectionId;
  visible: boolean;
}

export interface Settings {
  refreshMinutes: number;
  launchAtStartup: boolean;
  warnThresholdPct: number;
  enabledAgents: string[] | null; // null = all agents
  quotaProvider: string | null; // which provider the widget + quota tab show; null = first available
  sections: SectionPref[];
}

// Allowed refresh intervals (minutes). A closed set, not a free range, so nobody
// can poll the quota API often enough to trip rate limits — enforced in sanitize,
// so a hand-edited settings.json is snapped too, not just the settings UI.
export const REFRESH_CHOICES = [5, 10, 15, 30, 60] as const;
const nearestRefresh = (n: number) =>
  REFRESH_CHOICES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));

const defaultSections = (): SectionPref[] => SECTION_IDS.map((id) => ({ id, visible: true }));

export const defaultSettings: Settings = {
  refreshMinutes: 5,
  launchAtStartup: false,
  warnThresholdPct: 80,
  enabledAgents: null,
  quotaProvider: null,
  sections: defaultSections(),
};

// Keep the user's order/visibility but drop unknown ids and append any new
// section (a later app version adds one) at the end, visible by default.
function sanitizeSections(raw: any): SectionPref[] {
  if (!Array.isArray(raw)) return defaultSections();
  const seen = new Set<string>();
  const out: SectionPref[] = [];
  for (const item of raw) {
    const id = item?.id;
    if ((SECTION_IDS as readonly string[]).includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push({ id, visible: item?.visible !== false });
    }
  }
  for (const id of SECTION_IDS) if (!seen.has(id)) out.push({ id, visible: true });
  return out;
}

// userData = %APPDATA%\agent-usage (app name from package.json)
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

// Validate each field independently so one bad value doesn't discard the rest.
export function sanitizeSettings(raw: any): Settings {
  const s = { ...defaultSettings };
  if (typeof raw?.refreshMinutes === "number" && Number.isFinite(raw.refreshMinutes))
    s.refreshMinutes = nearestRefresh(raw.refreshMinutes);
  if (typeof raw?.launchAtStartup === "boolean") s.launchAtStartup = raw.launchAtStartup;
  if (typeof raw?.warnThresholdPct === "number" && Number.isFinite(raw.warnThresholdPct))
    s.warnThresholdPct = Math.min(Math.max(Math.round(raw.warnThresholdPct), 1), 100);
  if (Array.isArray(raw?.enabledAgents)) s.enabledAgents = raw.enabledAgents.map(String);
  if (typeof raw?.quotaProvider === "string") s.quotaProvider = raw.quotaProvider;
  s.sections = sanitizeSections(raw?.sections);
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
