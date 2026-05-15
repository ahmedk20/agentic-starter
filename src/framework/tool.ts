import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentContext, Tool } from "@core/types";

export interface DefineToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  // The schema-narrowed input shape — execute() receives z.infer<S>, not unknown.
  execute: (input: z.infer<S>, ctx: AgentContext) => Promise<unknown>;
}

// Smart-constructor that produces a plain Tool from a Zod schema.
// Two responsibilities, both invisible to the rest of the framework:
//   (1) Derive the JSON Schema the LLM sees in the function-calling payload.
//   (2) Parse the model's raw input through Zod before user code runs.
// Validation failures throw a normal Error, which tool-loop.ts:94-107 catches and
// converts into a tool_result so the model can self-correct on the next turn.
export function defineTool<S extends z.ZodTypeAny>(spec: DefineToolSpec<S>): Tool {
  // Derived once at construction — the tool's shape never changes between calls,
  // and recomputing per invocation would burn CPU on every LLM turn for no benefit.
  const raw = zodToJsonSchema(spec.schema, { $refStrategy: "none" }) as Record<string, unknown>;
  // $refStrategy: "none" inlines sub-schemas. We also strip $schema because OpenAI's
  // strict JSON-Schema validator has historically rejected the top-level $schema field.
  delete raw["$schema"];
  const inputSchema = raw;

  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    async execute(input: unknown, ctx: AgentContext): Promise<unknown> {
      const parsed = spec.schema.safeParse(input);
      if (!parsed.success) {
        // Flatten Zod issues to one line — the model receives this as plain text in a
        // tool_result, and a long JSON dump confuses smaller models more than it helps.
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid tool input — ${issues}`);
      }
      return spec.execute(parsed.data as z.infer<S>, ctx);
    },
  };
}
