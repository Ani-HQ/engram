import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { ActionError, actionInputFingerprint, listActions, parseActionInput, parseActionsQuery, recordAction } from "../gateway/src/actions";
import { runWithContext } from "../gateway/src/context";
import { normalizeToken, parsePolicies } from "../gateway/src/policies";
import { oauthActorName } from "../gateway/src/oauth";

const writer = normalizeToken({ name: "codex", orgId: 7 });
const now = new Date("2026-10-21T12:00:00Z");

// The storage seam lets these tests verify SQL bindings and mapping without a
// process-global DB mock that can silently replace other suites' real exports.
function database() {
  const calls: { query: string; values: any[] }[] = [];
  const action = {
    id: "action-1", agent: "codex", tool: "github.create_pull_request",
    summary: "Opened the fix", resource: "https://github.com/a/b/pull/1",
    status: "completed", evidence: "reported", run_id: "run-1",
    occurred_at: now, recorded_at: now, detail: "Pull request created",
  };
  const db = ((strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("INSERT INTO action_events")) return Promise.resolve([{
      ...action, id: values[0], agent: values[2], tool: values[3], summary: values[4],
      resource: values[5], status: values[6], run_id: values[7], occurred_at: values[8], detail: values[9],
      action_key: values[10], event_id: values[11], payload_fingerprint: values[12],
      approach: values[13], task_title: values[14], outcome: values[15], current_step: values[16], harness: values[17], source_label: values[18], source_kind: values[19],
    }]);
    if (query.includes("pg_advisory_xact_lock") || query.includes("SELECT tool, status") || query.includes("AND event_id =")) return Promise.resolve([]);
    if (query.includes("array_agg")) return Promise.resolve([{ agents: ["codex"], tools: [action.tool] }]);
    if (query.includes("WITH ledger")) return Promise.resolve([action, {
      ...action, id: "audit:2", evidence: "observed", status: "failed", tool: "remember",
    }]);
    return { fragment: true, query, values };
  }) as unknown as postgres.Sql;
  db.begin = (async (callback: (transaction: postgres.Sql) => unknown) => callback(db)) as any;
  return { db, calls };
}

describe("action ingestion", () => {
  test("validates required fields, lengths, dates, status, and server-owned identity", () => {
    for (const raw of [null, [], {}, { tool: "x", summary: " " }, { tool: "x", summary: "x".repeat(501) },
      { tool: "x", summary: "x", status: "success" }, { tool: "x", summary: "x", agent: "other" },
      { tool: "x", summary: "x", evidence: "observed" }, { tool: "x", summary: "x", occurredAt: "tomorrow" },
      { tool: "x", summary: "x", actionKey: "" }, { tool: "x", summary: "x", eventId: "a b" },
      { tool: "x", summary: "x", actionKey: "x".repeat(201) },
      { tool: "x", summary: "x", approach: "x".repeat(1001) }, { tool: "x", summary: "x", approach: [] },
      { tool: "x", summary: "x", eventId: "eng_abcdefghijklmnopqrstuvwxyz" },
      { tool: "x", summary: "x", occurredAt: "2026-02-30T12:00:00Z" },
      { tool: "x", summary: "x", occurredAt: "2026-10-22T00:00:00Z" }]) {
      expect(() => parseActionInput(raw, now)).toThrow(ActionError);
    }
    expect(parseActionInput({ tool: " github.commit ", summary: " Saved ", resource: " " }, now))
      .toMatchObject({ tool: "github.commit", summary: "Saved", status: "completed", resource: null, occurredAt: now.toISOString() });
  });

  test("redacts credentials before persisting, and derives identity from the authenticated token", async () => {
    const { db, calls } = database();
    const result = await recordAction(writer, {
      tool: "github.create_pull_request", summary: "Opened the fix",
      resource: "https://example.com/result?token=shortsecret",
      detail: '{"password":"secret-value","key":"sk-abcdefghijklmnopqrstuvwxyz"}',
      approach: 'Compared local metadata {"password":"approach-secret"}',
    }, db);
    expect(result.action).toMatchObject({ agent: "codex", evidence: "reported", resource: "https://example.com/result?token=REDACTED" });
    expect(result.action.detail).not.toContain("secret-value");
    expect(result.action.detail).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.action.approach).not.toContain("approach-secret");
    const insert = calls.find(call => call.query.includes("INSERT INTO action_events"))!;
    expect(insert.values[1]).toBe(7);
    expect(insert.query).toContain("'reported'");
    expect(insert.query).not.toContain("UPDATE");
    expect(insert.query).toContain("clock_timestamp()");
    expect(calls[0].query).toContain("pg_advisory_xact_lock");
  });

  test("read-only tokens and OAuth read scope cannot append", async () => {
    const { db, calls } = database();
    const input = { tool: "shell", summary: "Executed a command" };
    await expect(recordAction(normalizeToken({ ...writer, canWrite: false }), input, db)).rejects.toMatchObject({ status: 403 });
    await expect(recordAction(normalizeToken({ ...writer, kind: "oauth", scopes: ["memory:read"] }), input, db)).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(0);
  });

  test("org write policy and context isolation also apply to action reports", async () => {
    const { db, calls } = database();
    const context = {
      org: { id: 7, name: "Team", slug: "team", kind: "team" as const, brainDb: "brain_org_7", homeDir: "brain", dataDb: "brain_org_7", policies: parsePolicies({ agentsMayWrite: false }) },
      token: writer, dataSql: db,
    };
    await runWithContext(context, async () => {
      await expect(recordAction(writer, { tool: "shell", summary: "Ran" }, db)).rejects.toMatchObject({ status: 403 });
      await expect(listActions(normalizeToken({ ...writer, orgId: 8 }), {}, db)).rejects.toMatchObject({ status: 403 });
    });
    expect(calls).toHaveLength(0);
  });
});

describe("shared action queries", () => {
  test("uses the same query contract for URL and MCP arguments with bounded pagination", () => {
    const input = { q: "pull request", agent: "codex", tool: "github", status: "failed", resource: "pull/1", runId: "run-1", limit: "3", offset: "6" };
    expect(parseActionsQuery(new URLSearchParams(input))).toEqual(parseActionsQuery(input));
    expect(parseActionsQuery({})).toMatchObject({ limit: 40, offset: 0 });
    expect(parseActionsQuery({ limit: 1000, offset: -1 })).toMatchObject({ limit: 100, offset: 0 });
    expect(() => parseActionsQuery({ status: "unknown" })).toThrow(ActionError);
    expect(() => parseActionsQuery({ offset: "NaN" })).toThrow(ActionError);
  });

  test("queries both evidence sources within one org, returns facets, and detects an extra page", async () => {
    const { db, calls } = database();
    const result = await listActions(writer, { q: "100%", resource: "pull/1", runId: "run-1", limit: 1 }, db);
    expect(result).toMatchObject({ more: true, agents: ["codex"], tools: ["github.create_pull_request"] });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ id: "action-1", evidence: "reported", occurredAt: now.toISOString() });
    const ledger = calls.find(call => call.query.includes("UNION ALL"))!;
    expect(ledger.query).toContain("UNION ALL");
    const reports = calls.find(call => call.query.includes("AS action_version"))!;
    expect(reports.query).toContain("FROM action_events WHERE org_id");
    expect(reports.query).toContain("PARTITION BY agent, (action_key IS NULL), coalesce(action_key, id)");
    expect(reports.query).toContain("recorded_at DESC, (status <> 'running') DESC, id DESC");
    expect(ledger.query).toContain("WHERE audit_log.org_id");
    expect(ledger.query).toContain("registered_source.org_id = audit_log.org_id");
    expect(reports.values.at(-1)).toBe(7);
    expect(ledger.values.at(-1)).toBe(7);
    expect(ledger.query).toContain("'observed'");
    expect(ledger.query).toContain("ELSE 'failed'");
    expect(ledger.query).toContain("'list_actions', 'record_action', 'whoami'");
    const page = calls.find(call => call.query.includes("LIMIT"))!;
    expect(page.query).toContain("strpos");
    expect(page.query).not.toContain("ILIKE");
    expect(page.values).toContain("100%");
    expect(page.values.slice(-2)).toEqual([2, 0]);
    const all = await listActions(writer, {}, db);
    expect(all.more).toBe(false);
    expect(all.actions[1]).toMatchObject({ id: "audit:2", evidence: "observed", status: "failed" });
  });

  test("client identity distinguishes agents acting for the same OAuth user", () => {
    expect(oauthActorName({ sub: "ani", client_id: "claude" })).toBe("oauth:ani:claude");
    expect(oauthActorName({ sub: "ani", client_id: "codex" })).not.toBe(oauthActorName({ sub: "ani", client_id: "claude" }));
    expect(oauthActorName({ sub: "ani", azp: "chatgpt" })).toBe("oauth:ani:chatgpt");
    expect(oauthActorName({ sub: "ani" })).toBe("oauth:ani");
  });
});

describe("action delivery identity", () => {
  test("a logical action keeps its original run binding, including an absent run ID", async () => {
    for (const [originalRun, nextRun, accepted] of [[null, "new-run", false], ["original-run", "other-run", false], ["original-run", undefined, false], ["original-run", "original-run", true], [null, undefined, true]] as const) {
      const store = database();
      const db = ((parts: TemplateStringsArray, ...values: any[]) => {
        const query = parts.join("?");
        if (query.includes("SELECT tool, status")) return Promise.resolve([{ tool: "files.write", status: "running", run_id: originalRun, occurred_at: now }]);
        return store.db(parts, ...values);
      }) as unknown as postgres.Sql;
      db.begin = (async (callback: (transaction: postgres.Sql) => unknown) => callback(db)) as any;
      const report = { tool: "files.write", summary: "Still working", status: "running", actionKey: "task:stable", eventId: "task:stable:update", ...(nextRun === undefined ? {} : { runId: nextRun }) };
      if (accepted) {
        expect((await recordAction(writer, report, db)).action.runId).toBe(originalRun);
      } else {
        await expect(recordAction(writer, report, db)).rejects.toMatchObject({ status: 409, message: "An actionKey cannot change its runId" });
        expect(store.calls.some(call => call.query.includes("INSERT INTO action_events"))).toBe(false);
      }
    }
  });

  test("canonical fingerprints ignore generated timestamps but include explicit event time and payload", () => {
    const raw = { tool: "files.write", summary: "Updated", actionKey: "task:1", eventId: "event:1" };
    const first = parseActionInput(raw, now);
    const retry = parseActionInput({ ...raw, summary: " Updated " }, new Date(now.getTime() + 10_000));
    expect(first.occurredAt).not.toBe(retry.occurredAt);
    expect(actionInputFingerprint(first)).toBe(actionInputFingerprint(retry));
    const legacyCanonical = '{"tool":"files.write","summary":"Updated","resource":null,"status":"completed","runId":null,"detail":null,"actionKey":"task:1","occurredAt":null}';
    expect(actionInputFingerprint(first)).toBe(createHash("sha256").update(legacyCanonical).digest("hex"));
    expect(actionInputFingerprint(parseActionInput({ ...raw, detail: "Changed" }, now))).not.toBe(actionInputFingerprint(first));
    expect(actionInputFingerprint(parseActionInput({ ...raw, approach: "Compared file hashes" }, now))).not.toBe(actionInputFingerprint(first));
    expect(actionInputFingerprint(parseActionInput({ ...raw, approach: null }, now))).toBe(actionInputFingerprint(first));
    expect(actionInputFingerprint(parseActionInput({ ...raw, occurredAt: now.toISOString() }, now))).not.toBe(actionInputFingerprint(first));
  });

  test("event retries return the original receipt and conflicting reuse fails", async () => {
    const { db, calls } = database();
    const raw = { tool: "files.write", summary: "Updated", actionKey: "task:1", eventId: "event:1" };
    const original = (await recordAction(writer, raw, db)).action;
    const event = { ...original, run_id: null, action_key: original.actionKey, event_id: original.eventId, occurred_at: original.occurredAt, recorded_at: original.recordedAt, payload_fingerprint: actionInputFingerprint(parseActionInput(raw)) };
    const lookup = ((parts: TemplateStringsArray, ...values: any[]) => {
      const query = parts.join("?");
      calls.push({ query, values });
      if (query.includes("AND event_id =")) return Promise.resolve([event]);
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    lookup.begin = (async (callback: (transaction: postgres.Sql) => unknown) => callback(lookup)) as any;
    expect((await recordAction(writer, raw, lookup)).action).toEqual(original);
    await expect(recordAction(writer, { ...raw, summary: "Different" }, lookup)).rejects.toMatchObject({ status: 409 });
    expect(calls.filter(call => call.query.includes("INSERT INTO action_events"))).toHaveLength(1);
  });

  test("the same logical action cannot change tool, move backward, or leave a terminal state", async () => {
    for (const previous of [
      { tool: "other.tool", status: "running", occurred_at: now },
      { tool: "files.write", status: "running", occurred_at: new Date(Date.now() + 1_000) },
      { tool: "files.write", status: "completed", occurred_at: now },
      { tool: "files.write", status: "failed", occurred_at: now },
    ]) {
      const calls: string[] = [];
      const db = ((parts: TemplateStringsArray) => {
        const query = parts.join("?"); calls.push(query);
        return Promise.resolve(query.includes("SELECT tool, status") ? [previous] : []);
      }) as unknown as postgres.Sql;
      db.begin = (async (callback: (transaction: postgres.Sql) => unknown) => callback(db)) as any;
      await expect(recordAction(writer, { tool: "files.write", summary: "Working", status: "running", actionKey: "task:1" }, db)).rejects.toMatchObject({ status: 409 });
      expect(calls.some(query => query.includes("INSERT INTO action_events"))).toBe(false);
    }
  });
});

describe("explicit task context and source metadata", () => {
  test("bounds and redacts task fields without accepting claimed verification or models", () => {
    for (const [field, value] of [["taskTitle", "x".repeat(301)], ["outcome", "x".repeat(2001)], ["currentStep", "x".repeat(501)], ["taskTitle", []], ["harness", "https://example.com/logo.svg"], ["harness", "x".repeat(81)], ["sourceLabel", "x".repeat(101)], ["sourceLabel", "bad\nlabel"], ["sourceKind", "registered"], ["model", "verified-model"]]) {
      expect(() => parseActionInput({ tool: "files.write", summary: "Updated", [String(field)]: value }, now)).toThrow(ActionError);
    }
    const parsed = parseActionInput({ tool: "files.write", summary: "Updated", taskTitle: " Publish the release ", outcome: '{"password":"private-result"}', currentStep: " Reviewing changes ", harness: " Grok-Bot ", sourceLabel: "Review assistant" }, now);
    expect(parsed).toMatchObject({ taskTitle: "Publish the release", currentStep: "Reviewing changes", harness: "grok-bot", sourceLabel: "Review assistant" });
    expect(parsed.outcome).not.toContain("private-result");
    const baseline = parseActionInput({ tool: "files.write", summary: "Updated" }, now);
    for (const field of ["taskTitle", "outcome", "currentStep", "harness", "sourceLabel"]) {
      expect(actionInputFingerprint(parseActionInput({ tool: "files.write", summary: "Updated", [field]: field === "harness" ? "codex" : "Explicit context" }, now))).not.toBe(actionInputFingerprint(baseline));
    }
    expect(actionInputFingerprint(parseActionInput({ tool: "files.write", summary: "Updated", taskTitle: null, outcome: "", currentStep: null, harness: null, sourceLabel: "" }, now))).toBe(actionInputFingerprint(baseline));
  });

  test("connection registration wins over a reported source without changing identity", async () => {
    const store = database();
    const registered = normalizeToken({ ...writer, source: { harness: "codex", label: null, kind: "registered" } });
    const result = await recordAction(registered, { tool: "files.write", summary: "Updated", taskTitle: "Publish release", outcome: "Release notes saved", currentStep: "Old stage", harness: "grok-bot", sourceLabel: "Untrusted override" }, store.db);
    expect(result.action).toMatchObject({ agent: writer.name, taskTitle: "Publish release", outcome: "Release notes saved", currentStep: null, harness: "codex", sourceLabel: null, sourceKind: "registered" });
    const reported = await recordAction(writer, { tool: "files.read", summary: "Reading", status: "running", currentStep: "Inspecting the manifest", harness: "grok-bot", sourceLabel: "Reviewer" }, store.db);
    expect(reported.action).toMatchObject({ agent: writer.name, currentStep: "Inspecting the manifest", harness: "grok-bot", sourceLabel: "Reviewer", sourceKind: "reported" });
  });
});
