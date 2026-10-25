import { expect, test } from "bun:test";
import { TypesafeReflexClient } from "../gateway/src/reflex/client";

test("provider parsing failures cannot copy private echoed content into circuit-breaker logs", async () => {
  const privateText = "TENANT_PRIVATE_DEPLOYMENT_ROADMAP";
  const client = new TypesafeReflexClient(async () => new Response(privateText), Date.now,
    { apiKey: "fixture-only", model: "jev-1.13.0", maxAttempts: 1 });
  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    for (let index = 0; index < 5; index++) {
      expect(await client.evaluate({ state: {}, questions: { kind: { type: "choice", instructions: "Classify", criteria: { fact: "Fact" } } } })).toBeNull();
    }
  } finally { console.warn = original; }
  expect(logged.some(line => line.includes("circuit open"))).toBe(true);
  expect(logged.join("\n")).not.toContain(privateText);
});
