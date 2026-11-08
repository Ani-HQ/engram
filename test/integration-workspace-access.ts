// Called only by the marked disposable PostgreSQL integration runner.
// Linked workspaces and teammate requests against real tables. No provider calls.
import assert from "node:assert/strict";
import type postgres from "postgres";
import { closeOrgPool, ensureDatabase, migrateOrgDataTables, poolFor } from "../gateway/src/db";
import { getOrg, withOrg } from "../gateway/src/orgs";
import { DEFAULT_POLICIES, normalizeToken } from "../gateway/src/policies";
import { upsertMemoryEntry } from "../gateway/src/memory-entries";
import { activeLinks, createLink, listHomeLinks, listTeamLinks, revokeHomeLink, revokeTeamLink, workspaceChoices } from "../gateway/src/linked-workspaces";
import { approveRequest, askTeammate, declineRequest, getShareRequest, listApprovals, previewRequest, revokeGrant } from "../gateway/src/share-requests";

export async function checkWorkspaceAccess(db: postgres.Sql): Promise<number> {
  assert.equal((await db`SELECT purpose FROM _engram_integration_sandbox WHERE id = 1`)[0]?.purpose, "engram-disposable-integration-v1");
  let checks = 1;
  const equal = (a: unknown, b: unknown, message: string) => { assert.deepEqual(a, b, message); checks++; };
  const reject = async (fn: () => Promise<unknown>, code: string, message: string) => { await assert.rejects(fn, (error: any) => error.code === code, message); checks++; };
  const text = (result: any) => JSON.parse(result.content[0].text);
  const personalId = 850001, teamId = 850002, otherTeamId = 850003, mateId = 850004;
  const ani = "linked-owner@example.test", mate = "linked-teammate@example.test";
  const client = { enabled: () => false, available: () => false, evaluate: async () => { throw new Error("No provider request is permitted in this suite"); } };
  const sharing = { db, client };
  try {
    equal(Number((await db`SELECT count(*) AS n FROM orgs WHERE id IN (${personalId},${teamId},${otherTeamId},${mateId})`)[0].n), 0, "Fixtures must not replace an existing workspace");
    for (const [id, kind] of [[personalId, "personal"], [teamId, "team"], [otherTeamId, "team"], [mateId, "personal"]] as const) {
      await db`INSERT INTO orgs(id,name,slug,kind,brain_db,data_db,home_dir,policies,provisioning_status)
        VALUES (${id},${`Access fixture ${id}`},${`access-fixture-${id}`},${kind},${`brain_org_${id}`},${`brain_org_${id}`},${`org-${id}`},${db.json(DEFAULT_POLICIES)},'ready')`;
    }
    await db`INSERT INTO org_members(org_id,email,role) VALUES (${personalId},${ani},'owner'),(${mateId},${mate},'owner'),(${otherTeamId},${ani},'member')`;
    const aniTeam = Number((await db`INSERT INTO org_members(org_id,email,role) VALUES (${teamId},${ani},'member') RETURNING id`)[0].id);
    await db`INSERT INTO org_members(org_id,email,role) VALUES (${teamId},${mate},'owner')`;
    const personal = (await getOrg(personalId, db))!, team = (await getOrg(teamId, db))!, matePersonal = (await getOrg(mateId, db))!;
    const owner = normalizeToken({ name: ani, orgId: personalId, role: "owner", kind: "session", email: ani });
    const agent = normalizeToken({ name: `oauth:${ani}:claude`, orgId: personalId, role: "owner", kind: "oauth", email: ani, scopes: [] });
    const connections = [{ agent: agent.name, kind: "oauth" as const, displayName: "Claude", status: "authorized", archivedAt: null }];
    const link = { kind: "oauth" as const, name: agent.name };

    // ---- Part 1: linked workspaces ----
    equal(await activeLinks(personal, link, db), [], "A new connection reaches no team");
    const listed = await listHomeLinks(owner, personal, connections, db);
    equal(listed.teams.map(t => t.id).sort(), [teamId, otherTeamId].sort(), "Only teams the person belongs to are offered");
    await reject(() => createLink(owner, personal, { agent: agent.name, teamId: mateId }, connections, db), "forbidden", "A workspace the person isn't in can't be linked");
    await reject(() => createLink(owner, personal, { agent: "oauth:someone-else:x", teamId }, connections, db), "not_found", "Only this workspace's own active connections can be linked");
    const memberSession = normalizeToken({ name: mate, orgId: teamId, role: "owner", kind: "session", email: mate });
    await reject(() => createLink(memberSession, team, { agent: agent.name, teamId }, connections, db), "forbidden", "Links are made only from a personal workspace by its owner");
    const created = await createLink(owner, personal, { agent: agent.name, teamId }, connections, db);
    equal((await activeLinks(personal, link, db)).map(t => t.orgId), [teamId], "The link takes effect for that connection");
    equal((await createLink(owner, personal, { agent: agent.name, teamId }, connections, db)).link.id, created.link.id, "Linking again is idempotent");
    equal(await activeLinks(personal, { kind: "token", name: agent.name }, db), [], "A link is bound to the exact credential kind and name");
    const choices = await workspaceChoices(personal, agent, db, "https://engram.example");
    equal([choices.linked.map(l => l.slug), choices.notLinked.map(l => l.slug)], [[team.slug], [`access-fixture-${otherTeamId}`]], "list_workspaces separates linked from linkable teams");

    await db`UPDATE orgs SET policies = ${db.json({ ...DEFAULT_POLICIES, linkedReads: false })} WHERE id = ${teamId}`;
    equal(await activeLinks(personal, link, db), [], "A team owner turning linked reads off pauses every link");
    await reject(() => createLink(owner, personal, { agent: agent.name, teamId }, connections, db), "linking_disabled", "No new links while turned off");
    await db`UPDATE orgs SET policies = ${db.json(DEFAULT_POLICIES)} WHERE id = ${teamId}`;
    equal((await activeLinks(personal, link, db)).length, 1, "Turning it back on restores paused links");

    const teamView = await listTeamLinks(memberSession, team, db);
    equal([teamView.canRevoke, teamView.links.map(l => l.member)], [true, [ani]], "Team owners see who linked a personal connection");
    const plainMember = normalizeToken({ name: ani, orgId: teamId, role: "member", kind: "session", email: ani });
    equal((await listTeamLinks(plainMember, team, db)).canRevoke, false, "Members can see links but not revoke them");
    await reject(() => revokeTeamLink(plainMember, team, created.link.id, db), "forbidden", "Only team owners revoke from the team side");
    await revokeTeamLink(memberSession, team, created.link.id, db);
    equal(await activeLinks(personal, link, db), [], "A team owner's revoke ends access");

    const relinked = await createLink(owner, personal, { agent: agent.name, teamId }, connections, db);
    await db`DELETE FROM org_members WHERE id = ${aniTeam}`;
    equal(await activeLinks(personal, link, db), [], "Leaving the team ends linked access");
    await db`INSERT INTO org_members(org_id,email,role) VALUES (${teamId},${ani},'member')`;
    equal(await activeLinks(personal, link, db), [], "Rejoining does not revive an old link");
    equal(Number((await db`SELECT count(*) AS n FROM connection_workspace_links WHERE id = ${relinked.link.id}`)[0].n), 0, "The old membership's link row is gone with it");
    const fresh = await createLink(owner, personal, { agent: agent.name, teamId }, connections, db);
    await revokeHomeLink(owner, personal, fresh.link.id, db);
    equal(await activeLinks(personal, link, db), [], "The person can unlink from their own workspace");

    // ---- Part 2: teammate requests ----
    const mateDb = `brain_org_${mateId}`;
    for (const name of [mateDb, `brain_org_${teamId}`]) { await ensureDatabase(name); await migrateOrgDataTables(poolFor(name)); }
    await poolFor(mateDb)`TRUNCATE memory_entries, trails, reflex_decisions, review_items, dream_runs RESTART IDENTITY CASCADE`;
    const mateOwner = normalizeToken({ name: mate, orgId: mateId, role: "owner", kind: "session", email: mate });
    await withOrg(matePersonal, mateOwner, () => upsertMemoryEntry({ slug: "notes/deploy", topicHint: "deploy", rawText: "The deploy pipeline uses staged rollouts with a manual gate.\n\nMy dentist is on Tuesday.", repo: null, harness: null }));
    const asker = normalizeToken({ name: `oauth:${ani}:claude`, orgId: teamId, role: "member", kind: "oauth", email: ani, scopes: [] });
    const mails: any[] = [];
    const ask = (question: string, teammate = mate) => askTeammate(asker, team, { teammate, question }, { db, notify: async input => { mails.push(input); } });

    equal((await ask("anything at all", "nobody@example.test")).isError, true, "A non-member can't be asked");
    equal((await ask("anything at all", ani)).isError, true, "You can't ask yourself");
    const pending = text(await ask("What did we decide about the deploy pipeline?"));
    equal([pending.status, mails.length, mails[0]?.to], ["pending", 1, mate], "A request waits for the owner and emails them once");
    equal(text(await getShareRequest(asker, team, { requestId: pending.requestId }, { db })).status, "pending", "The asker sees it waiting");
    const outsider = normalizeToken({ name: "oauth:outsider:x", orgId: teamId, role: "member", kind: "oauth", email: "outsider@example.test", scopes: [] });
    equal((await getShareRequest(outsider, team, { requestId: pending.requestId }, { db })).isError, true, "Only the asker can read their request");

    const approvals = await listApprovals(mateOwner, matePersonal, db);
    equal([approvals.pending.length, approvals.pending[0].question, approvals.pending[0].requester], [1, "What did we decide about the deploy pipeline?", ani], "The owner sees who asked and the exact question");
    const draft = await withOrg(matePersonal, mateOwner, () => previewRequest(mateOwner, matePersonal, pending.requestId, { db, sharing }));
    assert.ok(draft.preview.candidates.length > 0); checks++;
    equal(Number((await db`SELECT count(*) AS n FROM context_shares WHERE source_org = ${mateId}`)[0].n), 0, "Previewing shares nothing");
    const approved = await withOrg(matePersonal, mateOwner, () => approveRequest(mateOwner, matePersonal, pending.requestId,
      { mode: "standing", topic: "deploy pipeline", previewId: draft.preview.previewId, selections: [{ id: draft.preview.candidates[0].id, text: "The deploy pipeline uses staged rollouts with a manual gate." }], acknowledged: true },
      "https://engram.example", { db, sharing }));
    assert.ok(approved.grantId); checks++;
    const answered = text(await getShareRequest(asker, team, { requestId: pending.requestId }, { db }));
    equal([answered.status, answered.excerpts.map((e: any) => e.text)], ["answered", ["The deploy pipeline uses staged rollouts with a manual gate."]], "The asker gets exactly the approved excerpt");
    equal(JSON.stringify(answered).includes("dentist"), false, "Nothing unapproved leaves");

    const auto = text(await ask("Is there a manual gate in the deploy pipeline?"));
    equal([auto.status, auto.excerpts.length], ["answered", 1], "A 90-day approval answers covered questions from approved excerpts");
    const notCovered = text(await ask("How is hiring going this quarter?"));
    equal(notCovered.status, "pending", "Anything outside the topic comes back as a request");
    await declineRequest(mateOwner, matePersonal, notCovered.requestId, { db });
    const declined = text(await getShareRequest(asker, team, { requestId: notCovered.requestId }, { db }));
    equal(declined.status, "closed", "A decline reads as closed");
    await revokeGrant(mateOwner, matePersonal, approved.grantId!, { db });
    equal(text(await ask("Any change to the deploy pipeline gate?")).status, "pending", "Revoking the approval stops automatic answers");

    for (let i = 0; i < 4; i++) await ask(`Question number ${i} about something`);
    equal((await ask("One more question please")).isError, true, "Open requests to one person are capped");
    await db`UPDATE orgs SET policies = ${db.json({ ...DEFAULT_POLICIES, shareRequests: false })} WHERE id = ${teamId}`;
    const off = await askTeammate(asker, (await getOrg(teamId, db))!, { teammate: mate, question: "Anything new on deploys?" }, { db, notify: async () => {} });
    equal(off.isError, true, "Team owners can turn teammate requests off");
    equal(mails.length, 1, "Several requests in a short window send one email");
    return checks;
  } finally {
    await db`DELETE FROM context_share_requests WHERE team_org IN (${teamId},${otherTeamId})`;
    await db`DELETE FROM context_shares WHERE source_org = ${mateId}`;
    await db`DELETE FROM context_share_grants WHERE source_org = ${mateId}`;
    await db`DELETE FROM context_share_previews WHERE source_org = ${mateId}`;
    await db`DELETE FROM connection_workspace_links WHERE home_org_id = ${personalId}`;
    await db`DELETE FROM org_members WHERE org_id IN (${personalId},${teamId},${otherTeamId},${mateId})`;
    await db`DELETE FROM orgs WHERE id IN (${personalId},${teamId},${otherTeamId},${mateId})`;
    await Promise.all([closeOrgPool(`brain_org_${mateId}`), closeOrgPool(`brain_org_${teamId}`)]);
  }
}
