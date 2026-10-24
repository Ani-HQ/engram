import { describe, expect, test } from "bun:test";
import { workspacePending } from "./account.js";

describe("workspace provisioning presentation", () => {
  test("holds content for all unfinished states without treating existing demo sessions as pending", () => {
    for (const provisioningStatus of ["pending", "provisioning", "failed"]) expect(workspacePending({ org: { id: 2, provisioningStatus } })).toBe(true);
    expect(workspacePending({ org: { id: 2, provisioningStatus: "ready" } })).toBe(false);
    expect(workspacePending({ org: { id: 2 } })).toBe(false);
    expect(workspacePending(null)).toBe(false);
    expect(workspacePending({ org: { id: 2 }, onboarding: { provisioning: true } })).toBe(true);
  });
});
