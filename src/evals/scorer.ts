import type { OrchestratorResult } from "@framework/orchestrator";
import type { EvalCase } from "@evals/cases";

export interface CriterionResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScoreResult {
  caseId: string;
  // True when every criterion passes. For xfail cases the runner inverts this to
  // determine whether the overall case "passed" — see run.ts.
  passed: boolean;
  score: number; // 0.0–1.0 fraction of criteria that passed
  criteria: CriterionResult[];
}

// Returns per-criterion pass/fail for one completed eval case. Does not know about
// xfail — that inversion is the runner's job so this function stays pure and testable.
export function scoreCase(evalCase: EvalCase, result: OrchestratorResult): ScoreResult {
  const criteria: CriterionResult[] = [];

  // Agent-dispatch criteria: each expectedAgent must appear in steps with ok: true.
  // Extra agents are allowed (the orchestrator may have run more than expected).
  for (const agentName of evalCase.expectedAgents) {
    const step = result.steps.find((s) => s.agentName === agentName);
    let passed: boolean;
    let detail: string;

    if (step === undefined) {
      passed = false;
      detail = `${agentName} was never dispatched`;
    } else if (!step.ok) {
      passed = false;
      // TypeScript narrows step to the ok:false branch here, so step.error is safe.
      detail = `${agentName} was dispatched but failed: ${step.error}`;
    } else {
      passed = true;
      detail = `${agentName} dispatched and succeeded`;
    }

    criteria.push({ name: `agent:${agentName}`, passed, detail });
  }

  // Keyword-coverage criteria: each expected keyword must appear as a substring in the answer.
  // Case-sensitive so that "Cache-Control" ≠ "cache-control" — the model must produce exact terms.
  for (const keyword of evalCase.expectedKeywords) {
    const passed = result.answer.includes(keyword);
    criteria.push({
      name: `keyword:${keyword}`,
      passed,
      detail: passed
        ? `"${keyword}" found in answer`
        : `"${keyword}" missing from answer`,
    });
  }

  const passCount = criteria.filter((c) => c.passed).length;
  const score = criteria.length > 0 ? passCount / criteria.length : 1.0;
  const passed = criteria.every((c) => c.passed);

  return { caseId: evalCase.id, passed, score, criteria };
}
