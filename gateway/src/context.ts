import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import type { OrgPolicies, TokenRecord } from "./policies";

export interface ContextOrg {
  id: number;
  name: string;
  slug: string;
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
  return storage.run(ctx, fn);
}
