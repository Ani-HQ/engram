import type { TokenRecord } from "../auth";

export function isPathTokenAllowed(token: TokenRecord): boolean {
  return !token.secrets && !Object.values(token.scopes).some(p => p === "rw");
}
