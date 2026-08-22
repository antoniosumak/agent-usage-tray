import type { QuotaState } from "./quota";

// resets_at of the window we already notified for; a new window has a new
// resets_at, which re-arms the toast. Also re-armed when usage drops back
// below the threshold, so each above-threshold episode fires at most once
// (resets_at alone doesn't dedup when it's null or jitters between polls).
let notifiedResetsAt: string | null = null;
let armed = true;

// Pure dedup decision, split out so it's testable without electron.
// Returns true when a toast should fire; mutates the arm/window state.
export function shouldNotify(
  percent: number,
  resetsAt: string | null,
  thresholdPct: number,
): boolean {
  if (percent < thresholdPct) {
    armed = true; // dropped below → re-arm for the next episode
    return false;
  }
  const windowKey = resetsAt ?? "";
  if (windowKey !== notifiedResetsAt) armed = true; // new window → re-arm
  if (!armed) return false;
  notifiedResetsAt = windowKey;
  armed = false;
  return true;
}

function remaining(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function checkThreshold(quota: QuotaState, thresholdPct: number): void {
  if (quota.status !== "ok") return;
  const session = quota.buckets.find((b) => b.kind === "session");
  if (!session) return;
  if (!shouldNotify(session.percent, session.resetsAt, thresholdPct)) return;
  const { Notification } = require("electron"); // lazy: keeps shouldNotify testable without electron
  if (!Notification.isSupported()) return;
  const left = remaining(session.resetsAt);
  new Notification({
    title: "Agent Usage",
    body: `Claude session quota at ${Math.round(session.percent)}%${left ? ` — resets in ${left}` : ""}`,
  }).show();
}
