// All model names live here — never inline strings in provider or agent code.
// Swap the default once and every agent picks it up automatically.
export const MODELS = {
  DEFAULT: "gpt-4o",
  FAST:    "gpt-4o-mini",
} as const;
