import type { ModelPrice } from "@framework/cost-tracker";

// All model names live here — never inline strings in provider or agent code.
// Swap the default once and every agent picks it up automatically.
export const MODELS = {
  DEFAULT: "gpt-4o",
  FAST:    "gpt-4o-mini",
} as const;

// USD per 1M tokens. Copy/paste-able from OpenAI's pricing page in this exact unit so
// updating a rate is a one-line change. Per-deployment data: it lives in config/ on
// purpose so the framework layer never imports it.
export const PRICES: Record<string, ModelPrice> = {
  "gpt-4o":      { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60 },
};
