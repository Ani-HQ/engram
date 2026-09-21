import { config } from "../config";
import { retryDelayMs } from "./retry";
import type { ReflexAnswer, ReflexClient, ReflexQuestion, ReflexResult, ReflexTransport } from "./types";

const CIRCUIT_AFTER = 5;
const CIRCUIT_MS = 10 * 60 * 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TypesafeReflexClient implements ReflexClient {
  private hardDisabled = false;
  private circuitOpenUntil = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly transport: ReflexTransport = fetch,
    private readonly now: () => number = Date.now,
    private readonly opts: { apiKey?: string; model?: string; endpoint?: string; timeoutMs?: number } = {},
  ) {}

  enabled(): boolean {
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
  }): Promise<ReflexResult | null> {
    if (!this.available()) return null;
    const key = this.opts.apiKey ?? config.reflex.apiKey;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await this.transport(this.opts.endpoint ?? config.reflex.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: input.state,
            model: this.opts.model ?? config.reflex.model,
            questions: input.questions,
          }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? config.reflex.timeoutMs),
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
          const body = await res.text().catch(() => "");
          console.warn(`[reflex] HTTP ${res.status} ${body.slice(0, 160)}`);
          this.markFail(`HTTP ${res.status}`);
          return null;
        }
        const json = (await res.json()) as {
          model?: string;
          answers?: Record<string, ReflexAnswer>;
        };
        if (!json.answers || Object.keys(json.answers).length === 0) {
          this.markFail("empty answers");
          return null;
        }
        this.markOk();
        return { model: json.model ?? config.reflex.model, answers: json.answers };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (timedOut && attempt < maxAttempts) {
          console.warn("[reflex] timeout (retrying)");
          continue;
        }
        console.warn(`[reflex] ${message}`);
        this.markFail(message);
        return null;
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
