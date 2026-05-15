import { describe, expect, it } from "bun:test";
import type { AgentContext, Tool } from "@core/types";
import { NoOpCostTracker } from "@framework/cost-tracker";
import { FakeLLMProvider } from "@llm/fake";
import { runToolLoop } from "@framework/tool-loop";

// Silent stub context — keeps test output clean, only care about return values here.
function makeCtx(): AgentContext {
  return {
    runId: "test-run",
    parentAgentName: "test",
    depth: 0,
    state: { data: {}, update: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    tracer: {
      startSpan: () => "span",
      endSpan: () => {},
      recordToolCall: () => {},
      getEvents: () => [],
    },
    signal: new AbortController().signal,
    costTracker: new NoOpCostTracker(),
  };
}

function makeTool(name: string, result: unknown, throws?: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {},
    async execute() {
      if (throws) throw new Error(throws);
      return result;
    },
  };
}

describe("runToolLoop", () => {
  it("returns text immediately when the model does not call any tools", async () => {
    const llm = new FakeLLMProvider([{ kind: "text", text: "done" }]);
    const result = await runToolLoop({ llm, messages: [], tools: [], ctx: makeCtx() });
    expect(result).toBe("done");
  });

  it("executes a tool and returns the model's follow-up text", async () => {
    const llm = new FakeLLMProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: "search", input: { q: "Paris" } }] },
      { kind: "text", text: "Paris is the capital of France" },
    ]);
    const search = makeTool("search", "Paris, France");

    const result = await runToolLoop({
      llm,
      messages: [],
      tools: [search],
      ctx: makeCtx(),
    });

    expect(result).toBe("Paris is the capital of France");
    // The second LLM call must include the tool result in its messages.
    const secondCall = llm.calls[1];
    expect(secondCall).toBeDefined();
    const lastMsg = secondCall!.messages.at(-1);
    expect(lastMsg?.role).toBe("tool");
  });

  it("converts tool errors into error messages — does not throw", async () => {
    const llm = new FakeLLMProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: "search", input: {} }] },
      { kind: "text", text: "I could not search, here is what I know anyway" },
    ]);
    const brokenSearch = makeTool("search", null, "network timeout");

    const result = await runToolLoop({
      llm,
      messages: [],
      tools: [brokenSearch],
      ctx: makeCtx(),
    });

    expect(result).toBe("I could not search, here is what I know anyway");
    // The tool result sent to the model must contain the error text.
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("network timeout");
  });

  it("handles an unknown tool name gracefully", async () => {
    const llm = new FakeLLMProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: "nonexistent", input: {} }] },
      { kind: "text", text: "ok" },
    ]);

    const result = await runToolLoop({ llm, messages: [], tools: [], ctx: makeCtx() });
    expect(result).toBe("ok");

    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.role === "tool" && toolMsg.content).toContain("not available");
  });

  it("throws when maxIterations is exceeded", async () => {
    // Model always wants another tool — never returns text.
    const llm = new FakeLLMProvider(
      Array.from({ length: 5 }, () => ({
        kind: "tool_use" as const,
        calls: [{ id: "c1", name: "search", input: {} }],
      })),
    );
    const search = makeTool("search", "result");

    await expect(
      runToolLoop({ llm, messages: [], tools: [search], ctx: makeCtx(), maxIterations: 3 }),
    ).rejects.toThrow("maxIterations");
  });

  it("runs multiple parallel tool calls and appends all results", async () => {
    const llm = new FakeLLMProvider([
      {
        kind: "tool_use",
        calls: [
          { id: "c1", name: "search", input: {} },
          { id: "c2", name: "calc", input: {} },
        ],
      },
      { kind: "text", text: "combined" },
    ]);

    const result = await runToolLoop({
      llm,
      messages: [],
      tools: [makeTool("search", "search result"), makeTool("calc", "42")],
      ctx: makeCtx(),
    });

    expect(result).toBe("combined");
    // Both tool results must appear in the second call's messages.
    const secondMessages = llm.calls[1]!.messages;
    const toolMessages = secondMessages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });
});
