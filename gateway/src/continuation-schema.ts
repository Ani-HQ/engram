import type postgres from "postgres";

// Continuation tables live in workspace storage next to memory_entries, so the
// checkpoint, its receipt and the lineage head commit in one transaction.
export async function migrateContinuationTables(client: postgres.Sql) {
  await client`
    CREATE TABLE IF NOT EXISTS continuation_tasks (
      id          text PRIMARY KEY CHECK (id ~ '^task_[a-f0-9]{32}$'),
      org_id      integer NOT NULL,
      title       text NOT NULL,
      project     text,
      created_by  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
      closed_at   timestamptz,
      closed_by   text,
      deleted_at  timestamptz,
      deleted_by  text
    )`;
  await client`CREATE INDEX IF NOT EXISTS continuation_tasks_recent_idx ON continuation_tasks (org_id, updated_at DESC) WHERE deleted_at IS NULL`;
  await client`
    CREATE TABLE IF NOT EXISTS continuation_checkpoints (
      id           text PRIMARY KEY CHECK (id ~ '^cp_[a-f0-9]{32}$'),
      org_id       integer NOT NULL,
      task_id      text NOT NULL REFERENCES continuation_tasks(id),
      lineage      text NOT NULL,
      parent_id    text REFERENCES continuation_checkpoints(id),
      revision     integer NOT NULL CHECK (revision > 0),
      trigger      text NOT NULL CHECK (trigger IN ('start', 'decision', 'plan', 'blocker', 'milestone', 'handoff', 'completed')),
      record       jsonb NOT NULL,
      record_hash  text NOT NULL,
      author       text NOT NULL,
      run_id       text,
      harness      text,
      repo         text,
      branch       text,
      created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
    )`;
  await client`CREATE INDEX IF NOT EXISTS continuation_checkpoints_task_idx ON continuation_checkpoints (org_id, task_id, created_at DESC)`;
  // Checkpoints are immutable. A trigger enforces it even for code that forgets.
  await client.unsafe(`
    CREATE OR REPLACE FUNCTION continuation_checkpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'continuation checkpoints are immutable'; END $$`);
  await client.unsafe(`DROP TRIGGER IF EXISTS continuation_checkpoints_immutable ON continuation_checkpoints`);
  await client.unsafe(`CREATE TRIGGER continuation_checkpoints_immutable BEFORE UPDATE ON continuation_checkpoints FOR EACH ROW EXECUTE FUNCTION continuation_checkpoint_immutable()`);
  await client`
    CREATE TABLE IF NOT EXISTS continuation_heads (
      org_id         integer NOT NULL,
      task_id        text NOT NULL REFERENCES continuation_tasks(id),
      lineage        text NOT NULL,
      checkpoint_id  text NOT NULL REFERENCES continuation_checkpoints(id),
      revision       integer NOT NULL,
      updated_at     timestamptz NOT NULL,
      PRIMARY KEY (org_id, task_id, lineage)
    )`;
  await client`
    CREATE TABLE IF NOT EXISTS continuation_receipts (
      org_id         integer NOT NULL,
      author         text NOT NULL,
      request_id     text NOT NULL,
      op             text NOT NULL CHECK (op IN ('create', 'append')),
      fingerprint    text NOT NULL,
      task_id        text NOT NULL REFERENCES continuation_tasks(id),
      checkpoint_id  text NOT NULL REFERENCES continuation_checkpoints(id),
      unchanged      boolean NOT NULL DEFAULT false,
      created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (org_id, author, request_id)
    )`;
}
