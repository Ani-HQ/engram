import assert from "node:assert/strict";
import type postgres from "postgres";
import { issueToken, authenticateStoredSecret, listTokens, setTokenSource } from "../gateway/src/auth";
import { recordAction, listActions } from "../gateway/src/actions";
import { getActivity, listActivities } from "../gateway/src/activities";
import { audit } from "../gateway/src/audit";
import { normalizeToken } from "../gateway/src/policies";
import { getOrg, withOrg } from "../gateway/src/orgs";
import { getShowcaseSettings, getPublicActivity, updateShowcaseSettings } from "../gateway/src/showcase";
import { PROFILE_PRESENTATION_SCHEMA_VERSION, SHOWCASE_SCHEMA_VERSION } from "../gateway/src/showcase-schema";

// Called only after the parent's disposable-database guard and migrations.
export async function checkTaskActivity(db: postgres.Sql): Promise<number> {
  let checks = 0;
  function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
  const versions = (await db`SELECT version, activity_version, showcase_version, profile_presentation_version FROM engram_schema_state WHERE id=true`)[0];
  equal([versions.version, versions.activity_version, versions.showcase_version, versions.profile_presentation_version], [2026102202, 2026102301, 2026102501, PROFILE_PRESENTATION_SCHEMA_VERSION], "Additive presentation readiness preserves every predecessor activity and showcase marker");
  equal(SHOWCASE_SCHEMA_VERSION, 2026102501, "Existing runtime revisions retain their exact showcase schema contract");
  const org = (await getOrg(2))!;
  const raw = await issueToken(2, "task-source-codex", true, null, db, { harness: "codex", label: "Development laptop" });
  const agent = (await authenticateStoredSecret(raw, db))!;
  const other = (await authenticateStoredSecret(await issueToken(2, "task-source-other", true, null, db), db))!;
  equal([agent.name, agent.orgId, agent.source], ["task-source-codex", 2, { harness: "codex", label: "Development laptop", kind: "registered" }], "Registered source is returned without changing authenticated identity");
  equal((await listTokens(2)).find(token => token.name === agent.name)?.harness, "codex", "Connection listing retains the explicit source registration");
  const started = await recordAction(agent, { tool: "files.write", summary: "Updating release notes", runId: "task-context-regression", actionKey: "task-context:write", eventId: "task-context:write:start", status: "running", taskTitle: "Publish the October release", currentStep: "Updating release notes", harness: "cursor", sourceLabel: "Spoofed source", resource: "docs/release.md" });
  equal([started.action.harness, started.action.sourceLabel, started.action.sourceKind], ["codex", "Development laptop", "registered"], "An incoming reported source cannot override the registered connection");
  const completedInput = { tool: "files.write", summary: "Release notes updated", runId: "task-context-regression", actionKey: "task-context:write", eventId: "task-context:write:done", status: "completed", outcome: "October release notes are ready", resource: "docs/release.md" };
  const completed = await recordAction(agent, completedInput);
  const retried = await recordAction(agent, completedInput);
  equal(retried.action.id, completed.action.id, "Structured task reports retain event retry deduplication");
  await assert.rejects(() => recordAction(agent, { ...completedInput, outcome: "Different reported outcome" }), error => (error as any).status === 409); checks++;
  await recordAction(other, { tool: "github.create_pull_request", summary: "Reviewing release notes", runId: "task-context-regression", actionKey: "task-context:review", eventId: "task-context:review:start", status: "running", currentStep: "Reviewing the release diff", resource: "https://github.com/example/release/pull/42", harness: "grok-bot", sourceLabel: "Review assistant" });
  const detail = (await getActivity(agent, "run:task-context-regression")).activity;
  equal([detail.kind, detail.taskTitle, detail.outcome, detail.currentStep, detail.status], ["task", "Publish the October release", "October release notes are ready", "Reviewing the release diff", "running"], "Structured context is explicit while aggregate status remains child-derived");
  equal(detail.resources, ["docs/release.md", "https://github.com/example/release/pull/42"], "Resources include all contributors with stable deduplication");
  equal(detail.agents.find(value => value.name === other.name)?.sourceKind, "reported", "Unregistered harness identity remains explicitly reported");
  equal(detail.actions.find(value => value.agent === agent.name)?.currentStep, null, "A completed logical action cannot expose an inherited running stage");
  equal((await listActions(agent, { agent: agent.name })).actions[0].taskTitle, "Publish the October release", "Task title survives an update that omitted optional context");
  equal((await db`SELECT task_title FROM action_events WHERE id = ${completed.action.id}`)[0].task_title, null, "Projection inheritance never rewrites the append-only event");
  equal((await listActivities(agent, { kind: "tasks", q: "October release", agent: agent.name })).activities.length, 1, "Task title and outcome are searchable through the grouped endpoint");

  await recordAction(other, { tool: "browser.open", summary: "Open a reference", harness: "claude-code", sourceLabel: "Old label", actionKey: "task-source:atomic", status: "running" });
  await recordAction(other, { tool: "browser.open", summary: "Read the reference", harness: "grok-bot", actionKey: "task-source:atomic", status: "running" });
  const standalone = (await listActivities(other, { kind: "tasks", q: "Read the reference" })).activities[0];
  equal([standalone.kind, standalone.taskTitle, standalone.agents[0].harness, standalone.agents[0].sourceLabel], ["action", null, "grok-bot", null], "Legacy standalone reports remain actions and source snapshots never mix labels from different reports");

  // Newer memory receipts must not occupy or truncate the task page.
  for (let index = 0; index < 5; index++) await withOrg(org, agent, () => audit(agent.name, "remember", `memory-operation-${index}`, "ok", `task-source/memory-${index}`));
  await withOrg(org, agent, () => audit(agent.name, "recall", "legacy operation without a page", "ok"));
  const tasks = await listActivities(agent, { kind: "tasks", agent: agent.name, limit: 1 });
  equal([tasks.activities.length, tasks.activities[0].id, tasks.more, tasks.stats.total], [1, "run:task-context-regression", false, 1], "Task kind is applied before pagination and statistics despite newer memory operations");
  equal(tasks.tools.includes("recall"), false, "Task facets exclude observed-only memory operations");
  const memory = await listActivities(agent, { kind: "memory", agent: agent.name, limit: 2 });
  equal([memory.activities.length, memory.more, memory.stats.total], [2, true, 6], "Memory kind paginates and counts its own operation stream");
  equal(memory.activities.every(value => value.kind === "memory" && value.taskTitle === null && value.outcome === null), true, "Single memory operations never acquire invented task context");
  equal(memory.activities[0].agents[0].harness, "codex", "Observed operations retain registered connection source within their tenant");
  equal((await listActivities(agent, { kind: "memory", q: "legacy operation without a page", agent: agent.name })).activities[0].resources, [], "A legacy memory operation without a slug does not fabricate a resource");
  const all = await listActivities(agent, { kind: "all", agent: agent.name });
  equal(all.stats.total, 7, "Compatibility all-view includes the task and individual memory operations");
  const foreign = (await authenticateStoredSecret(await issueToken(3, "task-source-codex", true, null, db, { harness: "cursor" }), db))!;
  equal((await listActivities(foreign, { kind: "tasks", q: "Publish the October release" })).stats.total, 0, "Task/source context cannot cross a same-named connection in another tenant");
  equal(await setTokenSource(2, agent.name, { harness: "grok-bot", sourceLabel: "Updated source" }, db), { name: agent.name, harness: "grok-bot", sourceLabel: "Updated source" }, "Source edits update only the selected active connection");
  const updated = (await authenticateStoredSecret(raw, db))!;
  equal([updated.name, updated.orgId, updated.canWrite, updated.source?.harness], [agent.name, 2, true, "grok-bot"], "Reauthentication gets the updated display source with unchanged identity and permission");
  equal((await authenticateStoredSecret(await issueToken(3, "other-source-check", true, null, db), db))?.orgId, 3, "Editing source does not move credentials between tenants");
  equal((await listTokens(3)).find(token => token.name === agent.name)?.harness, "cursor", "A same-named connection in another tenant retains its source");
  equal(await setTokenSource(2, "absent-other-connection", { harness: "codex" }, db), null, "Source edits cannot create or redirect an absent connection");
  equal((await recordAction(updated, completedInput)).action.harness, "codex", "Retrying an old event after a registration edit preserves its original immutable source snapshot");
  const publicValue = JSON.stringify((await getShowcaseSettings(normalizeToken({ ...agent, role: "owner" }), "https://integration.example", db)).preview);
  equal(["Publish the October release", "Development laptop", "Review assistant"].some(value => publicValue.includes(value)), false, "Task titles, results and source labels remain absent from public aggregates");
  const human = normalizeToken({ ...updated, role: "owner" });
  const previousProfile = (await getShowcaseSettings(human, "https://integration.example", db)).profile;
  const column = (await db`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'action_profiles' AND column_name = 'show_activity'`)[0];
  equal([column?.column_default, column?.is_nullable], ["false", "NO"], "Existing public profiles acquire a non-null activity permission that defaults off");
  try {
    await updateShowcaseSettings(human, { ...previousProfile, published: true, showActivity: false }, "https://integration.example", db);
    equal((await getPublicActivity(previousProfile.slug, db))?.activity, { enabled: false, events: [] }, "Published profiles retain aggregate-only access until an owner explicitly opts in");
    const privateReport = { tool: "github.create_pull_request", summary: "Private public-projection test summary", taskTitle: "Private public-projection task", currentStep: "Private public-projection step", resource: "https://github.com/private-projection-owner/private-projection-repo/pull/93", actionKey: "private-public-projection-key", status: "running", eventId: "private-public-projection-start" };
    await recordAction(updated, privateReport);
    await updateShowcaseSettings(human, { ...previousProfile, published: true, showActivity: true }, "https://integration.example", db);
    const first = (await getPublicActivity(previousProfile.slug, db))!;
    const event = first.activity.events[0];
    equal([event.agent, event.service, event.action, event.status], [{ product: "grok-bot", label: "Grok Bot" }, "github", "Creating a pull request", "running"], "Real SQL projects the latest logical action with canonical source, provider and a fixed operation label");
    await recordAction(updated, { ...privateReport, status: "completed", currentStep: undefined, outcome: "Private public-projection outcome", eventId: "private-public-projection-finish" });
    const second = (await getPublicActivity(previousProfile.slug, db))!;
    equal(second.activity.events.find(value => value.id === event.id)?.action, "Created a pull request", "A terminal SQL update preserves the opaque public identity and changes its safe label");
    equal(second.activity.events.filter(value => value.id === event.id).length, 1, "Append-only lifecycle rows become one public logical event");
    for (const secret of ["Private public-projection", "private-projection-owner", "private-projection-repo", "private-public-projection-key", agent.name, "Development laptop", "Updated source"]) equal(JSON.stringify(second).includes(secret), false, "Real public snapshots exclude raw identities, descriptions and resource details");
    equal(second.activity.events.length <= 20, true, "The real SQL public feed is bounded");
    await updateShowcaseSettings(human, { ...previousProfile, published: true, showActivity: false }, "https://integration.example", db);
    equal((await getPublicActivity(previousProfile.slug, db))?.activity, { enabled: false, events: [] }, "Opting out removes events while preserving published aggregates");
  } finally {
    await updateShowcaseSettings(human, previousProfile, "https://integration.example", db);
  }
  return checks;
}
