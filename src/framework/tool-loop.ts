import type { AgentContext, LLMProvider, Message, Tool } from "@core/types";

export interface ToolLoopOptions {
  llm: LLMProvider;
  messages: Message[];
  tools: readonly Tool[];
  ctx: AgentContext;
  maxIterations?: number;
}

export async function runToolLoop({
  llm,
  messages,
  tools,
  ctx,
  maxIterations = 10,
}: ToolLoopOptions): Promise<string> {
  // Own copy of the history — callers keep their original array, the loop mutates its own.
  const history: Message[] = [...messages];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // LLM errors are intentionally NOT caught here — they bubble up to BaseAgent.run()
    // which wraps them as AgentError. Swallowing them here would hide real failures.
    // Passing ctx (not just signal) lets the provider record token usage to ctx.costTracker
    // and check the budget cap before firing the request.
    const response = await llm.complete(history, { tools, signal: ctx.signal, ctx });

    if (response.kind === "text") {
      return response.text;
    }

    // Append the assistant's tool_use message BEFORE tool results.
    // OpenAI requires each tool_call_id in a tool result to match a tool_use block
    // that appeared earlier in the conversation — out-of-order messages are rejected.
    history.push({
      role: "assistant",
      content: response.calls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    });

    // Execute all tool calls in parallel — the model may request several independent tools
    // (e.g. search + calculator) and there is no reason to serialize them.
    const toolMessages = await Promise.all(
      response.calls.map((call) =>
        executeToolCall(call.name, call.id, call.input, tools, ctx),
      ),
    );

    history.push(...toolMessages);
  }

  // Reaching here means the model kept calling tools past the limit.
  // This is always a bug — either in the prompt, the tool outputs, or a misbehaving model.
  throw new Error(
    `runToolLoop exceeded maxIterations (${maxIterations}). ` +
      `The model may be stuck in a cycle. Check tool outputs and system prompt.`,
  );
}

// ── private helper ───────────────────────────────────────────────────────────

async function executeToolCall(
  name: string,
  id: string,
  input: unknown,
  tools: readonly Tool[],
  ctx: AgentContext,
): Promise<Message & { role: "tool" }> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    ctx.logger.warn("unknown tool requested by model", { tool: name });
    return {
      role: "tool",
      content: `Error: tool "${name}" is not available. Available tools: [${tools.map((t) => t.name).join(", ")}]`,
      tool_call_id: id,
    };
  }

  const startedAt = Date.now();

  try {
    const result = await tool.execute(input, ctx);
    const durationMs = Date.now() - startedAt;
    ctx.logger.debug("tool succeeded", { tool: name, durationMs });

    return {
      role: "tool",
      content: typeof result === "string" ? result : JSON.stringify(result),
      tool_call_id: id,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    // Tool errors are caught per-call — one failing tool doesn't abort the whole agent.
    // The model receives the error text and can recover: retry, use a different tool, or explain the failure.
    ctx.logger.warn("tool failed", { tool: name, error: message, durationMs });

    return {
      role: "tool",
      content: `Error: ${message}`,
      tool_call_id: id,
    };
  }
}
