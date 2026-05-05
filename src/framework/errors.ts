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
