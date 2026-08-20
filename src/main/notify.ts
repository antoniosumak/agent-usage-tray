import { Notification } from "electron";
import type { QuotaState } from "./quota";

// resets_at of the window we already notified for; a new window has a new
// resets_at, which re-arms the toast.
let notifiedResetsAt: string | null = null;

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
  if (!session || session.percent < thresholdPct) return;
  const windowKey = session.resetsAt ?? "";
  if (windowKey === notifiedResetsAt) return;
  notifiedResetsAt = windowKey;
  if (!Notification.isSupported()) return;
  const left = remaining(session.resetsAt);
  new Notification({
    title: "Agent Usage",
    body: `Claude session quota at ${Math.round(session.percent)}%${left ? ` — resets in ${left}` : ""}`,
  }).show();
}
