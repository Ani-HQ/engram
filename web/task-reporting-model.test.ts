import { describe, expect, test } from "bun:test";
import { taskReportingStatus, taskReportingSummary } from "./task-reporting-model.js";

describe("task reporting evidence", () => {
  test("archived and deleted listings do not create reporting attention or authorization claims", () => {
    const archived = { status: "revoked", archivedAt: "2026-10-26T09:00:00Z", canWrite: true, taskReports: 7 };
    expect(taskReportingStatus(archived)).toMatchObject({ state: "archived", eligible: false, reconnect: false, readOnly: false, withReports: false, reportCount: 7 });
    expect(taskReportingStatus({ ...archived, status: "authorized" }).eligible).toBe(false);
    expect(taskReportingSummary({ connections: [archived, { status: "authorized", canWrite: true, taskReports: 3, deletedAt: "2026-10-26T09:00:00Z" }, { status: "authorized", canWrite: true, taskReports: 1 }] })).toEqual({ total: 1, eligible: 1, reconnect: 0, readOnly: 0, withReports: 1, available: true, more: false });
  });
  test("reconnect and read-only access take priority over historical receipts", () => {
    for (const status of ["revoked", "expired", "membership_removed"]) {
      expect(taskReportingStatus({ status, canWrite: true, taskReports: 12 })).toMatchObject({
        state: "reconnect", label: "Reconnect needed", eligible: false, reconnect: true,
        readOnly: false, withReports: false, reportCount: 12,
      });
    }
    expect(taskReportingStatus({ status: "authorized", canWrite: false, taskReports: 12 })).toMatchObject({
      state: "read-only", eligible: false, reconnect: false, readOnly: true, withReports: false, reportCount: 12,
    });
    expect(taskReportingStatus({ status: "membership_removed" }).detail).toContain("Restore access");
  });

  test("memory traffic, recent contact and client claims cannot substitute for task reports", () => {
    const result = taskReportingStatus({
      status: "authorized", canWrite: true, taskReports: 0, memoryCalls: 999,
      lastContactAt: "2099-01-01T00:00:00Z", lastTaskReportAt: "2099-01-01T00:00:00Z",
      running: true, hookInstalled: true, harness: "codex",
    });
    expect(result).toMatchObject({ state: "no-reports", label: "No task reports", eligible: true, withReports: false, reportCount: 0 });
    expect(result).not.toHaveProperty("running");
    expect(result).not.toHaveProperty("hookInstalled");
    expect(result).not.toHaveProperty("lastContactAt");
  });

  test("positive counts establish received reports without a freshness or running claim", () => {
    const result = taskReportingStatus({ status: "authorized", canWrite: true, taskReports: 2, lastTaskReportAt: "2000-01-01T00:00:00Z" });
    expect(result).toMatchObject({ state: "reports-received", label: "Reports received", eligible: true, withReports: true, reportCount: 2 });
    expect(result.detail).toContain("does not verify automatic capture or current work");
    expect(result).not.toHaveProperty("working");
    expect(result).not.toHaveProperty("enabled");
  });

  test("missing and malformed metadata never produces an authorization or receipt claim", () => {
    for (const value of [null, undefined, false, 1, "authorized", [], {}, { status: "unknown", canWrite: true, taskReports: 2 }, { status: "authorized", canWrite: "true", taskReports: 2 }]) {
      expect(taskReportingStatus(value)).toMatchObject({ state: "unknown", eligible: false, reconnect: false, readOnly: false, withReports: false });
    }
    for (const taskReports of [undefined, null, "2", NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(taskReportingStatus({ status: "authorized", canWrite: true, taskReports })).toMatchObject({ state: "unknown", eligible: true, withReports: false, reportCount: 0 });
    }
    const result = taskReportingStatus({ status: "invented", canWrite: true, taskReports: 2, token: "private-token", headers: { Authorization: "private-header" } });
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-header|Authorization/);
  });

  test("summaries distinguish write metadata, reconnect needs and receipt evidence within a bounded inventory", () => {
    const summary = taskReportingSummary({ more: true, connections: [
      { status: "authorized", canWrite: true, taskReports: 0 },
      { status: "authorized", canWrite: true, taskReports: 3 },
      { status: "authorized", canWrite: false, taskReports: 4 },
      { status: "revoked", canWrite: true, taskReports: 7 },
      { status: "expired", canWrite: true, taskReports: 0 },
      { status: "membership_removed", canWrite: false, taskReports: 0 },
      { status: "unknown", canWrite: true, taskReports: 9 },
      null,
    ] });
    expect(summary).toEqual({ eligible: 2, reconnect: 3, readOnly: 1, withReports: 1, total: 8, more: true, available: true });
  });

  test("unavailable payloads differ from an empty inventory and cannot reuse another workspace's evidence", () => {
    const empty = { eligible: 0, reconnect: 0, readOnly: 0, withReports: 0, total: 0, more: false };
    for (const payload of [undefined, null, [], {}, { connections: null }, { connections: "private" }]) {
      expect(taskReportingSummary(payload)).toEqual({ ...empty, available: false });
    }
    expect(taskReportingSummary({ connections: [] })).toEqual({ ...empty, available: true });
    const workspaceA = Object.freeze({ connections: Object.freeze([Object.freeze({ status: "authorized", canWrite: true, taskReports: 1 })]), more: true });
    expect(taskReportingSummary(workspaceA)).toMatchObject({ eligible: 1, withReports: 1, more: true });
    expect(taskReportingSummary({ connections: [{ status: "revoked", canWrite: true, taskReports: 0 }], more: "true" })).toMatchObject({ eligible: 0, reconnect: 1, withReports: 0, more: false });
    expect(taskReportingSummary(workspaceA)).toMatchObject({ eligible: 1, withReports: 1, more: true });
    expect(taskReportingSummary(null)).toEqual({ ...empty, available: false });
  });
});
