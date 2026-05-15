import { z } from "zod";
import { defineTool } from "@framework/tool";

export const calculateTool = defineTool({
  name: "calculate",
  description:
    "Evaluates a mathematical expression and returns the numeric result. " +
    "Use for arithmetic, percentages, ratios, and growth rates — any calculation " +
    "you would otherwise do mentally. Example input: \"(1500 * 0.08) / 12\".",
  // Whitelist regex is the actual security barrier — Zod surfaces it to the LLM as a
  // `pattern` constraint AND enforces it at parse time, so a bad expression never
  // reaches Function() below. Single source of truth for what counts as valid input.
  schema: z
    .object({
      expression: z
        .string()
        .min(1)
        .regex(/^[\d\s+\-*/%().e]+$/i, {
          message:
            "expression may contain only digits, whitespace, and + - * / % ( ) . e",
        })
        .describe("A mathematical expression, e.g. \"150 * 0.08\" or \"(100 + 50) / 3\""),
    })
    .strict(), // rejects extra keys — keeps the JSON Schema's additionalProperties: false honest
  async execute({ expression }) {
    try {
      // Function() runs in global scope — it cannot read any variable from this module.
      // The regex above is the real safety check; "use strict" just disables legacy quirks
      // (e.g. octal literals) that could widen the surface unintentionally.
      const result = Function(`"use strict"; return (${expression})`)() as unknown;
      if (typeof result !== "number" || !isFinite(result)) {
        throw new Error(`result is not a finite number: ${String(result)}`);
      }
      return result;
    } catch (err) {
      throw new Error(
        `calculate: could not evaluate "${expression}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});
