# Privacy and data flow

Engram's substantiated promise is **private by default, explicit sharing, and a self-hosting option**. Do not advertise “100% secure,” “100% private,” end-to-end encryption, zero-knowledge storage, a compliance certification, or an absolute guarantee against breaches. The source and infrastructure have not established those properties.

## Hosted operator and contact

Outcome Driven Holdings LLC operates `https://engram.ani.computer`. Public support,
privacy, correction, export-help, and account/workspace-erasure requests go to
[ani@odstdio.com](mailto:ani@odstdio.com). The operator aims to acknowledge requests
within two business days. Approved erasure from the active service has a target of
30 days after the requester's authority and scope are verified; explain delays and
retained exceptions. These are manual service targets, not automatic deletion jobs
or an incident-resolution SLA. The hosted notice is published at `/privacy` with
an update date of 24 October 2026. Self-hosted operators set their own policies.

## Stored information

Memory pages and capture records live in the selected workspace's database. The central control database holds workspace identity, memberships, hashed credentials, action reports, memory-call audit, subscription state, Jev consent/usage accounting, and opt-in public-profile settings. Per-workspace request context selects storage; missing or corrupt context and storage bindings fail closed. This is application-enforced tenant isolation, not cryptographic isolation from an operator who has database access.

People and agents in a team workspace share that workspace's memory and activity. Separate personal workspaces are private to their owner. Explicit sharing rules can copy selected content into a team; standing rules re-check both memberships and target permissions. Removed memberships invalidate sessions and delegated credentials through current membership checks. Removing someone cannot recall copies they already exported.

Reviewed sharing in the console stores a natural-language instruction, a temporary preview, and the exact approved excerpt snapshots in central sharing records. An optional Jev judgment can propose matches under the separate Jev consent and access/budget rules. The text-match fallback does not understand intent or exclusions. Owners must review and explicitly approve each excerpt. New or changed source text is never shared automatically. Team recipients read only the approved projection plus other memory already available in their team. An isolated agent credential reads only its approved snapshots at `/mcp/shared`; existing full-workspace credentials retain their access. Revocation blocks future reads, not previously downloaded copies. Preview expiry, cleanup, and legacy standing-rule differences are documented in [Sharing](SHARING.md).

## Outbound processing

| Destination | When | Information |
| --- | --- | --- |
| A connected agent | Authenticated reads | The workspace results requested by that agent. Its own environment has its own data handling rules. |
| TypeSafe / Jev | Server has a key **and** the workspace has separate Jev consent and applicable funding/budget permission | Bounded relevant memory text, candidates, query context, activity reports or trail context for optional classification, relationship judgments, ranking or digest selection. |
| Voyage | Operator has a key **and** workspace owner enables external AI | Text used by optional embeddings. |
| OpenAI | Separate brief provider key/model are configured **and** workspace owner enables external AI | Bounded relevant activity context for optional generated briefs. `store:false` does not establish a provider-wide zero-retention or no-training promise. |
| Stripe | Owner opens hosted Checkout/Portal; signed billing lifecycle; approved Jev invoice export | Opaque workspace/customer/subscription references, subscription state and an aggregate Jev invoice amount/batch reference. Payment/contact data is collected by Stripe, not the Engram UI. No memory, agent names, action details, provider prompts or transcripts are sent by billing. |
| Resend | Hosted sign-in or invitation | Recipient email and a time-limited sign-in/invitation message; team invitation messages also identify the workspace/inviter. |
| Google Cloud and Cloudflare | Hosted operation and edge traffic | Network/request metadata, operational diagnostics, service databases and backups under the relevant infrastructure access and retention controls. |
| Public viewers | Owner explicitly publishes a profile | Chosen name/bio, aggregate counts, dates, generic tool categories; no raw action or memory details. |

Jev's `jevProcessing` consent defaults to false independently for each workspace.
The older `externalAiProcessing` control covers configured Voyage embeddings
and optional OpenAI briefs. Neither control enables the other. A server API key
alone does not grant consent. Self-hosters provide their own server-side
`JEV_API_KEY` (legacy `REFLEX_API_KEY`/`TYPESAFE_API_KEY` fallbacks remain supported)
and explicitly opt in. Hosted customer Jev also requires an active Cloud
subscription, an accepted approved rate and a positive soft budget. One expressly
authorized operator workspace can receive a one-time operator-funded
default with a $1 USD monthly soft budget; this does not opt other accounts in or
enable Voyage/OpenAI. It is not a customer billing charge.

Child engine processes receive a limited environment, with no Stripe, mail,
signing or Jev key. A Voyage key is supplied only under the separate embedding
consent. Optional processing is disabled for hosted requests without a current
write entitlement. Core keyword search, storage and action history remain local
to the deployment when providers are disabled. Connected agents themselves are
outside this boundary.

The hosted Jev usage ledger records opaque operation/task identifiers, requested
and reported models, actual token counts, rate versions, accounting amounts and
request/error state. It does not store provider prompts, memory text, answers
or keys. Bounded activity-analysis results and memory-review records have their
own existing storage paths. Input redaction reduces exposure but is not a
guarantee that content sent for analysis contains no sensitive information.

TypeSafe states that it does not train Jev on customer requests/responses;
retention and deletion depend on the applicable terms and any agreed
zero-data-retention arrangement. Do not promise that the hosted key has such an
arrangement without verifying it. See the provider's
[data-handling notice](https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained)
and [Jev integration details](REFLEX.md).

Disabling a provider prevents future optional processing. It does not delete information already sent to a provider; provider retention and terms must be reviewed by the operator. The app makes no claim about training or retention by third parties. Browser scripts, fonts, and icons are self-hosted; there are no ad pixels or third-party analytics in the web app.

The operator verified host-scoped Cloudflare RUM disabled, email obfuscation off,
and the scoped Browser Integrity Check rule on 24 October 2026. Deployment
verification must still check the public HTML and API responses after edge changes;
see [EDGE.md](EDGE.md). App source alone does not prove the edge's behavior.

## User controls

Workspace owners manage membership, agent write permissions, separate Jev processing, optional embeddings/briefs, and public profiles. People can export the memory and activity they can read. The browser export pins its workspace and stops if that workspace changes during the download. Exports do not include raw tokens, other workspaces, billing details, or a complete infrastructure backup.

Unpublishing returns 404 from Engram's public page, JSON, cards, and new live streams. Existing streams close on their next publication check, normally within five seconds. Public profiles share counts by default. A separate owner choice enables a redacted activity stream with canonical agent products, services, broad action labels, evidence, state, and receipt times. Labels are constructed from allowlisted operation types; private free text, personal agent aliases, repository/document names, URLs, and transcripts are excluded. Changing the sharing scope retires the old stream binding. Responses are not publicly cached by Engram. Copies retained by social networks, crawlers, portfolio sites, or other people cannot be recalled. Paid access expiry does not block reading/export, privacy controls, credential revocation, or unpublishing. See [the live API contract](PUBLIC_ACTIVITY.md).

Memory deletion/recovery uses the existing authenticated page APIs. Page deletion
is recoverable soft deletion; it does not purge `memory_entries`, activity, audit,
archives, or recovery copies. There is no self-service account/workspace erasure
endpoint and no inactivity/age-based cleanup of memory or append-only history.
Canceling payment does not erase data. Whole-workspace erasure is an operator
process, including shared-content scope, related records, and restore handling.

## Hosted retention settings and procedure

The operator verified these infrastructure settings on 24 October 2026:

| Data | Current retention / handling |
| --- | --- |
| Workspace memory, activity, account/access metadata | Kept until an approved manual erasure request; no automatic inactive-workspace/history TTL. Exceptions are documented in the request record. |
| Cloud SQL automated backups | Enabled, scheduled window beginning 09:00 UTC; retention unit `COUNT`, value `14`. This is 14 retained automated backup copies, not a fixed 14-day erasure deadline. |
| Cloud SQL transaction logs | Seven days configured for point-in-time recovery. |
| On-demand release/recovery backups | Retained independently of the automated-backup count. Inventory and remove manually when no longer needed; record exceptions and reapply erasures after restores. A successful on-demand release backup existed on 24 October 2026. |
| Default application logs | `projects/ani-hq/locations/global/buckets/_Default` configured for 30 days; not retention-locked. This setting does not establish retention for every system/security log or Cloudflare edge record. |
| Payment/email/optional AI provider records | Provider retention applies. Disabling a provider, canceling a subscription, or erasing a workspace does not itself erase the provider's records. |

See [Data retention and erasure](DATA_RETENTION.md) for the manual request,
retention-review, backup-inventory, and restore procedure. Do not represent that
runbook as an automated implementation or promise immediate deletion from all
copies.

## Infrastructure boundary

The app must read workspace data to answer requests. A hosting operator can access its databases, process memory, and backups. HTTPS and infrastructure encryption settings depend on deployment; local HTTP Compose is loopback-only. Self-hosted operators are responsible for TLS, updates, credentials, database backups and retention, and restricting network access. Hosted infrastructure can produce operational/network logs; this document does not promise log-free operation.

See [SECURITY.md](../SECURITY.md), [SELF_HOSTING.md](SELF_HOSTING.md), and
[BILLING.md](BILLING.md). The public `/privacy` page identifies the hosted operator,
contact, processing, and current retention/deletion handling. Do not describe it
as a legal compliance certification or extend its hosted commitments to unrelated
self-hosted installations.
