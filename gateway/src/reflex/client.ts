import { config } from "../config";
import { currentOrg } from "../context";
import { externalAiAllowed } from "../privacy";
import { retryDelayMs } from "./retry";
import { validateAnswers } from "./answers";
import { sanitizeProviderInput } from "./sanitize";
import { reserveWorkspaceInference } from "../insights-budget";
import { readAiResponse } from "./http";
import type { ReflexAnswer, ReflexClient, ReflexQuestion, ReflexResult, ReflexTransport } from "./types";

const CIRCUIT_AFTER = 5;
const CIRCUIT_MS = 10 * 60 * 1000;

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
    private readonly opts: { apiKey?: string; model?: string; endpoint?: string; timeoutMs?: number; maxAttempts?: number } = {},
  ) {}

  enabled(): boolean {
    // Explicitly injected clients are also used by isolated transport tests.
    // Every actual workspace request, including background jobs, needs consent.
    if (currentOrg() && !externalAiAllowed()) return false;
    if (!currentOrg() && this.opts.apiKey === undefined) return false;
    if (this.opts.apiKey === undefined && !/^jev-\d+\.\d+\.\d+$/.test(this.opts.model ?? config.reflex.model)) return false;
    return Boolean(this.opts.apiKey ?? config.reflex.apiKey);
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
  }): Promise<ReflexResult | null> {
    if (!this.available()) return null;
    const key = this.opts.apiKey ?? config.reflex.apiKey;
    const maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? this.opts.maxAttempts ?? 3));
    const requestedModel = this.opts.model ?? config.reflex.model;
    // Bound and redact every outbound memory path, including pre-existing tasks.
    const safeInput = sanitizeProviderInput({ state: input.state, questions: input.questions }) as { state: unknown; questions: unknown };
    if (JSON.stringify(safeInput).length > 32_000 || Object.keys(input.questions).length > 32) return null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal?.aborted) return null;
      if (TypesafeReflexClient.inFlight >= Math.min(32, Math.max(1, config.reflex.concurrency))) return null;
      TypesafeReflexClient.inFlight++;
      try {
        const org = currentOrg();
        if (this.opts.apiKey === undefined && (!org || !await reserveWorkspaceInference(org.id))) return null;
        if (input.signal?.aborted) return null;
        const res = await this.transport(this.opts.endpoint ?? config.reflex.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: safeInput.state,
            model: requestedModel,
            questions: safeInput.questions,
          }),
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(this.opts.timeoutMs ?? config.reflex.timeoutMs)]) : AbortSignal.timeout(this.opts.timeoutMs ?? config.reflex.timeoutMs),
        });
        if (res.status === 401) {
          this.markFail("HTTP 401", true);
          return null;
        }
        if (this.shouldRetry(res.status) && attempt < maxAttempts) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const delay = retryDelayMs(attempt, Number.isFinite(retryAfter) ? retryAfter : undefined);
          console.warn(`[reflex] HTTP ${res.status}, retry in ${Math.round(delay / 1000)}s`);
          this.markFail(`HTTP ${res.status}`);
          if (!this.available()) return null;
          await sleep(delay);
          continue;
        }
        if (!res.ok) {
          // Provider error bodies can echo tenant inputs. Never log them.
          console.warn(`[reflex] HTTP ${res.status}`);
          this.markFail(`HTTP ${res.status}`);
          return null;
        }
        const body = await readAiResponse(res, 128_000);
        const json = JSON.parse(body) as {
          model?: string;
          answers?: Record<string, ReflexAnswer>;
        };
        const answers = validateAnswers(json.answers, input.questions);
        if (!answers) {
          this.markFail("invalid answers");
          return null;
        }
        this.markOk();
        const reported = typeof json.model === "string" && /^[a-zA-Z0-9._:/-]{1,120}$/.test(json.model);
        if (reported && /^jev-\d+\.\d+\.\d+$/.test(requestedModel) && json.model !== requestedModel) {
          this.markFail("model version mismatch"); return null;
        }
        return { model: reported ? json.model! : requestedModel, requestedModel, modelReported: reported, answers };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
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
