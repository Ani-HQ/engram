import { config } from "./config";
import { tenantDbUrl } from "./tenant-db";
import { runBrainCommand } from "./brain";
import { withMemoryWriteLock } from "./write-coordination";
import postgres from "postgres";
import { currentOrg } from "./context";
import { externalAiAllowed, brainEnvironment } from "./privacy";

function embeddingOrg() {
  const org = currentOrg();
  if (!org || !externalAiAllowed(org)) throw new Error("Embedding setup requires an opted-in workspace context");
  return org;
}

export async function currentEmbeddingWidth(): Promise<number | null> {
  const sql = postgres(tenantDbUrl(embeddingOrg().brainDb), { max: 1, onnotice: () => {} });
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
  const sql = postgres(tenantDbUrl(embeddingOrg().brainDb), { max: 1, onnotice: () => {} });
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

export async function initVoyageBrain() {
  await runBrainCommand(embeddingOrg(), [
    "init",
    "--non-interactive",
    "--force",
    "--json",
    "--embedding-model",
    config.voyage.model,
    "--embedding-dimensions",
    String(config.voyage.dimensions),
  ], 180_000);
}

export async function maybeEnableVoyage(): Promise<{ changed: boolean; width: number | null }> {
  if (!externalAiAllowed()) return { changed: false, width: null };
  if (!config.voyage.apiKey) return { changed: false, width: await currentEmbeddingWidth() };
  const width = await currentEmbeddingWidth();
  if (width && width !== config.voyage.dimensions) {
    console.error(`[embed] resizing content_chunks.embedding from ${width} to ${config.voyage.dimensions}`);
    await resizeEmbeddingColumn(config.voyage.dimensions);
  }
  await withMemoryWriteLock(async () => {
    await initVoyageBrain();
    await runBrainCommand(embeddingOrg(), ["embed", "--stale"],300_000);
  });
  return { changed: width !== config.voyage.dimensions, width: config.voyage.dimensions };
}
