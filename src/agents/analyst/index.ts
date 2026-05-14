import type { AgentContext, AgentInput, AgentOutput, Message } from "@core/types";
import { BaseAgent } from "@framework/agent";
import { runToolLoop } from "@framework/tool-loop";
import { ANALYST_SYSTEM_PROMPT } from "./prompts";
import { calculateTool } from "./tools";

export class AnalystAgent extends BaseAgent {
  readonly name = "analyst";
  readonly description = "Performs structured general analysis on any question or problem";
  readonly systemPrompt = ANALYST_SYSTEM_PROMPT;
  readonly tools = [calculateTool] as const;

  protected async execute(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    const messages: Message[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user",   content: input.task },
    ];

    const result = await runToolLoop({
      llm: this.llm,
      messages,
      tools: this.tools,
      ctx,
    });

    return { result, confidence: 0.85 };
  }
}
