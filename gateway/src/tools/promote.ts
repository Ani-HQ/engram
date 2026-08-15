import { canRead, canWrite, type TokenRecord } from "../auth";
import { audit } from "../audit";
import { scopeClient } from "../scopes";

export const PROMOTE_TOOL_DEF = {
  name: "promote",
  description: "Copy a page from one readable scope into one writable scope with promotion frontmatter.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "Page slug to promote.",
      },
      from_scope: {
        type: "string",
        description: "Readable source scope.",
      },
      to_scope: {
        type: "string",
        description: "Writable target scope.",
      },
    },
    required: ["slug", "from_scope", "to_scope"],
  },
};

function textArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function summarize(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {}).slice(0, 200);
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function textFromToolResult(result: any): string | null {
  if (typeof result?.structuredContent?.content === "string") return result.structuredContent.content;
  if (typeof result?.content === "string") return result.content;

  const block = Array.isArray(result?.content)
    ? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")
    : null;
  if (!block) return null;

  try {
    const parsed = JSON.parse(block.text);
    // gbrain get_page returns the page body in `compiled_truth`.
    if (typeof parsed?.compiled_truth === "string") return parsed.compiled_truth;
    if (typeof parsed?.content === "string") return parsed.content;
    if (typeof parsed?.page?.content === "string") return parsed.page.content;
    if (typeof parsed?.body === "string") return parsed.body;
  } catch {
    // Some MCP tools return the page body directly as the text block.
  }
  return block.text;
}

function promotedContent(content: string, fromScope: string, promotedAt: string): string {
  return [
    "---",
    `promoted_from: ${JSON.stringify(fromScope)}`,
    `promoted_at: ${promotedAt}`,
    "---",
    content,
  ].join("\n");
}

export async function promoteTool(token: TokenRecord, args: Record<string, unknown>): Promise<any> {
  const slug = textArg(args, "slug");
  const fromScope = textArg(args, "from_scope");
  const toScope = textArg(args, "to_scope");
  const summary = summarize({ slug, from_scope: fromScope, to_scope: toScope });

  if (!slug || !fromScope || !toScope) {
    await audit(token.name, "promote", null, summary, "denied");
    return toolError("Missing required promote arguments.");
  }
  if (!canRead(token, fromScope) || !canWrite(token, toScope)) {
    await audit(token.name, "promote", `${fromScope}->${toScope}`, summary, "denied");
    return toolError("Promote denied.");
  }

  try {
    const source = await scopeClient(fromScope).callTool({ name: "get_page", arguments: { slug } });
    const content = textFromToolResult(source);
    if (content === null) {
      await audit(token.name, "promote", `${fromScope}->${toScope}`, summary, "error");
      return toolError("Source page could not be read.");
    }

    const promotedAt = new Date().toISOString();
    await scopeClient(toScope).callTool({
      name: "put_page",
      arguments: { slug, content: promotedContent(content, fromScope, promotedAt) },
    });
    await audit(token.name, "promote", `${fromScope}->${toScope}`, summary, "ok");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ slug, from_scope: fromScope, to_scope: toScope, promoted_at: promotedAt }, null, 2),
      }],
    };
  } catch (e) {
    await audit(token.name, "promote", `${fromScope}->${toScope}`, summary, "error");
    return toolError(`Promote failed: ${String(e).slice(0, 200)}`);
  }
}
