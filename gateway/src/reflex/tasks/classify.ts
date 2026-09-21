import { config } from "../../config";
import { choiceOf, noulValue, scoreOf } from "../answers";
import type { ReflexAnswer, ReflexClient, ReflexQuestion } from "../types";

export const MEMORY_KINDS = [
  "decision",
  "correction",
  "preference",
  "fact",
  "handoff",
  "temporary",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryClassification {
  kind: MemoryKind | null;
  importance: number | null;
  longevity: "ephemeral" | "seasonal" | "durable" | null;
  sensitivity: number | null;
  actionability: number | null;
  model: string | null;
}

export function buildClassifyQuestions(text: string): {
  state: unknown;
  questions: Record<string, ReflexQuestion>;
} {
  return {
    state: { memory: text.slice(0, 800) },
    questions: {
      kind: {
        type: "choice",
        instructions: "What kind of shared-memory note is this?",
        criteria: {
          decision: "A choice or constraint the next agent should follow.",
          correction: "A previous belief or note is wrong.",
          preference: "A standing taste or style preference.",
          fact: "A durable fact about the project or person.",
          handoff: "Work is being passed to another agent or session.",
          temporary: "Useful only for a short time.",
        },
      },
      importance: {
        type: "score",
        instructions: "How important is this for later agents?",
        criteria: ["Minor", "Useful", "Must keep"],
      },
      longevity: {
        type: "choice",
        instructions: "How long should this stay active?",
        criteria: {
          ephemeral: "Days.",
          seasonal: "Weeks or one project phase.",
          durable: "Should remain until explicitly superseded.",
        },
      },
      sensitivity: {
        type: "noul",
        instructions: "Does this contain private, credential, or sensitive material?",
        criteria: { true: "Sensitive", false: "Ordinary project memory" },
      },
      actionability: {
        type: "noul",
        instructions: "Does this tell a later agent to do something specific?",
        criteria: { true: "Actionable", false: "Informational only" },
      },
    },
  };
}

export function parseClassification(
  answers: Record<string, ReflexAnswer>,
  model: string | null,
  minConfidence = config.reflex.minConfidence,
): MemoryClassification {
  const kindRaw = choiceOf(answers, "kind", minConfidence);
  const longevityRaw = choiceOf(answers, "longevity", minConfidence);
  return {
    kind: kindRaw && MEMORY_KINDS.includes(kindRaw as MemoryKind) ? kindRaw as MemoryKind : null,
    importance: scoreOf(answers, "importance", minConfidence),
    longevity: longevityRaw === "ephemeral" || longevityRaw === "seasonal" || longevityRaw === "durable"
      ? longevityRaw
      : null,
    sensitivity: noulValue(answers, "sensitivity", minConfidence),
    actionability: noulValue(answers, "actionability", minConfidence),
    model,
  };
}

export async function classifyMemory(
  client: ReflexClient,
  text: string,
): Promise<MemoryClassification | null> {
  if (!client.available()) return null;
  const result = await client.evaluate(buildClassifyQuestions(text));
  if (!result) return null;
  return parseClassification(result.answers, result.model);
}
