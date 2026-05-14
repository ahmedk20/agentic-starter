import { z } from "zod";
import { MODELS } from "./models";

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  // Optional — falls back to the default model so local runs need only the API key.
  OPENAI_MODEL: z.string().optional(),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  // Print every missing/invalid field before exiting — fix all problems in one run.
  console.error("Missing or invalid environment variables:");
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// Exported as a plain object — callers read env.openaiKey, never process.env directly.
export const env = {
  openaiKey: result.data.OPENAI_API_KEY,
  model:     result.data.OPENAI_MODEL ?? MODELS.DEFAULT,
} as const;
