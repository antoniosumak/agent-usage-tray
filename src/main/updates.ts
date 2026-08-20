import { app, shell } from "electron";

// TODO: replace owner placeholder once the GitHub repo exists.
const LATEST_RELEASE_URL = "https://api.github.com/repos/antonio-sumak/agent-usage/releases/latest";
const CHECK_INTERVAL_MS = 24 * 3_600_000;

export interface UpdateInfo {
  version: string;
}

// Renderer only gets the version string; the URL stays in main so
// shell.openExternal never receives renderer-supplied input.
let releaseUrl: string | null = null;

function isNewer(tag: string, current: string): boolean {
  const a = tag.replace(/^v/, "").split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export function startUpdates(onUpdate: (u: UpdateInfo) => void): void {
  async function check(): Promise<void> {
    try {
      const res = await fetch(LATEST_RELEASE_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-usage" },
      });
      if (!res.ok) return; // 404 = no releases yet; stay silent
      const body = await res.json();
      const tag = String(body?.tag_name ?? "");
      if (tag && isNewer(tag, app.getVersion())) {
        releaseUrl = typeof body?.html_url === "string" ? body.html_url : null;
        onUpdate({ version: tag.replace(/^v/, "") });
      }
    } catch {
      // network error → silently no update
    }
  }
  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}

export function openReleasePage(): void {
  if (releaseUrl) void shell.openExternal(releaseUrl);
}
