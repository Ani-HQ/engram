#!/usr/bin/env bun
// Operator-only recovery. Never import gateway startup or execute migrations.
// Execute only after the human explicitly authorizes this exact email/org.
import type postgres from "postgres";
import { OwnerCheckError, withOperatorDatabase } from "./check-owners";

export interface RecoverySettings { project: "ani-hq"; orgId: 1; email: string; run: boolean }
export function recoverySettings(args: string[]): RecoverySettings {
  const values: Record<string, string> = {};
  let run = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--run" && !run) { run = true; continue; }
    if (!["--project", "--org", "--email"].includes(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new OwnerCheckError("invalid_recovery_arguments");
    values[key] = args[++i];
  }
  const email = values["--email"] ?? "";
  if (values["--project"] !== "ani-hq" || values["--org"] !== "1") throw new OwnerCheckError("recovery_target_not_authorized");
  if (email.length > 254 || email !== email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OwnerCheckError("normalized_email_required");
  return { project: "ani-hq", orgId: 1, email, run };
}

export async function recoverOwner(db: postgres.Sql, options: RecoverySettings) {
  // Revalidate even for direct operator callers. Exact canonical input avoids
  // silently selecting a different identity during an exceptional repair.
  recoverySettings(["--project", options.project, "--org", String(options.orgId), "--email", options.email, ...(options.run ? ["--run"] : [])]);
  if (!options.run) throw new OwnerCheckError("explicit_execution_required");
  return db.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '5s'`;
    const orgs = await tx`SELECT id, brain_db, data_db, home_dir FROM public.orgs WHERE id = 1 FOR UPDATE`;
    const org = orgs[0];
    if (!org || org.id !== 1 || org.brain_db !== "brain_shared" || org.data_db !== "engram_gateway" || org.home_dir !== "brain") throw new OwnerCheckError("recovery_workspace_binding_invalid");
    // Normal membership APIs do not take a recovery advisory lock. This short
    // table lock therefore excludes concurrent membership writes while we
    // prove zero owners and insert; ordinary SELECTs remain available.
    await tx`LOCK TABLE public.org_members IN SHARE ROW EXCLUSIVE MODE`;
    const members = await tx`SELECT id, email, role FROM public.org_members WHERE org_id = 1 AND (role = 'owner' OR email = ${options.email})`;
    const owners = members.filter(member => member.role === "owner");
    const selected = members.find(member => member.email === options.email);
    if (selected?.role === "owner") return { ok: true, operation: "already_owner", orgId: 1, memberId: Number(selected.id), ownerRows: owners.length };
    if (owners.length) throw new OwnerCheckError("recovery_owners_already_exist");
    if (selected) throw new OwnerCheckError("existing_member_promotion_not_authorized");
    const inserted = await tx`INSERT INTO public.org_members (org_id, email, role) VALUES (1, ${options.email}, 'owner') RETURNING id`;
    const verified = await tx`SELECT id, role FROM public.org_members WHERE org_id = 1 AND role = 'owner'`;
    if (inserted.length !== 1 || verified.length !== 1 || String(inserted[0].id) !== String(verified[0].id) || verified[0].role !== "owner") throw new OwnerCheckError("recovery_verification_failed");
    return { ok: true, operation: "owner_created", orgId: 1, memberId: Number(inserted[0].id), ownerRows: 1 };
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const options = recoverySettings(process.argv.slice(2));
    if (!options.run) console.log(JSON.stringify({ mode: "plan", project: options.project, orgId: options.orgId, normalizedEmailProvided: true, operation: "insert_new_owner_only_if_no_owner_and_no_selected_membership", existingMemberPromotion: false, migrations: false, execute: false }));
    else console.log(JSON.stringify(await withOperatorDatabase({ project: options.project, region: "us-central1", instance: "engram-pg", run: true }, "write", db => recoverOwner(db, options), controller.signal)));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, operation: "owner_recovery", reason: error instanceof OwnerCheckError ? error.code : "recovery_unavailable", ...(error instanceof OwnerCheckError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    process.exitCode = 1;
  }
}
