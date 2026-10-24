import { describe, expect, test } from "bun:test";
import { activityDetail, activityPage, groupActivities, latestLogicalActions } from "./activity-model.js";

const now = new Date("2026-10-22T10:00:00.000Z");
function action(id: string, changes: Record<string, unknown> = {}) {
  return { id, agent: "codex", tool: "files.write", summary: `Action ${id}`, resource: null,
    status: "completed", evidence: "reported", runId: null, actionKey: null, eventId: null,
    occurredAt: "2026-10-22T09:50:00.000Z", recordedAt: "2026-10-22T09:50:00.000Z",
    detail: null, approach: null, ...changes };
}

describe("private activity grouping", () => {
  test("task and memory views filter whole groups before pagination and statistics", () => {
    const rows = [
      action("task", { runId: "launch", taskTitle: "Prepare launch", outcome: "Created the brief", harness: "grok-bot", sourceKind: "reported" }),
      action("nested-memory", { runId: "launch", tool: "get_page", evidence: "observed", resource: "engram://launch" }),
      action("memory", { tool: "search", evidence: "observed" }),
    ];
    const tasks = activityPage(rows, { kind: "tasks", limit: 1 }, now);
    expect(tasks.activities).toHaveLength(1);
    expect(tasks.activities[0]).toMatchObject({ taskTitle: "Prepare launch", outcome: "Created the brief", actionCount: 2, resources: ["engram://launch"] });
    expect(tasks.stats.total).toBe(1);
    expect(tasks.tools).toContain("get_page");
    const memory = activityPage(rows, { kind: "memory", limit: 1 }, now);
    expect(memory.activities).toHaveLength(1);
    expect(memory.activities[0]).toMatchObject({ kind: "memory", actionCount: 1 });
    expect(memory.stats.total).toBe(1);
    expect(memory.tools).toEqual(["search"]);
    expect(activityPage(rows, {}, now).stats.total).toBe(2);
  });

  test("retains explicit task context through terminal lifecycle updates", () => {
    const start = action("start", { actionKey: "build", taskTitle: "Build the brief", harness: "grok-bot", sourceKind: "registered", status: "running" });
    const finish = action("finish", { actionKey: "build", outcome: "Created the brief", harness: "other", sourceKind: "reported", recordedAt: "2026-10-22T09:59:00.000Z" });
    const [group] = groupActivities([start, finish], now);
    expect(group.taskTitle).toBe("Build the brief");
    expect(group.outcome).toBe("Created the brief");
    expect(group.kind).toBe("task");
  });
  test("groups one shared run across reporters without inferring approaches", () => {
    const rows = [
      action("design", { agent: "claude", summary: "Build the activity experience", runId: "shared-run", approach: "Agree on the information hierarchy before implementation." }),
      action("build", { runId: "shared-run", status: "running", occurredAt: "2026-10-22T09:55:00.000Z", recordedAt: "2026-10-22T09:55:00.000Z" }),
      action("test", { agent: "baymax", tool: "shell.execute", runId: "shared-run", status: "failed", evidence: "observed" }),
    ];
    const [group] = groupActivities(rows, now);
    expect(group.id).toBe("run:shared-run");
    expect(group.summary).toBe("Build the activity experience");
    expect(group.status).toBe("running");
    expect(group.agents.map((agent: any) => agent.name)).toEqual(["baymax", "claude", "codex"]);
    expect(group.tools).toEqual(["files.write", "shell.execute"]);
    expect(group.approaches).toEqual([{ text: rows[0].approach, agent: "claude", evidence: "reported" }]);
    expect(group.evidence).toBe("mixed");
    expect(group.actionCount).toBe(3);
  });

  test("collapses lifecycle reports while retaining the first title and start time", () => {
    const start = action("start", { actionKey: "task-build", status: "running", summary: "Build the task view", approach: "Create a readable task list." });
    const finish = action("finish", { actionKey: "task-build", occurredAt: "2026-10-22T09:58:00.000Z", recordedAt: "2026-10-22T09:59:00.000Z", summary: "Finished the view", approach: "Verify keyboard navigation." });
    const before = groupActivities([start], now)[0];
    const [after] = groupActivities([start, finish], now);
    expect(after.id).toBe(before.id);
    expect(after.id).toMatch(/^action:[0-9a-f]{64}$/);
    expect(after.summary).toBe(start.summary);
    expect(after.startedAt).toBe(start.occurredAt);
    expect(after.updatedAt).toBe(finish.recordedAt);
    expect(after.actionCount).toBe(1);
    expect(after.status).toBe("completed");
    expect(after.actions).toEqual([{ ...finish, startedAt: start.occurredAt }]);
    expect(after.approaches).toEqual([{ text: finish.approach, agent: "codex", evidence: "reported" }]);
  });

  test("keeps equal action keys isolated by reporter and unkeyed event identity", () => {
    const groups = groupActivities([
      action("first", { actionKey: "same" }), action("second", { agent: "claude", actionKey: "same" }),
      action("same"), action("legacy", { runId: "   " }),
    ], now);
    expect(groups).toHaveLength(4);
    expect(new Set(groups.map((group: any) => group.id)).size).toBe(4);
    expect(groups.some((group: any) => group.id === "event:same")).toBe(true);
    expect(groups.some((group: any) => group.id === "event:legacy")).toBe(true);
  });

  test("uses full-group filters and pagination without dropping other contributors", () => {
    const rows = [
      action("design", { runId: "shared", agent: "claude", summary: "Review keyboard support", approach: "Test every interactive control with the keyboard." }),
      action("build", { runId: "shared", tool: "shell.execute", resource: "file://private-test" }),
      action("other", { agent: "baymax", tool: "browser.navigate" }),
    ];
    const page = activityPage(rows, { agent: "claude", tool: "shell.execute", q: "interactive", limit: 1 }, now);
    expect(page.activities).toHaveLength(1);
    expect(page.activities[0].agents).toHaveLength(2);
    expect(page.activities[0].tools).toEqual(["files.write", "shell.execute"]);
    expect(page.activities[0].actionCount).toBe(2);
    expect(page.activities[0]).not.toHaveProperty("actions");
    expect(page.agents).toContain("baymax");
    expect(page.tools).toContain("browser.navigate");
    expect(page.more).toBe(false);
    expect(activityPage(rows, { limit: 1 }, now).more).toBe(true);
    expect(activityPage(rows, { limit: 1, offset: 1 }, now).activities[0].id).not.toBe(activityPage(rows, { limit: 1 }, now).activities[0].id);
    expect(activityDetail(rows, "run:shared", now)?.actions).toHaveLength(2);
    expect(activityDetail(rows, "run:missing", now)).toBeNull();
  });

  test("counts status tabs before the selected status filter and distinguishes stale work", () => {
    const rows = [
      action("running", { status: "running" }),
      action("stale", { status: "running", recordedAt: "2026-10-22T09:40:00.000Z" }),
      action("failed", { status: "failed" }), action("done"),
    ];
    const page = activityPage(rows, { status: "running" }, now);
    expect(page.stats).toEqual({ running: 2, failed: 1, completed: 1, total: 4 });
    expect(page.activities).toHaveLength(2);
    expect(page.activities.reduce((sum: number, group: any) => sum + group.workingActions, 0)).toBe(1);
    expect(page.activities.reduce((sum: number, group: any) => sum + group.staleActions, 0)).toBe(1);
    expect(page.checkedAt).toBe(now.toISOString());
    expect(page.freshnessSeconds).toBe(900);
    expect(groupActivities([action("done"), action("failed", { status: "failed", runId: "failed" })], now).find((group: any) => group.runId === "failed")?.status).toBe("failed");
  });

  test("selects a terminal lifecycle report on an exact timestamp tie", () => {
    const start = action("z-start", { actionKey: "tie", status: "running" });
    const finish = action("a-finish", { actionKey: "tie", status: "completed" });
    expect(latestLogicalActions([start, finish])).toEqual([{ ...finish, startedAt: start.occurredAt }]);
  });

  test("retains a reported approach when a completion omits it", () => {
    const start = action("start", { actionKey: "keep-approach", status: "running", approach: "Check the API contract before implementing the view." });
    const finish = action("finish", { actionKey: "keep-approach", occurredAt: "2026-10-22T09:59:00.000Z", recordedAt: "2026-10-22T09:59:00.000Z" });
    const [group] = groupActivities([start, finish], now);
    expect(group.approaches).toEqual([{ text: start.approach, agent: "codex", evidence: "reported" }]);
    expect(group.actions[0].approach).toBe(start.approach);
    expect(group.status).toBe("completed");
  });
});
