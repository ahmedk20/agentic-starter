// Composition root — the only file that knows about every concrete type.
// If a dependency is wired incorrectly, this is the only place to look.
import { AnalystAgent } from "@agents/analyst";
import { env } from "@config/env";
import { buildContext } from "@framework/context";
import { Orchestrator } from "@framework/orchestrator";
import { AgentRegistry } from "@framework/registry";
import { OpenAIProvider } from "@llm/openai-provider";
import { ShortTermMemory } from "@memory/short-term";

// ── Build the dependency graph ───────────────────────────────────────────────

const llm      = new OpenAIProvider(env.openaiKey, env.model);
const memory   = new ShortTermMemory(); // available for agents that need cross-step state
const registry = new AgentRegistry();

registry.register(new AnalystAgent(llm));

const orchestrator = new Orchestrator(registry, llm);

// ── Run ──────────────────────────────────────────────────────────────────────

// Accept the task from the command line or fall back to a default for quick testing.
const task =
  process.argv[2] ??
  "Analyse the tradeoffs between SQL and NoSQL databases for a high-traffic web application.";

console.log(`\nTask: ${task}\n`);

const answer = await orchestrator.run(task);

console.log("\n── Final Answer ──────────────────────────────────────────────────\n");
console.log(answer);
