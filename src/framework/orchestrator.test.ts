import { describe, expect, it } from "bun:test";
import type { Agent, AgentContext, AgentInput, AgentOutput } from "@core/types";
import { FakeLLMProvider } from "@llm/fake";
import { Orchestrator } from "@framework/orchestrator";
import { AgentRegistry } from "@framework/registry";

// Behaviours we need: succeed, fail, hang-until-abort. Each makes a different
// dispatch path observable from outside.
type Behavior =
  | { kind: "ok"; result: string }
  | { kind: "fail"; error: string }
  | { kind: "hang" };

function makeAgent(name: string, behavior: Behavior): Agent {
  return {
    name,
    description: `${name} stub`,
    async run(_input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
      if (behavior.kind === "fail") throw new Error(behavior.error);
      if (behavior.kind === "hang") {
        // Resolve only when the child signal aborts — proves the timeout actually reaches the agent.
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted by signal")),
            { once: true },
          );
        });
        throw new Error("unreachable — hang() always rejects via abort");
      }
      return { result: behavior.result, confidence: 1 };
    },
  };
}

function planText(steps: Array<{ agentName: string; task: string; dependsOn?: string[] }>): string {
  return JSON.stringify(steps);
}

describe("Orchestrator.dispatch", () => {
  it("runs a single-step plan end-to-end", async () => {
    const llm = new FakeLLMProvider([
      { kind: "text", text: planText([{ agentName: "analyst", task: "do it" }]) },
      { kind: "text", text: "FINAL" },
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("analyst", { kind: "ok", result: "analyst result" }));

    const orch = new Orchestrator(registry, llm);
    expect((await orch.run("t")).answer).toBe("FINAL");
  });

  it("synthesizes survivors when one of two independent agents fails", async () => {
    // Without allSettled, beta's throw would reject Promise.all and the whole run dies.
    // The test passes only if allSettled is in place.
    const llm = new FakeLLMProvider([
      {
        kind: "text",
        text: planText([
          { agentName: "alpha", task: "..." },
          { agentName: "beta", task: "..." },
        ]),
      },
      { kind: "text", text: "PARTIAL-FINAL" },
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("alpha", { kind: "ok", result: "alpha works" }));
    registry.register(makeAgent("beta", { kind: "fail", error: "beta broken" }));

    const orch = new Orchestrator(registry, llm);
    expect((await orch.run("t")).answer).toBe("PARTIAL-FINAL");

    // Synthesis must have seen alpha's output AND been told about beta's failure.
    const synthCall = llm.calls[1]!;
    const userMsg = synthCall.messages.find((m) => m.role === "user");
    const text = userMsg && typeof userMsg.content === "string" ? userMsg.content : "";
    expect(text).toContain("alpha works");
    expect(text).toContain("beta");
    expect(text).toContain("failed");
  });

  it("skips a dependent step when its parent failed (cascade)", async () => {
    let childRan = false;
    const llm = new FakeLLMProvider([
      {
        kind: "text",
        text: planText([
          { agentName: "parent", task: "..." },
          { agentName: "child", task: "...", dependsOn: ["parent"] },
        ]),
      },
      // No synthesis response — every step fails, so run() must throw before synthesis.
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("parent", { kind: "fail", error: "parent broken" }));
    registry.register({
      name: "child",
      description: "child",
      async run() {
        childRan = true;
        return { result: "child ran", confidence: 1 };
      },
    });

    const orch = new Orchestrator(registry, llm);
    await expect(orch.run("t")).rejects.toThrow(/every agent in the plan errored/);
    expect(childRan).toBe(false);
  });

  it("times out a hanging agent without blocking its sibling", async () => {
    const llm = new FakeLLMProvider([
      {
        kind: "text",
        text: planText([
          { agentName: "fast", task: "..." },
          { agentName: "slow", task: "..." },
        ]),
      },
      { kind: "text", text: "FINAL" },
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("fast", { kind: "ok", result: "fast result" }));
    registry.register(makeAgent("slow", { kind: "hang" }));

    // 50ms timeout — fast resolves immediately, slow is aborted by AbortSignal.timeout.
    const orch = new Orchestrator(registry, llm, { agentTimeoutMs: 50 });
    expect((await orch.run("t")).answer).toBe("FINAL");

    // The synthesis prompt should mention the timeout failure for the slow agent.
    const synthCall = llm.calls[1]!;
    const userMsg = synthCall.messages.find((m) => m.role === "user");
    const text = userMsg && typeof userMsg.content === "string" ? userMsg.content : "";
    expect(text).toContain("fast result");
    expect(text).toContain("slow");
    expect(text).toMatch(/timed out/);
  });

  it("returns a cost summary even on a happy-path run (NoOp-free path)", async () => {
    // No price table → all costs are $0, but token counting + per-agent attribution must still
    // populate the summary. This is the regression net for "did we forget to thread the tracker?"
    const llm = new FakeLLMProvider([
      { kind: "text", text: planText([{ agentName: "analyst", task: "..." }]) },
      { kind: "text", text: "FINAL" },
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("analyst", { kind: "ok", result: "ok" }));

    const orch = new Orchestrator(registry, llm);
    const { cost } = await orch.run("t");
    // FakeLLMProvider returns no usage data, so totals stay at 0 — but the summary shape must exist.
    expect(cost).toMatchObject({
      totalUsd: 0,
      totalTokens: 0,
      byAgent: expect.any(Object),
      byModel: expect.any(Object),
    });
  });

  it("throws cleanly when every step fails (no survivors to synthesize)", async () => {
    const llm = new FakeLLMProvider([
      {
        kind: "text",
        text: planText([
          { agentName: "alpha", task: "..." },
          { agentName: "beta", task: "..." },
        ]),
      },
    ]);
    const registry = new AgentRegistry();
    registry.register(makeAgent("alpha", { kind: "fail", error: "a broken" }));
    registry.register(makeAgent("beta", { kind: "fail", error: "b broken" }));

    const orch = new Orchestrator(registry, llm);
    await expect(orch.run("t")).rejects.toThrow(/every agent in the plan errored/);
  });
});
