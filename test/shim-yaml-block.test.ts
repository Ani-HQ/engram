import { describe, expect, test } from "bun:test";

const yaml = require("../shim/yaml-block.js");
const engram = ['url: "https://engram.example/mcp"', "headers:", '  Authorization: "Bearer eng_new"'];
const managed = (item: string) => item.includes(" memory hook hermes");
const hook = ['- command: "node index.js memory hook hermes pre_llm_call"', "  timeout: 10"];

describe("YAML block editing for Hermes config.yaml", () => {
  test("an empty or missing file gets just the Engram entry", () => {
    expect(yaml.setMappingChild("", "mcp_servers", "engram", engram)).toBe([
      "mcp_servers:", "  engram:", '    url: "https://engram.example/mcp"', "    headers:", '      Authorization: "Bearer eng_new"', "",
    ].join("\n"));
  });

  test("other settings, servers and comments are kept exactly", () => {
    const before = [
      "# Hermes settings",
      "model:",
      "  default: anthropic/claude-opus",
      "",
      "mcp_servers:",
      "    # my servers",
      "    github:",
      '        command: "npx"',
      "        args: [\"-y\", \"@modelcontextprotocol/server-github\"]",
      "",
      "# terminal settings",
      "terminal:",
      "  backend: local",
      "",
    ].join("\n");
    const after = yaml.setMappingChild(before, "mcp_servers", "engram", engram);
    expect(after).toBe([
      "# Hermes settings", "model:", "  default: anthropic/claude-opus", "",
      "mcp_servers:", "    # my servers", "    github:", '        command: "npx"', "        args: [\"-y\", \"@modelcontextprotocol/server-github\"]",
      "    engram:", '      url: "https://engram.example/mcp"', "      headers:", '        Authorization: "Bearer eng_new"',
      "", "# terminal settings", "terminal:", "  backend: local", "",
    ].join("\n"));
    // Running again replaces the entry instead of adding another.
    expect(yaml.setMappingChild(after, "mcp_servers", "engram", engram)).toBe(after);
  });

  test("an existing Engram entry is replaced in place", () => {
    const before = "mcp_servers:\n  engram:\n    url: https://old.example/mcp\n    headers:\n      Authorization: 'Bearer eng_old'\n  other:\n    url: https://other.example/mcp\n";
    const after = yaml.setMappingChild(before, "mcp_servers", "engram", engram);
    expect(after).toBe('mcp_servers:\n  engram:\n    url: "https://engram.example/mcp"\n    headers:\n      Authorization: "Bearer eng_new"\n  other:\n    url: https://other.example/mcp\n');
    expect(yaml.readMappingChild(before, "mcp_servers", "engram").map((line: string) => line.trim())).toEqual(["url: https://old.example/mcp", "headers:", "Authorization: 'Bearer eng_old'"]);
  });

  test("an empty inline value becomes a block", () => {
    for (const empty of ["{}", "null", "~", ""]) {
      expect(yaml.setMappingChild(`model: x\nmcp_servers:${empty ? ` ${empty}` : ""}\n`, "mcp_servers", "engram", engram)).toContain("mcp_servers:\n  engram:\n");
    }
  });

  test("hook lists keep other hooks and replace only Engram's item", () => {
    const before = [
      "hooks:",
      "  pre_llm_call:",
      "    - command: ~/bin/notify.sh",
      "      timeout: 5",
      '    - command: "old/node old/index.js memory hook hermes pre_llm_call"',
      "      timeout: 10",
      "  post_tool_call:",
      "    - matcher: terminal",
      "      command: ~/bin/audit.sh",
      "hooks_auto_accept: false",
      "",
    ].join("\n");
    const after = yaml.setSequenceItem(before, "hooks", "pre_llm_call", managed, hook);
    expect(after).toBe([
      "hooks:", "  pre_llm_call:", "    - command: ~/bin/notify.sh", "      timeout: 5",
      '    - command: "node index.js memory hook hermes pre_llm_call"', "      timeout: 10",
      "  post_tool_call:", "    - matcher: terminal", "      command: ~/bin/audit.sh", "hooks_auto_accept: false", "",
    ].join("\n"));
    expect(yaml.setSequenceItem(after, "hooks", "pre_llm_call", managed, hook)).toBe(after);
  });

  test("indentless lists and missing events are handled", () => {
    const indentless = "hooks:\n  pre_llm_call:\n  - command: ~/bin/notify.sh\n  on_session_start:\n  - command: ~/bin/start.sh\n";
    expect(yaml.setSequenceItem(indentless, "hooks", "pre_llm_call", managed, hook)).toBe(
      'hooks:\n  pre_llm_call:\n  - command: ~/bin/notify.sh\n  - command: "node index.js memory hook hermes pre_llm_call"\n    timeout: 10\n  on_session_start:\n  - command: ~/bin/start.sh\n');
    expect(yaml.setSequenceItem("hooks:\n  on_session_start: []\n", "hooks", "pre_llm_call", managed, hook)).toBe(
      'hooks:\n  on_session_start: []\n  pre_llm_call:\n    - command: "node index.js memory hook hermes pre_llm_call"\n      timeout: 10\n');
    expect(yaml.setSequenceItem("hooks:\n  pre_llm_call: []\n", "hooks", "pre_llm_call", managed, hook)).toBe(
      'hooks:\n  pre_llm_call:\n    - command: "node index.js memory hook hermes pre_llm_call"\n      timeout: 10\n');
  });

  test("layouts it cannot edit safely are refused, never rewritten", () => {
    const refused = [
      "mcp_servers: {github: {command: npx}}\n",
      "mcp_servers: &servers\n  github:\n    command: npx\n",
      "mcp_servers:\n  github: {}\nmcp_servers:\n  other: {}\n",
      "mcp_servers:\n\tgithub: {}\n",
      "mcp_servers:\n  - github\n",
      "---\nmcp_servers:\n  github: {}\n---\nother: 1\n",
    ];
    for (const raw of refused) expect(() => yaml.setMappingChild(raw, "mcp_servers", "engram", engram)).toThrow(/Setup preserved the file/);
    expect(() => yaml.setSequenceItem("hooks:\n  pre_llm_call:\n    command: x\n", "hooks", "pre_llm_call", managed, hook)).toThrow(/not a list/);
    expect(() => yaml.setSequenceItem("hooks:\n  pre_llm_call: [{command: x}]\n", "hooks", "pre_llm_call", managed, hook)).toThrow(/Setup preserved the file/);
  });

  test("scalars read in every quoting style", () => {
    expect(yaml.scalar(' "Bearer eng_\\u0041"')).toBe("Bearer eng_A");
    expect(yaml.scalar(" 'it''s' # note")).toBe("it's");
    expect(yaml.scalar(" https://x.example/mcp # note")).toBe("https://x.example/mcp");
    expect(yaml.quote('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
  });
});
