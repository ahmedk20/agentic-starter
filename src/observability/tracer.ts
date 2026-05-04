import type { AgentInput, AgentOutput, TraceCollector, TraceEvent } from "@core/types";

export class ConsoleTraceCollector implements TraceCollector {
  private readonly events: TraceEvent[] = [];

  // spanId → {agentName, runId} — endSpan and recordToolCall only receive spanId,
  // but TraceEvent requires all three fields, so we store the mapping here.
  private readonly spans = new Map<string, { agentName: string; runId: string }>();

  startSpan(agentName: string, runId: string, input: AgentInput): string {
    const spanId = crypto.randomUUID();
    this.spans.set(spanId, { agentName, runId });

    const event: TraceEvent = {
      spanId,
      agentName,
      runId,
      kind: "agent_start",
      payload: { input },
    };
    this.record(event);
    return spanId;
  }

  endSpan(spanId: string, output: AgentOutput, durationMs: number): void {
    const span = this.spans.get(spanId) ?? { agentName: "unknown", runId: "unknown" };
    const event: TraceEvent = {
      spanId,
      ...span,
      kind: "agent_end",
      durationMs,
      payload: { output },
    };
    this.record(event);
  }

  recordToolCall(
    spanId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    durationMs: number,
  ): void {
    const span = this.spans.get(spanId) ?? { agentName: "unknown", runId: "unknown" };
    const event: TraceEvent = {
      spanId,
      ...span,
      kind: "tool_call",
      durationMs,
      payload: { toolName, input, output },
    };
    this.record(event);
  }

  getEvents(): readonly TraceEvent[] {
    return this.events;
  }

  private record(event: TraceEvent): void {
    this.events.push(event);
    console.log(JSON.stringify({ trace: event, ts: Date.now() }));
  }
}
