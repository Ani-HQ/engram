import { describe, expect, test } from "bun:test";
import { publicActivityEvents } from "../gateway/src/public-activity";
import { publicActivitySnapshot } from "../gateway/src/showcase-view";

const now = new Date("2026-10-25T12:00:00Z");
const options = { enabled: true, scope: "tenant-7:public-page", key: "server-only-test-key", now };
const row = { id: "private-action-id", agent: "private-owner@example.com", action_key: "private-logical-key", tool: "github.create_pull_request", resource: "https://github.com/private-org/private-repo/pull/42?token=private-token", status: "running", evidence: "reported", recorded_at: "2026-10-25T11:59:00Z", harness: "codex", source_label: "Private agent alias", summary: "Secret task title", task_title: "Secret repository", current_step: "Secret branch", outcome: "Secret results", detail: "Secret transcript", run_id: "private-run" };

describe("closed public activity projection", () => {
  test("publishes only fixed labels and opaque scoped identities, never source descriptions or resources", () => {
    const [event] = publicActivityEvents([row], options);
    expect(event).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), agent: { product: "codex", label: "Codex" }, service: "github", action: "Creating a pull request", status: "running", evidence: "reported", updatedAt: "2026-10-25T11:59:00.000Z" });
    for (const secret of ["private-", "private@", "Secret", "token=", "pull/42", "alias", "transcript", "github.com"]) expect(JSON.stringify(event)).not.toContain(secret);
    expect(publicActivityEvents([{ ...row, id: "new-lifecycle-event", status: "completed" }], options)[0].id).toBe(event.id);
    expect(publicActivityEvents([row], { ...options, scope: "tenant-8:public-page" })[0].id).not.toBe(event.id);
    expect(publicActivityEvents([row], { ...options, key: "different-server-key" })[0].id).not.toBe(event.id);
  });

  test("unknown products and provider lookalikes stay generic without inheriting private labels", () => {
    for (const resource of ["https://github.com.evil.example/private-repo", "https://github-example.com/private-repo", "mcp://github-lookalike/private-repo"]) {
      const [event] = publicActivityEvents([{ ...row, harness: "private-agent-name", source_label: "GitHub", resource }], options);
      expect(event.agent).toEqual({ product: "other", label: "Agent" });
      expect(event.service).toBe(resource.startsWith("https:") ? "browser" : "code");
      expect(event.action).toBe("Creating a pull request");
    }
    expect(publicActivityEvents([{ ...row, resource: "/Users/private-owner/private-repo/secret.ts" }], options)[0].service).toBe("files");
    expect(publicActivityEvents([{ ...row, resource: "engram://secret-query", tool: "search" }], options)[0].action).toBe("Searching memory");
    expect(publicActivityEvents([{ ...row, resource: null, tool: "search" }], options)[0].service).toBe("memory");
    expect(publicActivityEvents([{ ...row, resource: null, tool: "private_github_proxy.search" }], options)[0].service).toBe("other");
    const git = publicActivityEvents([{ ...row, resource: "repo:private-owner/private-repo", tool: "custom.operation" }], options)[0];
    expect([git.service, git.action]).toEqual(["git", "Git activity"]);
  });

  test("fresh receipt evidence bounds running state; malformed receipts and evidence never become events", () => {
    expect(publicActivityEvents([{ ...row, recorded_at: "2026-10-25T11:45:00Z" }], options)[0].status).toBe("running");
    expect(publicActivityEvents([{ ...row, recorded_at: "2026-10-25T11:44:59Z" }], options)[0].status).toBe("stale");
    expect(publicActivityEvents([{ ...row, recorded_at: "2026-10-25T12:01:00Z" }], options)[0].status).toBe("stale");
    for (const recorded_at of [null, undefined, "", "invalid", "0", {}, 42]) expect(publicActivityEvents([{ ...row, recorded_at }], options)).toEqual([]);
    for (const bad of [{ evidence: "verified" }, { status: "success" }, { id: "" }]) expect(publicActivityEvents([{ ...row, ...bad }], options)).toEqual([]);
    expect(publicActivityEvents([{ ...row, evidence: "observed", status: "failed" }], options)[0].evidence).toBe("observed");
  });

  test("known operations use closed status-aware templates while lookalike namespaces never supply labels", () => {
    const cases = [
      ["search", "Searched memory"], ["get_page", "Read memory"], ["remember", "Saved memory"],
      ["files.read", "Read a file"], ["files.write", "Wrote a file"], ["browser.navigate", "Browsed a page"],
      ["browser.screenshot", "Took a screenshot"], ["terminal.execute", "Ran a command"], ["shell.execute", "Ran a command"],
      ["github.create_pull_request", "Created a pull request"], ["mcp__github__get_pull_request", "Read a pull request"],
      ["github.merge_pull_request", "Merged a pull request"], ["github.create_issue", "Created an issue"],
      ["github.get_issue", "Read issues"], ["email.create_draft", "Drafted an email"], ["email.send", "Sent an email"],
      ["calendar.list_events", "Read calendar events"], ["calendar.create_event", "Created a calendar event"],
      ["cloud.deploy", "Deployed a service"], ["cloud.restart_service", "Restarted a service"],
      ["docs.read", "Read a document"], ["docs.edit", "Edited a document"], ["database.query", "Queried a database"],
    ];
    for (const [tool, action] of cases) expect(publicActivityEvents([{ ...row, tool, status: "completed" }], options)[0].action).toBe(action);
    expect(publicActivityEvents([{ ...row, tool: "email.create_draft" }], options)[0].action).toBe("Drafting an email");
    expect(publicActivityEvents([{ ...row, tool: "email.send", status: "failed" }], options)[0].action).toBe("Attempted to send an email");
    for (const tool of ["mcp__github-lookalike__create_pull_request", "mcp__private__github_create_pull_request", "private_github.create_pull_request", "github.create_pull_request_private_repo", "github.com/create_pull_request"]) {
      const event = publicActivityEvents([{ ...row, tool, resource: null }], options)[0];
      expect(event.service).toBe("other");
      expect(event.action).toBe("Agent activity");
      expect(JSON.stringify(event)).not.toContain(tool);
    }
    for (const [tool, service] of [["cloud.restart_service", "cloud"], ["database.query", "data"], ["shell.execute", "code"]]) expect(publicActivityEvents([{ ...row, tool, resource: "custom://private-resource" }], options)[0].service).toBe(service);
  });

  test("requires explicit public opt-in and bounds the newest logical events", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...row, id: `private-${index}`, action_key: `private-key-${index}`, recorded_at: new Date(now.getTime() - index * 1000) }));
    const events = publicActivityEvents([...rows.reverse(), rows[0]], options);
    expect(events).toHaveLength(20);
    expect(events[0].updatedAt).toBe(now.toISOString());
    expect(new Set(events.map(event => event.id)).size).toBe(20);
    expect(publicActivityEvents(rows, { ...options, enabled: false })).toEqual([]);
    expect(publicActivityEvents(rows, { ...options, scope: "" })).toEqual([]);
    expect(publicActivityEvents(rows, { ...options, key: "" })).toEqual([]);
    const profile = { slug: "public-page", displayName: "Ada", bio: "", published: true };
    expect(publicActivitySnapshot(profile, {}, now, { rows, scope: options.scope, key: options.key }).activity).toEqual({ enabled: false, events: [] });
    const preview = publicActivitySnapshot(profile, {}, now, { rows, scope: options.scope, key: options.key, preview: true });
    expect(preview.activity.enabled).toBe(false);
    expect(preview.activity.events).toHaveLength(20);
    const publicValue = publicActivitySnapshot({ ...profile, showActivity: true }, {}, now, { rows: rows.map(value => ({ ...value, summary: "private".repeat(10_000), source_label: "private".repeat(10_000) })), scope: options.scope, key: options.key });
    expect(Buffer.byteLength(JSON.stringify(publicValue))).toBeLessThan(16_000);
    expect(JSON.stringify(publicValue)).not.toContain("private");
  });
});
