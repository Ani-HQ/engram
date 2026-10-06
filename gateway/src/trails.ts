import { createHash } from "node:crypto";
import { brainClient } from "./brain";
import { dataSql } from "./db";
import { idFromFingerprint } from "./memory-entries";
import { capTranscript, redactSecrets, repoPageSlug } from "./redact";
import { reflexClient } from "./reflex";
import { choiceOf } from "./reflex/answers";

export const HARNESSES = ["claude", "cursor", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface TrailTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Trail {
  id: string;
  harness: string;
  sessionId: string;
  repo: string | null;
  cwd: string | null;
  branch: string | null;
  authorEmail: string | null;
  startedAt: string | null;
  endedAt: string | null;
  transcript: string | null;
  digest: string | null;
  digestSlug: string | null;
}

export interface TrailIngest {
  harness: string;
  sessionId: string;
  repo?: string | null;
  cwd?: string | null;
  branch?: string | null;
  authorEmail?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  transcript?: string | null;
  turns?: TrailTurn[];
}

export function trailId(harness: string, sessionId: string): string {
  const hex = createHash("sha256").update(`${harness}\n${sessionId}`).digest("hex");
  return idFromFingerprint(hex);
}

export function parseHarness(value: unknown): Harness | null {
  return typeof value === "string" && HARNESSES.includes(value as Harness)
    ? value as Harness
    : null;
}

export function extractTurns(transcript: string): TrailTurn[] {
  const turns: TrailTurn[] = [];
  const blocks = transcript.split(/\n(?=(?:User|Assistant|Human|Claude|Codex)\s*:)/i);
  for (const block of blocks) {
    const match = block.match(/^(User|Assistant|Human|Claude|Codex)\s*:\s*([\s\S]+)/i);
    if (!match) continue;
    const role = /^(user|human)$/i.test(match[1]) ? "user" : "assistant";
    const text = match[2].trim();
    if (text) turns.push({ role, text });
  }
  if (turns.length) return turns;
  const trimmed = transcript.trim();
  return trimmed ? [{ role: "user", text: trimmed }] : [];
}

export function extractFiles(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s`'"])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g)) {
    const path = match[1].replace(/^[./]+/, "");
    if (path && !path.startsWith("http") && path.length < 180) found.add(path);
  }
  return [...found].slice(0, 12);
}

export function heuristicDigest(input: {
  repo?: string | null;
  harness?: string | null;
  turns?: TrailTurn[];
  transcript?: string | null;
  variant?: "work" | "decisions" | "files";
}): string {
  const turns = input.turns?.length ? input.turns : extractTurns(input.transcript ?? "");
  const users = turns.filter(turn => turn.role === "user").map(turn => clip(turn.text, 220));
  const assistants = turns.filter(turn => turn.role === "assistant").map(turn => clip(turn.text, 220));
  const files = extractFiles(input.transcript ?? turns.map(turn => turn.text).join("\n"));
  const repo = input.repo || "a local folder";
  const harness = input.harness || "an agent";
  const variant = input.variant ?? "work";

  if (variant === "files") {
    return [
      `Worked on ${repo} in ${harness}.`,
      files.length ? `Files: ${files.join(", ")}.` : "No file paths were obvious in the transcript.",
      users[0] ? `Opened with: ${users[0]}` : null,
      assistants.at(-1) ? `Last reply: ${assistants.at(-1)}` : null,
    ].filter(Boolean).join("\n");
  }
  if (variant === "decisions") {
    return [
      `Decisions from ${harness} on ${repo}.`,
      users[0] ? `Asked: ${users[0]}` : "No user prompt was captured.",
      assistants.at(-1) ? `Settled at: ${assistants.at(-1)}` : null,
      users.length > 1 ? `Also asked: ${users.slice(1, 3).join(" / ")}` : null,
    ].filter(Boolean).join("\n");
  }
  return [
    `Worked on ${repo} in ${harness}.`,
    users[0] ? `Prompts: ${users.slice(0, 2).join(" / ")}` : "No user prompt was captured.",
    files.length ? `Files: ${files.slice(0, 6).join(", ")}.` : null,
    assistants.at(-1) ? `Last: ${assistants.at(-1)}` : null,
  ].filter(Boolean).join("\n");
}

export async function generateDigest(input: {
  repo?: string | null;
  harness?: string | null;
  turns?: TrailTurn[];
  transcript?: string | null;
}): Promise<{ digest: string; model: string | null }> {
  const variants = {
    work: heuristicDigest({ ...input, variant: "work" }),
    decisions: heuristicDigest({ ...input, variant: "decisions" }),
    files: heuristicDigest({ ...input, variant: "files" }),
  };
  try {
    const result = await reflexClient().evaluate({
      state: {
        repo: input.repo,
        harness: input.harness,
        prompts: (input.turns ?? extractTurns(input.transcript ?? ""))
          .filter(turn => turn.role === "user")
          .slice(0, 4)
          .map(turn => clip(turn.text, 400)),
        files: extractFiles(input.transcript ?? ""),
      },
      questions: {
        digest: {
          type: "choice",
          instructions: "Pick the digest that best tells a teammate what happened in this conversation.",
          criteria: variants,
        },
      },
    });
    const picked = result ? choiceOf(result.answers, "digest", 0.4) : null;
    if (picked && variants[picked as keyof typeof variants]) {
      return { digest: variants[picked as keyof typeof variants], model: result?.model ?? null };
    }
  } catch (e) {
    console.warn("[trails] jev digest skipped:", String(e).slice(0, 160));
  }
  return { digest: variants.work, model: null };
}

export function digestSlug(input: {
  repo?: string | null;
  harness: string;
  sessionId: string;
  at?: string | null;
}): string {
  const day = (input.at ?? new Date().toISOString()).slice(0, 10);
  const short = trailId(input.harness, input.sessionId).replace(/-/g, "").slice(0, 8);
  return `trails/${repoPageSlug(input.repo)}/${day}-${input.harness}-${short}`;
}

export function parseTrailIngest(body: Record<string, unknown>): TrailIngest | string {
  const harness = parseHarness(body.harness);
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim()
    ? body.sessionId.trim()
    : typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : "";
  if (!harness) return "harness must be claude, cursor, or codex";
  if (!sessionId) return "session_id required";
  const turns = Array.isArray(body.turns) ? body.turns.flatMap(asTurn) : [];
  const transcript = typeof body.transcript === "string" ? body.transcript : null;
  if (!transcript?.trim() && !turns.length) return "transcript required";
  return {
    harness,
    sessionId,
    repo: optionalText(body.repo),
    cwd: optionalText(body.cwd),
    branch: optionalText(body.branch),
    authorEmail: optionalText(body.authorEmail) ?? optionalText(body.author_email),
    startedAt: optionalText(body.startedAt) ?? optionalText(body.started_at),
    endedAt: optionalText(body.endedAt) ?? optionalText(body.ended_at),
    transcript,
    turns,
  };
}

export async function ingestTrail(input: TrailIngest, authorEmail?: string | null): Promise<Trail> {
  const turns = input.turns?.length ? input.turns : extractTurns(input.transcript ?? "");
  const raw = input.transcript?.trim() || flattenTurns(turns);
  const transcript = capTranscript(redactSecrets(raw));
  const id = trailId(input.harness, input.sessionId);
  const existing = await getTrail(id);
  const { digest, model } = await generateDigest({
    repo: input.repo,
    harness: input.harness,
    turns,
    transcript,
  });
  const slug = existing?.digestSlug ?? digestSlug({
    repo: input.repo,
    harness: input.harness,
    sessionId: input.sessionId,
    at: input.startedAt ?? input.endedAt,
  });
  const author = authorEmail ?? input.authorEmail ?? null;
  const startedAt = input.startedAt ?? existing?.startedAt ?? new Date().toISOString();
  const endedAt = input.endedAt ?? new Date().toISOString();

  const rows = await dataSql()`
    INSERT INTO trails (
      id, harness, session_id, repo, cwd, branch, author_email,
      started_at, ended_at, transcript, digest, digest_slug
    ) VALUES (
      ${id}, ${input.harness}, ${input.sessionId}, ${input.repo ?? null},
      ${input.cwd ?? null}, ${input.branch ?? null}, ${author},
      ${startedAt}, ${endedAt}, ${transcript}, ${digest}, ${slug}
    )
    ON CONFLICT (harness, session_id) DO UPDATE SET
      repo = COALESCE(EXCLUDED.repo, trails.repo),
      cwd = COALESCE(EXCLUDED.cwd, trails.cwd),
      branch = COALESCE(EXCLUDED.branch, trails.branch),
      author_email = COALESCE(EXCLUDED.author_email, trails.author_email),
      started_at = COALESCE(trails.started_at, EXCLUDED.started_at),
      ended_at = EXCLUDED.ended_at,
      transcript = EXCLUDED.transcript,
      digest = EXCLUDED.digest,
      digest_slug = COALESCE(trails.digest_slug, EXCLUDED.digest_slug),
      updated_at = now()
    RETURNING *`;
  const trail = rowToTrail(rows[0]);
  await writeDigestPage(trail, model).catch(e => {
    console.error("[trails] digest page failed:", String(e).slice(0, 160));
  });
  const { shareAfterWrite } = await import("./sharing");
  await shareAfterWrite({ kind: "trail", trail }).catch(e => {
    console.error("[trails] share failed:", String(e).slice(0, 160));
  });
  return trail;
}

export async function getTrail(id: string): Promise<Trail | null> {
  try {
    const rows = await dataSql()`SELECT * FROM trails WHERE id = ${id}`;
    return rows[0] ? rowToTrail(rows[0]) : null;
  } catch (e) {
    console.error("[trails] get failed:", String(e).slice(0, 160));
    return null;
  }
}

export async function listTrails(filter: {
  repo?: string | null;
  harness?: string | null;
  authorEmail?: string | null;
  limit?: number;
  offset?: number;
}): Promise<Trail[]> {
  const limit = Math.min(Math.max(filter.limit ?? 40, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
  try {
    const rows = await dataSql()`
      SELECT * FROM trails
      WHERE (${filter.repo ?? null}::text IS NULL OR repo = ${filter.repo ?? null})
        AND (${filter.harness ?? null}::text IS NULL OR harness = ${filter.harness ?? null})
        AND (${filter.authorEmail ?? null}::text IS NULL OR author_email = ${filter.authorEmail ?? null})
      ORDER BY COALESCE(ended_at, updated_at) DESC
      LIMIT ${limit} OFFSET ${offset}`;
    return rows.map(rowToTrail);
  } catch (e) {
    console.error("[trails] list failed:", String(e).slice(0, 160));
    return [];
  }
}

export async function listRepos(): Promise<string[]> {
  try {
    const rows = await dataSql()`
      SELECT DISTINCT repo FROM trails
      WHERE repo IS NOT NULL
      ORDER BY repo`;
    return rows.map(row => String(row.repo));
  } catch {
    return [];
  }
}

export async function attributionForSlugs(slugs: string[]): Promise<Map<string, { author: string | null; harness: string | null }>> {
  const out = new Map<string, { author: string | null; harness: string | null }>();
  if (!slugs.length) return out;
  try {
    const rows = await dataSql()`
      SELECT digest_slug, author_email, harness
      FROM trails
      WHERE digest_slug = ANY(${slugs})`;
    for (const row of rows) {
      if (row.digest_slug) {
        out.set(String(row.digest_slug), {
          author: row.author_email ? String(row.author_email) : null,
          harness: row.harness ? String(row.harness) : null,
        });
      }
    }
  } catch {
    // recall still works without attribution
  }
  return out;
}

export function publicTrail(trail: Trail, includeTranscript: boolean) {
  return {
    id: trail.id,
    harness: trail.harness,
    sessionId: trail.sessionId,
    repo: trail.repo,
    cwd: trail.cwd,
    branch: trail.branch,
    authorEmail: trail.authorEmail,
    startedAt: trail.startedAt,
    endedAt: trail.endedAt,
    digest: trail.digest,
    digestSlug: trail.digestSlug,
    transcript: includeTranscript ? trail.transcript : undefined,
  };
}

export async function writeDigestPage(trail: Trail, model?: string | null): Promise<void> {
  if (!trail.digestSlug || !trail.digest) return;
  const title = [
    trail.harness,
    trail.repo || "local",
    (trail.endedAt ?? trail.startedAt ?? "").slice(0, 10),
  ].filter(Boolean).join(" · ");
  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `harness: ${JSON.stringify(trail.harness)}`,
    trail.repo ? `repo: ${JSON.stringify(trail.repo)}` : null,
    trail.authorEmail ? `author: ${JSON.stringify(trail.authorEmail)}` : null,
    `session_id: ${JSON.stringify(trail.sessionId)}`,
    "---",
    "",
    `# ${title}`,
    "",
    trail.digest,
    "",
    model ? `_Digest judged by ${model}._` : "_Digest written without Jev._",
  ].filter(line => line !== null).join("\n");
  await brainClient().callTool({
    name: "put_page",
    arguments: { slug: trail.digestSlug, content: `${body}\n` },
  });
  const projectSlug = `projects/${repoPageSlug(trail.repo)}`;
  const day = (trail.endedAt ?? trail.startedAt ?? new Date().toISOString()).slice(0, 10);
  try {
    await brainClient().callTool({
      name: "add_timeline_entry",
      arguments: {
        slug: projectSlug,
        date: day,
        summary: `${trail.harness} session${trail.authorEmail ? ` by ${trail.authorEmail}` : ""}`,
        source: trail.digestSlug,
      },
    });
  } catch {
    // A missing project page is fine; the digest page still exists.
  }
}

export async function deleteDigestPage(slug: string | null): Promise<void> {
  if (!slug) return;
  try {
    await brainClient().callTool({ name: "delete_page", arguments: { slug } });
  } catch {
    // unshare still records the copy as gone
  }
}

function flattenTurns(turns: TrailTurn[]): string {
  return turns.map(turn => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n\n");
}

function asTurn(value: unknown): TrailTurn[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  return role && text ? [{ role, text }] : [];
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function rowToTrail(row: any): Trail {
  return {
    id: String(row.id),
    harness: String(row.harness),
    sessionId: String(row.session_id),
    repo: row.repo ? String(row.repo) : null,
    cwd: row.cwd ? String(row.cwd) : null,
    branch: row.branch ? String(row.branch) : null,
    authorEmail: row.author_email ? String(row.author_email) : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    transcript: row.transcript != null ? String(row.transcript) : null,
    digest: row.digest != null ? String(row.digest) : null,
    digestSlug: row.digest_slug ? String(row.digest_slug) : null,
  };
}
