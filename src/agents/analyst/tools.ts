import type { AgentContext, Tool } from "@core/types";

export const calculateTool: Tool = {
  name: "calculate",
  description:
    "Evaluates a mathematical expression and returns the numeric result. " +
    "Use for arithmetic, percentages, ratios, and growth rates — any calculation " +
    "you would otherwise do mentally. Example input: \"(1500 * 0.08) / 12\".",
  inputSchema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "A mathematical expression, e.g. \"150 * 0.08\" or \"(100 + 50) / 3\"",
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },

  async execute(input: unknown, _ctx: AgentContext): Promise<unknown> {
    if (typeof input !== "object" || input === null) {
      throw new Error("calculate: input must be an object");
    }

    const { expression } = input as Record<string, unknown>;

    if (typeof expression !== "string" || expression.trim() === "") {
      throw new Error("calculate: expression must be a non-empty string");
    }

    // Whitelist approach: only digits, operators, parentheses, decimals, and 'e' for
    // scientific notation (1e6). Any letter other than 'e' indicates an injection attempt.
    if (!/^[\d\s+\-*/%().e]+$/i.test(expression)) {
      throw new Error(
        `calculate: expression contains invalid characters — ` +
          `only numbers and operators (+, -, *, /, %, **) are allowed.`,
      );
    }

    try {
      // Function() runs in global scope, not local — cannot access variables from this file.
      // "use strict" disables legacy JS that could widen the attack surface.
      // The regex above already blocks anything dangerous before we reach this line.
      const result = Function(`"use strict"; return (${expression})`)() as unknown;

      if (typeof result !== "number" || !isFinite(result)) {
        throw new Error(`result is not a finite number: ${String(result)}`);
      }

      return result;
    } catch (err) {
      throw new Error(
        `calculate: could not evaluate "${expression}" — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
