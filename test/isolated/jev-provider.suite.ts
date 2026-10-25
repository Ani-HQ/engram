import { beforeEach, expect, mock, test } from "bun:test";
import { runWithContext } from "../../gateway/src/context";
import { normalizeToken, parsePolicies } from "../../gateway/src/policies";

const calls: Array<{ kind: string; value?: any }> = [];
let admission = true, settlement = true, expired = false, reserveError = false;
const seen = new Set<string>();
mock.module("../../gateway/src/config", () => ({ config: { deploymentMode: "hosted", gbrainHomesDir: "/fixture", reflex: { apiKey: "fixture-key", model: "jev-1.13.0", endpoint: "https://api.typesafe.ai/v1/systemone", concurrency: 8, timeoutMs: 30 } }, databaseSecurity: {} }));
mock.module("../../gateway/src/tenant-db", () => ({ tenantDbUrl: () => "postgresql://fixture/brain" }));
mock.module("../../gateway/src/billing", () => ({ requireHostedWriteAccess: async () => { if (expired) throw new Error("expired"); } }));
mock.module("../../gateway/src/insights-budget", () => ({ reserveWorkspaceInference: async () => { throw new Error("Hosted calls must use the atomic Jev reservation"); } }));
mock.module("../../gateway/src/jev", () => ({
  reserveJevCall: async (input: any) => {
    calls.push({ kind: "reserve", value: input });
    if (reserveError) throw new Error("private storage details");
    if (!admission || (input.operationId && seen.has(input.operationId))) return null;
    if (input.operationId) seen.add(input.operationId);
    return { id: "attempt-1" };
  },
  settleJevCall: async (id: string, usage: any) => { calls.push({ kind: "settle", value: { id, ...usage } }); return settlement; },
  failJevCall: async (id: string, reason: string) => { calls.push({ kind: "fail", value: { id, reason } }); },
}));
const { TypesafeReflexClient, safeJevEndpoint, JEV_ENDPOINT } = await import("../../gateway/src/reflex/client");
const { processingOrg, brainEnvironment } = await import("../../gateway/src/privacy");

const input = { state: { memory: "A useful decision" }, questions: { x: { type: "noul" as const, instructions: "Is this useful?" } }, task: "classify" as const };
const response = (extra: Record<string, unknown> = {}) => ({ model: "jev-1.13.0", usage: { input_tokens: 123, output_tokens: 4 }, answers: { x: { type: "noul", noul: .9 } }, ...extra });
const org = (policies: Record<string, unknown> = { jevProcessing: true }) => ({ id: 7, name: "Private", slug: "private", kind: "personal" as const, brainDb: "brain_org_7", dataDb: "brain_org_7", homeDir: "org-7", policies: parsePolicies(policies) });
const actor = normalizeToken({ name: "owner", orgId: 7, kind: "session", role: "owner", email: "fixture@example.test" });
function workspace<T>(work: () => T, policies?: Record<string, unknown>) { return runWithContext({ org: org(policies), token: actor, dataSql: {} as any }, work); }
function client(result: () => Response | Promise<Response> = () => Response.json(response()), options: ConstructorParameters<typeof TypesafeReflexClient>[2] = {}) {
  return new TypesafeReflexClient(async (url, init) => { calls.push({ kind: "transport", value: { url, redirect: init?.redirect, signal: init?.signal } }); return result(); }, Date.now, options);
}
beforeEach(() => { calls.length = 0; admission = settlement = true; expired = reserveError = false; seen.clear(); });

test("legacy consent cannot enable Jev; Jev consent cannot enable other provider credentials", async () => {
  for (const policies of [{}, { externalAiProcessing: true }, { jevProcessing: "true" }, { jevProcessing: 1 }]) {
    expect(await workspace(() => client().evaluate(input), policies)).toBeNull();
  }
  expect(calls).toHaveLength(0);
  expect(await client().evaluate(input)).toBeNull();
  expect(brainEnvironment(org({ jevProcessing: true }), { VOYAGE_API_KEY: "must-not-inherit" }).VOYAGE_API_KEY).toBeUndefined();
});

test("expired hosted entitlement strips all effective provider flags without changing saved preferences", async () => {
  const stored = org({ jevProcessing: true, externalAiProcessing: true }); expired = true;
  const effective = await processingOrg(stored, actor);
  expect(effective.policies.jevProcessing).toBe(false); expect(effective.policies.externalAiProcessing).toBe(false);
  expect(stored.policies.jevProcessing).toBe(true); expect(stored.policies.externalAiProcessing).toBe(true);
});

test("reservation denial or storage failure never reaches the provider", async () => {
  admission = false;
  expect(await workspace(() => client().evaluate(input))).toBeNull();
  reserveError = true;
  expect(await workspace(() => client().evaluate(input))).toBeNull();
  expect(calls.filter(call => call.kind === "transport")).toHaveLength(0);
});

test("actual model and usage settle before unusable answers are discarded", async () => {
  expect(await workspace(() => client(() => Response.json(response({ answers: { x: { type: "score", score: 9 } } }))).evaluate(input))).toBeNull();
  expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "settle"]);
  expect(calls[2].value).toEqual({ id: "attempt-1", model: "jev-1.13.0", inputTokens: 123, outputTokens: 4 });
  expect(calls[0].value.task).toBe("classify");
  expect(calls[1].value.redirect).toBe("error");
});

test("stable alias requests preserve actual reported alias or version in metering and results", async () => {
  for (const reported of ["jev-latest", "jev-1.13.0"]) {
    calls.length = 0;
    const result = await workspace(() => client(() => Response.json(response({ model: reported })), { model: "jev-latest" }).evaluate(input));
    expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "settle"]);
    expect(calls[0].value.model).toBe("jev-latest");
    expect(calls[2].value).toEqual({ id: "attempt-1", model: reported, inputTokens: 123, outputTokens: 4 });
    expect(result?.requestedModel).toBe("jev-latest");
    expect(result?.model).toBe(reported);
    expect(result?.modelReported).toBe(true);
  }
});

test("preview and unknown requested models never transmit", async () => {
  for (const model of ["jev-preview", "jev-next", "jev-1.13", ""]) {
    expect(await workspace(() => client(undefined, { model }).evaluate(input))).toBeNull();
  }
  expect(calls).toHaveLength(0);
});

test("missing or malformed usage/model is unbillable and does not produce a result", async () => {
  for (const extra of [{ usage: undefined }, { model: undefined }, { model: "jev-preview" }, { model: "jev-next" }, { usage: { input_tokens: -1, output_tokens: 0 } }, { usage: { input_tokens: 1.5, output_tokens: 0 } }, { usage: { input_tokens: "123", output_tokens: 0 } }, { usage: { input_tokens: 1_000_001, output_tokens: 0 } }]) {
    calls.length = 0;
    expect(await workspace(() => client(() => Response.json(response(extra))).evaluate(input))).toBeNull();
    expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "fail"]);
    expect(calls[2].value.reason).toBe("invalid_usage");
  }
});

test("a wrong returned model still reaches settlement and cannot be used or customer-billed", async () => {
  settlement = false;
  expect(await workspace(() => client(() => Response.json(response({ model: "jev-1.14.0" }))).evaluate(input))).toBeNull();
  expect(calls[2].value.model).toBe("jev-1.14.0"); expect(calls.some(call => call.kind === "fail")).toBe(false);
});

test("an explicit version does not silently accept a floating response alias", async () => {
  settlement = false;
  expect(await workspace(() => client(() => Response.json(response({ model: "jev-latest" }))).evaluate(input))).toBeNull();
  expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "settle"]);
  expect(calls[2].value.model).toBe("jev-latest");
});

test("hosted HTTP errors and timeout attempts cannot be silently retried", async () => {
  for (const status of [402, 429, 529, 500]) {
    calls.length = 0;
    expect(await workspace(() => client(() => new Response("private provider echo", { status }), { maxAttempts: 3 }).evaluate({ ...input, maxAttempts: 3 }))).toBeNull();
    expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "fail"]);
    expect(calls[2].value.reason).toBe("http_error");
  }
  calls.length = 0;
  expect(await workspace(() => client(() => { throw new DOMException("private timeout", "TimeoutError"); }, { maxAttempts: 3 }).evaluate(input))).toBeNull();
  expect(calls.map(call => call.kind)).toEqual(["reserve", "transport", "fail"]); expect(calls[2].value.reason).toBe("timeout");
});

test("background operation replays do not retransmit when content or answers change", async () => {
  const provider = client(undefined, { operationId: "job:fixture-123" });
  expect(await workspace(() => provider.evaluate({ ...input, operationKey: "entry-123" }))).not.toBeNull();
  expect(await workspace(() => provider.evaluate({ ...input, state: { memory: "Changed since the first attempt" }, operationKey: "entry-123" }))).toBeNull();
  expect(calls.filter(call => call.kind === "transport")).toHaveLength(1);
  const reservations = calls.filter(call => call.kind === "reserve");
  expect(reservations[0].value.operationId).toBe(reservations[1].value.operationId);
  expect(reservations[0].value.operationId).not.toContain("entry-123");
});

test("hosted endpoint pins HTTPS origin/path while self-host overrides remain explicit and safe", () => {
  expect(safeJevEndpoint(JEV_ENDPOINT, true)).toBe(JEV_ENDPOINT);
  for (const endpoint of ["http://api.typesafe.ai/v1/systemone", "https://evil.example/v1/systemone", `${JEV_ENDPOINT}?secret=x`, `${JEV_ENDPOINT}#x`, "https://user:private@api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1/models"]) {
    expect(safeJevEndpoint(endpoint, true)).toBeNull(); expect(workspace(() => client(undefined, { endpoint }).enabled())).toBe(false);
  }
  expect(safeJevEndpoint("https://selfhost.example/custom", false)).toBe("https://selfhost.example/custom");
  expect(safeJevEndpoint("http://localhost:8080/jev", false)).toBe("http://localhost:8080/jev");
  expect(safeJevEndpoint("http://remote.example/jev", false)).toBeNull();
});
