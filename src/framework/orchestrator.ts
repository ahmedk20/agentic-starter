import type { AgentContext, AgentOutput, LLMProvider, Message } from "@core/types";
import { buildContext } from "@framework/context";
import { AgentRegistry } from "@framework/registry";

export interface PlanStep {
  agentName: string;
  task: string;
  dependsOn?: string[]; // agent names that must complete before this step runs
}

interface AgentResult {
  agentName: string;
  output: AgentOutput;
}

// Generic planning prompt — no domain knowledge, no business logic.
// The model learns what agents can do from the descriptions passed at runtime.
const PLANNER_PROMPT = `You are an AI orchestrator. Given a task and a list of agents, produce an execution plan.

Return a JSON array only — no markdown fences, no explanation. Each element:
{
  "agentName": "exact agent name from the list",
  "task": "specific instruction for this agent",
  "dependsOn": ["agentName"]   // optional — omit if this step has no dependencies
}

Rules:
- Only use agent names from the provided list.
- Use dependsOn only when an agent truly needs another agent's output to do its job.
- Omit dependsOn for independent steps — they will run in parallel.`;

export class Orchestrator {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly llm: LLMProvider,
  ) {}

  // Public entry point — the only method callers invoke directly.
  async run(task: string, signal?: AbortSignal): Promise<string> {
    const runId = crypto.randomUUID();
    const ctx = buildContext({
      runId,
      parentAgentName: "orchestrator",
      ...(signal !== undefined ? { signal } : {}),
    });

    ctx.logger.info("run started", { task });

    const steps = await this.plan(task, ctx);
    ctx.logger.info("plan ready", { stepCount: steps.length });

    const results = await this.dispatch(steps, ctx);
    const answer = await this.synthesize(task, results, ctx);

    ctx.logger.info("run complete");
    return answer;
  }

  async plan(task: string, ctx: AgentContext): Promise<PlanStep[]> {
    const agentList = this.registry
      .list()
      .map((name) => `- ${name}: ${this.registry.get(name).description}`)
      .join("\n");

    const messages: Message[] = [
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: `Agents:\n${agentList}\n\nTask: ${task}` },
    ];

    const response = await this.llm.complete(messages, { signal: ctx.signal });

    if (response.kind !== "text") {
      ctx.logger.warn("planner returned tool_use unexpectedly — using fallback plan");
      return this.fallbackPlan(task);
    }

    try {
      const raw = JSON.parse(extractJSON(response.text)) as unknown;
      if (!Array.isArray(raw)) throw new Error("plan is not an array");
      return raw.map(parseStep);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't crash on a bad plan — run all agents in parallel and let them sort it out.
      ctx.logger.warn("plan parsing failed — using fallback", { error: message });
      return this.fallbackPlan(task);
    }
  }

  async dispatch(steps: PlanStep[], ctx: AgentContext): Promise<AgentResult[]> {
    const completed = new Map<string, AgentOutput>();
    const allResults: AgentResult[] = [];
    const remaining = [...steps];

    while (remaining.length > 0) {
      // A step is ready when all its declared dependencies have finished.
      const ready = remaining.filter(
        (step) =>
          !step.dependsOn || step.dependsOn.every((dep) => completed.has(dep)),
      );

      if (ready.length === 0) {
        // Nothing is ready but steps remain — dependency cycle or missing agent name.
        throw new Error(
          `Unresolvable dependencies in plan. ` +
            `Remaining steps: [${remaining.map((s) => s.agentName).join(", ")}]. ` +
            `Completed: [${[...completed.keys()].join(", ")}]`,
        );
      }

      for (const step of ready) {
        remaining.splice(remaining.indexOf(step), 1);
      }

      // Independent steps run in parallel — never serialize agents that don't need to wait.
      const results = await Promise.all(
        ready.map(async (step) => {
          ctx.logger.info("dispatching agent", { agent: step.agentName });
          const agent = this.registry.get(step.agentName);
          const output = await agent.run({ task: step.task }, ctx);
          return { agentName: step.agentName, output };
        }),
      );

      for (const result of results) {
        completed.set(result.agentName, result.output);
        allResults.push(result);
      }
    }

    return allResults;
  }

  async synthesize(
    task: string,
    results: AgentResult[],
    ctx: AgentContext,
  ): Promise<string> {
    const agentOutputs = results
      .map((r) => `[${r.agentName}]:\n${r.output.result}`)
      .join("\n\n");

    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are a synthesis agent. Combine the outputs from multiple agents into one coherent, complete answer for the user.",
      },
      {
        role: "user",
        content: `Original task: ${task}\n\nAgent outputs:\n${agentOutputs}\n\nProvide the final answer.`,
      },
    ];

    const response = await this.llm.complete(messages, { signal: ctx.signal });
    return response.kind === "text" ? response.text : agentOutputs;
  }

  // Fallback: run every registered agent in parallel with the original task.
  // Used when plan() fails to parse a valid plan from the LLM.
  private fallbackPlan(task: string): PlanStep[] {
    return this.registry.list().map((name) => ({ agentName: name, task }));
  }
}

// ── module-private helpers ───────────────────────────────────────────────────

// Strips markdown code fences the model sometimes wraps JSON in.
function extractJSON(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? text.trim();
}

function parseStep(raw: unknown): PlanStep {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`step is not an object: ${JSON.stringify(raw)}`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s["agentName"] !== "string") throw new Error("step missing agentName");
  if (typeof s["task"] !== "string") throw new Error("step missing task");

  return {
    agentName: s["agentName"],
    task: s["task"],
    // Conditionally include dependsOn so the field is absent (not undefined) when omitted.
    ...(Array.isArray(s["dependsOn"])
      ? { dependsOn: s["dependsOn"].filter((d): d is string => typeof d === "string") }
      : {}),
  };
}
