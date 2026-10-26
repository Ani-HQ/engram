export interface MemoryReply {
  ok: boolean; status: string; runId?: string; context?: string; contextBytes?: number;
  contextBudgetBytes?: number; duplicate?: boolean; result?: Record<string, unknown>;
  receipt?: { slug: string }; verification?: Record<string, unknown>;
  started?: boolean; ended?: boolean; canWrite?: boolean; reporting?: boolean; reports?: Record<string, unknown>; decisions?: Record<string, unknown>;
}
export interface TaskIdentity { runtime?: string; sessionId: string; taskId: string; title?: string }
export declare const SDK_VERSION: string;
export declare const READ_TOOLS: readonly string[];
export declare const CAPABILITIES: readonly string[];
export declare class EngramMemory {
  constructor(options: { host?: string; token?: string; project: string; budgetBytes?: number;
    stateDirectory?: string; fetchImpl?: typeof fetch; timeoutMs?: number; canWrite?: boolean; reporting?: boolean });
  task(identity: TaskIdentity): MemoryTask;
}
export declare class MemoryTask {
  readonly runId: string;
  start(options?: { query?: string }): Promise<MemoryReply>;
  callMcp(name: string, args?: Record<string, unknown>): Promise<MemoryReply>;
  progress(progressId: string, currentStep: string): Promise<MemoryReply>;
  decision(deltaId: string, text: string, options?: { kind?: 'decision' | 'correction' | 'constraint' | 'handoff'; topic?: string }): Promise<MemoryReply>;
  noChange(): Promise<MemoryReply>;
  end(status: 'completed' | 'failed', outcome: string): Promise<MemoryReply>;
  status(): Promise<MemoryReply>;
  beginVerification(): Promise<MemoryReply>;
  verificationStatus(): Promise<MemoryReply>;
}
