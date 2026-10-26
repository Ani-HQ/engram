/** Optional task identity is client metadata, never a tool argument or authority. */
export const INTEGRATION_CAPABILITIES = ["task-context", "lifecycle-events", "explicit-deltas"] as const;
export interface McpIntegration { id: string; version: string; runtime: string; capabilities: string[] }
export interface McpMemoryContext { runId?: string; maxBytes?: number; integration?: McpIntegration; probeId?: string; verification?: "begin" | "status" }
const identifier = (value: unknown, maximum = 80): value is string => typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
export function parseMcpIntegration(value: unknown): McpIntegration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration metadata must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["id", "version", "runtime", "capabilities"].includes(key)) || !identifier(input.id) || !identifier(input.runtime) || !identifier(input.version, 40)) throw new Error("Integration metadata requires bounded id, version and runtime labels.");
  const capabilities = input.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.length > INTEGRATION_CAPABILITIES.length || capabilities.some(item => typeof item !== "string" || !INTEGRATION_CAPABILITIES.includes(item as any)) || new Set(capabilities).size !== capabilities.length) throw new Error("Unsupported integration capabilities.");
  return { id: input.id, version: input.version, runtime: input.runtime, capabilities: [...capabilities].sort() as string[] };
}

export function parseMcpMemoryContext(meta: unknown): McpMemoryContext {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const value = (meta as Record<string, unknown>)["com.engram/context"];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Engram context metadata must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["runId", "maxBytes", "integration", "probeId", "verification"].includes(key))) throw new Error("Unsupported Engram context metadata.");
  if (input.runId !== undefined && (typeof input.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.runId))) {
    throw new Error("Engram runId must be an opaque identifier of 1–128 characters.");
  }
  if (input.maxBytes !== undefined && (!Number.isInteger(input.maxBytes) || (input.maxBytes as number) < 1024 || (input.maxBytes as number) > 16384)) {
    throw new Error("Engram maxBytes must be an integer from 1024 to 16384.");
  }
  const integration = input.integration === undefined ? undefined : parseMcpIntegration(input.integration);
  if (input.probeId !== undefined && (typeof input.probeId !== "string" || !/^emp_[A-Za-z0-9_-]{32}$/.test(input.probeId))) throw new Error("Invalid verification probe ID.");
  if (input.verification !== undefined && input.verification !== "begin" && input.verification !== "status") throw new Error("Unsupported verification operation.");
  if ((input.probeId !== undefined || input.verification !== undefined) && (!input.runId || !integration)) throw new Error("Verification requires task and integration metadata.");
  if (input.verification === "begin" && input.probeId !== undefined) throw new Error("Begin verification without an existing probe ID.");
  if (input.verification === "status" && input.probeId === undefined) throw new Error("Verification status requires the issued probe ID.");
  return { ...(input.runId !== undefined ? { runId: input.runId as string } : {}), ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes as number } : {}), ...(integration ? { integration } : {}), ...(input.probeId ? { probeId: input.probeId as string } : {}), ...(input.verification ? { verification: input.verification as "begin" | "status" } : {}) };
}
