import { config } from "../../config";
import { choiceOf } from "../answers";
import type { ReflexClient, ReflexQuestion } from "../types";

export const NONE_TOPIC = "none";

export interface TopicCandidate {
  slug: string;
  title: string;
}

export function buildTopicRouteQuestions(text: string, candidates: TopicCandidate[]): {
  state: unknown;
  questions: Record<string, ReflexQuestion>;
} {
  const criteria: Record<string, string | null> = {
    [NONE_TOPIC]: "This memory does not belong on any of the listed topic pages.",
  };
  for (const candidate of candidates) {
    criteria[candidate.slug] = `Belongs on ${candidate.title} (${candidate.slug}).`;
  }
  return {
    state: {
      memory: text.slice(0, 800),
      candidates: candidates.map(candidate => ({
        slug: candidate.slug,
        title: candidate.title,
      })),
    },
    questions: {
      topic: {
        type: "choice",
        instructions: "Choose the existing topic page this memory should accumulate under. Choose none if it is a new or one-off note.",
        criteria,
      },
    },
  };
}

export function parseTopicRoute(
  answers: Record<string, import("../types").ReflexAnswer>,
  candidates: TopicCandidate[],
  minConfidence = config.reflex.minConfidence,
): string | null {
  const choice = choiceOf(answers, "topic", minConfidence);
  if (!choice || choice === NONE_TOPIC) return null;
  return candidates.some(candidate => candidate.slug === choice) ? choice : null;
}

export async function routeTopic(
  client: ReflexClient,
  text: string,
  candidates: TopicCandidate[],
): Promise<{ topic: string | null; model: string | null; confidence: number | null }> {
  if (!client.available() || candidates.length === 0) {
    return { topic: null, model: null, confidence: null };
  }
  const built = buildTopicRouteQuestions(text, candidates.slice(0, 8));
  const result = await client.evaluate(built);
  if (!result) return { topic: null, model: null, confidence: null };
  const topic = parseTopicRoute(result.answers, candidates);
  return {
    topic,
    model: result.model,
    confidence: result.answers.topic && result.answers.topic.type === "choice"
      ? result.answers.topic.confidence ?? null
      : null,
  };
}
