import { spawnSync } from "node:child_process";
import { config, dbUrl } from "./config";
import postgres from "postgres";

export async function currentEmbeddingWidth(): Promise<number | null> {
  const sql = postgres(dbUrl(config.brainDb), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT atttypmod AS dims
      FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`;
    const dims = Number(rows[0]?.dims);
    return Number.isFinite(dims) && dims > 0 ? dims : null;
  } catch {
    return null;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function resizeEmbeddingColumn(dims: number): Promise<void> {
  const sql = postgres(dbUrl(config.brainDb), { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async tx => {
      await tx`DROP INDEX IF EXISTS idx_chunks_embedding`;
      await tx`UPDATE content_chunks SET embedding = NULL, embedded_at = NULL`;
      await tx.unsafe(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${dims})`);
      if (dims <= 2000) {
        await tx`CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)`;
      }
    });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export function initVoyageBrain() {
  const env = {
    ...(process.env as Record<string, string>),
    GBRAIN_HOME: `${config.gbrainHomesDir}/brain`,
    GBRAIN_DATABASE_URL: dbUrl(config.brainDb),
    VOYAGE_API_KEY: config.voyage.apiKey,
  };
  const result = spawnSync(config.gbrainBin, [
    "init",
    "--non-interactive",
    "--force",
    "--json",
    "--embedding-model",
    config.voyage.model,
    "--embedding-dimensions",
    String(config.voyage.dimensions),
  ], {
    env,
    timeout: 180_000,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `voyage init failed (status=${result.status}): ${(result.stderr || result.stdout || "").slice(-400)}`,
    );
  }
}

export async function maybeEnableVoyage(): Promise<{ changed: boolean; width: number | null }> {
  if (!config.voyage.apiKey) return { changed: false, width: await currentEmbeddingWidth() };
  const width = await currentEmbeddingWidth();
  if (width && width !== config.voyage.dimensions) {
    console.error(`[embed] resizing content_chunks.embedding from ${width} to ${config.voyage.dimensions}`);
    await resizeEmbeddingColumn(config.voyage.dimensions);
  }
  initVoyageBrain();
  const embed = spawnSync(config.gbrainBin, ["embed", "--stale"], {
    env: {
      ...(process.env as Record<string, string>),
      GBRAIN_HOME: `${config.gbrainHomesDir}/brain`,
      GBRAIN_DATABASE_URL: dbUrl(config.brainDb),
      VOYAGE_API_KEY: config.voyage.apiKey,
    },
    timeout: 300_000,
    encoding: "utf8",
  });
  if (embed.status !== 0) {
    console.warn("[embed] stale re-embed skipped:", (embed.stderr || embed.stdout || "").slice(0, 200));
  }
  return { changed: width !== config.voyage.dimensions, width: config.voyage.dimensions };
}
