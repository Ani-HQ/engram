// Setup help is presentation state. Only an explicit existing source survives
// a key replacement; choosing instructions must never label a new credential.
export function genericConnectionDraft(previous = {}) {
  return {
    name: previous.name || "", canWrite: previous.canWrite !== false,
    helpAgentId: previous.helpAgentId || "", keyExpanded: previous.keyExpanded === true,
    helpExpanded: previous.helpExpanded === true,
  };
}

export function connectionKeyPayload(draft, input) {
  return {
    name: input.name,
    canWrite: input.canWrite !== false,
    ...(draft.harness ? { harness: draft.harness, ...(draft.sourceLabel ? { sourceLabel: draft.sourceLabel } : {}) } : {}),
  };
}
