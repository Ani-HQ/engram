// Admin CLI — direct Postgres, no HTTP admin surface.
//   bun cli/engram-admin.ts token issue --name mac-claude [--org ID] [--write false]
//   bun cli/engram-admin.ts token list
//   bun cli/engram-admin.ts token revoke --name old-agent
// Requires ENGRAM_DB_URL_TEMPLATE (same env the gateway uses).
import { randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import { dbUrl } from "../gateway/src/config";

const sql = postgres(dbUrl("engram_gateway"), { max: 1, onnotice: () => {} });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireName(): string {
  const name = arg("--name");
  if (!name || name.startsWith("--")) throw new Error("--name required");
  return name;
}

function orgId(): number {
  const raw = arg("--org");
  if (!raw) return 1;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("--org must be a positive integer id");
  return id;
}

function rejectArgsExcept(allowedFlags: Set<string>) {
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i += 1) {
    const part = args[i];
    if (!part.startsWith("--")) throw new Error(`unsupported argument: ${part}`);
    if (!allowedFlags.has(part)) throw new Error(`unsupported argument: ${part}`);
    i += 1;
  }
}

const [cmd, sub] = process.argv.slice(2);

try {
  if (cmd === "token" && sub === "issue") {
    rejectArgsExcept(new Set(["--name", "--org", "--write"]));
    const name = requireName();
    const org = orgId();
    const write = arg("--write");
    if (write !== undefined && write !== "true" && write !== "false") throw new Error("--write must be true or false");
    const token = "eng_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`
      INSERT INTO tokens (name, sha256_hash, scopes, secrets_acl, org_id, role, can_write, issuer_kind)
      VALUES (${name}, ${hash}, ${sql.json({})}, ${sql.json(false)}, ${org}, 'agent', ${write !== "false"}, 'operator')`;
    console.log(`token '${name}' issued for org ${org} — shown ONCE, store it now:\n${token}`);
  } else if (cmd === "workspace" && sub === "create") {
    rejectArgsExcept(new Set(["--name", "--email"]));
    const name = requireName();
    const email = arg("--email");
    if (!email || email.startsWith("--")) throw new Error("--email required");
    const { createOrg } = await import("../gateway/src/orgs");
    const { createSession } = await import("../gateway/src/auth");
    const { migrate, closeDatabasePools } = await import("../gateway/src/db");
    try {
      await migrate();
      const org = await createOrg(name, email);
      const token = await createSession({ orgId: org.id, name: email, email, role: "owner" });
      console.log(`Workspace '${org.name}' created (id ${org.id}).\nOpen the app, choose 'Use an access token', and sign in with this owner token.\nIt expires in 14 days and is shown only here. Store it securely:\n${token}\n\nIssue agent credentials separately with: token issue --org ${org.id} --name <agent>`);
    } finally { await closeDatabasePools(); }
  } else if (cmd === "workspace" && sub === "login") {
    rejectArgsExcept(new Set(["--org", "--email"]));
    if (!arg("--org")) throw new Error("--org required");
    const email = arg("--email");
    if (!email || email.startsWith("--")) throw new Error("--email required");
    const { memberInOrg } = await import("../gateway/src/orgs");
    const { createSession } = await import("../gateway/src/auth");
    const { closeDatabasePools } = await import("../gateway/src/db");
    try {
      const member = await memberInOrg(orgId(), email);
      if (!member || member.role !== "owner") throw new Error("No current owner with this email in that workspace");
      const token = await createSession({ orgId: member.orgId, name: member.email, email: member.email, role: member.role });
      console.log(`Owner access for workspace ${member.orgId} — expires in 14 days; store securely:\n${token}`);
    } finally { await closeDatabasePools(); }
  } else if (cmd === "token" && sub === "list") {
    rejectArgsExcept(new Set(["--org"]));
    const org = arg("--org") ? orgId() : null;
    const rows = org
      ? await sql`
          SELECT name, org_id, created_at, revoked_at, last_used_at
          FROM tokens WHERE org_id = ${org} ORDER BY created_at`
      : await sql`
          SELECT name, org_id, created_at, revoked_at, last_used_at
          FROM tokens ORDER BY created_at`;
    for (const r of rows) {
      console.log(
        `${r.revoked_at ? "REVOKED " : ""}${r.name}` +
        `  org=${r.org_id}` +
        `  created=${r.created_at}` +
        `  last_used=${r.last_used_at ?? "never"}`);
    }
  } else if (cmd === "token" && sub === "revoke") {
    rejectArgsExcept(new Set(["--name", "--org"]));
    const name = requireName();
    const org = orgId();
    const r = await sql`
      UPDATE tokens SET revoked_at = now()
      WHERE name = ${name} AND org_id = ${org} AND revoked_at IS NULL`;
    console.log(r.count > 0 ? `token '${name}' revoked` : `no active token named '${name}' in org ${org}`);
  } else if (cmd === "dream" && sub === "run") {
    rejectArgsExcept(new Set());
    await sql.end({ timeout: 1 }).catch(() => {});
    const { main } = await import("../gateway/src/jobs/dream");
    await main();
  } else {
    console.log("usage: engram-admin workspace create --name N --email E | workspace login --org ID --email E | token issue --name N [--org ID] [--write false] | token list [--org ID] | token revoke --name N [--org ID] | dream run");
    process.exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
