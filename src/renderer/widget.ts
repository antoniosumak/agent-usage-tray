// window.api type comes from renderer.ts's declare-global block (same tsc program)
// Blue matches the popup quota bars (#005bd3 light / blue-500 dark).
function color(): string {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "#3b82f6" : "#005bd3";
}

// coarsest unit that fits: 3w / 5d / 3h / 45m; empty if past/unknown
function resetIn(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const min = Math.round((Date.parse(resetsAt) - Date.now()) / 60000);
  if (!(min > 0)) return "";
  if (min >= 7 * 1440) return `${Math.round(min / (7 * 1440))}w`;
  if (min >= 1440) return `${Math.round(min / 1440)}d`;
  if (min >= 60) return `${Math.round(min / 60)}h`;
  return `${min}m`;
}

let last: any = null;
function render(s: any): void {
  last = s;
  for (const kind of ["session", "weekly_all"]) {
    const bucket = s.quota?.status === "ok" ? s.quota.buckets.find((b: any) => b.kind === kind) : null;
    const fill = document.getElementById(`fill-${kind}`)!;
    const pct = document.getElementById(`pct-${kind}`)!;
    const reset = document.getElementById(`reset-${kind}`)!;
    if (bucket) {
      const p = Math.min(Math.max(bucket.percent, 0), 100);
      fill.style.width = `${p}%`;
      fill.style.background = color();
      pct.textContent = `${Math.round(bucket.percent)}%`;
      reset.textContent = resetIn(bucket.resetsAt);
    } else {
      fill.style.width = "0%";
      pct.textContent = "–";
      reset.textContent = "";
    }
  }
}

window.api.onState(render);
// State pushes are infrequent; tick the countdown so it stays fresh between them.
setInterval(() => last && render(last), 60000);
