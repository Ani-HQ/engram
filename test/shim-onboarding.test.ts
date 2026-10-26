import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const onboarding = require("../shim/onboarding.js");
const shim = require("../shim/index.js");
const cli = path.resolve(import.meta.dir, "../shim/index.js");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "engram-onboarding-"));
const token = "eng_fixture-onboarding-secret-never-real";
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function home() { return mkdtempSync(path.join(fixtureRoot, "home-")); }
function environment(root: string, extra = {}) {
  return { ...process.env, HOME: root, ENGRAM_HOST: "", ENGRAM_TOKEN: "", XDG_CACHE_HOME: path.join(root, "cache"), ...extra };
}
async function run(args: string[], root: string, extra = {}, input = "") {
  const child = Bun.spawn(["node", cli, ...args], { env: environment(root, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stdout + stderr).not.toContain(token);
  return { code, stdout, stderr };
}
function server(options: { identityStatus?: number; malformed?: boolean; catalog?: any[]; identity?: string; redirect?: boolean } = {}) {
  const requests: { method: string; name?: string; auth: string | null; agent: string | null }[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const value = await req.json() as any;
    requests.push({ method: value.method, name: value.params?.name, auth: req.headers.get("Authorization"), agent: req.headers.get("User-Agent") });
    if (options.redirect) return new Response(null, { status: 302, headers: { Location: "https://must-not-follow.invalid/mcp" } });
    if (options.identityStatus) return new Response("private error details must not be printed", { status: options.identityStatus });
    if (options.malformed) return new Response("<html>proxy injection</html>");
    if (value.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: value.id, result: { content: [{ type: "text", text: JSON.stringify({ token: options.identity || "fixture-codex" }) }] } });
    return Response.json({ jsonrpc: "2.0", id: value.id, result: { tools: options.catalog || ["whoami", "recall", "remember"].map(name => ({ name, inputSchema: { type: "object" } })) } });
  } });
  return { service, requests, host: service.url.origin };
}

describe("onboarding endpoint and credential safety", () => {
  test("accepts canonical HTTPS or loopback HTTP without duplicate mcp paths", () => {
    expect(onboarding.endpointForHost("https://engram.ani.computer/mcp/")).toEqual({ endpoint: "https://engram.ani.computer/mcp", host: "https://engram.ani.computer" });
    expect(onboarding.endpointForHost("http://localhost:9000/").endpoint).toBe("http://localhost:9000/mcp");
    expect(onboarding.endpointForHost("http://[::1]:9000/mcp").endpoint).toBe("http://[::1]:9000/mcp");
    expect(onboarding.endpointForHost("https://example.com/engram/").endpoint).toBe("https://example.com/engram/mcp");
    expect(onboarding.endpointForHost(" \nhttps://example.com/mcp\t ").endpoint).toBe("https://example.com/mcp");
    for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/#secret", "file:///tmp/config", "https://foo\nbar.example", "https://foo\tbar.example", "https://example.com/a b", "https://example.com/\u0000path"]) {
      expect(() => onboarding.endpointForHost(value)).toThrow();
    }
  });

  test("noninteractive missing inputs and argv secrets fail promptly without mutation", async () => {
    const root = home();
    expect((await run(["setup"], root)).code).toBe(1);
    expect((await run(["setup", "codex"], root)).stderr).toContain("hidden prompt");
    expect((await run(["setup", "codex", "--token", token], root)).stderr).toContain("command history");
    expect(readdirSync(root)).toEqual([]);
  });

  test("bad remote URLs fail before transmitting or writing credentials", async () => {
    const root = home();
    const result = await run(["setup", "cursor", "--host", "http://example.com"], root, { ENGRAM_TOKEN: token });
    expect(result.code).toBe(1); expect(result.stderr).toContain("requires HTTPS"); expect(readdirSync(root)).toEqual([]);
  });

  test("denied, injected HTML, invalid catalog, and redirected endpoints never mutate config", async () => {
    for (const options of [{ identityStatus: 401 }, { identityStatus: 403 }, { malformed: true }, { catalog: [{ name: "remember" }] }, { redirect: true }]) {
      const root = home(), upstream = server(options);
      try {
        const result = await run(["setup", "codex", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
        expect(result.code).toBe(1); expect(result.stdout).not.toContain("is configured"); expect(result.stderr).not.toContain("private error"); expect(readdirSync(root)).toEqual([]);
        expect(upstream.requests.every(row => row.method === "tools/list" || row.name === "whoami")).toBe(true);
      } finally { upstream.service.stop(true); }
    }
  });
});

describe("real CLI setup and read-only verification", () => {
  test("piped setup preserves unrelated JSON, writes private config/cache and keeps every backup", async () => {
    const root = home(), upstream = server();
    const file = path.join(root, ".cursor", "mcp.json");
    mkdirSync(path.dirname(file));
    const original = JSON.stringify({ theme: "keep", mcpServers: { unrelated: { command: "keep-me" }, engram: { url: "https://old.invalid/mcp" } } });
    writeFileSync(file, original); chmodSync(file, 0o640);
    try {
      const args = ["setup", "cursor", "--host", upstream.host, "--token-stdin"];
      const result = await run(args, root, {}, token + "\n");
      expect(result.code).toBe(0); expect(result.stdout).toContain("Authenticated as fixture-codex");
      expect(result.stdout).toContain("have not been tested"); expect(result.stdout).toContain("do not prove");
      expect(result.stdout).toContain("engram-check-"); expect(result.stdout).toContain(file);
      const config = JSON.parse(readFileSync(file, "utf8"));
      expect(config.theme).toBe("keep"); expect(config.mcpServers.unrelated.command).toBe("keep-me");
      expect(config.mcpServers.engram.headers.Authorization).toBe(`Bearer ${token}`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file + ".engram-backup", "utf8")).toBe(original);
      expect(statSync(file + ".engram-backup").mode & 0o777).toBe(0o600);
      expect((await run(args, root, {}, token)).code).toBe(0);
      expect(readFileSync(file + ".engram-backup", "utf8")).toBe(original);
      expect(readdirSync(path.dirname(file)).filter(name => name.includes("engram-backup"))).toHaveLength(2);
      expect(upstream.requests.map(row => [row.method, row.name])).toEqual([["tools/call", "whoami"], ["tools/list", undefined], ["tools/call", "whoami"], ["tools/list", undefined]]);
      expect(upstream.requests.every(row => row.auth === `Bearer ${token}` && row.agent?.startsWith("engram-mcp-onboarding/"))).toBe(true);
      const cached = readdirSync(path.join(root, "cache", "engram-mcp")); expect(cached).toHaveLength(1);
      expect(readFileSync(path.join(root, "cache", "engram-mcp", cached[0]), "utf8")).not.toContain(token);
    } finally { upstream.service.stop(true); }
  });

  test("doctor reads setup’s Codex config and performs only identity/catalog requests without writes", async () => {
    const root = home(), upstream = server();
    const codexDir = path.join(root, ".codex"); mkdirSync(codexDir);
    const original = 'model = "keep-model"\ndeveloper_instructions = """\nKeep example text:\n[mcp_servers.engram]\nurl = "https://instruction-example.invalid/mcp"\n"""\n[mcp_servers.other]\ncommand = "keep-other"\n[mcp_servers.engram] # see [example]\nurl = "https://old.invalid/mcp"\n[mcp_servers.engram.http_headers]\nAuthorization = "Bearer old-fixture"\n[[agents]]\nname = "keep-array"\n[projects."/a/project"]\ntrust_level = "trusted"\n';
    writeFileSync(path.join(codexDir, "config.toml"), original, { mode: 0o600 });
    try {
      const result = await run(["setup", "codex", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
      expect(result.code).toBe(0);
      const file = path.join(root, ".codex", "config.toml");
      const before = readFileSync(file, "utf8"), files = readdirSync(path.dirname(file)), cache = readdirSync(path.join(root, "cache", "engram-mcp"));
      expect(before).toContain('model = "keep-model"'); expect(before).toContain('command = "keep-other"'); expect(before).toContain('[projects."/a/project"]');
      expect(before).toContain('url = "https://instruction-example.invalid/mcp"'); expect(before).toContain('name = "keep-array"');
      expect(before).not.toContain("old-fixture"); expect(readFileSync(file + ".engram-backup", "utf8")).toBe(original);
      const checked = await run(["doctor", "codex"], root);
      expect(checked.code).toBe(0); expect(checked.stdout).toContain("Live access passed"); expect(checked.stdout).toContain("does not prove your agent");
      expect(readFileSync(file, "utf8")).toBe(before); expect(readdirSync(path.dirname(file))).toEqual(files); expect(readdirSync(path.join(root, "cache", "engram-mcp"))).toEqual(cache);
      expect(upstream.requests.every(row => row.method === "tools/list" || row.name === "whoami")).toBe(true);
    } finally { upstream.service.stop(true); }
  });

  test("doctor --host never forwards a different endpoint’s saved credential", async () => {
    const root = home(), original = server(), other = server();
    try {
      expect((await run(["setup", "codex", "--host", original.host], root, { ENGRAM_TOKEN: token })).code).toBe(0);
      const result = await run(["doctor", "codex", "--host", other.host], root);
      expect(result.code).toBe(1); expect(other.requests).toEqual([]);
    } finally { original.service.stop(true); other.service.stop(true); }
  });

  test("verify without a harness checks an env token without creating config or cache", async () => {
    const root = home(), upstream = server({ identity: `fixture\u001b[31m-${token}` });
    try {
      const result = await run(["verify", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
      expect(result.code).toBe(0); expect(result.stdout).not.toContain("\u001b"); expect(readdirSync(root)).toEqual([]);
    } finally { upstream.service.stop(true); }
  });

  test("setup Claude uses native HTTP config even without a Claude binary", async () => {
    const root = home(), upstream = server();
    try {
      const result = await run(["setup", "claude", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(path.join(root, ".claude.json"), "utf8")).mcpServers.engram).toEqual({ type: "http", url: upstream.host + "/mcp", headers: { Authorization: `Bearer ${token}` } });
    } finally { upstream.service.stop(true); }
  });

  test("malformed config roots and symlinks are reported as partial failures without overwriting", async () => {
    const upstream = server();
    try {
      for (const content of [`{"mcpServers": []}`, `{"mcpServers": "${token}"}`, `{bad JSON ${token}`]) {
        const root = home(), dir = path.join(root, ".cursor"); mkdirSync(dir); const file = path.join(dir, "mcp.json"); writeFileSync(file, content);
        const result = await run(["setup", "cursor", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
        expect(result.code).toBe(1); expect(result.stdout).not.toContain("is configured"); expect(readFileSync(file, "utf8")).toBe(content); expect(readdirSync(dir)).toEqual(["mcp.json"]);
      }
      const root = home(), dir = path.join(root, ".cursor"); mkdirSync(dir); const linked = path.join(root, "dotfiles.json"); writeFileSync(linked, "{}"); symlinkSync(linked, path.join(dir, "mcp.json"));
      const result = await run(["setup", "cursor", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
      expect(result.code).toBe(1); expect(result.stderr).toContain("symbolic link"); expect(readFileSync(linked, "utf8")).toBe("{}");
    } finally { upstream.service.stop(true); }
  });

  test("an ancestor link beneath home cannot redirect config or backups into dotfiles", async () => {
    const root = home(), upstream = server();
    const linked = path.join(root, "dotfiles"), targetDir = path.join(linked, "windsurf");
    mkdirSync(targetDir, { recursive: true });
    const file = path.join(targetDir, "mcp_config.json"), original = '{"mcpServers":{"keep":{"command":"keep"}}}';
    writeFileSync(file, original);
    symlinkSync(linked, path.join(root, ".codeium"));
    try {
      const result = await run(["setup", "windsurf", "--host", upstream.host], root, { ENGRAM_TOKEN: token });
      expect(result.code).toBe(1); expect(result.stderr).toContain("symbolic link");
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(readdirSync(targetDir)).toEqual(["mcp_config.json"]);
      expect(existsSync(path.join(root, "cache"))).toBe(false);
    } finally { upstream.service.stop(true); }
  });

  test("atomic config writes preserve owner-only permissions and never overwrite backups", () => {
    const root = home(), file = path.join(root, "config.json"); writeFileSync(file, "before", { mode: 0o600 });
    shim.backupAndWrite(file, "after");
    expect(readFileSync(file, "utf8")).toBe("after"); expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).some(name => name.endsWith(".tmp"))).toBe(false);
  });
});

const ptyProgram = String.raw`
import json, os, pty, select, signal, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", sys.argv[1], "setup"])
received = b""
def until(marker):
    global received
    deadline = time.time() + 8
    while marker not in received:
        if time.time() > deadline: raise RuntimeError("PTY prompt timed out: " + repr(marker))
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: chunk = os.read(fd, 4096)
            except OSError: break
            if not chunk: break
            received += chunk
    if marker not in received: raise RuntimeError("PTY ended before prompt: " + repr(marker))
try:
    until(b"Which agent?")
    os.write(fd, b"2\r")
    until(b"Project folder")
    os.write(fd, os.environ["HOME"].encode() + b"\r")
    until(b"Memory topic")
    os.write(fd, b"Fixture project\r")
    until(b"Where is your memory?")
    os.write(fd, b"2\r")
    until(b"Your Engram base URL:")
    os.write(fd, sys.argv[2].encode() + b"\r")
    until(b"Access token (hidden; paste, then press Enter):")
    os.write(fd, os.environ["FIXTURE_TYPED_TOKEN"].encode() + (b"\x03" if os.environ.get("FIXTURE_CANCEL") else b"\r"))
    deadline = time.time() + 8
    status = None
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: chunk = os.read(fd, 4096)
            except OSError: chunk = b""
            if chunk: received += chunk
        child, result = os.waitpid(pid, os.WNOHANG)
        if child:
            status = os.waitstatus_to_exitcode(result)
            break
    if status is None: raise RuntimeError("PTY command did not exit")
    print(json.dumps({"code": status, "output": received.decode(errors="replace"), "echo_restored": bool(termios.tcgetattr(fd)[3] & termios.ECHO)}))
finally:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(fd)
`;

describe("real terminal onboarding", () => {
  test("TTY agent selection and hidden token paste connect without ever echoing the credential", async () => {
    const root = home(), upstream = server();
    try {
      const child = Bun.spawn(["python3", "-c", ptyProgram, cli, upstream.host], { env: environment(root, { FIXTURE_TYPED_TOKEN: token }), stdout: "pipe", stderr: "pipe" });
      const [code, raw, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, error).toBe(0);
      const result = JSON.parse(raw); expect(result.output).not.toContain(token); expect(result.code).toBe(0);
      expect(result.echo_restored).toBe(true);
      expect(result.output).toContain("Engram is configured"); expect(existsSync(path.join(root, ".codex", "config.toml"))).toBe(true);
    } finally { upstream.service.stop(true); }
  }, 15000);

  test("Ctrl-C during hidden input restores terminal and exits without network or config writes", async () => {
    const root = home(), upstream = server();
    try {
      const child = Bun.spawn(["python3", "-c", ptyProgram, cli, upstream.host], { env: environment(root, { FIXTURE_TYPED_TOKEN: token, FIXTURE_CANCEL: "1" }), stdout: "pipe", stderr: "pipe" });
      const [code, raw, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, error).toBe(0);
      const result = JSON.parse(raw); expect(result.output).not.toContain(token); expect(result.code).toBe(1); expect(result.output).toContain("Cancelled");
      expect(result.echo_restored).toBe(true);
      expect(upstream.requests).toEqual([]); expect(readdirSync(root)).toEqual([]);
    } finally { upstream.service.stop(true); }
  }, 15000);
});
