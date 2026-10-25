/** Stable provider alias; it does not identify immutable model weights. */
export const DEFAULT_JEV_MODEL = "jev-latest";

const EXACT_JEV_MODEL = /^jev-\d+\.\d+\.\d+$/;

/** Preview and unreviewed aliases are deliberately excluded. */
export function isJevModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && (value === DEFAULT_JEV_MODEL || EXACT_JEV_MODEL.test(value));
}

export function configuredJevModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.REFLEX_MODEL ?? env.TYPESAFE_MODEL ?? DEFAULT_JEV_MODEL).trim();
}

/** An alias may resolve to a version; an explicit version remains strict. */
export function jevModelMatches(requested: unknown, reported: unknown): boolean {
  return isJevModel(requested) && isJevModel(reported)
    && (requested === DEFAULT_JEV_MODEL || requested === reported);
}
