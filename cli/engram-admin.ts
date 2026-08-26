// Admin CLI — direct Postgres, no HTTP admin surface.
//   bun cli/engram-admin.ts token issue --name mac-claude
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
    rejectArgsExcept(new Set(["--name"]));
    const name = requireName();
    const token = "eng_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`
      INSERT INTO tokens (name, sha256_hash, scopes, secrets_acl)
      VALUES (${name}, ${hash}, ${sql.json({})}, ${sql.json(false)})`;
    console.log(`token '${name}' issued — shown ONCE, store it now:\n${token}`);
  } else if (cmd === "token" && sub === "list") {
    rejectArgsExcept(new Set());
    const rows = await sql`
      SELECT name, created_at, revoked_at, last_used_at
      FROM tokens ORDER BY created_at`;
    for (const r of rows) {
      console.log(
        `${r.revoked_at ? "REVOKED " : ""}${r.name}` +
        `  created=${r.created_at}` +
        `  last_used=${r.last_used_at ?? "never"}`);
    }
  } else if (cmd === "token" && sub === "revoke") {
    rejectArgsExcept(new Set(["--name"]));
    const name = requireName();
    const r = await sql`UPDATE tokens SET revoked_at = now() WHERE name = ${name} AND revoked_at IS NULL`;
    console.log(r.count > 0 ? `token '${name}' revoked` : `no active token named '${name}'`);
  } else {
    console.log("usage: engram-admin token issue --name N | token list | token revoke --name N");
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
