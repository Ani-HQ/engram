// The security boundary: curated allowlist of gbrain tools, scope routing,
// write guards, and fan-out reads across the token's readable scopes.
// Nothing outside ALLOWED_READS/ALLOWED_WRITES ever reaches a gbrain child.
import { TokenRecord, canWrite, readableScopes } from "./auth";
import { scopeClient } from "./scopes";
import { audit } from "./audit";
import { SECRET_TOOL_DEFS, callSecretTool } from "./tools/secrets";
import { PROMOTE_TOOL_DEF, promoteTool } from "./tools/promote";

const ALLOWED_READS = new Set(["search", "get_page", "list_pages", "recall"]);
const ALLOWED_WRITES = new Set(["put_page", "remember", "add_tag", "add_link", "add_timeline_entry"]);

// Extra args engram adds to every proxied tool schema.
const SCOPE_ARG = {
  scope: {
    type: "string",
    description: "Memory scope to target (e.g. 'shared'). Reads default to all scopes your token can read; writes require one writable scope (defaulted when unambiguous).",
  },
};

let cachedToolDefs: any[] | null = null;

export async function listTools(token: TokenRecord): Promise<any[]> {
  if (!cachedToolDefs) {
    // Any scope's child serves the same tool schemas; use the first configured one.
    const first = readableScopes(token)[0] ?? "shared";
    const all = await scopeClient(first).listTools();
    cachedToolDefs = all.tools
      .filter(t => ALLOWED_READS.has(t.name) || ALLOWED_WRITES.has(t.name))
      .map(t => ({
        ...t,
        inputSchema: {
          ...t.inputSchema,
          properties: { ...(t.inputSchema as any).properties, ...SCOPE_ARG },
        },
      }));
  }
  return [
    ...cachedToolDefs,
    ...(token.secrets ? SECRET_TOOL_DEFS : []),
    ...(Object.keys(token.scopes).some(s => canWrite(token, s)) ? [PROMOTE_TOOL_DEF] : []),
    {
      name: "whoami",
      description: "Show this token's identity: name, readable/writable scopes, secrets access.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function summarizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

export async function callTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const { scope: requestedScope, ...rest } = (args ?? {}) as Record<string, unknown> & { scope?: string };

  if (name === "whoami") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ token: token.name, scopes: token.scopes, secrets: token.secrets }, null, 2),
      }],
    };
  }

  if (name === "secret_get" || name === "secret_list") {
    return callSecretTool(token, name, args ?? {});
  }

  if (name === "promote") {
    return promoteTool(token, args ?? {});
  }

  const readable = readableScopes(token);

  if (ALLOWED_WRITES.has(name)) {
    const writable = Object.keys(token.scopes).filter(s => canWrite(token, s));
    const target = (requestedScope as string) ?? (writable.length === 1 ? writable[0] : undefined);
    if (!target || !canWrite(token, target)) {
      await audit(token.name, name, target ?? null, summarizeArgs(rest), "denied");
      return toolError(
        `Write denied. Token '${token.name}' can write to: [${writable.join(", ") || "none"}]` +
        (target ? `, requested scope '${target}'.` : ". Pass an explicit 'scope' argument."),
      );
    }
    const result = await scopeClient(target).callTool({ name, arguments: rest });
    await audit(token.name, name, target, summarizeArgs(rest), "ok");
    return result;
  }

  if (ALLOWED_READS.has(name)) {
    const targets = requestedScope ? [requestedScope as string] : readable;
    const denied = targets.filter(s => !readable.includes(s));
    if (denied.length > 0 || targets.length === 0) {
      await audit(token.name, name, targets.join(","), summarizeArgs(rest), "denied");
      return toolError(`Read denied. Token '${token.name}' can read: [${readable.join(", ") || "none"}].`);
    }
    const results = await Promise.all(targets.map(async scope => {
      try {
        const r = await scopeClient(scope).callTool({ name, arguments: rest });
        return { scope, r };
      } catch (e) {
        return { scope, r: toolError(`scope '${scope}' failed: ${String(e).slice(0, 200)}`) };
      }
    }));
    await audit(token.name, name, targets.join(","), summarizeArgs(rest), "ok");
    if (results.length === 1) return results[0].r;
    // Fan-out merge: label each scope's content block.
    return {
      content: results.flatMap(({ scope, r }) =>
        (r.content ?? []).map((c: any) =>
          c.type === "text" ? { ...c, text: `[scope: ${scope}]\n${c.text}` } : c)),
    };
  }

  await audit(token.name, name, null, summarizeArgs(rest), "denied_unknown_tool");
  return toolError(`Unknown or disallowed tool: ${name}`);
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
