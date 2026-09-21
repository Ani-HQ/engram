import type { ReflexAnswer } from "./types";

export function choiceOf(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): string | null {
  const answer = answers[key];
  if (!answer || answer.type !== "choice") return null;
  if ((answer.confidence ?? 0) < minConfidence) return null;
  return answer.choice;
}

export function noulYes(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): boolean {
  const answer = answers[key];
  if (!answer || answer.type !== "noul") return false;
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
  if (!answer || answer.type !== "noul") return null;
  const confidence = 2 * Math.abs(answer.noul - 0.5);
  if (confidence < minConfidence) return null;
  return answer.noul;
}

export function scoreOf(
  answers: Record<string, ReflexAnswer>,
  key: string,
  minConfidence: number,
): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== "score") return null;
  if ((answer.confidence ?? 0) < minConfidence) return null;
  return answer.score;
}
