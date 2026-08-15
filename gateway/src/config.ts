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

// Scope name -> database name. Scope names never contain characters that need escaping:
// lowercase alphanumerics plus ':' for product scopes (product:beacon -> brain_product_beacon).
export function scopeDb(scope: string): string {
  return "brain_" + scope.replace(/[^a-z0-9]+/g, "_");
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  scopes: (process.env.ENGRAM_SCOPES ?? "shared").split(",").map(s => s.trim()).filter(Boolean),
  gbrainBin: process.env.GBRAIN_BIN ?? `${process.env.HOME}/.bun/bin/gbrain`,
  gbrainHomesDir: process.env.GBRAIN_HOMES_DIR ?? "/gbrain-homes",
};
