import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WorkerCommand } from "./worker-command";

const delay = (ms:number) => new Promise<void>(r => setTimeout(r,ms));

// Confirm runtime deletion even if the CLI was killed or disconnected. Returning
// while an unknown worker still runs would release its caller's database lock.
export async function cleanupWorker(spec: WorkerCommand): Promise<void> {
  const removeBootstrap = async () => {
    for (const path of spec.cleanupFiles ?? []) await rm(path,{force:true});
  };
  if (!spec.cleanup) { await removeBootstrap(); return; }
  for (;;) {
    const gone = await new Promise<boolean>(resolve => {
      const p = spawn(spec.cleanup!.command,spec.cleanup!.args,{ env: spec.env, stdio:["ignore","ignore","pipe"] });
      let diagnostic = "";
      p.stderr.on("data", chunk => { if (diagnostic.length < 4096) diagnostic += chunk; });
      const timer = setTimeout(() => p.kill("SIGKILL"),10_000);
      p.on("error", () => { clearTimeout(timer); resolve(false); });
      p.on("close",code => { clearTimeout(timer); resolve(code === 0 || /no such (?:container|object)|(?:sandbox|container).*not found|does not exist/i.test(diagnostic)); });
    });
    if (gone) {
      try { await removeBootstrap(); return; }
      catch { /* Do not release an unconfirmed credential cleanup. */ }
    }
    await delay(1000);
  }
}

// Unlike the SDK's generic stdio launcher, this transport never returns from
// close until the child and its container/sandbox have actually stopped. It also
// supplies an exact environment and a one MiB protocol-buffer limit.
export class WorkerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = new ReadBuffer({maxBufferSize:1024*1024});
  private exited: Promise<void> = Promise.resolve();
  private closed?: Promise<void>;
  private finished?: Promise<void>;
  constructor(private spec: WorkerCommand) {}
  async start() {
    if (this.child) throw new Error("Memory transport already started");
    const p = spawn(this.spec.command,this.spec.args,{cwd:this.spec.cwd,env:this.spec.env,stdio:["pipe","pipe","pipe"],detached:process.platform !== "win32"});
    this.child = p;
    this.exited = new Promise<void>(resolve => { p.once("close",() => { resolve(); void this.finish(); }); p.once("error",() => resolve()); });
    p.stderr.on("data",() => {});
    p.stdin.on("error",() => this.onerror?.(new Error("Memory worker connection failed")));
    p.stdout.on("data",chunk => {
      try { this.buffer.append(chunk); let message; while ((message=this.buffer.readMessage()) !== null) this.onmessage?.(message); }
      catch { this.onerror?.(new Error("Memory worker returned an invalid response")); void this.close(); }
    });
    await new Promise<void>((resolve,reject) => { p.once("spawn",resolve); p.once("error",() => reject(new Error("Memory worker could not start"))); });
  }
  private finish() {
    this.finished ??= cleanupWorker(this.spec).then(() => { this.buffer.clear(); this.onclose?.(); });
    return this.finished;
  }
  async send(message: JSONRPCMessage) {
    if (!this.child?.stdin.writable) throw new Error("Memory worker is disconnected");
    await new Promise<void>((resolve,reject) => this.child!.stdin.write(serializeMessage(message),error => error ? reject(new Error("Memory worker connection failed")) : resolve()));
  }
  close(): Promise<void> {
    this.closed ??= (async () => {
      const p = this.child;
      if (p) {
        p.stdin.end();
        await Promise.race([this.exited,delay(100)]);
        if (p.exitCode === null && p.signalCode === null) {
          try { process.platform === "win32" ? p.kill("SIGTERM") : process.kill(-p.pid!,"SIGTERM"); } catch {}
        }
        await cleanupWorker(this.spec);
        await Promise.race([this.exited,delay(500)]);
        if (p.exitCode === null && p.signalCode === null) {
          try { process.platform === "win32" ? p.kill("SIGKILL") : process.kill(-p.pid!,"SIGKILL"); } catch {}
        }
        await this.exited;
      }
      await this.finish();
    })();
    return this.closed;
  }
}
