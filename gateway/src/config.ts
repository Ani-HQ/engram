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

export const config = {
  port: Number(process.env.PORT ?? 8080),
  brainDb: process.env.ENGRAM_BRAIN_DB ?? "brain_shared",
  gbrainBin: process.env.GBRAIN_BIN ?? `${process.env.HOME}/.bun/bin/gbrain`,
  gbrainHomesDir: process.env.GBRAIN_HOMES_DIR ?? "/gbrain-homes",
};
