import { expect, test } from "bun:test";
import { connectionKeyPayload, genericConnectionDraft } from "./connection-setup-state.js";

test("the generic entry cannot inherit a dismissed replacement's hidden source", () => {
  const draft = genericConnectionDraft({ name: "Replacement-new", canWrite: false, harness: "codex", sourceLabel: "Existing manual label", helpAgentId: "vscode", keyExpanded: true });
  expect(draft).toEqual({ name: "Replacement-new", canWrite: false, helpAgentId: "vscode", keyExpanded: true, helpExpanded: false });
  expect(connectionKeyPayload(draft, { name: draft.name, canWrite: draft.canWrite })).toEqual({ name: "Replacement-new", canWrite: false });
  expect(genericConnectionDraft()).toEqual({ name: "", canWrite: true, helpAgentId: "", keyExpanded: false, helpExpanded: false });
});

test("optional setup help cannot assign a source or change key permissions", () => {
  for (const helpAgentId of ["", "codex", "chatgpt", "vscode", "other"]) {
    expect(connectionKeyPayload({ helpAgentId, helpExpanded: true }, { name: "Work laptop", canWrite: false, harness: "grok", sourceLabel: "Injected source" })).toEqual({ name: "Work laptop", canWrite: false });
  }
});

test("replacing a key preserves only its explicit source independently of viewed help", () => {
  expect(connectionKeyPayload({ harness: "custom-client", sourceLabel: "Existing source", helpAgentId: "codex" }, { name: "Replacement", canWrite: true, harness: "codex" })).toEqual({ name: "Replacement", canWrite: true, harness: "custom-client", sourceLabel: "Existing source" });
  expect(connectionKeyPayload({ sourceLabel: "Orphan label", helpAgentId: "codex" }, { name: "New key", canWrite: true })).toEqual({ name: "New key", canWrite: true });
});
