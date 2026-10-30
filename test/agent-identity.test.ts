import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import type postgres from "postgres";
import { AgentIdentityError, cleanAgentLogo, cleanAgentName, mapAgentIdentity, setAgentIdentity, updateAgentIdentity } from "../gateway/src/agent-identity";

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Buffer) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(kind: string, content: Buffer) {
  const body = Buffer.concat([Buffer.from(kind, "ascii"), content]);
  const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(content.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4); return out;
}
function png(width: number, height = width) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1); for (let x = 0; x < width; x++) row.set([30, 140, 90, 255], 1 + x * 4);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

type Row = Record<string, any>;
function store(initial: Row | null = null, { owner = true } = {}) {
  let row: Row | null = initial;
  const calls: string[] = [];
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?"); calls.push(query);
    if (query.includes("SELECT locked FROM agent_identities")) return row ? [row] : [];
    if (query.includes("FROM org_members")) return owner ? [{ id: 1 }] : [];
    if (query.includes("pg_advisory_xact_lock")) return [];
    if (query.includes("SELECT name FROM tokens")) return [{ name: "fleet-vm" }];
    if (query.includes("INSERT INTO agent_identities")) {
      const [org_id, actor_kind, actor_name, a, b, c] = values as any[];
      if (query.includes("reported_name, reported_logo_png, reported_at)")) {
        const hasName = values[5], hasLogo = values[6];
        row = { ...(row ?? { org_id, actor_kind, actor_name, locked: false }), reported_name: hasName || !row ? a : row.reported_name, reported_logo_png: hasLogo || !row ? b : row.reported_logo_png, reported_at: new Date() };
      } else if (query.includes("reported_name = NULL")) {
        row = { org_id, actor_kind, actor_name, locked: row?.locked ?? false, reported_name: null, reported_logo_png: null, owner_name: null, owner_logo_png: null };
      } else {
        const hasName = values[6], hasLogo = values[7], hasLock = values[8];
        row = { ...(row ?? { org_id, actor_kind, actor_name, locked: false }), owner_name: hasName || !row ? a : row.owner_name, owner_logo_png: hasLogo || !row ? b : row.owner_logo_png, locked: hasLock ? c : row?.locked ?? false };
      }
      return [row];
    }
    return [];
  };
  const db = Object.assign(run, { begin: async (fn: (tx: any) => any) => fn(run) }) as unknown as postgres.Sql;
  return { db, calls, get row() { return row; } };
}
const agent = { name: "fleet-vm", orgId: 7, role: "agent" as const, canWrite: true, kind: "token" as const, email: null, scopes: [] };
const owner = { name: "ada", orgId: 7, role: "owner" as const, canWrite: true, kind: "session" as const, email: "ada@example.com", scopes: [] };

describe("agent self-identity", () => {
  test("names are trimmed, control characters removed, secrets redacted and length bounded", () => {
    expect(cleanAgentName("  Fleet \n VM​ ")).toBe("Fleet VM");
    expect(cleanAgentName("")).toBeNull();
    expect(cleanAgentName("   ")).toBeNull();
    expect(() => cleanAgentName("x".repeat(61))).toThrow(AgentIdentityError);
    expect(() => cleanAgentName(42)).toThrow("Name must be text");
  });

  test("logos accept square PNGs from 64 to 512 px and store a 64 px re-encode", async () => {
    for (const size of [64, 128, 256, 512]) {
      const bytes = (await cleanAgentLogo(png(size)))!;
      expect(bytes.readUInt32BE(16)).toBe(64);
      expect(bytes.readUInt32BE(20)).toBe(64);
    }
    expect(await cleanAgentLogo("")).toBeNull();
    for (const bad of [png(100), png(64, 128), "data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/logo.png", 7]) {
      await expect(cleanAgentLogo(bad)).rejects.toThrow("square PNG");
    }
  });

  test("an agent saves its own name and logo, shown as self-described", async () => {
    const s = store();
    const result = await setAgentIdentity(agent, { name: "Fleet VM", logo: png(128) }, s.db);
    expect(result.ok).toBe(true);
    expect(result.shown).toEqual({ name: "Fleet VM", logo: true, source: "agent" });
    expect(s.row!.actor_name).toBe("fleet-vm");
    expect(s.row!.actor_kind).toBe("token");
    const mapped = mapAgentIdentity(s.row);
    expect(mapped.logo!.startsWith("data:image/png;base64,")).toBe(true);
    expect(mapped.source).toBe("agent");
  });

  test("an agent must pass something, and a lock refuses changes", async () => {
    await expect(setAgentIdentity(agent, {}, store().db)).rejects.toThrow("Pass name, logo or both");
    const locked = store({ org_id: 7, actor_kind: "token", actor_name: "fleet-vm", locked: true });
    await expect(setAgentIdentity(agent, { name: "Renamed" }, locked.db)).rejects.toThrow("locked");
    expect(locked.calls.some(q => q.includes("INSERT INTO agent_identities"))).toBe(false);
  });

  test("console sessions cannot use the agent tool", async () => {
    await expect(setAgentIdentity(owner, { name: "Me" }, store().db)).rejects.toThrow("Only a connected agent");
  });

  test("owner choices win over what the agent reported", () => {
    const mapped = mapAgentIdentity({ actor_kind: "token", actor_name: "fleet-vm", reported_name: "Self", owner_name: "Build box", locked: true });
    expect(mapped).toMatchObject({ name: "Build box", source: "owner", reportedName: "Self", locked: true });
    expect(mapAgentIdentity({ actor_kind: "oauth", actor_name: "x" }).source).toBeNull();
  });

  test("only a workspace owner can rename, lock or reset", async () => {
    await expect(updateAgentIdentity({ ...owner, role: "member" }, { id: "token:4", name: "X" }, store().db)).rejects.toThrow("Only a workspace owner");
    await expect(updateAgentIdentity(agent, { id: "token:4", name: "X" }, store().db)).rejects.toThrow("forbidden");
    await expect(updateAgentIdentity(owner, { id: "token:4", name: "X" }, store(null, { owner: false }).db)).rejects.toThrow("Only a workspace owner");
    await expect(updateAgentIdentity(owner, { id: "nope", name: "X" }, store().db)).rejects.toThrow("valid connection");
    await expect(updateAgentIdentity(owner, { id: "token:4" }, store().db)).rejects.toThrow("Nothing to change");
    await expect(updateAgentIdentity(owner, { id: "token:4", locked: "yes" }, store().db)).rejects.toThrow("true or false");
  });

  test("owner rename and lock resolve the connection to its actor name", async () => {
    const s = store({ org_id: 7, actor_kind: "token", actor_name: "fleet-vm", reported_name: "Self", locked: false });
    const identity = await updateAgentIdentity(owner, { id: "token:4", name: "Build box", locked: true }, s.db);
    expect(identity).toMatchObject({ agent: "fleet-vm", name: "Build box", source: "owner", locked: true, reportedName: "Self" });
    expect(s.calls.some(q => q.includes("pg_advisory_xact_lock"))).toBe(true);
    const reset = await updateAgentIdentity(owner, { id: "token:4", reset: true }, s.db);
    expect(reset).toMatchObject({ name: null, logo: null, source: null, locked: true });
  });
});
