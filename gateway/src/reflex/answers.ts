import type { ReflexAnswer, ReflexQuestion } from "./types";

export function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function confidenceOf(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null;
  const row = answer as Record<string, unknown>;
  if (row.type === "noul") return unit(row.noul) ? 2 * Math.abs(row.noul - 0.5) : null;
  return unit(row.confidence) ? row.confidence : null;
}

export function choiceOf(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): string | null {
  const answer = answers[key];
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !unit(minConfidence)) return null;
  const confidence = confidenceOf(answer);
  if (confidence === null || confidence < minConfidence) return null;
  return answer.choice;
}

export function noulYes(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): boolean {
  const answer = answers[key];
  if (!answer || answer.type !== "noul" || !unit(answer.noul) || !unit(minConfidence)) return false;
  const confidence = 2 * Math.abs(answer.noul - 0.5);
  if (confidence < minConfidence) return false;
  return answer.noul >= 0.5;
}

export function noulValue(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== "noul" || !unit(answer.noul) || !unit(minConfidence)) return null;
  const confidence = 2 * Math.abs(answer.noul - 0.5);
  if (confidence < minConfidence) return null;
  return answer.noul;
}

export function scoreOf(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > max || !unit(minConfidence)) return null;
  const confidence = confidenceOf(answer);
  if (confidence === null || confidence < minConfidence) return null;
  return answer.score;
}

// Transport JSON is untrusted. Validate each value against the requested schema
// before any task parser can act on it. Invalid responses cause abstention.
export function validateAnswers(raw: unknown, questions: Record<string, ReflexQuestion>): Record<string, ReflexAnswer> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result: Record<string, ReflexAnswer> = {};
  for (const [key, value] of Object.entries(raw)) {
    const question = questions[key];
    if (!question || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const answer = value as Record<string, unknown>;
    if (answer.type !== question.type) return null;
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) || !unit(answer.confidence)) return null;
      if (answer.probabilities !== undefined && (!answer.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities) ||
        Object.entries(answer.probabilities).some(([choice, probability]) => !Object.hasOwn(question.criteria, choice) || !unit(probability)))) return null;
      result[key] = { type: "choice", choice: answer.choice, confidence: answer.confidence };
    } else if (question.type === "score") {
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 || !unit(answer.confidence)) return null;
      result[key] = { type: "score", score: answer.score, confidence: answer.confidence };
    } else {
      if (!unit(answer.noul)) return null;
      result[key] = { type: "noul", noul: answer.noul };
    }
  }
  return Object.keys(result).length ? result : null;
}
