import { mkdirSync, realpathSync, writeFileSync, rmSync, chmodSync, chownSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";

export const workerSettings = {
  isolation: process.env.ENGRAM_WORKER_ISOLATION ?? (config.deploymentMode === "hosted" ? "cloudrun" : "process"),
  sandboxBin: process.env.ENGRAM_SANDBOX_BIN ?? "/usr/local/gcp/bin/sandbox",
  image: process.env.ENGRAM_WORKER_IMAGE ?? "",
  network: process.env.ENGRAM_WORKER_NETWORK ?? "engram-workers",
  maxWorkers: Math.floor(Math.min(16, Math.max(1, Number(process.env.ENGRAM_MAX_BRAIN_WORKERS) || 2))),
  maxCalls: 2,
};
if (!["process", "docker", "cloudrun"].includes(workerSettings.isolation)) throw new Error("Invalid worker isolation mode");
if (config.deploymentMode === "hosted" && workerSettings.isolation === "process") throw new Error("Hosted workspaces require isolated workers");
if (workerSettings.isolation === "docker" && !workerSettings.image) throw new Error("ENGRAM_WORKER_IMAGE is required for container workers");

export interface WorkerCommand { command: string; args: string[]; env: Record<string, string>; cwd: string; cleanup?: { command: string; args: string[] }; cleanupFiles?: string[] }
export function workerCommand(homeDir: string, args: string[], env: Record<string, string>): WorkerCommand {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(homeDir)) throw new Error("Invalid worker home binding");
  mkdirSync(resolve(config.gbrainHomesDir), { recursive: true, mode: 0o700 });
  const root = realpathSync(resolve(config.gbrainHomesDir));
  const home = resolve(root, homeDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (realpathSync(home) !== home) throw new Error("Worker homes must not traverse symlinks");
  if (workerSettings.isolation === "process") return { command: config.gbrainBin, args, env, cwd: home };
  const safeEnv = { ...env, HOME: "/gbrain-work", GBRAIN_HOME: "/gbrain-work", TMPDIR: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin" };
  const runtimeName = `engram-${randomUUID()}`;
  if (workerSettings.isolation === "docker") {
    // The internal Docker network has a database/proxy, but no external egress.
    // Provider analysis remains in the consent-aware gateway worker.
    delete safeEnv.VOYAGE_API_KEY;
    return {
      command: "docker",
      args: ["run", "--rm", "--name", runtimeName, "--init", "-i", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", "--cpus=1", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--network", workerSettings.network, "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=bind,source=${home},target=/gbrain-work`, "--workdir", "/gbrain-work", ...Object.keys(safeEnv).flatMap(k => ["--env", k]), "--entrypoint", "/usr/local/bin/worker-entrypoint", workerSettings.image, ...args],
      env: { ...safeEnv, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}) }, cwd: home,
      cleanup: {command:"docker",args:["rm","--force",runtimeName]},
    };
  }
  // Cloud Run supplies a PID and metadata boundary. Mask the host's complete
  // tenant home tree before exposing only this workspace at another path.
  // The sandbox helper logs argv. Credentials travel only through this private,
  // single-use file; the worker consumes it without touching the MCP stream.
  // Cloud Run's network launcher needs root. Its jail cannot switch UIDs, so
  // the trusted wrapper clears active capabilities and locks privilege gains.
  // Match the bound directory to the jail identity without granting access to
  // any other parent files or tenant homes.
  if (process.getuid?.() === 0) {
    chownSync(home, 0, process.getgid?.() ?? 0);
  }
  chmodSync(home, 0o700);
  const temporary = resolve(home, ".tmp");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  if (realpathSync(temporary) !== temporary) throw new Error("Worker temporary directories must not traverse symlinks");
  if (process.getuid?.() === 0) chownSync(temporary, 0, process.getgid?.() ?? 0);
  chmodSync(temporary, 0o700);
  safeEnv.TMPDIR = "/gbrain-work/.tmp";
  const credentialName = `.engram-worker-env-${randomUUID()}.json`;
  const credentialFile = resolve(home, credentialName);
  try {
    writeFileSync(credentialFile, JSON.stringify(safeEnv), { flag: "wx", mode: 0o600 });
  }
  catch {
    rmSync(credentialFile, { force: true });
    throw new Error("Worker environment could not be prepared");
  }
  const masked = ["/root", "/home", "/run", "/tmp", "/app"];
  // A masked ancestor already hides all homes. Avoid creating a nested mount
  // target under a read-only empty parent, which some runtimes reject.
  if (!masked.some(parent => root === parent || root.startsWith(`${parent}/`))) masked.push(root);
  return {
    command: workerSettings.sandboxBin,
    args: ["do", "--sandbox-name", runtimeName, "--workdir", "/gbrain-work", "--write", "--allow-egress", ...masked.flatMap(path => ["--mount", `type=bind,source=/sandbox-empty,destination=${path},readonly`]), "--mount", `type=bind,source=${home},destination=/gbrain-work`, "--", "/usr/local/bin/cloudrun-worker", "/usr/local/bin/worker-entrypoint", "--engram-env-file", `/gbrain-work/${credentialName}`, ...args],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, cwd: home,
    cleanup: {command:workerSettings.sandboxBin,args:["delete","--force",runtimeName]},
    cleanupFiles: [credentialFile],
  };
}
