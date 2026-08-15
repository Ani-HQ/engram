// Admin CLI — direct Postgres, no HTTP admin surface.
//   bun cli/engram-admin.ts token issue --name mac-claude --scopes shared:rw,private:rw --secrets
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

function parseScopes(spec: string): Record<string, string> {
  // "shared:rw,private:r" -> {shared: "rw", private: "r"}
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const [scope, perm] = part.trim().split(":");
    if (!scope || !["r", "rw"].includes(perm)) {
      throw new Error(`bad scope spec '${part}' — use scope:r or scope:rw`);
    }
    out[scope] = perm;
  }
  return out;
}

const [cmd, sub] = process.argv.slice(2);

try {
  if (cmd === "token" && sub === "issue") {
    const name = arg("--name");
    const scopes = parseScopes(arg("--scopes") ?? "shared:r");
    const secrets = process.argv.includes("--secrets");
    if (!name) throw new Error("--name required");
    const token = "eng_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`
      INSERT INTO tokens (name, sha256_hash, scopes, secrets_acl)
      VALUES (${name}, ${hash}, ${sql.json(scopes)}, ${sql.json(secrets)})`;
    console.log(`token '${name}' issued — shown ONCE, store it now:\n${token}`);
  } else if (cmd === "token" && sub === "list") {
    const rows = await sql`
      SELECT name, scopes, secrets_acl, created_at, revoked_at, last_used_at
      FROM tokens ORDER BY created_at`;
    for (const r of rows) {
      console.log(
        `${r.revoked_at ? "REVOKED " : ""}${r.name}  scopes=${JSON.stringify(r.scopes)}` +
        `  secrets=${r.secrets_acl}  last_used=${r.last_used_at ?? "never"}`);
    }
  } else if (cmd === "token" && sub === "revoke") {
    const name = arg("--name");
    if (!name) throw new Error("--name required");
    const r = await sql`UPDATE tokens SET revoked_at = now() WHERE name = ${name} AND revoked_at IS NULL`;
    console.log(r.count > 0 ? `token '${name}' revoked` : `no active token named '${name}'`);
  } else {
    console.log("usage: engram-admin token issue|list|revoke [--name N] [--scopes s:rw,...] [--secrets]");
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
