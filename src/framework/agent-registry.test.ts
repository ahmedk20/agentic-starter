import { describe, expect, it } from "bun:test";
import type { Agent, AgentContext, AgentInput, AgentOutput } from "@core/types";
import { AgentRegistry } from "@framework/registry";

// Minimal Agent stub — satisfies the interface without importing BaseAgent.
// Each test gets a fresh instance via makeAgent() so there's zero shared state.
function makeAgent(name: string): Agent {
  return {
    name,
    description: `${name} stub`,
    async run(_input: AgentInput, _ctx: AgentContext): Promise<AgentOutput> {
      return { result: `${name} result`, confidence: 1 };
    },
  };
}

describe("AgentRegistry", () => {
  it("retrieves the exact instance that was registered", () => {
    const registry = new AgentRegistry();
    const agent = makeAgent("analyst");
    registry.register(agent);
    // toBe checks reference equality — not just same shape, same object.
    expect(registry.get("analyst")).toBe(agent);
  });

  it("throws on duplicate registration", () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent("analyst"));
    expect(() => registry.register(makeAgent("analyst"))).toThrow(
      `Agent "analyst" is already registered`,
    );
  });

  it("throws when getting an agent that was never registered", () => {
    const registry = new AgentRegistry();
    expect(() => registry.get("unknown")).toThrow(`Agent "unknown" is not registered`);
  });

  it("list() returns names in insertion order", () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent("analyst"));
    registry.register(makeAgent("researcher"));
    registry.register(makeAgent("trader"));
    expect(registry.list()).toEqual(["analyst", "researcher", "trader"]);
  });

  it("each registry instance is fully isolated", () => {
    const registryA = new AgentRegistry();
    const registryB = new AgentRegistry();
    registryA.register(makeAgent("analyst"));
    // registryB has no agents — registryA's state must not leak.
    expect(() => registryB.get("analyst")).toThrow();
    expect(registryB.list()).toEqual([]);
  });
});
