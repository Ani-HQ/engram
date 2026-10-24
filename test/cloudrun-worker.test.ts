import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../deploy/cloudrun-worker.py", import.meta.url));

async function run(args: string[]) {
  const child = Bun.spawn(["/usr/bin/python3", wrapper, ...args], { env: { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", DUMMY_SECRET: "must-not-be-logged" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe("Cloud Run capability boundary", () => {
  test("rejects an untrusted initial command with a fixed diagnostic", async () => {
    const result = await run(["/tmp/must-not-be-logged"]);
    expect(result).toEqual({ stdout: "", stderr: "Worker privilege restriction failed\n", code: 70 });
  });

  test.skipIf(process.platform !== "linux")("keeps capabilities zero and NNP set across Python, shell and Bun exec", async () => {
    const javascript = `import {readFileSync} from 'node:fs'; const s=Object.fromEntries(readFileSync('/proc/self/status','utf8').split('\\n').filter(s=>s.includes(':')).map(s=>{const i=s.indexOf(':');return[s.slice(0,i),s.slice(i+1).trim()]})); console.log(JSON.stringify(Object.fromEntries(['CapInh','CapPrm','CapEff','CapAmb','CapBnd','NoNewPrivs'].map(k=>[k,s[k]]))));`;
    const python = `import json,subprocess\nwith open('/proc/self/status') as f: s=dict(line.split(':',1) for line in f if ':' in line)\nfirst={k:s[k].strip() for k in ['CapInh','CapPrm','CapEff','CapAmb','CapBnd','NoNewPrivs']}\nsecond=json.loads(subprocess.check_output(['/bin/sh','-c','exec "$1" --eval "$2"','sh',${JSON.stringify(process.execPath)},${JSON.stringify(javascript)}],text=True))\nprint(json.dumps([first,second]))`;
    const result = await run(["/usr/bin/python3", "-c", python]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    for (const stage of JSON.parse(result.stdout)) {
      for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) expect(BigInt(`0x${stage[key]}`)).toBe(0n);
      expect(stage.NoNewPrivs).toBe("1");
    }
  });
});
