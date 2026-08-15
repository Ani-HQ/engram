import { canRead, readableScopes, type TokenRecord } from "../auth";
import { audit } from "../audit";

const SECRET_PREFIX = "engram";
const SECRET_MANAGER_MODULE = "@google-cloud/secret-manager";

let secretManagerClient: any | null = null;

export const SECRET_TOOL_DEFS = [
  {
    name: "secret_get",
    description: "Read a Secret Manager secret value from an authorized engram scope.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Secret name inside the selected scope.",
        },
        scope: {
          type: "string",
          description: "Memory scope containing the secret. Required when this token can read more than one scope.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "secret_list",
    description: "List Secret Manager secret names visible to this token. Values are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Optional memory scope to list. Defaults to all readable scopes.",
        },
      },
    },
  },
];

export function secretIdFor(scope: string, name: string): string {
  return `${SECRET_PREFIX}--${scope.replace(/:/g, "-")}--${name}`;
}

function secretProject(): string {
  return process.env.ENGRAM_GCP_PROJECT ?? "ani-hq";
}

function secretPrefixFor(scope: string): string {
  return `${SECRET_PREFIX}--${scope.replace(/:/g, "-")}--`;
}

function secretVersionPath(scope: string, name: string): string {
  return `projects/${secretProject()}/secrets/${secretIdFor(scope, name)}/versions/latest`;
}

function parentPath(): string {
  return `projects/${secretProject()}`;
}

async function client() {
  if (!secretManagerClient) {
    const mod = await import(SECRET_MANAGER_MODULE);
    secretManagerClient = new mod.SecretManagerServiceClient();
  }
  return secretManagerClient;
}

function textArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function secretArgSummary(name: string | null): string {
  return name ? JSON.stringify({ name }).slice(0, 200) : "{}";
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resolveSecretGetScope(token: TokenRecord, requestedScope: string | null): string | null {
  if (requestedScope) return requestedScope;
  const readable = readableScopes(token);
  return readable.length === 1 ? readable[0] : null;
}

function resolveSecretListScopes(token: TokenRecord, requestedScope: string | null): string[] {
  return requestedScope ? [requestedScope] : readableScopes(token);
}

export async function callSecretTool(
  token: TokenRecord,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  if (name === "secret_get") return secretGet(token, args);
  if (name === "secret_list") return secretList(token, args);
  return toolError(`Unknown secret tool: ${name}`);
}

async function secretGet(token: TokenRecord, args: Record<string, unknown>): Promise<any> {
  const secretName = textArg(args, "name");
  const requestedScope = textArg(args, "scope");

  if (!secretName) {
    await audit(token.name, "secret_get", requestedScope, "{}", "denied");
    return toolError("Missing required secret name.");
  }
  if (!token.secrets) {
    await audit(token.name, "secret_get", requestedScope, secretArgSummary(secretName), "denied");
    return toolError("Secret access denied.");
  }

  const scope = resolveSecretGetScope(token, requestedScope);
  if (!scope) {
    await audit(token.name, "secret_get", null, secretArgSummary(secretName), "denied");
    return toolError("Pass an explicit scope for this secret.");
  }
  if (!canRead(token, scope)) {
    await audit(token.name, "secret_get", scope, secretArgSummary(secretName), "denied");
    return toolError("Secret access denied.");
  }

  try {
    const c = await client();
    const [version] = await c.accessSecretVersion({ name: secretVersionPath(scope, secretName) });
    const data = version.payload?.data;
    const value = data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data ?? "");
    await audit(token.name, "secret_get", scope, secretArgSummary(secretName), "ok");
    return { content: [{ type: "text", text: value }] };
  } catch {
    await audit(token.name, "secret_get", scope, secretArgSummary(secretName), "error");
    return toolError("Secret read failed.");
  }
}

async function secretList(token: TokenRecord, args: Record<string, unknown>): Promise<any> {
  const requestedScope = textArg(args, "scope");

  if (!token.secrets) {
    await audit(token.name, "secret_list", requestedScope, "{}", "denied");
    return toolError("Secret access denied.");
  }

  const scopes = resolveSecretListScopes(token, requestedScope);
  const denied = scopes.filter(scope => !canRead(token, scope));
  if (denied.length > 0 || scopes.length === 0) {
    await audit(token.name, "secret_list", scopes.join(","), "{}", "denied");
    return toolError("Secret access denied.");
  }

  try {
    const prefixes = new Map(scopes.map(scope => [scope, secretPrefixFor(scope)]));
    const c = await client();
    const [secrets] = await c.listSecrets({ parent: parentPath() });
    const visible = (secrets ?? []).flatMap((secret: any) => {
      const id = String(secret.name ?? "").split("/").pop() ?? "";
      for (const [scope, prefix] of prefixes) {
        if (id.startsWith(prefix)) return [{ scope, name: id.slice(prefix.length) }];
      }
      return [];
    }).sort((a: { scope: string; name: string }, b: { scope: string; name: string }) =>
      a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));

    await audit(token.name, "secret_list", scopes.join(","), "{}", "ok");
    return { content: [{ type: "text", text: JSON.stringify({ secrets: visible }, null, 2) }] };
  } catch {
    await audit(token.name, "secret_list", scopes.join(","), "{}", "error");
    return toolError("Secret list failed.");
  }
}
