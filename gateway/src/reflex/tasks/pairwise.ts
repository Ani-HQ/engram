import { config } from "../../config";
import { choiceOf } from "../answers";
import type { ReflexAnswer, ReflexClient, ReflexQuestion } from "../types";

export const RELATIONS = ["duplicate", "contradict", "refine", "supersede", "unrelated"] as const;
export type MemoryRelation = (typeof RELATIONS)[number];

export function buildPairwiseQuestions(a: string, b: string): {
  state: unknown;
  questions: Record<string, ReflexQuestion>;
} {
  return {
    state: {
      a: a.replace(/\s+/g, " ").slice(0, 400),
      b: b.replace(/\s+/g, " ").slice(0, 400),
    },
    questions: {
      relation: {
        type: "choice",
        instructions: "How does memory A relate to memory B?",
        criteria: {
          duplicate: "A restates B with no new decision.",
          contradict: "A and B cannot both be true.",
          refine: "A adds detail to B without replacing it.",
          supersede: "A replaces B as the current truth.",
          unrelated: "They are about different things.",
        },
      },
    },
  };
}

export function parsePairwise(
  answers: Record<string, ReflexAnswer>,
  minConfidence = config.reflex.minConfidence,
): { relation: MemoryRelation | null; confidence: number | null } {
  const raw = choiceOf(answers, "relation", minConfidence);
  const answer = answers.relation;
  return {
    relation: raw && RELATIONS.includes(raw as MemoryRelation) ? raw as MemoryRelation : null,
    confidence: answer && answer.type === "choice" ? answer.confidence ?? null : null,
  };
}

export async function judgePair(
  client: ReflexClient,
  a: string,
  b: string,
): Promise<{ relation: MemoryRelation | null; confidence: number | null; model: string | null }> {
  if (!client.available()) return { relation: null, confidence: null, model: null };
  const result = await client.evaluate(buildPairwiseQuestions(a, b));
  if (!result) return { relation: null, confidence: null, model: null };
  return { ...parsePairwise(result.answers), model: result.model };
}
