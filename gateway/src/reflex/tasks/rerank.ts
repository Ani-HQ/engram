import { config } from "../../config";
import { scoreOf } from "../answers";
import type { ReflexAnswer, ReflexClient, ReflexQuestion } from "../types";

export interface RankedHit {
  index: number;
  score: number;
}

export function buildRerankQuestions(query: string, snippets: string[]): {
  state: unknown;
  questions: Record<string, ReflexQuestion>;
} {
  const questions: Record<string, ReflexQuestion> = {};
  snippets.forEach((snippet, index) => {
    questions[`h${index}`] = {
      type: "score",
      instructions: {
        query,
        snippet: snippet.replace(/\s+/g, " ").slice(0, 320),
        question: "How well does this snippet answer the query, weighing relevance, usefulness, and freshness together?",
      },
      criteria: ["Off topic", "Weakly related", "Useful", "Best answer"],
    };
  });
  return {
    state: {
      query,
      hits: snippets.map((snippet, index) => ({
        i: index,
        snippet: snippet.replace(/\s+/g, " ").slice(0, 320),
      })),
    },
    questions,
  };
}

export function parseRerank(
  answers: Record<string, ReflexAnswer>,
  count: number,
  minConfidence = config.reflex.minConfidence,
): RankedHit[] | null {
  const ranked: RankedHit[] = [];
  for (let index = 0; index < count; index += 1) {
    const score = scoreOf(answers, `h${index}`, minConfidence);
    if (score === null) continue;
    ranked.push({ index, score });
  }
  if (!ranked.length) return null;
  return ranked.sort((a, b) => b.score - a.score || a.index - b.index);
}

export async function rerankHits(
  client: ReflexClient,
  query: string,
  snippets: string[],
): Promise<RankedHit[] | null> {
  if (!client.available() || snippets.length === 0) return null;
  const result = await client.evaluate(buildRerankQuestions(query, snippets));
  if (!result) return null;
  return parseRerank(result.answers, snippets.length);
}
