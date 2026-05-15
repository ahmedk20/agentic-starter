import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { AgentContext } from "@core/types";
import { NoOpCostTracker } from "@framework/cost-tracker";
import { ShortTermMemory } from "@memory/short-term";
import { defineTool } from "@framework/tool";

// Silent stub context — these tests care about validation, not observability.
function makeCtx(): AgentContext {
  return {
    runId: "t",
    parentAgentName: "t",
    depth: 0,
    state: { data: {}, update: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    tracer: {
      startSpan: () => "s",
      endSpan: () => {},
      recordToolCall: () => {},
      getEvents: () => [],
    },
    signal: new AbortController().signal,
    costTracker: new NoOpCostTracker(),
    memory: new ShortTermMemory(),
  };
}

describe("defineTool", () => {
  it("validates input and passes the parsed value to execute", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echoes",
      schema: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    expect(await tool.execute({ value: "hello" }, makeCtx())).toBe("HELLO");
  });

  it("throws a plain Error on invalid input — tool-loop catches and surfaces to the model", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echoes",
      schema: z.object({ value: z.string() }),
      async execute({ value }) {
        return value;
      },
    });

    // Wrong type — Zod's path:message format must appear in the thrown error so the model can self-correct.
    await expect(tool.execute({ value: 42 }, makeCtx())).rejects.toThrow(/Invalid tool input/);
    await expect(tool.execute({ value: 42 }, makeCtx())).rejects.toThrow(/value/);
    // Missing required field — must also throw, not silently call execute with undefined.
    await expect(tool.execute({}, makeCtx())).rejects.toThrow(/Invalid tool input/);
  });

  it("derives a JSON Schema with descriptions and required fields", () => {
    const tool = defineTool({
      name: "echo",
      description: "echoes",
      schema: z.object({
        value: z.string().describe("the thing to echo"),
      }),
      async execute({ value }) {
        return value;
      },
    });

    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        value: { type: "string", description: "the thing to echo" },
      },
      required: ["value"],
    });
    // $schema would leak the JSON-Schema spec URL into the LLM's tool definition —
    // strict OpenAI validators have rejected it in the past, so defineTool strips it.
    expect(tool.inputSchema).not.toHaveProperty("$schema");
  });

  it("rejects extra properties when schema is .strict()", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echoes",
      schema: z.object({ value: z.string() }).strict(),
      async execute({ value }) {
        return value;
      },
    });

    await expect(
      tool.execute({ value: "ok", extra: "nope" }, makeCtx()),
    ).rejects.toThrow(/Invalid tool input/);
  });
});
