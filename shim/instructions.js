'use strict';

// One bounded, packaged instruction set for HTTP and local stdio initialization.
// It asks the agent to report real work; it never manufactures reports itself.
const SERVER_INSTRUCTIONS = [
  'Engram shares memory and agent-reported task history across agents, harnesses, and machines.',
  'Call recall before substantive project or recurring-topic work. Call remember for decisions, corrections, constraints, and handoffs; keep entries to two sentences. Save intent the repo cannot explain, not mechanical state.',
  'For each real substantive user task, call record_action with tool "agent.task", taskTitle, and status "running" when work starts. Send meaningful currentStep updates, then status "completed" or "failed" with an honest outcome. Report actual tool operations separately when useful.',
  'Keep one opaque runId per task and a stable actionKey per action. Repeat tool, runId, and resource on updates. Use a new eventId per update; reuse it only for an identical retry. After completion or failure, use a new actionKey for another attempt. Refresh running work within 15 minutes only while it is known to be running.',
  'Reports remain agent-reported, never independently observed external actions. Do not invent tasks, outcomes, or past activity from memory calls. Never include credentials or hidden reasoning. Reporting failures must not block the task or cause retry loops; say the report was not recorded instead of claiming delivery.',
  'list_actions reads the history shared with the web app.',
].join('\n\n');

module.exports = { SERVER_INSTRUCTIONS };
