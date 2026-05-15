// Composition root — the only file that knows about every concrete type.
// If a dependency is wired incorrectly, this is the only place to look.
import { AnalystAgent } from "@agents/analyst";
import { ResearcherAgent } from "@agents/researcher";
import { env } from "@config/env";
import { PRICES } from "@config/models";
import { Orchestrator } from "@framework/orchestrator";
import { AgentRegistry } from "@framework/registry";
import { OpenAIProvider } from "@llm/openai-provider";
import { SqliteLongTermMemory } from "@memory/sqlite";

// ── Build the dependency graph ───────────────────────────────────────────────

const llm      = new OpenAIProvider(env.openaiKey, env.model);
// Long-term memory persists across runs — a file-backed knowledge base shared by every
// agent in this composition. Namespace "shared" because the current demo agents collaborate
// on one task; per-agent namespaces would mean swapping this for a withNamespace() wrapper.
const memory   = new SqliteLongTermMemory("shared", "./.agent-memory.db");
const registry = new AgentRegistry();

registry.register(new AnalystAgent(llm));
registry.register(new ResearcherAgent(llm));

// Budget cap is intentionally conservative for a demo. Raise via env var when running
// production workloads. budgetUsd: undefined would disable the ceiling entirely.
const orchestrator = new Orchestrator(registry, llm, {
  prices: PRICES,
  budgetUsd: 1.0,
  memory,
});

// ── Run ──────────────────────────────────────────────────────────────────────

// Accept the task from the command line or fall back to a default for quick testing.
const task =
  process.argv[2] ??
  "Analyse the tradeoffs between SQL and NoSQL databases for a high-traffic web application.";

console.log(`\nTask: ${task}\n`);

try {
  const { answer, cost } = await orchestrator.run(task);

  console.log("\n── Final Answer ──────────────────────────────────────────────────\n");
  console.log(answer);
  console.log("\n── Cost ──────────────────────────────────────────────────────────\n");
  console.log(`Total: $${cost.totalUsd.toFixed(4)}  (${cost.totalTokens} tokens)`);
  for (const [agent, { tokens, usd }] of Object.entries(cost.byAgent)) {
    console.log(`  ${agent.padEnd(16)} $${usd.toFixed(4)}  (${tokens} tokens)`);
  }
} finally {
  // SQLite holds an open file handle — release it so the process exits cleanly.
  await memory.close();
}
