import type { WorkflowEvent } from "../types/ui";

/** Exclude the union of question waits, including an open round. */
export function workflowElapsedSeconds(startedAt: number | null, events: WorkflowEvent[], now: number): number | null {
  if (startedAt === null || !Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
  const end = Math.max(startedAt, now);
  const waits = events.filter((event) => event.toolName === "ask_user_question" && Number.isFinite(event.startedAtMs))
    .map((event) => [Math.max(startedAt, event.startedAtMs!), Math.min(end,
      event.finishedAtMs ?? (event.status === "running" ? end : event.startedAtMs!))])
    .filter(([start, finish]) => finish > start).sort((a, b) => a[0] - b[0]);
  let excluded = 0;
  let coveredUntil = startedAt;
  for (const [start, finish] of waits) {
    excluded += Math.max(0, finish - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, finish);
  }
  return Math.max(0, Math.floor((end - startedAt - excluded) / 1000));
}
