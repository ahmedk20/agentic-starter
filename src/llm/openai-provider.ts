import OpenAI from "openai";
import type {
  LLMCompleteOptions,
  LLMProvider,
  LLMResponse,
  Message,
  Tool,
} from "@core/types";

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({
      apiKey,
      // SDK retries 429 and 5xx automatically — we don't catch those ourselves.
      maxRetries: 3,
    });
  }

  async complete(messages: Message[], opts?: LLMCompleteOptions): Promise<LLMResponse> {
    // Budget check fires BEFORE the request — once we've sent the request the dollars are
    // already spent. Throws BudgetExceededError, which BaseAgent.run() re-throws unchanged.
    opts?.ctx?.costTracker.assertWithinBudget();

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAIMessages(messages),
        // exactOptionalPropertyTypes requires fields to be absent, not undefined, when unset.
        ...(opts?.tools     ? { tools:      toOpenAITools(opts.tools) }  : {}),
        ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      // signal lives in the request options, not the body — this is how the SDK wires AbortSignal.
      { signal: opts?.signal },
    );

    // Record usage post-flight. parentAgentName is the *calling* agent's name — set by
    // BaseAgent.run() when it built the child ctx — so attribution lands on the real owner,
    // not on "orchestrator" which is only the root context's name.
    if (opts?.ctx && response.usage) {
      opts.ctx.costTracker.record(opts.ctx.parentAgentName, this.model, {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      });
    }

    const message = response.choices[0]?.message;
    if (!message) throw new Error("OpenAI returned no choices");

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        kind: "tool_use",
        calls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          // arguments is always a JSON string from the API — parse once here, never elsewhere.
          input: JSON.parse(tc.function.arguments) as unknown,
        })),
      };
    }

    return { kind: "text", text: message.content ?? "" };
  }

  async *stream(messages: Message[], opts?: LLMCompleteOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAIMessages(messages),
        stream: true,
      },
      { signal: opts?.signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async tokenCount(messages: Message[]): Promise<number> {
    // OpenAI has no standalone count endpoint — 4 chars ≈ 1 token is a safe approximation
    // for planning purposes. Replace with tiktoken if exact counts become critical.
    const text = messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    return Math.ceil(text.length / 4);
  }
}

// ── Translation helpers (module-private) ────────────────────────────────────

function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((msg): OpenAI.Chat.ChatCompletionMessageParam => {
    if (msg.role === "system") return { role: "system", content: msg.content };
    if (msg.role === "user")   return { role: "user",   content: msg.content };
    if (msg.role === "tool")   return { role: "tool",   content: msg.content, tool_call_id: msg.tool_call_id };

    // assistant — may be plain text or an array of ContentBlocks
    if (typeof msg.content === "string") {
      return { role: "assistant", content: msg.content };
    }

    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length > 0) {
      return {
        role: "assistant",
        // OpenAI requires content: null when tool_calls is present.
        content: null,
        tool_calls: toolUseBlocks.map((b) => {
          if (b.type !== "tool_use") throw new Error("invariant: filtered above");
          return {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          };
        }),
      };
    }

    // text-only ContentBlock array — flatten to a single string
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return { role: "assistant", content: text };
  });
}

function toOpenAITools(tools: readonly Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
