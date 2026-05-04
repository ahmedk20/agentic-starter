import type { Agent } from "@core/types";

export class AgentRegistry {
  // Plain instance Map — no static fields, no getInstance().
  // One registry per orchestrator, created in main.ts and injected via constructor.
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.name)) {
      // Throw, never silently overwrite — a duplicate name is a wiring bug, not a recoverable state.
      throw new Error(
        `Agent "${agent.name}" is already registered. Each agent name must be unique.`,
      );
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): Agent {
    const agent = this.agents.get(name);
    if (!agent) {
      // Throw here rather than returning undefined — fail at the boundary with a clear message
      // instead of crashing later with "cannot read properties of undefined (reading 'run')".
      throw new Error(
        `Agent "${name}" is not registered. Registered agents: [${this.list().join(", ")}]`,
      );
    }
    return agent;
  }

  list(): string[] {
    // Map preserves insertion order — list() is deterministic, safe to use in tests and planner prompts.
    return Array.from(this.agents.keys());
  }
}
