import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import type { OrgKind, OrgPolicies, TokenRecord } from "./policies";

export interface ContextOrg {
  id: number;
  name: string;
  slug: string;
  kind: OrgKind;
  brainDb: string;
  homeDir: string;
  dataDb: string;
  policies: OrgPolicies;
}

export interface RequestContext {
  org: ContextOrg;
  token: TokenRecord;
  dataSql: postgres.Sql;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentOrg(): ContextOrg | undefined {
  return storage.getStore()?.org;
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  if (!Number.isSafeInteger(ctx.org.id) || ctx.org.id < 1 || ctx.token.orgId !== ctx.org.id) {
    throw new Error("Actor and workspace context must match");
  }
  return storage.run(ctx, fn);
}

export function requireContext(): RequestContext {
  const ctx = currentContext();
  if (!ctx) throw new Error("A workspace context is required");
  if (ctx.token.orgId !== ctx.org.id) throw new Error("Actor and workspace context must match");
  return ctx;
}
