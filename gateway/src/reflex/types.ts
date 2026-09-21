export type ReflexChoiceQuestion = {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
};

export type ReflexNoulQuestion = {
  type: "noul";
  instructions: string | Record<string, unknown>;
  criteria?: { true?: string; false?: string };
};

export type ReflexScoreQuestion = {
  type: "score";
  instructions: string | Record<string, unknown>;
  criteria: string[];
};

export type ReflexQuestion = ReflexChoiceQuestion | ReflexNoulQuestion | ReflexScoreQuestion;

export type ReflexChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type ReflexNoulAnswer = {
  type: "noul";
  noul: number;
};

export type ReflexScoreAnswer = {
  type: "score";
  score: number;
  confidence?: number;
};

export type ReflexAnswer = ReflexChoiceAnswer | ReflexNoulAnswer | ReflexScoreAnswer;

export type ReflexResult = {
  model: string;
  answers: Record<string, ReflexAnswer>;
};

export interface ReflexClient {
  enabled(): boolean;
  available(): boolean;
  evaluate(input: {
    state: unknown;
    questions: Record<string, ReflexQuestion>;
  }): Promise<ReflexResult | null>;
}

export type ReflexTransport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
