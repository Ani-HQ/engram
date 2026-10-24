// Isolated token-endpoint fixture: module mocks never escape this subprocess.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mock } from "bun:test";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.ENGRAM_OAUTH_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.ENGRAM_DB_URL_TEMPLATE = "postgresql://fixture:fixture@localhost:1/__DB__";
process.env.ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS = "1";
process.env.ENGRAM_DEPLOYMENT_MODE = "self-hosted";
process.env.ENGRAM_DATABASE_AUTHORITY = "inline";
delete process.env.ENGRAM_PUBLIC_URL;
delete process.env.ENGRAM_OAUTH_ISSUER;
delete process.env.ENGRAM_OAUTH_AUDIENCE;

let member: { id: number; org_id: number; email: string; role: string } | null = { id: 41, org_id: 7, email: "ada@example.com", role: "member" };
let afterRefreshRead: (() => void) | undefined;
const codes: any[] = [], refreshes: any[] = [];
let nextId = 1, checks = 0;
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
const org = { id: 7, name: "Fixture", slug: "fixture", kind: "team", brain_db: "brain_org_7", data_db: "brain_org_7", home_dir: "org-7", policies: {}, created_at: new Date(), provisioning_status: "ready" };
function insert(statement: string, values: unknown[], list: any[]) {
  const columns = /INSERT INTO \w+\s*\(([^)]+)\)/.exec(statement)![1].split(",").map(part => part.trim());
  const row: any = { id: nextId++ };
  columns.forEach((column, index) => { row[column] = values[index]; });
  list.push(row); return [];
}
const fixtureSql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
  const statement = parts.join("?");
  if (statement.includes("FROM tokens t")) return [];
  if (statement.includes("FROM sessions s")) return member ? [{ name: member.email, org_id: 7, role: member.role, email: member.email }] : [];
  if (statement.includes("FROM org_members")) return member && values[0] === 7 && values[1] === member.email ? [{ ...member }] : [];
  if (statement.includes("FROM orgs")) return values[0] === 7 ? [org] : [];
  if (statement.includes("FROM oauth_clients")) return [{ client_id: "oc_fixture", redirect_uris: ["http://localhost:7777/cb"] }];
  if (statement.includes("INSERT INTO oauth_codes")) return insert(statement, values, codes);
  if (statement.includes("INSERT INTO oauth_refresh_tokens")) return insert(statement, values, refreshes);
  if (statement.includes("SELECT * FROM oauth_codes")) return codes.filter(row => row.sha256_hash === values[0] && !row.used_at).map(row => ({ ...row }));
  if (statement.includes("UPDATE oauth_codes SET used_at")) {
    const row = codes.find(row => row.id === values[0] && !row.used_at);
    if (!row) return [];
    row.used_at = new Date(); return [{ id: row.id }];
  }
  if (statement.includes("FROM oauth_refresh_tokens")) {
    const rows = refreshes.filter(row => row.sha256_hash === values[0] && row.client_id === values[1] && !row.revoked_at).map(row => ({ ...row }));
    afterRefreshRead?.(); afterRefreshRead = undefined;
    return rows;
  }
  throw new Error(`Unexpected fixture query: ${statement}`);
}) as any;
fixtureSql.json = (value: unknown) => value;
fixtureSql.begin = async (work: (tx: any) => unknown) => work(fixtureSql);
const realDb = await import("../../gateway/src/db");
mock.module("../../gateway/src/db", () => ({ ...realDb, sql: fixtureSql }));
const { handleOauth, pkceChallenge } = await import("../../gateway/src/oauth-as");
const { authenticateJwt, decodeJwt } = await import("../../gateway/src/oauth");
const { signJwt } = await import("../../gateway/src/oauth-keys");
const { sha256 } = await import("../../gateway/src/hash");
const issuer = "https://engram.example", audience = `${issuer}/mcp`, verifier = "a".repeat(43);

async function authorize(): Promise<string> {
  const url = new URL(`${issuer}/oauth/authorize`);
  for (const [key, value] of Object.entries({ client_id: "oc_fixture", redirect_uri: "http://localhost:7777/cb", code_challenge: pkceChallenge(verifier), resource: audience, scope: "memory:read" })) url.searchParams.set(key, value);
  const response = await handleOauth(new Request(url, { headers: { cookie: "engram_session=ens_fixture" } }), url);
  equal(response?.status, 302, "Live member can authorize a connector");
  return new URL(response!.headers.get("location")!).searchParams.get("code")!;
}
async function exchange(code: string) {
  return token({ grant_type: "authorization_code", code, client_id: "oc_fixture", code_verifier: verifier, redirect_uri: "http://localhost:7777/cb" });
}
async function token(body: Record<string, string>) {
  const url = new URL(`${issuer}/oauth/token`);
  const response = await handleOauth(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), url);
  assert.ok(response); return { status: response.status, body: await response.json() as any };
}
async function refresh(raw: string) { return token({ grant_type: "refresh_token", refresh_token: raw, client_id: "oc_fixture" }); }

const firstCode = await authorize();
equal(codes[0].membership_id, 41, "Authorization code persists the issuing membership ID");
const first = await exchange(firstCode);
equal(first.status, 200, "Bound code exchanges successfully");
equal(decodeJwt(first.body.access_token)?.payload.membership_id, 41, "Access JWT signs the actual membership ID");
equal(refreshes[0].membership_id, 41, "Refresh credential persists the same membership ID");
equal((await authenticateJwt(first.body.access_token, audience))?.orgId, 7, "Issued access token authenticates in its original workspace");
const renewed = await refresh(first.body.refresh_token);
equal(renewed.status, 200, "An unchanged live membership can refresh");
equal(decodeJwt(renewed.body.access_token)?.payload.membership_id, 41, "Refreshed access JWT retains exact membership binding");
const pendingCode = await authorize();
member = null;
equal(await authenticateJwt(first.body.access_token, audience), null, "Removal immediately rejects the access JWT");
member = { id: 42, org_id: 7, email: "ada@example.com", role: "member" };
equal(await authenticateJwt(first.body.access_token, audience), null, "Rejoining with the same email does not reactivate the access JWT");
equal((await exchange(pendingCode)).status, 400, "A pre-removal authorization code cannot authorize a replacement membership");
// Keep the row unrevoked deliberately: the exact-member check is independent
// of removal's persistent revocation and catches a selected-in-flight refresh.
equal((await refresh(first.body.refresh_token)).status, 400, "An old refresh cannot mint access for a replacement membership");
const unbound = signJwt({ sub: member.email, email: member.email, org_id: 7 }, { issuer, audience });
equal(await authenticateJwt(unbound, audience), null, "Legacy unbound access JWT fails closed");
const oldRefresh = "orf_unbound_fixture";
refreshes.push({ sha256_hash: sha256(oldRefresh), client_id: "oc_fixture", email: member.email, org_id: 7, membership_id: null, resource: audience, scope: "memory:read" });
equal((await refresh(oldRefresh)).status, 400, "Legacy unbound refresh fails closed");
const unboundCode = "oac_unbound_fixture";
codes.push({ id: nextId++, sha256_hash: sha256(unboundCode), client_id: "oc_fixture", email: member.email, org_id: 7, membership_id: null, redirect_uri: "http://localhost:7777/cb", code_challenge: pkceChallenge(verifier), resource: audience, scope: "memory:read" });
equal((await exchange(unboundCode)).status, 400, "Legacy unbound authorization code fails closed");
const fresh = await exchange(await authorize());
equal(fresh.status, 200, "Rejoined member can explicitly authorize a fresh connector");
equal(decodeJwt(fresh.body.access_token)?.payload.membership_id, 42, "New authorization binds the replacement membership");
equal((await authenticateJwt(fresh.body.access_token, audience))?.email, member.email, "Fresh access token authenticates normally");
afterRefreshRead = () => { member = { id: 43, org_id: 7, email: "ada@example.com", role: "member" }; };
equal((await refresh(fresh.body.refresh_token)).status, 400, "Refresh selected before removal/rejoin cannot bridge to the next membership");
console.log(JSON.stringify({ checks }));
