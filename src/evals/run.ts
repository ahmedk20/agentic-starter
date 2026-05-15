// Eval runner — fake mode only.
// Wires a FakeLLMProvider + stub agents from each EvalCase's scripted data,
// runs the full orchestrator pipeline, scores the result, and prints a report.
// Run with: bun src/evals/run.ts

import type { Agent, AgentContext, AgentInput, AgentOutput } from "@core/types";
import { AgentRegistry } from "@framework/registry";
import { Orchestrator } from "@framework/orchestrator";
import type { OrchestratorResult } from "@framework/orchestrator";
import { FakeLLMProvider } from "@llm/fake";
import { EVAL_CASES, FAIL_SENTINEL } from "@evals/cases";
import type { EvalCase } from "@evals/cases";
import { scoreCase } from "@evals/scorer";
import type { ScoreResult } from "@evals/scorer";

// Minimal Agent implementation — no BaseAgent, no LLM. Returns the scripted response
// directly or throws if it sees FAIL_SENTINEL, which is what the failure-recovery
// test cases need to exercise the orchestrator's allSettled error path.
function makeStubAgent(name: string, description: string, response: string): Agent {
  return {
    name,
    description,
    async run(_input: AgentInput, _ctx: AgentContext): Promise<AgentOutput> {
      if (response === FAIL_SENTINEL) {
        throw new Error(`${name}: scripted failure`);
      }
      return { result: response, confidence: 1.0 };
    },
  };
}

// Agent descriptions used by the planner prompt — content doesn't affect fake-mode
// routing (the plan is scripted), but the registry still needs a non-empty description
// to build the agent list string. Extend when new agent names appear in EVAL_CASES.
const AGENT_DESCRIPTIONS: Record<string, string> = {
  analyst:    "Performs quantitative analysis and calculations",
  researcher: "Researches topics and compiles information",
};

async function runCase(
  evalCase: EvalCase,
): Promise<{ result: OrchestratorResult | null; score: ScoreResult; thrownError?: string }> {
  // Two scripted LLM responses per case:
  //   call 0 → plan step (returned by orchestrator.plan())
  //   call 1 → synthesis (returned by orchestrator.synthesize())
  // Stub agents bypass the LLM entirely — they never call llm.complete().
  const llm = new FakeLLMProvider([
    { kind: "text", text: JSON.stringify(evalCase.scriptedPlan) },
    { kind: "text", text: evalCase.scriptedSynthesis },
  ]);

  const registry = new AgentRegistry();
  const agentNames = new Set(evalCase.scriptedPlan.map((s) => s.agentName));
  for (const agentName of agentNames) {
    const response = evalCase.scriptedAgentResponses[agentName] ?? FAIL_SENTINEL;
    const description = AGENT_DESCRIPTIONS[agentName] ?? agentName;
    registry.register(makeStubAgent(agentName, description, response));
  }

  const orchestrator = new Orchestrator(registry, llm, { agentTimeoutMs: 5_000 });

  try {
    const result = await orchestrator.run(evalCase.task);
    return { result, score: scoreCase(evalCase, result) };
  } catch (err) {
    // synthesize() throws when every agent failed — treat as zero score.
    const message = err instanceof Error ? err.message : String(err);
    const emptyResult: OrchestratorResult = {
      answer: "",
      cost: { totalUsd: 0, totalTokens: 0, byAgent: {}, byModel: {} },
      steps: [],
    };
    return { result: null, score: scoreCase(evalCase, emptyResult), thrownError: message };
  }
}

async function main(): Promise<void> {
  type RunRecord = { case: EvalCase; score: ScoreResult; thrownError?: string };
  const records: RunRecord[] = [];

  for (const evalCase of EVAL_CASES) {
    process.stdout.write(`  running: ${evalCase.id} ... `);
    const runResult = await runCase(evalCase);
    records.push({
      case: evalCase,
      score: runResult.score,
      // exactOptionalPropertyTypes: omit the key entirely when there is no error rather
      // than setting it to undefined, which would be a type violation.
      ...(runResult.thrownError !== undefined ? { thrownError: runResult.thrownError } : {}),
    });
    process.stdout.write("done\n");
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const SEP = "─".repeat(70);
  console.log(`\n${SEP}`);
  console.log("EVAL RESULTS");
  console.log(SEP);

  let totalPass = 0;
  let totalFail = 0;

  for (const r of records) {
    // xfail: this case is expected to score as failed. The meta-criterion is that the
    // scorer correctly identifies the gap — so "case passes" means "scorer said false".
    const caseEffectivelyPassed = r.case.xfail === true ? !r.score.passed : r.score.passed;
    if (caseEffectivelyPassed) {
      totalPass++;
    } else {
      totalFail++;
    }

    const icon = caseEffectivelyPassed ? "✓" : "✗";
    const xfailTag = r.case.xfail === true ? " [xfail]" : "";
    const pct = `${Math.round(r.score.score * 100)}%`.padStart(4);
    const idLabel = `${icon} ${r.case.id}${xfailTag}`;
    console.log(`  ${idLabel.padEnd(38)} ${pct}  ${r.case.description}`);

    if (!caseEffectivelyPassed) {
      if (r.thrownError !== undefined) {
        console.log(`       ERROR: ${r.thrownError}`);
      }
      for (const c of r.score.criteria.filter((cr) => !cr.passed)) {
        console.log(`       FAIL:  ${c.detail}`);
      }
    }
  }

  console.log(SEP);
  console.log(`  ${totalPass}/${records.length} cases passed\n`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("Eval runner crashed:", err);
  process.exit(1);
});
