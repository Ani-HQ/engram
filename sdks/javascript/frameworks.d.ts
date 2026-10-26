import type { EngramMemory, MemoryReply, MemoryTask, TaskIdentity } from './index.d.ts';
type MaybePromise<T> = T | Promise<T>;
interface KnownOutcome { status: 'completed' | 'failed'; outcome: string }
interface FrameworkResult<T> { result: T; task: MemoryTask; memory: MemoryReply }
export declare class LangGraphMemoryAdapter<TInput = Record<string, unknown>> {
  constructor(memory: EngramMemory, options: {
    injectContext: (input: TInput, untrustedContext: string) => MaybePromise<TInput>;
    progressLabels?: Record<string, string>;
  });
  prepare(input: TInput, identity: TaskIdentity, query?: string): Promise<{ task: MemoryTask; input: TInput; memory: MemoryReply }>;
  run<TResult>(graph: { invoke(input: TInput, config?: unknown): Promise<TResult> }, input: TInput, options: {
    identity: TaskIdentity; query?: string; config?: unknown; outcome?: (result: TResult) => MaybePromise<KnownOutcome | null>;
  }): Promise<FrameworkResult<TResult>>;
  stream(graph: { stream(input: TInput, config?: unknown): MaybePromise<AsyncIterable<unknown>> }, input: TInput, options: {
    identity: TaskIdentity; query?: string; config?: Record<string, unknown>; outcome?: (lastEvent: unknown) => MaybePromise<KnownOutcome | null>;
  }): AsyncGenerator<unknown>;
}
export declare function createAdkMemoryPlugin(memory: EngramMemory, options: {
  identify: (invocation: unknown) => MaybePromise<TaskIdentity & { query?: string }>;
  injectContext: (invocation: unknown, untrustedContext: string) => MaybePromise<void>;
  progressLabels?: Record<string, string>;
  outcome?: (invocation: unknown) => MaybePromise<KnownOutcome | null>;
  BasePlugin?: new (name: string) => unknown;
}): Promise<unknown>;
export declare function runWithMemory<TInput, TResult>(memory: EngramMemory, options: {
  identity: TaskIdentity; query?: string; input: TInput;
  injectContext: (input: TInput, context: string) => MaybePromise<TInput>;
  invoke: (input: TInput, task: MemoryTask) => MaybePromise<TResult>;
  outcome?: (result: TResult) => MaybePromise<KnownOutcome | null>;
}): Promise<FrameworkResult<TResult>>;
