import { config } from "../config";
import { createHash } from "node:crypto";
import { currentOrg } from "../context";
import { jevAllowed } from "../privacy";
import { retryDelayMs } from "./retry";
import { validateAnswers } from "./answers";
import { sanitizeProviderInput } from "./sanitize";
import { reserveWorkspaceInference } from "../insights-budget";
import { readAiResponse } from "./http";
import { reserveJevCall, settleJevCall, failJevCall } from "../jev";
import { isJevModel, jevModelMatches } from "../jev-model";
import type { ReflexAnswer, ReflexClient, ReflexQuestion, ReflexResult, ReflexTask, ReflexTransport } from "./types";

const CIRCUIT_AFTER = 5;
const CIRCUIT_MS = 10 * 60 * 1000;
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function safeJevEndpoint(raw: string, hosted = config.deploymentMode === "hosted"): string | null {
  try {
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    if (hosted) return url.href === JEV_ENDPOINT ? JEV_ENDPOINT : null;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch { return null; }
}

function reportedUsage(value: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return Number.isSafeInteger(raw.input_tokens) && Number(raw.input_tokens) >= 0 && Number(raw.input_tokens) <= 1_000_000
    && Number.isSafeInteger(raw.output_tokens) && Number(raw.output_tokens) >= 0 && Number(raw.output_tokens) <= 1_000_000
    ? { inputTokens: Number(raw.input_tokens), outputTokens: Number(raw.output_tokens) } : null;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TypesafeReflexClient implements ReflexClient {
  private static inFlight = 0;
  private hardDisabled = false;
  private circuitOpenUntil = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly transport: ReflexTransport = fetch,
    private readonly now: () => number = Date.now,
    private readonly opts: { apiKey?: string; model?: string; endpoint?: string; timeoutMs?: number; maxAttempts?: number; operationId?: string } = {},
  ) {}

  enabled(): boolean {
    // Explicitly injected clients are also used by isolated transport tests.
    // Every actual workspace request, including background jobs, needs consent.
    if (currentOrg() && !jevAllowed()) return false;
    if (config.deploymentMode === "hosted" && !currentOrg()) return false;
    if (!currentOrg() && this.opts.apiKey === undefined) return false;
    if (!isJevModel(this.opts.model ?? config.reflex.model)) return false;
    return Boolean(this.opts.apiKey ?? config.reflex.apiKey) && safeJevEndpoint(this.opts.endpoint ?? config.reflex.endpoint) !== null;
  }

  available(): boolean {
    return this.enabled() && !this.hardDisabled && this.now() >= this.circuitOpenUntil;
  }

  reset(): void {
    this.hardDisabled = false;
    this.circuitOpenUntil = 0;
    this.consecutiveFailures = 0;
  }

  async evaluate(input: {
    state: unknown;
    questions: Record<string, ReflexQuestion>;
    signal?: AbortSignal;
    maxAttempts?: number;
    task?: ReflexTask;
    operationKey?: string;
  }): Promise<ReflexResult | null> {
    if (!this.available()) return null;
    const key = this.opts.apiKey ?? config.reflex.apiKey;
    const hosted = config.deploymentMode === "hosted";
    // A timed-out hosted request can still have incurred provider cost. A new
    // user operation may request new work; this call never silently replays it.
    const maxAttempts = hosted ? 1 : Math.max(1, Math.min(3, input.maxAttempts ?? this.opts.maxAttempts ?? 3));
    const requestedModel = this.opts.model ?? config.reflex.model;
    const endpoint = safeJevEndpoint(this.opts.endpoint ?? config.reflex.endpoint);
    if (!endpoint) return null;
    // Bound and redact every outbound memory path, including pre-existing tasks.
    const safeInput = sanitizeProviderInput({ state: input.state, questions: input.questions }) as { state: unknown; questions: unknown };
    if (JSON.stringify(safeInput).length > 32_000 || Object.keys(input.questions).length > 32) return null;
    const body = JSON.stringify({ state: safeInput.state, model: requestedModel, questions: safeInput.questions });
    if (this.opts.operationId !== undefined && !/^[a-zA-Z0-9:_-]{1,140}$/.test(this.opts.operationId)) return null;
    const operationId = this.opts.operationId === undefined ? undefined
      : `${this.opts.operationId}:${input.task ?? "evaluation"}:${createHash("sha256").update(input.operationKey ?? input.task ?? "evaluation").digest("hex")}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal?.aborted) return null;
      if (TypesafeReflexClient.inFlight >= Math.min(32, Math.max(1, config.reflex.concurrency))) return null;
      TypesafeReflexClient.inFlight++;
      let reservation: { id: string } | null = null;
      let accounted = false;
      const fail = async (reason: "timeout" | "network" | "http_error" | "invalid_usage" | "aborted") => {
        if (!reservation || accounted) return;
        accounted = true;
        await failJevCall(reservation.id, reason);
      };
      try {
        const org = currentOrg();
        if (hosted) {
          if (!org) return null;
          reservation = await reserveJevCall({ orgId: org.id, model: requestedModel, task: input.task ?? "evaluation", operationId });
          if (!reservation) return null;
        } else if (this.opts.apiKey === undefined && (!org || !await reserveWorkspaceInference(org.id, undefined, "jev"))) return null;
        if (input.signal?.aborted) { await fail("aborted"); return null; }
        const res = await this.transport(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body,
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(this.opts.timeoutMs ?? config.reflex.timeoutMs)]) : AbortSignal.timeout(this.opts.timeoutMs ?? config.reflex.timeoutMs),
        });
        if (!res.ok) await fail("http_error");
        if (res.status === 401) { await res.body?.cancel(); this.markFail("HTTP 401", true); return null; }
        if (this.shouldRetry(res.status) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = retryDelayMs(attempt, Number.isFinite(retryAfter) ? retryAfter : undefined);
          console.warn(`[reflex] HTTP ${res.status}, retry in ${Math.round(delay / 1000)}s`);
          this.markFail(`HTTP ${res.status}`);
          await res.body?.cancel();
          if (!this.available()) return null;
          await sleep(delay);
          continue;
        }
        if (!res.ok) {
          // Provider error bodies can echo tenant inputs. Never log them.
          console.warn(`[reflex] HTTP ${res.status}`);
          this.markFail(`HTTP ${res.status}`);
          await res.body?.cancel();
          return null;
        }
        let json: { model?: string; answers?: Record<string, ReflexAnswer>; usage?: unknown };
        try { json = JSON.parse(await readAiResponse(res, 128_000)); }
        catch (error) { await fail(input.signal?.aborted ? "aborted" : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "invalid_usage"); this.markFail("invalid response"); return null; }
        const usage = reportedUsage(json?.usage);
        const reported = isJevModel(json?.model);
        if (!usage || !reported) { await fail("invalid_usage"); this.markFail("invalid usage"); return null; }
        // Meter the actual provider work even if its answers cannot be used.
        // The ledger independently validates alias resolution or an exact pin.
        if (reservation) {
          const settled = await settleJevCall(reservation.id, { model: json.model!, ...usage });
          accounted = true;
          if (!settled) { this.markFail("usage unavailable"); return null; }
        }
        if (!jevModelMatches(requestedModel, json.model)) { this.markFail("model mismatch"); return null; }
        const answers = validateAnswers(json.answers, input.questions);
        if (!answers) {
          this.markFail("invalid answers");
          return null;
        }
        this.markOk();
        return { model: json.model!, requestedModel, modelReported: true, answers, usage };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        try { await fail(input.signal?.aborted ? "aborted" : timedOut ? "timeout" : "network"); } catch { /* Reserved cost remains held for operator reconciliation. */ }
        if (input.signal?.aborted) return null;
        if (timedOut && attempt < maxAttempts) {
          console.warn("[reflex] timeout (retrying)");
          continue;
        }
        console.warn("[reflex] request failed");
        this.markFail(timedOut ? "timeout" : "request failed");
        return null;
      } finally {
        TypesafeReflexClient.inFlight--;
      }
    }
    return null;
  }

  private shouldRetry(status: number) {
    return status === 429 || status === 529;
  }

  private markOk() {
    this.consecutiveFailures = 0;
  }

  private markFail(why: string, fatal = false) {
    if (fatal) {
      this.hardDisabled = true;
      console.warn(`[reflex] disabled this process (${why})`);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_AFTER) {
      this.circuitOpenUntil = this.now() + CIRCUIT_MS;
      this.consecutiveFailures = 0;
      console.warn(`[reflex] circuit open 10m (${why})`);
    }
  }
}

let shared: TypesafeReflexClient | null = null;

export function reflexClient(): TypesafeReflexClient {
  if (!shared) shared = new TypesafeReflexClient();
  return shared;
}

export function resetReflexClient(client?: TypesafeReflexClient) {
  shared = client ?? new TypesafeReflexClient();
  return shared;
}
