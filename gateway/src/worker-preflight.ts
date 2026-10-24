import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { workerCommand, workerSettings } from "./worker-command";
import { cleanupWorker } from "./worker-transport";

async function execute(command: string, args: string[], env: Record<string,string>, cwd?: string) {
  return new Promise<string>((resolve,reject) => {
    const p = spawn(command,args,{env,cwd,stdio:["ignore","pipe","ignore"]});
    let result = "";
    p.stdout.on("data", chunk => { if (result.length < 8192) result += chunk; });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Worker isolation preflight timed out")); },30_000);
    p.on("error", () => { clearTimeout(timeout); reject(new Error("Worker isolation runtime is unavailable")); });
    p.on("close", code => { clearTimeout(timeout); code === 0 ? resolve(result) : reject(new Error("Worker isolation preflight failed")); });
  });
}

// Run before opening the HTTP listener. Unsupported/disabled sandbox facilities
// cannot silently turn a hosted installation into a shared process deployment.
export async function verifyWorkerIsolation(): Promise<void> {
  if (workerSettings.isolation === "process") return;
  if (workerSettings.isolation === "docker") {
    const raw = await execute("docker",["network","inspect",workerSettings.network,"--format","{{.Internal}}"],{ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(process.env.DOCKER_HOST ? {DOCKER_HOST:process.env.DOCKER_HOST} : {}) });
    if (raw.trim() !== "true") throw new Error("Worker Docker network must be internal");
  }
  mkdirSync(config.gbrainHomesDir,{recursive:true,mode:0o700});
  const root = realpathSync(config.gbrainHomesDir), name = `preflight-${randomUUID()}`;
  const marker = join(root,`${name}-other`);
  const markers = [marker, ...(workerSettings.isolation === "cloudrun" ? ["/root","/home","/run","/tmp"].map(directory => join(directory,`.engram-${name}`)) : [])];
  for (const path of markers) writeFileSync(path,"private-workspace-marker",{mode:0o600});
  const spec = workerCommand(name,[],{});
  const capabilityCheck = workerSettings.isolation === "cloudrun" ? `status = dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert status['NoNewPrivs'].strip() == '1'
assert all(int(status[key].strip(),16) == 0 for key in ['CapInh','CapPrm','CapEff','CapAmb'])
assert int(status['CapBnd'].strip(),16) & ~0x20000420 == 0
` : "";
  const probe = `import os, pathlib, urllib.request
${capabilityCheck}assert all(not pathlib.Path(path).exists() for path in ${JSON.stringify(markers)})
assert 'ENGRAM_DB_URL_TEMPLATE' not in os.environ
assert 'ENGRAM_PROVISIONER_DB_URL_TEMPLATE' not in os.environ
for p in pathlib.Path('/proc').glob('[0-9]*/environ'):
 try: data=p.read_bytes()
 except OSError: continue
 assert b'ENGRAM_DB_URL_TEMPLATE=' not in data and b'ENGRAM_TENANT_CREDENTIAL_KEY=' not in data and b'ENGRAM_PROVISIONER_DB_URL_TEMPLATE=' not in data
req=urllib.request.Request('http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',headers={'Metadata-Flavor':'Google'})
try:
 response=urllib.request.urlopen(req,timeout=2)
 assert response.status != 200
except (OSError, urllib.error.URLError): pass
print('isolated')
`;
  if (workerSettings.isolation === "docker") {
    const i = spec.args.indexOf("--entrypoint");
    spec.args[i+1] = "/usr/bin/python3";
  } else {
    const i = spec.args.indexOf("/usr/local/bin/worker-entrypoint");
    if (i < 0) throw new Error("Worker isolation command is invalid");
    spec.args.splice(i,spec.args.length-i,"/usr/bin/python3");
  }
  spec.args.push("-c",probe);
  try {
    const result = await execute(spec.command,spec.args,spec.env,spec.cwd);
    if (result.trim() !== "isolated") throw new Error("Worker isolation preflight failed");
  } finally {
    // A killed launcher can leave its runtime alive. Confirm deletion before
    // removing the probe's home or accepting any tenant requests.
    await cleanupWorker(spec);
    for (const path of markers) rmSync(path,{force:true});
    rmSync(join(root,name),{recursive:true,force:true});
  }
}
