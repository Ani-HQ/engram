# Hosted edge configuration

## Applied on 24 October 2026

The two hostname-scoped rules are active, applied through the authenticated
Cloudflare dashboard after the operator authorized the API-path security change:

- `Engram: self-contained pages` (`11730af104f44c859216fd4396a66953`)
  disables RUM and email rewriting only on `engram.ani.computer`.
- `Engram: API and MCP clients` (`c4c4bb300ebf4fd1b51ef904ad50a415`)
  disables Browser Integrity Check only on the machine paths listed below.

Fresh requests with `Python-urllib/3.13` returned 200 for health, protected-resource
discovery, authorization-server discovery and plans. Anonymous private API access
was rejected, unsigned billing webhooks returned 400, and GET `/mcp` returned 405.
The homepage, app shell, pricing, privacy and self-hosting HTML all matched the
reviewed source byte for byte without injected analytics or email-rewrite markup.
These checks do not establish the still-separate Stripe lifecycle gate.

The API credential still lacks Config Settings access. The dashboard-created
rules do not carry the helper's prepared stable refs: reconcile these exact IDs
and settings before running the helper with a future token, rather than appending
duplicates. No other rules or hostnames were changed.

## Historical findings and prepared API procedure

The hosted app is live at `https://engram.ani.computer`. A post-cutover check
found two Cloudflare transformations outside the application:

- Requests with `Python-urllib/3.13` receive HTTP403/error1010. The same health
  request with an explicit `EngramReleaseVerifier/1.0` user agent receives200.
  This matches Cloudflare's documented Browser Integrity Check behavior; the
  precise zone rule could not be inspected with the available token.
- Cloudflare injects its Web Analytics beacon into HTML and rewrites the example
  email in the self-hosting guide. The app's self-only script policy blocks the
  external beacon from loading. JavaScript, CSS, icons and font files match the
  reviewed source byte for byte.

The current Cloudflare credential can read the parent zone identity, but receives
403 from security settings, custom security rules and the exact
`http_config_settings` entrypoint. These are separate permission checks; the
Configuration Rules permission failure was verified directly. No edge settings
were changed during those checks.

## Prepared changes

The two rule objects in [cloudflare-config-rules.json](../deploy/cloudflare-config-rules.json)
are a reviewable configuration draft, not an applied ruleset. In the `ani.computer`
zone, open **Rules → Overview → Create rule → Configuration Rule** and add them
after overlapping configuration rules:

1. For the exact Engram hostname, disable Web Analytics (`disable_rum`) and
   email obfuscation. Other hostnames keep their settings.
2. For the exact Engram hostname and the listed machine endpoints, disable only
   Browser Integrity Check (`bic`). Browser page paths retain their current
   integrity checks. Authentication, WAF rules and rate limits stay active.

For API deployment, use a token scoped to this zone with **Config Settings Read**
and **Config Settings Write**. Read the existing `http_config_settings` entrypoint,
append/update only the two matching rule references, and preserve all unrelated
rules. Do not replace the entire entrypoint with the draft array. Never put a
token in a command argument or this repository.

The operator helper is offline by default:

```sh
python3 deploy/configure-edge.py --project ani-hq
```

After reviewing the plan, `--run` reads only `cloudflare-api-token` and
`cloudflare-zone-id` from Secret Manager in `ani-hq`, keeping their values in
memory. It validates the active `ani.computer` zone, checks both owned rule refs
before making changes, and uses only per-rule POST/PATCH operations. It appends
the two rules, or updates their existing IDs and moves them to the end. An
already matching final configuration requires no writes.

```sh
python3 deploy/configure-edge.py --project ani-hq --run
```

The helper refuses an absent entrypoint rather than risk replacing a concurrent
configuration; create a hostname-scoped Configuration Rule in the dashboard
first. It also refuses colliding refs with unexpected expressions/settings.
Final readback verifies both owned rules and the original unrelated rule IDs,
content and relative order. Concurrent additions are retained. A concurrent edit
or an interrupted request can leave a partial change: the helper reports
`changesMayHaveApplied` and never blindly retries or rolls back other edits.
Review the two owned refs before retrying. Cloudflare provides no transaction
across these two per-rule operations.

HTTP403 is reported without provider response text, with the required scoped
permission. It does not trigger a broader security change. Run the offline
regression checks with `python3 test/edge-configuration.py`.

After applying, verify ordinary Python requests reach health/discovery; private
API requests still require authentication; invalid webhook signatures still
return400; and HTML no longer contains injected beacon/email-obfuscation markup.
These post-apply checks passed in the dashboard deployment described above.
The independent Stripe payment lifecycle test in [BILLING.md](BILLING.md) remains
a separate distribution gate.

References: [Cloudflare error1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/),
[Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/),
[Configuration Rule settings](https://developers.cloudflare.com/rules/configuration-rules/settings/),
[dashboard setup](https://developers.cloudflare.com/rules/configuration-rules/create-dashboard/),
[API setup](https://developers.cloudflare.com/rules/configuration-rules/create-api/),
[append one rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/),
[update one rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/).
