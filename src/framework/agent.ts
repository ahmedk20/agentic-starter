import type {
  Agent,
  AgentContext,
  AgentInput,
  AgentOutput,
  LLMProvider,
  Tool,
} from "@core/types";
import { AgentCancelledError, AgentError, BudgetExceededError } from "@framework/errors";

export abstract class BaseAgent implements Agent {
  // Subclasses declare these as readonly class fields — no constructor argument needed.
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly systemPrompt: string;
  abstract readonly tools: readonly Tool[];

  // LLMProvider is injected — BaseAgent never constructs one itself.
  constructor(protected readonly llm: LLMProvider) {}

  // run() is the template: fixed sequence every agent follows.
  // Subclasses implement execute(), not run() — they get logging, tracing, and error
  // wrapping for free without writing any of it themselves.
  async run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    // Check abort before doing any work — honours orchestrator cancellation immediately.
    if (ctx.signal.aborted) {
      throw new AgentCancelledError(this.name);
    }

    // Child context: this is where attribution becomes correct. The parent ctx was built
    // with parentAgentName = "orchestrator"; downstream tools and LLM calls should now see
    // *this agent's* name so cost tracking, logging, and traces attribute to the real owner.
    // depth increments here so future recursion-depth guards have a real counter to read.
    const childCtx: AgentContext = {
      ...ctx,
      parentAgentName: this.name,
      depth: ctx.depth + 1,
    };

    const spanId = ctx.tracer.startSpan(this.name, ctx.runId, input);
    const startedAt = Date.now();

    ctx.logger.info("agent started", { agent: this.name, task: input.task });

    try {
      const output = await this.execute(input, childCtx);
      const durationMs = Date.now() - startedAt;

      ctx.tracer.endSpan(spanId, output, durationMs);
      ctx.logger.info("agent finished", { agent: this.name, durationMs, confidence: output.confidence });

      return output;
    } catch (err) {
      const durationMs = Date.now() - startedAt;

      // Re-throw typed errors unchanged — AgentError carries agentName, BudgetExceededError
      // carries cost info. Wrapping either would erase the type info the orchestrator needs
      // to decide how to respond (retry vs abort vs surface to user).
      if (err instanceof AgentError || err instanceof BudgetExceededError) {
        ctx.logger.error("agent failed", { agent: this.name, error: err.message, durationMs });
        ctx.tracer.endSpan(spanId, { result: err.message, confidence: 0 }, durationMs);
        throw err;
      }

      // Unknown errors from execute() — wrap so the orchestrator always gets an agentName.
      const wrapped = new AgentError(
        err instanceof Error ? err.message : String(err),
        this.name,
      );
      ctx.logger.error("agent failed", { agent: this.name, error: wrapped.message, durationMs });
      ctx.tracer.endSpan(spanId, { result: wrapped.message, confidence: 0 }, durationMs);
      throw wrapped;
    }
  }

  // The only method subclasses implement — pure agent logic, no logging, no error wrapping.
  protected abstract execute(input: AgentInput, ctx: AgentContext): Promise<AgentOutput>;
}
