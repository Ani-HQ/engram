# Linked workspaces: one agent connection that can read your teams

Draft, 7 November 2026, against `4de18d1`. Status: proposal. Nothing here is
built or shipped.

## Problem

Every agent connection is bound to exactly one workspace. An OAuth grant signs
`org_id` and `membership_id`; an `eng_` token stores one `org_id`. That is the
right default, but it makes a common case awkward.

A teammate connects their agent to their personal workspace, as `SHARING.md`
recommends. Later they want that agent to read what the team knows, for example
"what did we decide about the deploy pipeline in Ani HQ?". Today they must add
a second connector authorized to the team, and their agent then has two
Engram servers with the same tool names. Most people won't do that.

Goal: a person who belongs to a team can let an existing personal connection
read that team in one click, or in one ask from the agent that ends in one
click.

## Decisions proposed

| Decision | Proposal |
| --- | --- |
| Who grants | Only the human, in the console, with a current session. An agent can ask for a link but never create one. |
| What it grants | Read-only access to one named team workspace, for one connection. |
| Writes | Stay in the connection's home workspace. No cross-workspace writes in v1. |
| Picking a workspace | Read tools take an optional `workspace` argument. It only selects among links already stored for this connection; it never authorizes anything. |
| Default | Home workspace only. Omitting `workspace` behaves exactly like today. |
| Membership | Checked live on every call against the exact membership ID recorded when the link was made. Leaving or being removed from the team ends access immediately. |
| Team control | Team owners see linked connections on their Connections page and can revoke any of them. A team policy can turn linking off. |
| Audit | Every linked read writes an audit row in the team, attributed to the person and the connection, marked as linked. |

## Experience

### One click, from the console

On **Connections**, each personal connection gets an **Also read from** row
listing the teams the signed-in person belongs to, each with a toggle. Turning
one on asks for a short confirmation: "Let *Claude (Ani's laptop)* read Ani HQ's
memory? It cannot write there. Team owners can see and revoke this." The toggle
writes the link and takes effect on the agent's next call.

The team's Connections page lists it as "Ani's *Claude (Ani's laptop)*, linked
from a personal workspace, read only", with **Revoke**.

### One ask, from the agent

A new read-only tool, `list_workspaces`, returns the home workspace, the
linked teams, and any teams the person belongs to that are not linked yet.
Each unlinked team comes with a console URL that opens Connections with that
toggle focused. The agent can say: "You're in Ani HQ but this connection can't
read it yet. Approve it here: <link>". After one click, the agent retries.

`whoami` also reports linked workspaces so agents learn about them at start.

### Using a link

`recall`, `search`, `list_pages`, `get_page` and the task readers
(`find_tasks`, `resume_task`, `list_actions`) accept
`workspace: "<slug>"`. Results from a linked team carry the workspace name, so
the agent and the person can see where a memory came from.

`workspace: "all"` on `recall` and `search` fans out to home plus every linked
team, with a per-workspace result cap and labeled results. This is the
"just ask" path and the main reason for the feature.

Write tools (`remember`, `put_page`, `checkpoint_task`, `record_action` and the
rest) reject a `workspace` argument with a clear message: connect an agent
directly to the team, or use Sharing to publish reviewed excerpts.

## Design

### Storage

New central table, gateway database:

```sql
CREATE TABLE connection_workspace_links (
  id                   bigserial PRIMARY KEY,
  home_org_id          bigint NOT NULL REFERENCES orgs(id),
  connection_id        text   NOT NULL,          -- same identity connection_lifecycle uses
  target_org_id        bigint NOT NULL REFERENCES orgs(id),
  target_membership_id bigint NOT NULL REFERENCES org_members(id),
  granted_by_email     text   NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  revoked_by_email     text
);
CREATE UNIQUE INDEX ON connection_workspace_links (home_org_id, connection_id, target_org_id)
  WHERE revoked_at IS NULL;
```

The home workspace must be personal in v1 (`orgs.kind = 'personal'`). Team to
team linking is out of scope.

### Resolving a call

1. Authenticate exactly as today. This yields the home `TokenRecord`.
2. If a read tool has `workspace` set to something other than the home slug,
   look up an unrevoked link for `(home_org_id, connection_id, target slug)`.
3. Check that `target_membership_id` is still the person's current membership
   in the target (same rule as `oauthMemberForClaims`), that the connection's
   lifecycle row is not archived or deleted, and that the target's policy
   allows linked reads.
4. Build a derived `TokenRecord` for the target: target `orgId`, role
   `member`, `canWrite: false`, and an actor name of the form
   `linked:<home actor>`. OAuth scopes still apply: a grant without
   `memory:read` gets nothing.
5. Run the existing read path against the target's engine and audit there.

Any failed check returns the same "not linked" error, so a probe can't tell
"no such team" from "not a member".

### What this changes in the security contract

`OAUTH.md` says neither auth path chooses a tenant from an untrusted request
parameter. This proposal keeps the meaning of that rule: the credential still
decides everything it can reach, through server-side link rows a human created
with a live session. The `workspace` argument only selects one of those
pre-authorized targets, like choosing a file you already have access to. The
doc should be updated to say so explicitly, and tests must prove an unlinked or
stale target is unreachable whatever the argument says.

### Lifecycle

- Archiving or deleting a connection revokes its links.
- Removing a member from a team, or a member leaving, breaks the membership ID
  match. Rejoining does not revive old links.
- Deleting a personal workspace deletes its links.
- A team owner revoking a link records `revoked_by_email`.
- Turning the team policy off blocks all linked reads without deleting rows,
  so turning it back on restores them. (Open question below.)

### Billing

Linked reads are reads of the team, so they follow the team's rules for reads,
which stay available even after a trial lapses. No new billable unit.

## Out of scope for v1

- Writing to a team through a linked connection.
- Team-to-team links, or linking a team connection to a personal workspace.
- Letting an agent create a link without the human's click.
- Changing how Sharing snapshots or standing share rules work.

## Tests and release gates

- Unit: link resolution, every rejection path, argument validation on write
  tools, `workspace: "all"` labeling and caps.
- Tenant isolation: a connection with no link, a revoked link, a stale
  membership ID, an archived connection and a disabled team policy each read
  nothing from the team, including via search and exports.
- Audit: linked reads appear in the team's activity and not as home writes.
- Console: toggle, confirmation, team-side list and revoke, with loading,
  empty, error and narrow-screen states per the design-system contract.
- Live check in production with a test team before announcing.

## Stages

1. Table, resolution path, `workspace` on `recall`/`search`/`get_page`/
   `list_pages`, `list_workspaces`, `whoami` update, tests. Links created by an
   operator CLI only, for a private trial.
2. Console toggle, team-side list and revoke, team policy.
3. `workspace: "all"` fan-out and task readers.
4. Docs (`OAUTH.md`, `ORGS.md`, `SHARING.md`, `CONNECTION-LIFECYCLE.md`) and
   the agent setup prompts.

## Open questions

1. Should a new link need a team owner's approval, or is membership enough?
   Proposal: membership is enough, because any member can already connect an
   agent directly to the team. Owners can revoke.
2. Should `recall` search linked teams by default once linked, instead of
   needing `workspace: "all"`? Simpler for agents, but it mixes team memory into
   personal answers without the agent asking.
3. When a team turns linking off, should links be revoked for good or just
   paused?
4. Should team-side audit show the person's email, or only their member name?
