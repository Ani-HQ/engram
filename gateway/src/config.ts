// All deployment knobs in one place. The only required env is ENGRAM_DB_URL_TEMPLATE,
// a Postgres URL containing the literal __DB__ where the database name goes, e.g.
//   postgresql://postgres:pw@localhost:5544/__DB__
//   postgresql://engram:pw@/__DB__?host=/cloudsql/ani-hq:us-central1:engram-pg
const template = process.env.ENGRAM_DB_URL_TEMPLATE;
if (!template || !template.includes("__DB__")) {
  throw new Error("ENGRAM_DB_URL_TEMPLATE must be set and contain __DB__");
}

export function dbUrl(dbName: string): string {
  return template!.replace("__DB__", dbName);
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function secretValue(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return !value || value === "unset" ? "" : value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  brainDb: process.env.ENGRAM_BRAIN_DB ?? "brain_shared",
  gbrainBin: process.env.GBRAIN_BIN ?? `${process.env.HOME}/.bun/bin/gbrain`,
  gbrainHomesDir: process.env.GBRAIN_HOMES_DIR ?? "/gbrain-homes",
  reflex: {
    apiKey: secretValue(process.env.REFLEX_API_KEY ?? process.env.TYPESAFE_API_KEY),
    model: (process.env.REFLEX_MODEL ?? process.env.TYPESAFE_MODEL ?? "jev-latest").trim(),
    endpoint: (process.env.REFLEX_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone").trim(),
    timeoutMs: envNumber("REFLEX_TIMEOUT_MS", envNumber("JEV_TIMEOUT_MS", 15_000)),
    concurrency: envNumber("REFLEX_CONCURRENCY", envNumber("JEV_CONCURRENCY", 8)),
    minConfidence: Number(process.env.REFLEX_MIN_CONFIDENCE ?? process.env.JEV_MIN_CONFIDENCE ?? 0.55),
    writeStrict: process.env.REFLEX_WRITE_STRICT === "1",
  },
  voyage: {
    apiKey: secretValue(process.env.VOYAGE_API_KEY),
    model: (process.env.ENGRAM_EMBEDDING_MODEL ?? "voyage:voyage-4-large").trim(),
    dimensions: envNumber("ENGRAM_EMBEDDING_DIMENSIONS", 1024),
  },
};
