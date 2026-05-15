export class AgentError extends Error {
  constructor(
    message: string,
    readonly agentName: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

// Thrown by BaseAgent.run() when ctx.signal is already aborted before execute() starts.
// Extends AgentError so the orchestrator can catch one type and still read agentName.
export class AgentCancelledError extends AgentError {
  constructor(agentName: string) {
    super(`Agent "${agentName}" was cancelled before execution started`, agentName);
    this.name = "AgentCancelledError";
  }
}

// Thrown by an LLMProvider when the run's accumulated cost has reached the budget.
// Does NOT extend AgentError — it can fire on the orchestrator's own plan/synthesize calls
// where there is no agent. BaseAgent.run() re-throws this unchanged (same pattern as
// AgentError) so the typed information survives the agent boundary.
export class BudgetExceededError extends Error {
  constructor(
    readonly currentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Budget exceeded — accumulated $${currentUsd.toFixed(4)} reached cap $${budgetUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}
