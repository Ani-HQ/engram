import { describe, expect, test } from "bun:test";
import { connectionSetupPrompt, connectionSetupPromptWithKey, maskAccessKey } from "./onboarding-model.js";

const key = "eng_demo_0123456789abcdef";
const endpoint = "https://engram.example.test/mcp";

describe("ready-to-paste setup with a fresh key", () => {
  test("the copied prompt carries the exact key, endpoint and workspace, and asks for a whoami check", () => {
    const prompt = connectionSetupPromptWithKey(endpoint, { id: 4, name: "Team" }, key, "claude-code")!;
    expect(prompt).toContain(`"authorization": "Bearer ${key}"`);
    expect(prompt).toContain(`"endpoint": "${endpoint}"`);
    expect(prompt).toContain(`"name": "Team"`);
    expect(prompt).toContain(`"type": "http"`);
    for (const rule of ["Preserve all other MCP servers", "Do not print, repeat or log it", "whoami", "do not claim success", "Do not read or write memory"]) expect(prompt).toContain(rule);
  });

  test("the configuration reference follows the chosen client's format", () => {
    expect(connectionSetupPromptWithKey(endpoint, null, key, "codex")).toContain(`[mcp_servers.engram]`);
    expect(connectionSetupPromptWithKey(endpoint, null, key, "codex")).toContain("TOML configuration");
    expect(connectionSetupPromptWithKey(endpoint, null, key)).toContain(`"mcpServers"`);
  });

  test("an invalid endpoint or a malformed key yields nothing to copy", () => {
    expect(connectionSetupPromptWithKey("javascript:alert(1)", null, key)).toBeNull();
    for (const bad of ["", "  ", "a b", 'a"b', "a\\b", null]) expect(connectionSetupPromptWithKey(endpoint, null, bad as any)).toBeNull();
  });

  test("previews mask the key", () => {
    const masked = maskAccessKey(key);
    expect(masked).toBe("eng_de••••••••cdef");
    expect(connectionSetupPromptWithKey(endpoint, null, key)!.split(key).join(masked)).not.toContain(key);
    expect(maskAccessKey("short")).not.toContain("short");
  });

  test("the keyless prompt still never carries a key", () => {
    expect(connectionSetupPrompt(endpoint, null)).toContain("Never ask me to paste a key into this conversation");
    expect(connectionSetupPrompt(endpoint, null)).not.toContain("Bearer");
  });
});
