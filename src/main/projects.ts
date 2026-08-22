import { detectRuntime, Range, rangeSince } from "./cost";
import { assistantMessagesSince, pricing, messageCost } from "./tools";

// Per-project spend, rolled up from Claude Code's local JSONL transcripts. Like
// the tool breakdown, this is Claude Code only — other agents store sessions in
// other formats and never write ~/.claude/projects logs.
export interface ProjectCost {
  name: string;
  cost: number;
  tokens: number;
}

export interface ProjectState {
  status: "ok" | "no-data" | "runtime-missing" | "error";
  projects: ProjectCost[];
  totalCost: number;
  refreshing: boolean;
  fetchedAt: number | null;
}

export const initialProjectState: ProjectState = {
  status: "error",
  projects: [],
  totalCost: 0,
  refreshing: true,
  fetchedAt: null,
};

// ponytail: dir names are the abs path with every separator flattened to "-"
// ("C:\Projects\agent-usage" -> "C--Projects-agent-usage"). Ceiling: literal
// hyphens and path separators are now indistinguishable, so we can't perfectly
// re-split — strip a leading drive prefix and take the last "-" segment as a
// best-effort readable label.
export function displayName(dir: string): string {
  const noDrive = dir.replace(/^[A-Za-z]-+/, "");
  const seg = noDrive.split("-").filter(Boolean).pop();
  return seg || dir;
}

function usageTokens(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

export function startProjects(intervalMs: number, onState: (s: ProjectState) => void) {
  let state = initialProjectState;
  let runtime: string[] | null | undefined; // undefined = not yet detected
  let running = false;
  let range: Range = "today";

  const emit = (patch: Partial<ProjectState>) => {
    state = { ...state, ...patch };
    onState(state);
  };

  async function refresh(): Promise<void> {
    if (running) return;
    running = true;
    emit({ refreshing: true });
    try {
      if (runtime === undefined) runtime = await detectRuntime();
      if (runtime === null) {
        emit({ status: "runtime-missing", refreshing: false });
        return;
      }
      const msgs = await assistantMessagesSince(rangeSince(range));
      const byProject = new Map<string, ProjectCost>();
      for (const msg of msgs) {
        const rates = await pricing(runtime, msg.model);
        const p = byProject.get(msg.project) ?? { name: displayName(msg.project), cost: 0, tokens: 0 };
        p.cost += rates ? messageCost(msg.usage, rates) : 0;
        p.tokens += usageTokens(msg.usage);
        byProject.set(msg.project, p);
      }
      const projects = [...byProject.values()].sort((a, b) => b.cost - a.cost);
      emit({
        status: projects.length > 0 ? "ok" : "no-data",
        projects,
        totalCost: projects.reduce((n, p) => n + p.cost, 0),
        refreshing: false,
        fetchedAt: Date.now(),
      });
    } catch {
      emit({ status: state.fetchedAt ? state.status : "error", refreshing: false });
    } finally {
      running = false;
    }
  }

  void refresh();
  let timer = setInterval(() => void refresh(), intervalMs);
  return {
    refreshNow: () => void refresh(),
    setRange(r: Range) {
      range = r;
      void refresh();
    },
    setIntervalMs(ms: number) {
      clearInterval(timer);
      timer = setInterval(() => void refresh(), ms);
    },
  };
}
