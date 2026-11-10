# Linked workspaces and teammate requests

Drafted 7 November 2026 against `4de18d1`. Status: built on
`feat/linked-workspaces` (8 November 2026), with the decisions below. Not
shipped until it is merged, released and checked in production.

Two parts, in two directions:

- **Part 1, linked workspaces.** Your own agent reads teams you already belong
  to. No one else has to approve, because it is team memory you can already read.
- **Part 2, ask a teammate.** A teammate's agent asks for something from your
  personal memory. Nothing leaves without your yes, and you approve the exact
  excerpts.

Part 2 borrows the request-and-approve pattern from GBrain Teams' "ask before a
teammate's AI uses an account" (gbrain.io, 6 November 2026), adapted to memory
instead of connected accounts.

## Part 1: linked workspaces

### Problem

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

### Decisions proposed

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

### Experience

#### One click, from the console

On **Connections**, each personal connection gets an **Also read from** row
listing the teams the signed-in person belongs to, each with a toggle. Turning
one on asks for a short confirmation: "Let *Claude (Ani's laptop)* read Ani HQ's
memory? It cannot write there. Team owners can see and revoke this." The toggle
writes the link and takes effect on the agent's next call.

The team's Connections page lists it as "Ani's *Claude (Ani's laptop)*, linked
from a personal workspace, read only", with **Revoke**.

#### One ask, from the agent

A new read-only tool, `list_workspaces`, returns the home workspace, the
linked teams, and any teams the person belongs to that are not linked yet.
Each unlinked team comes with a console URL that opens Connections with that
toggle focused. The agent can say: "You're in Ani HQ but this connection can't
read it yet. Approve it here: <link>". After one click, the agent retries.

`whoami` also reports linked workspaces so agents learn about them at start.

#### Using a link

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

### Design

#### Storage

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

#### Resolving a call

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

#### What this changes in the security contract

`OAUTH.md` says neither auth path chooses a tenant from an untrusted request
parameter. This proposal keeps the meaning of that rule: the credential still
decides everything it can reach, through server-side link rows a human created
with a live session. The `workspace` argument only selects one of those
pre-authorized targets, like choosing a file you already have access to. The
doc should be updated to say so explicitly, and tests must prove an unlinked or
stale target is unreachable whatever the argument says.

#### Lifecycle

- Archiving or deleting a connection revokes its links.
- Removing a member from a team, or a member leaving, breaks the membership ID
  match. Rejoining does not revive old links.
- Deleting a personal workspace deletes its links.
- A team owner revoking a link records `revoked_by_email`.
- Turning the team policy off pauses all linked reads without deleting rows,
  so turning it back on restores them. A team owner can make access stricter
  this way, never looser.

#### Billing

Linked reads are reads of the team, so they follow the team's rules for reads,
which stay available even after a trial lapses. No new billable unit.

## Part 2: ask a teammate

### Problem

Sharing today only pushes: you describe a topic, review excerpts, and send
them. A teammate who needs something you know has to message you, wait, and
hope you remember to share it. Their agent can't ask.

### Decisions proposed

| Decision | Proposal |
| --- | --- |
| Default | Personal memory is "ask me". Nothing is readable by teammates without a request you approve. Team memory stays open to members, as now. |
| Who can ask | A current member of a team you also belong to, through an agent connected to that team, or from the console. |
| What you approve | The exact excerpts Engram proposes for the question, after you review and trim them, exactly like Sharing today. Never raw access to your memory. |
| Approval choices | **Just this once**, **This person, this topic, for 90 days**, or **Decline**. |
| Per person | An approval covers one requester. A yes to one teammate covers no one else. |
| Expiry | A one-off request you haven't answered lapses after 24 hours. Standing approvals last 90 days, then ask again. |
| Where you answer | One **Approvals** page plus an email with a link. |
| Team owners | Can turn requests off for their team. They can make it stricter, never open anyone's memory. |
| Audit | Requests, decisions and every excerpt delivered are logged in both workspaces. |

### Experience

**The teammate's side.** Their agent, connected to Ani HQ, calls a new tool,
`ask_teammate`, with a teammate (by name or email within the shared team) and a
question: "What did Ani decide about the deploy pipeline?" The agent gets back
a request ID and "Waiting for Ani to approve." It can check later with
`get_request`, or the person sees the answer arrive on the team's Sharing page.
If a 90-day approval already covers this person and topic, the answer comes back
straight away as reviewed excerpts (see below for how "covers" is decided).

**Your side.** You get an email: "Thejus's agent in Ani HQ asked about the
deploy pipeline." The link opens **Approvals**, which shows:

- who asked, from which team and which agent connection;
- their exact question;
- the excerpts Engram proposes, each unselected, which you can trim to an exact
  substring, the same review as Sharing;
- a plain warning that anything you approve is copied into the team and stays
  readable there until you revoke it.

Then choose **Just this once**, **For 90 days on this topic**, or **Decline**.
Declining tells the requester "Ani declined" with no reason and no hint of what
exists.

The page also lists pending requests, past decisions and active 90-day
approvals, each with **Revoke**.

### How a 90-day approval answers later questions

A standing approval stores the requester, the team, and the topic as you
confirmed it (Engram drafts the topic from the question; you can edit it).
Later questions from that person are matched against your memory with the
same candidate search Sharing uses. Excerpts are delivered without asking only
when they come from material you already approved under that topic. Anything
new still comes to you as a request, with the new excerpts to review. This is
stricter than GBrain, where an approved colleague's AI reads with the owner's
full access; in Engram nothing unreviewed ever leaves.

### Design

- **Reuse Sharing.** A request creates a preview with
  `previewContextShare` (personal workspace as source, the team as
  recipient), and approval goes through `commitContextShare`, so excerpts land
  as read-only `shared-context/<share-id>/<item-id>` pages in the team with the
  existing checks on ownership, membership and team acceptance.
- **New table `context_share_requests`:** requester member ID and team, owner
  member ID, question, status (pending, approved_once, approved_standing,
  declined, expired), the preview it produced, decision time, expiry.
- **New table `context_share_grants`:** owner, requester member ID, team,
  confirmed topic, the share IDs it covers, `expires_at` (90 days), revoked
  fields. Membership is checked live on every use, against exact member IDs.
- **Mail:** one email per request, batched if several arrive within a few
  minutes, through the existing mail service and its preferences.
- **Rate limits:** a cap on open requests per requester per owner, so an agent
  can't flood someone's inbox.
- **Standing share rules** move to the same 90-day expiry, with a renewal email
  a week before.

### What it never does

- Let a teammate's agent search your memory directly.
- Deliver an excerpt you haven't reviewed.
- Reveal whether a decline was because nothing matched or because you said no.
- Let a team owner approve on your behalf.

### Known gaps to state on the page

- Excerpt matching is text or model based and can miss or misjudge relevance;
  the review step is the privacy control, not the matcher.
- Revoking an approval removes the excerpts from the team, but copies an agent
  already read into its own context are out of Engram's reach.

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
- Part 2: a request never returns unreviewed text; decline and "nothing
  matched" look identical to the requester; expired, revoked and
  stale-membership grants deliver nothing; rate limits hold.
- Live check in production with a test team before announcing.

## Stages

1. Table, resolution path, `workspace` on `recall`/`search`/`get_page`/
   `list_pages`, `list_workspaces`, `whoami` update, tests. Links created by an
   operator CLI only, for a private trial.
2. Console toggle, team-side list and revoke, team policy.
3. `workspace: "all"` fan-out and task readers.
4. Docs (`OAUTH.md`, `ORGS.md`, `SHARING.md`, `CONNECTION-LIFECYCLE.md`) and
   the agent setup prompts.
5. Part 2: request and grant tables, `ask_teammate` and `get_request`, the
   Approvals page with "just this once" and decline, and the email.
6. Part 2: 90-day approvals, revoke, the team-owner switch, and 90-day expiry
   for standing share rules.

## Decisions (8 November 2026)

1. **Membership is enough to link.** No team-owner approval; owners can see
   and revoke links, or turn linking off.
2. **Linked teams are searched only when asked.** Agents pass
   `workspace: "<slug>"` or `workspace: "all"`. Plain calls stay home.
3. **No separate names.** Engram has no member display names, so the team's
   Connections list shows the member's email (already visible to members on
   the Members list) and the agent's name. Audit rows use the agent identity
   prefixed `linked:`.
4. **Agents ask first.** Teammate requests are made through `ask_teammate`;
   there is no console form for asking yet.
5. **No "never ask me" setting in v1.** Team owners can turn requests off for
   a team.
6. **Paused, not deleted.** When a team turns linking or requests off, links
   and approvals are paused and come back when turned on.

## As built

- Tables `connection_workspace_links`, `context_share_requests` and
  `context_share_grants`, with their own readiness marker
  (`workspace_access_version`) so a rollback still starts.
- `gateway/src/linked-workspaces.ts`: link checks, the `workspace` argument,
  `list_workspaces`, and `/api/linked-workspaces`.
- `gateway/src/share-requests.ts`: `ask_teammate`, `get_request`, and
  `/api/approvals`, built on the Sharing preview and commit.
- Console: **Connections** gets "Let agents read your teams" (personal) and
  "Linked from personal workspaces" (team). A new **Approvals** page in the
  personal workspace. Two switches in team **Workspace** settings.
- Team policies `linkedReads` and `shareRequests`, both on by default.
- Emails for requests are plain text and sent at most once per 10 minutes per
  person; everything waiting is on the Approvals page.

Standing share rules now expire too (10 November 2026): 90 days from creation
or renewal, with existing rules given 90 days from that release. A reminder
email goes out about a week before, and Approvals > Automatic sharing has Renew
and Stop. Expiry stops new copies only. See SHARING.md.
