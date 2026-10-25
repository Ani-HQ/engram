import { describe, expect, test } from "bun:test";
import { runWithContext } from "../gateway/src/context";
import { normalizeToken, parsePolicies } from "../gateway/src/policies";
import { brainEnvironment, externalAiAllowed, jevAllowed } from "../gateway/src/privacy";
import { TypesafeReflexClient } from "../gateway/src/reflex/client";

function inWorkspace<T>(id: number, optedIn: boolean, work: () => T): T {
  return runWithContext({ org: { id, name: "Private", slug: `private-${id}`, kind: "team", brainDb: `brain_org_${id}`, dataDb: `brain_org_${id}`, homeDir: `org-${id}`, policies: parsePolicies({ jevProcessing: optedIn }) }, token: normalizeToken({ name: "agent", orgId: id }), dataSql: {} as any }, work);
}

describe("workspace privacy defaults", () => {
  test("requires explicit boolean consent and a workspace context", () => {
    expect(parsePolicies({}).externalAiProcessing).toBe(false);
    expect(parsePolicies({ externalAiProcessing: "true" }).externalAiProcessing).toBe(false);
    expect(externalAiAllowed()).toBe(false);
    expect(inWorkspace(7, false, () => externalAiAllowed())).toBe(false);
    expect(inWorkspace(8, true, () => externalAiAllowed())).toBe(false);
    expect(inWorkspace(8, true, () => jevAllowed())).toBe(true);
    expect(jevAllowed()).toBe(false);
    expect(parsePolicies({ externalAiProcessing: true }).jevProcessing).toBe(false);
    for (const value of [undefined, null, "true", 1, {}, []]) expect(parsePolicies({ jevProcessing: value }).jevProcessing).toBe(false);
    expect(parsePolicies({ jevProcessing: true }).externalAiProcessing).toBe(false);
  });

  test("child processes receive no operator billing, auth or AI secrets by default", () => {
    const env = brainEnvironment({ brainDb: "brain_org_7", homeDir: "org-7", policies: parsePolicies({}) }, { PATH: "/bin", STRIPE_SECRET_KEY: "billing-secret", OPENAI_API_KEY: "ai-secret", VOYAGE_API_KEY: "embedding-secret", ENGRAM_OAUTH_PRIVATE_KEY: "signing-secret", RESEND_API_KEY: "mail-secret" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toEndWith("/org-7");
    expect(env.GBRAIN_DATABASE_URL).toContain("brain_org_7");
    for (const key of ["STRIPE_SECRET_KEY", "OPENAI_API_KEY", "VOYAGE_API_KEY", "ENGRAM_OAUTH_PRIVATE_KEY", "RESEND_API_KEY"]) expect(env[key]).toBeUndefined();
  });

  test("provider consent stays isolated across concurrent workspace requests", async () => {
    const sent: string[] = [];
    const client = new TypesafeReflexClient(async (_url, options) => {
      sent.push(JSON.parse(String(options?.body)).state.memory);
      return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 3 }, answers: { kind: { type: "choice", choice: "fact", confidence: 1 } } });
    }, Date.now, { apiKey: "test-key", model: "jev-1.13.0" });
    const ask = (memory: string) => client.evaluate({ state: { memory }, questions: { kind: { type: "choice", instructions: "classify", criteria: { fact: "fact" } } } });
    const [privateResult, optedInResult] = await Promise.all([
      inWorkspace(7, false, async () => { await Promise.resolve(); return ask("private-memory"); }),
      inWorkspace(8, true, async () => { await Promise.resolve(); return ask("opted-in-memory"); }),
    ]);
    expect(privateResult).toBeNull();
    expect(optedInResult?.answers.kind).toBeDefined();
    expect(sent).toEqual(["opted-in-memory"]);
  });
});
