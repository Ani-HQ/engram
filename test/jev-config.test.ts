import { expect, test } from "bun:test";

test("JEV_API_KEY is canonical and blank Compose defaults preserve legacy BYO aliases", async () => {
  const script = 'const {config}=await import("./gateway/src/config"); console.log(config.reflex.apiKey===process.env.EXPECTED_FIXTURE_KEY);';
  for (const [canonical, reflex, typesafe, expected] of [
    ["canonical-fixture", "legacy-fixture", "older-fixture", "canonical-fixture"],
    ["", "legacy-fixture", "older-fixture", "legacy-fixture"],
    ["unset", "", "older-fixture", "older-fixture"],
    ["", "", "unset", ""],
  ]) {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe", env: { ...process.env,
      ENGRAM_DEPLOYMENT_MODE: "self-hosted", ENGRAM_DATABASE_AUTHORITY: "inline", ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS: "1", ENGRAM_DB_URL_TEMPLATE: "postgresql://fixture:fixture@localhost:1/__DB__",
      JEV_API_KEY: canonical, REFLEX_API_KEY: reflex, TYPESAFE_API_KEY: typesafe, EXPECTED_FIXTURE_KEY: expected,
    } });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status, stderr).toBe(0); expect(stdout.trim()).toBe("true");
  }
});
