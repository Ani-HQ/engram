import { expect, test } from "bun:test";
import { parseMcpMemoryContext } from "../gateway/src/mcp-request-context";

test("Engram task metadata preserves protocol metadata without treating it as authority", () => {
  expect(parseMcpMemoryContext(undefined)).toEqual({});
  expect(parseMcpMemoryContext({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" })).toEqual({});
  expect(parseMcpMemoryContext({ "com.engram/context": { runId: "task:opaque/1", maxBytes: 4096 } })).toEqual({ runId: "task:opaque/1", maxBytes: 4096 });
  expect(parseMcpMemoryContext({ "com.engram/context": { maxBytes: 16384 } })).toEqual({ maxBytes: 16384 });
});

test("invalid task identity, budget escalation, and claimed workspace metadata are rejected", () => {
  for (const value of [null, [], "task", { runId: "" }, { runId: "x".repeat(129) }, { runId: "a\nsecret" }, { maxBytes: 1023 }, { maxBytes: 16385 }, { maxBytes: 4096.5 }, { maxBytes: "4096" }, { orgId: 2 }, { actualTokens: 0 }]) {
    expect(() => parseMcpMemoryContext({ "com.engram/context": value })).toThrow();
  }
});

test("bounded integration declarations and issued probe controls stay outside authority", () => {
  const integration = { id: "engram-sdk-js", version: "0.1.0", runtime: "custom-agent", capabilities: ["lifecycle-events", "task-context"] };
  const parse = (context: unknown) => parseMcpMemoryContext({ "com.engram/context": context });
  expect(parse({ runId: "task:1", integration, verification: "begin" })).toEqual({ runId: "task:1", integration: { ...integration, capabilities: ["lifecycle-events", "task-context"] }, verification: "begin" });
  const probeId = `emp_${"a".repeat(32)}`;
  expect(parse({ runId: "task:1", integration, probeId, verification: "status" }).probeId).toBe(probeId);
  for (const context of [
    { integration: { ...integration, automaticWorkflowVerified: true } },
    { integration: { ...integration, capabilities: ["automatic-verified"] } },
    { integration: { ...integration, capabilities: ["task-context", "task-context"] } },
    { integration: { ...integration, runtime: "secret\nvalue" } },
    { integration: { ...integration, version: "v".repeat(41) } },
    { runId: "task:1", integration, credentialKey: "a".repeat(64) },
    { runId: "task:1", integration, probeId: "client-chosen-proof" },
    { runId: "task:1", integration, verification: "status" },
    { runId: "task:1", integration, verification: "begin", probeId },
    { integration, probeId }, { runId: "task:1", probeId },
  ]) expect(() => parse(context)).toThrow();
});
