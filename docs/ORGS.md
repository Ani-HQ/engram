# Organizations

An organization is a brain. People and agents inside it share pages on purpose. A second organization has its own Postgres database and its own gbrain child, so it cannot read the first.

Ani HQ is org 1. Its pages stay in `brain_shared`. Its gateway rows stay in `engram_gateway`. A new org gets `brain_org_<id>` for both pages and reflex rows, and a child that starts on the first request and exits after it goes idle.

This is not the old scope router. Scopes split one team's pages by label. An org boundary is a different database.

## Roles

- **Owner.** Creates the org, invites people, sets the four policy switches, mints and revokes agent tokens.
- **Member.** Uses the console. Can remember, recall, and approve review items when the org allows it. Cannot change policy.
- **Agent.** An MCP token. Read-only, or read and write. The gateway allowlist is still the ceiling.

Existing Ani HQ tokens that predate orgs stay owners, because they were identity for one trusted team. Tokens minted after that are agents.

## Policies

A settings page, not a language:

- Agents may append.
- Only a member may delete or restore a page.
- Jev may propose links, tags, and conflicts. It still cannot apply them.
- Review items can be approved by owners only, or by any member.

Topic pages still roll to an archive at the current size.

## Onboarding

`/` is the landing page. The console is `/app`.

1. Name the org. The creator is the owner.
2. Mint one agent token. The screen shows the MCP URL and the Cursor and Claude Code snippets once.
3. Write one memory in the console. The collection opens on that page.
4. Invite a teammate. The console returns a join link. There is no mailer; send the link yourself. They join this org, not Ani HQ.

Claude, ChatGPT, and Grok connectors stay closed until `ENGRAM_OAUTH_ISSUER` is set. See [OAUTH.md](OAUTH.md).

## Creating a database

Org creation runs `CREATE DATABASE brain_org_<id>` through the template's `postgres` database. The runtime role needs `CREATEDB`, which the Cloud SQL `postgres` user has. Self-host the same way: the compose user is `postgres`.
