import type { AgentContext, AgentInput, AgentOutput, Message } from "@core/types";
import { BaseAgent } from "@framework/agent";
import { runToolLoop } from "@framework/tool-loop";
import { RESEARCHER_SYSTEM_PROMPT } from "./prompts";
import { structureOutlineTool } from "./tools";

export class ResearcherAgent extends BaseAgent {
  readonly name = "researcher";
  readonly description = "Gathers and structures factual information on a topic without drawing conclusions";
  readonly systemPrompt = RESEARCHER_SYSTEM_PROMPT;
  readonly tools = [structureOutlineTool] as const;

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

    return { result, confidence: 0.8 };
  }
}
