// Nothing outside the curated gbrain allowlist ever reaches the child.
import type { TokenRecord } from "./auth";
import { brainClient } from "./brain";
import { audit } from "./audit";

const FORWARDED_TOOLS = [
  "search",
  "get_page",
  "list_pages",
  "put_page",
  "add_tag",
  "add_link",
  "add_timeline_entry",
] as const;
const ALLOWED_TOOLS = new Set<string>(FORWARDED_TOOLS);

// engram's own verbs. They are not gbrain tools: each one is a small script over
// the allowlisted primitives, so an agent gets one obvious way to write and one
// obvious way to read instead of seven ways to do either.
const SYNTHETIC_TOOLS = new Set(["whoami", "remember", "recall"]);

// Response caps are enforced here, not suggested in a description, so an agent
// cannot blow up its own context by asking for more.
const MAX_FORWARDED_LIMIT = 25;
const MAX_SNIPPET = 280;
const MAX_FULL_BODY = 4000;
const RECALL_LIMIT = 5;

// gbrain never surfaces these prefixes in search, so a note written under one is
// written into a hole. Anything derived here gets re-homed before it is saved.
const EXCLUDED_PREFIXES = ["test/", "attachments/", ".raw/"];

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

// Shipped in the initialize result so an agent learns the policy once, from the
// server, instead of every harness having to repeat it in a system prompt.
export const SERVER_INSTRUCTIONS = [
  "engram is shared memory: one store across every agent, harness, and machine this user runs.",
  "What you write here, another agent reads later.",
  "",
  "Call `recall` before substantive work on a named project or recurring topic, not on every session.",
  "",
  "Call `remember` when a decision is made, a correction is given, or work is handed off.",
  "Record intent, decisions, and constraints: the things a repo cannot tell the next agent.",
  "Do not record mechanical state (git status, file lists, test output) any agent can re-derive.",
  "",
  "Keep entries short, a sentence or two.",
].join("\n");

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

// 2026-07-28 requires Mcp-Method/Mcp-Name so upstream gateways can route without
// parsing bodies. engram parses the body regardless (it needs id + params), so the
// headers buy no parse savings here — they are assertions to VALIDATE, not authority
// to obey. Obeying a header that disagrees with the body would make engram execute
// something other than what the JSON-RPC message says, and would silently diverge
// from any upstream WAF or rate-limiter that inspects bodies instead. So: the body
// is authoritative, a header may fill in what the body omits, and disagreement is a
// malformed request. Headers stay optional for 2025-06-18 and older clients.
export function resolveMcpRouting(
  headers: { get(name: string): string | null },
  msg: { method?: unknown; params?: { name?: unknown } },
): { method: unknown; name: unknown; conflict: string | null } {
  const headerMethod = headers.get("mcp-method")?.trim();
  const headerName = headers.get("mcp-name")?.trim();
  const bodyMethod = msg.method;
  const bodyName = msg.params?.name;

  const conflict =
    headerMethod && bodyMethod !== undefined && headerMethod !== bodyMethod
      ? `Mcp-Method '${headerMethod}' disagrees with body method '${String(bodyMethod)}'`
      : headerName && bodyName !== undefined && headerName !== bodyName
        ? `Mcp-Name '${headerName}' disagrees with body tool name '${String(bodyName)}'`
        : null;

  return {
    method: bodyMethod ?? headerMethod,
    name: bodyName ?? headerName,
    conflict,
  };
}

// 2026-07-28 retired initialize; each request carries version, identity,
// and capabilities in params._meta. Older clients omit _meta entirely.
export function readClientMeta(params: any): {
  protocolVersion: string;
  clientInfo: unknown;
  clientCapabilities: unknown;
} {
  const meta = params?._meta;
  return {
    protocolVersion: negotiateProtocolVersion(meta?.["io.modelcontextprotocol/protocolVersion"]),
    clientInfo: meta?.["io.modelcontextprotocol/clientInfo"],
    clientCapabilities: meta?.["io.modelcontextprotocol/clientCapabilities"],
  };
}

let cachedToolDefs: any[] | null = null;

// 2026-07-28 clients can share tools/list now: every token sees the same ten tools.
export function toolsListCacheHints(
  _token: TokenRecord,
  protocolVersion: string,
): Record<string, unknown> {
  if (protocolVersion !== "2026-07-28") return {};
  return { ttlMs: 300_000, cacheScope: "public" };
}

// gbrain's own descriptions run to hundreds of words and name tools engram does not
// serve. That text is re-sent to every agent on every session, so the gateway
// rewrites it: the tool NAMES do the teaching, descriptions only disambiguate.
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search: "Raw keyword search over saved pages. Prefer recall, which returns compact results.",
  get_page: "Fetch one page's full body by slug.",
  list_pages: "List stored pages. Use search or recall when you know what you are looking for.",
  put_page: "Create or replace a whole page (markdown with YAML frontmatter). To add a note, use remember.",
  add_tag: "Tag an existing page.",
  add_link: "Link one page to another.",
  add_timeline_entry: "Add a dated event to an existing page's timeline.",
  whoami: "Show this token's identity.",
  remember: "Save a decision, correction, or handoff to shared memory. Groups under a topic when given.",
  recall: "Search shared memory. Returns up to 5 short snippets.",
};

const SERVED_TOOL_NAMES = new Set<string>([...FORWARDED_TOOLS, ...SYNTHETIC_TOOLS]);
const TOOL_MENTION = /\b(?:get|find|list|put|add|set|code|query)_[a-z_]+\b/g;
const MAX_PARAM_DESCRIPTION = 160;

// A parameter description that runs long, or points at a gbrain tool engram does not
// expose, costs context and teaches a call the agent cannot make. Drop it; the
// parameter name and type still carry the schema.
function keepParamDescription(text: string): boolean {
  if (text.length > MAX_PARAM_DESCRIPTION) return false;
  for (const [mention] of text.matchAll(TOOL_MENTION)) {
    if (!SERVED_TOOL_NAMES.has(mention)) return false;
  }
  return true;
}

function sanitizeSchema(name: string, schema: any): any {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return schema;

  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries<any>(props)) {
    const { description, ...rest } = value ?? {};
    const keep = typeof description === "string" && keepParamDescription(description);
    cleaned[key] = keep ? value : rest;
  }
  // Say the cap out loud where a caller would otherwise guess: it is clamped anyway.
  if (cleaned.limit && (name === "search" || name === "list_pages")) {
    cleaned.limit = { ...cleaned.limit, description: `Max results (capped at ${MAX_FORWARDED_LIMIT}).` };
  }
  return { ...schema, properties: cleaned };
}

// A forwarded tool keeps gbrain's schema and loses gbrain's prose.
export function shrinkToolDef(tool: any): any {
  return {
    ...tool,
    description: TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
    inputSchema: sanitizeSchema(tool.name, tool.inputSchema),
  };
}

function syntheticToolDefs(): any[] {
  return [
    {
      name: "whoami",
      description: TOOL_DESCRIPTIONS.whoami,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "remember",
      description: TOOL_DESCRIPTIONS.remember,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to record, in one or two sentences." },
          topic: { type: "string", description: "Project or recurring topic. Entries accumulate under it." },
        },
        required: ["text"],
      },
    },
    {
      name: "recall",
      description: TOOL_DESCRIPTIONS.recall,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are trying to remember." },
          full: { type: "boolean", description: "Also return the best match's body, truncated." },
        },
        required: ["query"],
      },
    },
  ];
}

export async function listTools(_token: TokenRecord): Promise<any[]> {
  if (!cachedToolDefs) {
    const all = await brainClient().listTools();
    const byName = new Map(all.tools
      .filter(t => ALLOWED_TOOLS.has(t.name))
      .map(t => [t.name, t]));
    cachedToolDefs = [
      ...FORWARDED_TOOLS
        .map(name => byName.get(name))
        .filter(Boolean)
        .map(shrinkToolDef),
      ...syntheticToolDefs(),
    ];
  }
  return cachedToolDefs;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

// Cut on a word boundary, but not if that throws away most of the excerpt. The
// ellipsis is counted in the budget so the caller's cap is the real ceiling.
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function kebab(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(" ");
}

// A topic with a slash is taken as an explicit slug path, so agents can write into a
// folder they already use; anything else is a project name. Either way the result is
// re-homed if it landed under a prefix gbrain hides from search.
export function slugForRemember(text: string, topic?: string): string {
  let slug: string;
  if (topic && topic.trim()) {
    const path = topic.trim().toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9/._-]+/g, "")
      .replace(/-*\/-*/g, "/")
      .replace(/-{2,}/g, "-")
      .replace(/^[-/]+|[-/]+$/g, "");
    slug = path.includes("/") ? path : `projects/${kebab(topic) || "untitled"}`;
  } else {
    const day = new Date().toISOString().slice(0, 10);
    slug = `notes/${day}-${kebab(firstWords(text, 6)) || "note"}`;
  }
  return EXCLUDED_PREFIXES.some(prefix => slug.startsWith(prefix)) ? `projects/${slug}` : slug;
}

function parseToolJson(result: any): any {
  if (result?.isError) return null;
  const text = (result?.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// get_page signals a missing slug by throwing or by an error result; both mean the
// same thing here, so remember treats either as "page does not exist yet".
async function readPage(slug: string): Promise<any | null> {
  try {
    const parsed = parseToolJson(await brainClient().callTool({
      name: "get_page",
      arguments: { slug },
    }));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function yamlHeader(title: string, frontmatter: unknown): string {
  const extra = frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)
    ? Object.entries(frontmatter as Record<string, unknown>).filter(([key]) => key !== "title")
    : [];
  return [["title", title] as [string, unknown], ...extra]
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

// remember is read-modify-write, so two agents appending to the same topic at the
// same moment would both read the prior content and the second write would drop the
// first entry. Many agents sharing one brain is the entire point, so serialize per
// slug. Cloud Run runs max-instances=1, which makes an in-process queue sufficient;
// if this ever scales past one instance this needs a read-after-write check instead.
const appendQueue = new Map<string, Promise<unknown>>();

function serializeBySlug<T>(slug: string, work: () => Promise<T>): Promise<T> {
  const prior = appendQueue.get(slug) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  appendQueue.set(slug, next.catch(() => {}));
  return next;
}

async function remember(args: Record<string, unknown>): Promise<any> {
  const slugForLock = slugForRemember(
    typeof args.text === "string" ? args.text.trim() : "",
    typeof args.topic === "string" ? args.topic : undefined,
  );
  return serializeBySlug(slugForLock, () => rememberUnsynchronized(args));
}

async function rememberUnsynchronized(args: Record<string, unknown>): Promise<any> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return toolError("remember requires a non-empty 'text'");
  const topic = typeof args.topic === "string" ? args.topic : undefined;

  const slug = slugForRemember(text, topic);
  const existing = await readPage(slug);
  const prior = typeof existing?.compiled_truth === "string" && existing.compiled_truth.trim()
    ? existing.compiled_truth.trimEnd()
    : null;

  const title = (existing?.title?.trim?.() || topic?.trim() || firstWords(text, 6)).slice(0, 120);
  const entry = `- ${new Date().toISOString()} — ${text}`;
  // Append rather than replace: a topic is a running log, and an agent that
  // overwrites it silently deletes what an earlier session learned.
  const body = prior ? `${prior}\n\n${entry}` : `# ${title}\n\n${entry}`;
  // compiled_truth comes back without frontmatter, so a plain write-back would drop
  // the title and every other field on the first append. Rebuild the header from
  // what get_page returned; YAML is a superset of JSON, so stringify is a safe
  // encoder for every value gbrain can hand back.
  const content = prior?.startsWith("---")
    ? `${body}\n`
    : `---\n${yamlHeader(title, existing?.frontmatter)}\n---\n\n${body}\n`;

  await brainClient().callTool({ name: "put_page", arguments: { slug, content } });
  return jsonResult({ ok: true, slug, appended: prior !== null });
}

async function recall(args: Record<string, unknown>): Promise<any> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return toolError("recall requires a non-empty 'query'");

  // The limit is engram's, not the caller's: recall exists to return a small answer.
  const hits = parseToolJson(await brainClient().callTool({
    name: "search",
    arguments: { query, limit: RECALL_LIMIT },
  }));
  const top = (Array.isArray(hits) ? hits : []).slice(0, RECALL_LIMIT);

  const results = top.map((hit: any) => ({
    slug: hit?.slug,
    title: hit?.title,
    snippet: truncate(typeof hit?.chunk_text === "string" ? hit.chunk_text : "", MAX_SNIPPET),
  }));

  let full: { slug: unknown; body: string } | null = null;
  if (args.full === true && top.length) {
    const best = top.reduce((a: any, b: any) => (Number(b?.score) || 0) > (Number(a?.score) || 0) ? b : a);
    const page = await readPage(String(best?.slug ?? ""));
    if (page) {
      const body = typeof page.compiled_truth === "string" ? page.compiled_truth : "";
      full = { slug: best?.slug, body: truncate(body, MAX_FULL_BODY) };
    }
  }

  return jsonResult({ results, full });
}

function clampArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "search" && name !== "list_pages") return args;
  const limit = Number(args.limit);
  if (!Number.isFinite(limit) || limit <= MAX_FORWARDED_LIMIT) return args;
  return { ...args, limit: MAX_FORWARDED_LIMIT };
}

// gbrain returns whole chunks; 25 of them unabridged is a context dump, so the
// snippet cap is applied on the way out rather than trusted to the caller.
function capSearchResult(result: any): any {
  for (const item of result?.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    let parsed: any;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    let capped = false;
    for (const hit of parsed) {
      if (hit && typeof hit.chunk_text === "string" && hit.chunk_text.length > MAX_SNIPPET) {
        hit.chunk_text = truncate(hit.chunk_text, MAX_SNIPPET);
        capped = true;
      }
    }
    if (capped) item.text = JSON.stringify(parsed);
  }
  return result;
}

export async function callTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const forwardedArgs = clampArgs(name, args ?? {});

  if (name === "whoami") {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "ok");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ token: token.name }),
      }],
    };
  }

  if (SYNTHETIC_TOOLS.has(name)) {
    try {
      const result = name === "remember"
        ? await remember(forwardedArgs)
        : await recall(forwardedArgs);
      await audit(token.name, name, summarizeArgs(forwardedArgs), result.isError ? "error" : "ok");
      return result;
    } catch (e) {
      await audit(token.name, name, summarizeArgs(forwardedArgs), "error");
      throw e;
    }
  }

  if (!ALLOWED_TOOLS.has(name)) {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "denied");
    return toolError(`Unknown or disallowed tool: ${name}`);
  }

  try {
    const result = await brainClient().callTool({ name, arguments: forwardedArgs });
    await audit(token.name, name, summarizeArgs(forwardedArgs), "ok");
    return name === "search" ? capSearchResult(result) : result;
  } catch (e) {
    await audit(token.name, name, summarizeArgs(forwardedArgs), "error");
    throw e;
  }
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
