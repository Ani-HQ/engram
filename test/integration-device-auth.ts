import assert from "node:assert/strict";
import type postgres from "postgres";
import { authenticateStoredSecret, createSession } from "../gateway/src/auth";
import { handleWeb } from "../gateway/src/web";
import { sha256 } from "../gateway/src/hash";

// Invoked only by integration-postgres.ts after its disposable-database guard.
// Exercises the browser-approved installer sign-in over real HTTP routing.
export async function checkDeviceAuth(db: postgres.Sql): Promise<number> {
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
  const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
  const base = "https://integration.example";
  await db`TRUNCATE device_authorizations`;
  const approver = "device-approver@example.test", outsider = "device-outsider@example.test";
  await db`INSERT INTO org_members (org_id, email, role) VALUES (2, ${approver}, 'member'), (3, ${approver}, 'owner'), (3, ${outsider}, 'owner')`;
  const sessionA = await createSession({ orgId: 2, name: approver, role: "member", email: approver });
  const outsiderSession = await createSession({ orgId: 3, name: outsider, role: "owner", email: outsider });

  let address = 0;
  const start = (body: unknown, ip = `198.51.100.${++address}`) => handleWeb(new Request(`${base}/api/device/start`, {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body),
  }));
  const poll = (deviceCode: string) => handleWeb(new Request(`${base}/api/device/poll`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode }),
  }));
  const consoleRequest = (path: string, session: string, workspace: number, body?: unknown, extra: Record<string, string> = {}) => handleWeb(new Request(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: `engram_session=${session}`, "X-Engram-Console": "1", "X-Engram-Workspace": String(workspace), "Content-Type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  // Polling at the advertised interval is simulated by moving the last poll back.
  const rewind = (deviceCode: string) => db`UPDATE device_authorizations SET last_polled_at = now() - interval '10 seconds' WHERE device_code_hash = ${sha256(deviceCode)}`;

  // Start, approve, collect once.
  const started = await start({ device: "Ada's MacBook", agents: [{ harness: "claude-code" }, { harness: "codex", label: "Codex desktop" }, { harness: "cursor" }] });
  equal(started.status, 200, "The installer can start without a session or console header");
  const flow = await started.json();
  check(/^[A-Za-z0-9_-]{43}$/.test(flow.deviceCode) && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(flow.userCode), "Start returns a secret device code and a readable user code");
  equal([flow.verificationUri, flow.verificationUriComplete, flow.expiresIn, flow.interval], [`${base}/app#device`, `${base}/app#device=${flow.userCode}`, 600, 3], "Start returns the browser verification links and timing");
  const stored = await db`SELECT * FROM device_authorizations`;
  check(!JSON.stringify(stored).includes(flow.deviceCode) && stored[0].device_code_hash === sha256(flow.deviceCode), "Only the device-code hash is stored");
  check(!JSON.stringify(stored).includes("198.51.100"), "The client address is not stored");
  equal((await (await poll(flow.deviceCode)).json()).status, "pending", "An unapproved request is pending");
  equal((await (await poll(flow.deviceCode)).json()).status, "slow_down", "Polling faster than the interval asks the client to slow down");

  const loose = flow.userCode.toLowerCase().replace("-", "");
  const unauthenticated = await handleWeb(new Request(`${base}/api/device?code=${loose}`, { headers: { "X-Engram-Console": "1" } }));
  equal(unauthenticated.status, 401, "Reading a request requires a signed-in person");
  const noHeader = await handleWeb(new Request(`${base}/api/device/approve`, { method: "POST", headers: { Cookie: `engram_session=${sessionA}`, "X-Engram-Workspace": "2" }, body: JSON.stringify({ userCode: flow.userCode }) }));
  equal(noHeader.status, 403, "Approval keeps the console CSRF header boundary");
  const read = await consoleRequest(`/api/device?code=${loose}`, sessionA, 2);
  equal(read.status, 200, "A signed-in person can read a request with a lower-case, hyphen-free code");
  const detail = await read.json();
  equal([detail.userCode, detail.device, detail.status, detail.agents], [flow.userCode, "Ada's MacBook", "pending", [
    { harness: "claude-code", label: "Claude Code" }, { harness: "codex", label: "Codex desktop" }, { harness: "cursor", label: "Cursor" },
  ]], "The request detail shows the device, agents and state");
  equal((await consoleRequest(`/api/device/approve`, sessionA, 3, { userCode: flow.userCode })).status, 409, "Approval cannot target a workspace other than the session's");
  const approved = await consoleRequest(`/api/device/approve`, sessionA, 2, { userCode: flow.userCode });
  equal([approved.status, await approved.json()], [200, { ok: true, workspace: { id: 2, name: "Integration A" } }], "A member approves for the pinned workspace");
  equal((await (await consoleRequest(`/api/device/approve`, sessionA, 2, { userCode: flow.userCode })).json()).code, "approved", "A request is approved only once");
  await rewind(flow.deviceCode);
  const collected = await (await poll(flow.deviceCode)).json();
  equal([collected.status, collected.host, collected.workspace], ["approved", base, { id: 2, name: "Integration A" }], "The first poll after approval collects the result");
  equal(collected.tokens.map((token: any) => [token.harness, token.name]), [
    ["claude-code", "Claude Code on Ada's MacBook"], ["codex", "Codex on Ada's MacBook"], ["cursor", "Cursor on Ada's MacBook"],
  ], "One named access key is issued per agent");
  for (const token of collected.tokens) {
    const actor = await authenticateStoredSecret(token.token);
    equal([actor?.orgId, actor?.canWrite, actor?.source?.harness], [2, true, token.harness], "Each issued key authenticates to the approved workspace with its agent source");
  }
  equal((await db`SELECT issued_by_email FROM tokens WHERE name = 'Codex on Ada''s MacBook' AND org_id = 2`)[0].issued_by_email, approver, "Keys are attributed to the approving person");
  equal((await db`SELECT source_label FROM tokens WHERE name = 'Codex on Ada''s MacBook' AND org_id = 2`)[0].source_label, "Codex desktop", "The agent label is kept as the source label");
  await rewind(flow.deviceCode);
  equal(await (await poll(flow.deviceCode)).json(), { status: "consumed" }, "A second poll never re-issues keys");
  equal(Number((await db`SELECT count(*) AS n FROM tokens WHERE org_id = 2 AND name LIKE '% on Ada''s MacBook%'`)[0].n), 3, "Exactly three keys exist after repeated polling");

  // Concurrent collection still issues keys once.
  const again = await (await start({ device: "Ada's MacBook", agents: [{ harness: "codex" }] })).json();
  await consoleRequest(`/api/device/approve`, sessionA, 2, { userCode: again.userCode });
  await rewind(again.deviceCode);
  const racing = await Promise.all([poll(again.deviceCode), poll(again.deviceCode), poll(again.deviceCode)].map(async response => (await response).json()));
  equal(racing.filter(result => result.status === "approved").length, 1, "Concurrent polls deliver the keys exactly once");
  equal(racing.find(result => result.status === "approved").tokens[0].name, "Codex on Ada's MacBook (2)", "A repeated computer name gets a distinct key name");

  // Denied.
  const denied = await (await start({ device: "Shared desktop", agents: [{ harness: "cursor" }] })).json();
  equal((await consoleRequest(`/api/device/deny`, sessionA, 2, { userCode: denied.userCode })).status, 200, "A signed-in person can deny a request");
  await rewind(denied.deviceCode);
  equal(await (await poll(denied.deviceCode)).json(), { status: "denied" }, "A denied request reports denied");
  equal((await (await consoleRequest(`/api/device/approve`, sessionA, 2, { userCode: denied.userCode })).json()).code, "denied", "A denied request cannot be approved later");

  // Expired.
  const expired = await (await start({ device: "Old laptop", agents: [{ harness: "codex" }] })).json();
  await db`UPDATE device_authorizations SET expires_at = now() - interval '1 second' WHERE device_code_hash = ${sha256(expired.deviceCode)}`;
  equal((await (await consoleRequest(`/api/device?code=${expired.userCode}`, sessionA, 2)).json()).status, "expired", "The console sees an expired request");
  equal((await (await consoleRequest(`/api/device/approve`, sessionA, 2, { userCode: expired.userCode })).json()).code, "expired", "An expired request cannot be approved");
  equal(await (await poll(expired.deviceCode)).json(), { status: "expired" }, "An expired request reports expired");
  equal(await (await poll("A".repeat(43))).json(), { status: "expired" }, "An unknown device code looks expired");
  equal((await poll("short")).status, 400, "A malformed device code is rejected");
  equal((await consoleRequest(`/api/device?code=BCDF-GHJK`, sessionA, 2)).status, 404, "An unknown user code is not found");

  // An approver who leaves before collection issues nothing.
  const removed = await (await start({ device: "Contractor laptop", agents: [{ harness: "claude-code" }, { harness: "cursor" }] })).json();
  const outsiderApproval = await consoleRequest(`/api/device/approve`, outsiderSession, 3, { userCode: removed.userCode });
  equal(outsiderApproval.status, 200, "An owner approves for their own workspace");
  await db`DELETE FROM org_members WHERE org_id = 3 AND email = ${outsider}`;
  await rewind(removed.deviceCode);
  equal(await (await poll(removed.deviceCode)).json(), { status: "denied" }, "A former member's approval issues no keys");
  equal(Number((await db`SELECT count(*) AS n FROM tokens WHERE name LIKE '% on Contractor laptop%'`)[0].n), 0, "No partial key set remains after a failed collection");

  // Validation and rate limiting.
  equal((await start({ device: "", agents: [{ harness: "codex" }] })).status, 400, "A computer name is required");
  equal((await start({ device: "Laptop", agents: [{ harness: "codex" }, { harness: "codex" }] })).status, 400, "Duplicate agents are rejected");
  equal((await start({ device: "Laptop", agents: [{ harness: "windsurf" }] })).status, 400, "Unsupported agents are rejected");
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await start({ device: "Busy laptop", agents: [{ harness: "codex" }] }, "203.0.113.9")).status);
  equal([statuses.slice(0, 10).every(status => status === 200), statuses[10]], [true, 429], "Starts are limited per client address");
  equal(await (await start({ device: "Busy laptop", agents: [{ harness: "codex" }] }, "203.0.113.9")).json(), { error: "rate_limited", message: "Too many sign-in requests. Please wait a few minutes and try again." }, "A limited start says so");
  equal((await start({ device: "Another laptop", agents: [{ harness: "codex" }] }, "203.0.113.10")).status, 200, "Other clients are unaffected");

  await db`DELETE FROM org_members WHERE email = ${approver}`;
  return checks;
}
