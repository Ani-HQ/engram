import { sql } from "./db";

export async function audit(
  tokenName: string,
  tool: string,
  scope: string | null,
  argSummary: string,
  outcome: string,
) {
  try {
    await sql`
      INSERT INTO audit_log (token_name, tool, scope, arg_summary, outcome)
      VALUES (${tokenName}, ${tool}, ${scope}, ${argSummary}, ${outcome})`;
  } catch (e) {
    console.error("[audit] write failed:", String(e).slice(0, 200));
  }
}
