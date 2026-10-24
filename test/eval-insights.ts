/** Offline retrieval smoke evaluation; never loads credentials or calls a model. */
import fixtures from "./fixtures/insight-eval.json";
import { analyzeActions, type InsightAction } from "../gateway/src/insights-engine";

const now = new Date("2026-10-22T12:00:00Z");
let baseline = 0, lexical = 0, positives = 0, falsePositiveQueries = 0;
function reciprocal(ids: string[], relevant: string[]) { const index = ids.findIndex(id => relevant.includes(id)); return index < 0 ? 0 : 1 / (index + 1); }
for (const fixture of fixtures) {
  const actions: InsightAction[] = fixture.actions.map((item, index) => ({
    id: item.id, activityId: `event:${item.id}`, summary: item.summary, agent: "agent" in item ? item.agent : "agent", tool: item.tool,
    resource: null, status: "completed", evidence: "reported", runId: null, actionKey: null, eventId: null, detail: null, approach: null,
    occurredAt: new Date(now.getTime() - index * 1000).toISOString(), recordedAt: new Date(now.getTime() - index * 1000).toISOString(), startedAt: now.toISOString(),
  }));
  const ranked = analyzeActions({ actions, q: fixture.query, now }).search!.matches.map(item => item.actionId);
  if (fixture.relevant.length) { positives++; baseline += reciprocal(actions.map(item => item.id), fixture.relevant); lexical += reciprocal(ranked, fixture.relevant); }
  else if (ranked.length) falsePositiveQueries++;
}
const report = { fixtureVersion: "curated-smoke-1", queries: fixtures.length, positiveQueries: positives,
  chronologicalBaselineMRR: Number((baseline / positives).toFixed(4)), lexicalMRR: Number((lexical / positives).toFixed(4)), falsePositiveQueries,
  providerCalls: 0, jevQualityMeasured: false,
  limitation: "Small synthetic labeled fixtures check retrieval behavior only. They do not establish production quality, confidence calibration, model superiority or security." };
process.stdout.write(JSON.stringify(report) + "\n");
if (lexical < baseline || falsePositiveQueries) process.exitCode = 1;
