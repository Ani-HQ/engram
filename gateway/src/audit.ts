import { sql } from "./db";

// Writing a page is a contribution; reading or deleting one is not. Attribution is
// about who taught the brain something, so the list is deliberately narrow.
const CONTRIBUTING_TOOLS = [
  "put_page",
  "remember",
  "add_tag",
  "add_link",
  "add_timeline_entry",
];

export async function audit(
  tokenName: string,
  tool: string,
  argSummary: string,
  outcome: string,
  slug?: string | null,
) {
  try {
    await sql`
      INSERT INTO audit_log (token_name, tool, arg_summary, outcome, slug)
      VALUES (${tokenName}, ${tool}, ${argSummary}, ${outcome}, ${slug ?? null})`;
  } catch (e) {
    console.error("[audit] write failed:", String(e).slice(0, 200));
  }
}

export interface Contributor {
  name: string;
  first: string;
  last: string;
  writes: number;
}

export interface Provenance {
  origin: { by: string; at: string } | null;
  contributors: Contributor[];
}

function toProvenance(rows: any[]): Provenance {
  const contributors: Contributor[] = rows.map(r => ({
    name: String(r.token_name),
    first: new Date(r.first_at).toISOString(),
    last: new Date(r.last_at).toISOString(),
    writes: Number(r.writes) || 0,
  }));
  // Rows come back oldest-first, so the first contributor is the one who started the
  // page. A page whose only writes predate the slug column has no recoverable origin,
  // and says so rather than naming whoever happened to touch it since.
  const origin = contributors.length
    ? { by: contributors[0].name, at: contributors[0].first }
    : null;
  return { origin, contributors };
}

export async function provenanceFor(slugs: string[]): Promise<Map<string, Provenance>> {
  const out = new Map<string, Provenance>();
  if (!slugs.length) return out;
  try {
    const rows = await sql`
      SELECT slug, token_name,
             min(ts) AS first_at, max(ts) AS last_at, count(*)::int AS writes
      FROM audit_log
      WHERE slug = ANY(${slugs}) AND outcome = 'ok' AND tool = ANY(${CONTRIBUTING_TOOLS})
      GROUP BY slug, token_name
      ORDER BY slug, min(ts)`;
    const bySlug = new Map<string, any[]>();
    for (const row of rows) {
      const key = String(row.slug);
      if (!bySlug.has(key)) bySlug.set(key, []);
      bySlug.get(key)!.push(row);
    }
    for (const [slug, group] of bySlug) out.set(slug, toProvenance(group));
  } catch (e) {
    // Provenance is decoration on top of the page. Losing it must never lose the page.
    console.error("[audit] provenance read failed:", String(e).slice(0, 200));
  }
  return out;
}

export async function provenance(slug: string): Promise<Provenance> {
  return (await provenanceFor([slug])).get(slug) ?? { origin: null, contributors: [] };
}
