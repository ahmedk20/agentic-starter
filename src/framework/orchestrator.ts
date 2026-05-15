import type {
  AgentContext,
  AgentOutput,
  CostSummary,
  LLMProvider,
  MemoryStore,
  Message,
} from "@core/types";
import { buildContext } from "@framework/context";
import { InMemoryCostTracker, type ModelPrice } from "@framework/cost-tracker";
import { AgentRegistry } from "@framework/registry";

export interface PlanStep {
  agentName: string;
  task: string;
  dependsOn?: string[]; // agent names that must complete before this step runs
}

// Discriminated union — synthesize() branches on `ok`, never duck-types on shape.
// Matches LLMResponse / Message / ContentBlock — same project-wide pattern.
export type AgentResult =
  | { agentName: string; ok: true; output: AgentOutput }
  | { agentName: string; ok: false; error: string };

export interface OrchestratorOptions {
  // Hard upper bound on each agent's wall-clock time. A wedged tool or runaway
  // tool-loop blows past 30s easily — without a cap, Promise.allSettled would still
  // wait forever for the hung step.
  agentTimeoutMs?: number;
  // Price table for cost tracking — keyed by model name. Per-deployment config; the
  // framework reads it but never imports it. Pass {} to count tokens with zero cost.
  prices?: Record<string, ModelPrice>;
  // Hard ceiling in USD per run. Omit to track without enforcement.
  budgetUsd?: number;
  // Memory backend exposed to agents via ctx.memory. Omit to give each run a fresh
  // ShortTermMemory (no persistence). Plug in SqliteLongTermMemory or similar in main.ts.
  memory?: MemoryStore;
}

// Default is intentionally generous — long enough for legitimate multi-tool agent runs,
// short enough that an infinite loop won't burn through a token budget before tripping.
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

// What every Orchestrator.run() resolves to — answer is the synthesized prose, cost is
// the per-run ledger broken down by agent and model, steps is the per-agent outcome list.
// Returning all three forces callers to see exactly what happened rather than burying
// the receipts in a side-channel log.
export interface OrchestratorResult {
  answer: string;
  cost: CostSummary;
  steps: AgentResult[];
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
  private readonly agentTimeoutMs: number;
  private readonly prices: Record<string, ModelPrice>;
  private readonly budgetUsd: number | undefined;
  private readonly memory: MemoryStore | undefined;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly llm: LLMProvider,
    opts?: OrchestratorOptions,
  ) {
    this.agentTimeoutMs = opts?.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.prices = opts?.prices ?? {};
    this.budgetUsd = opts?.budgetUsd;
    this.memory = opts?.memory;
  }

  // Public entry point — the only method callers invoke directly.
  async run(task: string, signal?: AbortSignal): Promise<OrchestratorResult> {
    const runId = crypto.randomUUID();
    // Tracker is per-run: budgets are enforced per task, and a long-running process
    // must not silently accumulate spend across unrelated calls. The same instance is
    // threaded into ctx so every provider call records and budget-checks against it.
    const costTracker = new InMemoryCostTracker({
      prices: this.prices,
      ...(this.budgetUsd !== undefined ? { budgetUsd: this.budgetUsd } : {}),
    });
    const ctx = buildContext({
      runId,
      parentAgentName: "orchestrator",
      ...(signal !== undefined ? { signal } : {}),
      costTracker,
      // If the application plugged in a long-term memory at construction time, share it
      // across every run. Omit → buildContext defaults to a fresh ShortTermMemory per run.
      ...(this.memory !== undefined ? { memory: this.memory } : {}),
    });

    ctx.logger.info("run started", { task, budgetUsd: this.budgetUsd });

    const steps = await this.plan(task, ctx);
    ctx.logger.info("plan ready", { stepCount: steps.length });

    const results = await this.dispatch(steps, ctx);
    const answer = await this.synthesize(task, results, ctx);
    const cost = costTracker.summary();

    ctx.logger.info("run complete", { totalUsd: cost.totalUsd, totalTokens: cost.totalTokens });
    return { answer, cost, steps: results };
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

    const response = await this.llm.complete(messages, { signal: ctx.signal, ctx });

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
    const completed = new Map<string, AgentResult>();
    const remaining = [...steps];

    while (remaining.length > 0) {
      // A step is ready when every declared dependency has *completed* — success or failure.
      // We decide RUN vs SKIP per-step below, after the readiness gate.
      const ready = remaining.filter(
        (step) =>
          !step.dependsOn || step.dependsOn.every((dep) => completed.has(dep)),
      );

      if (ready.length === 0) {
        // Nothing is ready but steps remain — dependency cycle or a depends-on referring
        // to an agent that was never in the plan. Fail fast with the diagnostic info.
        throw new Error(
          `Unresolvable dependencies in plan. ` +
            `Remaining steps: [${remaining.map((s) => s.agentName).join(", ")}]. ` +
            `Completed: [${[...completed.keys()].join(", ")}]`,
        );
      }

      for (const step of ready) {
        remaining.splice(remaining.indexOf(step), 1);
      }

      // allSettled — independent steps share fate only if they were already linked
      // via dependsOn. One step crashing must never abort a sibling.
      const settled = await Promise.allSettled(
        ready.map((step) => this.runStep(step, completed, ctx)),
      );

      for (const s of settled) {
        if (s.status === "fulfilled") {
          completed.set(s.value.agentName, s.value);
        } else {
          // runStep catches everything — this branch is a framework bug, not a normal failure.
          // Log loudly but don't crash; surface in synthesize() as a missing result.
          ctx.logger.error("dispatch caught an unexpected rejection", {
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          });
        }
      }
    }

    return [...completed.values()];
  }

  async synthesize(
    task: string,
    results: AgentResult[],
    ctx: AgentContext,
  ): Promise<string> {
    const successes = results.filter((r): r is Extract<AgentResult, { ok: true }> => r.ok);
    const failures = results.filter((r): r is Extract<AgentResult, { ok: false }> => !r.ok);

    if (successes.length === 0) {
      // No survivors — synthesizing over nothing would produce hallucinated prose.
      // Throw with the real failure list so the caller can act on the actual problem.
      throw new Error(
        `Run failed — every agent in the plan errored or was skipped:\n` +
          failures.map((f) => `  - ${f.agentName}: ${f.error}`).join("\n"),
      );
    }

    const agentOutputs = successes
      .map((r) => `[${r.agentName}]:\n${r.output.result}`)
      .join("\n\n");

    // Tell the model what's missing — without this it may fabricate content to fill the gap.
    const failureNote =
      failures.length > 0
        ? `\n\nNote: ${failures.length} agent(s) failed or were skipped — ` +
          failures.map((f) => `${f.agentName} (${f.error})`).join(", ")
        : "";

    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are a synthesis agent. Combine the outputs from multiple agents into one coherent, complete answer for the user. " +
          "If some agents failed, work with what you have and briefly acknowledge the gap rather than inventing missing content.",
      },
      {
        role: "user",
        content: `Original task: ${task}\n\nAgent outputs:\n${agentOutputs}${failureNote}\n\nProvide the final answer.`,
      },
    ];

    const response = await this.llm.complete(messages, { signal: ctx.signal, ctx });
    return response.kind === "text" ? response.text : agentOutputs;
  }

  // ── private ────────────────────────────────────────────────────────────────

  // Runs one step with cascade-skip + timeout + try/catch. Always resolves to an
  // AgentResult — never throws — so Promise.allSettled's rejected branch only fires
  // on a framework bug, not on normal agent failure.
  private async runStep(
    step: PlanStep,
    completed: ReadonlyMap<string, AgentResult>,
    ctx: AgentContext,
  ): Promise<AgentResult> {
    // Cascade: a step depending on a failed parent runs with corrupted upstream context.
    // Better to mark it skipped than to let it produce garbage that synthesis combines.
    const failedDeps = (step.dependsOn ?? []).filter((dep) => {
      const r = completed.get(dep);
      return r !== undefined && r.ok === false;
    });
    if (failedDeps.length > 0) {
      const reason = `skipped — upstream agent(s) failed: [${failedDeps.join(", ")}]`;
      ctx.logger.warn("agent skipped", { agent: step.agentName, reason });
      return { agentName: step.agentName, ok: false, error: reason };
    }

    // Manual cancellation chain instead of AbortSignal.any([parent, AbortSignal.timeout(...)]).
    // That composition has had reliability issues across runtimes — an explicit controller
    // with a single timer + a parent-forward listener is deterministic and lets us record
    // *which* source aborted (timeout vs parent) without inspecting other signals.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.agentTimeoutMs);

    const onParentAbort = (): void => controller.abort();
    if (ctx.signal.aborted) {
      controller.abort();
    } else {
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    }

    const childCtx: AgentContext = { ...ctx, signal: controller.signal };

    ctx.logger.info("dispatching agent", {
      agent: step.agentName,
      timeoutMs: this.agentTimeoutMs,
    });

    try {
      const agent = this.registry.get(step.agentName);
      const output = await agent.run({ task: step.task }, childCtx);
      return { agentName: step.agentName, ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn("agent failed", {
        agent: step.agentName,
        error: message,
        timedOut,
      });
      return {
        agentName: step.agentName,
        ok: false,
        error: timedOut
          ? `timed out after ${this.agentTimeoutMs}ms: ${message}`
          : message,
      };
    } finally {
      // Always release the timer and detach the parent listener — otherwise a long-running
      // process accumulates millions of dead timers and ghost listeners over many runs.
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
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
