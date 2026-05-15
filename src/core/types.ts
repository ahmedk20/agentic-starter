// ─────────────────────────────────────────────────────────────
// src/core/types.ts — pure interfaces and types, zero implementations
// ─────────────────────────────────────────────────────────────

// ── Input / Output ──────────────────────────────────────────

export interface AgentInput {
  task: string;
  data?: unknown;
}

export interface AgentOutput {
  result: string;
  confidence: number; // 0–1
  metadata?: Record<string, unknown>;
}

// ── LLM message format ───────────────────────────────────────

// Mirrors OpenAI's chat completion message shape.
// tool_use blocks live in assistant messages; tool results are separate "tool" role messages.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// Discriminated union — each role has exactly the fields it needs, no optional leakage.
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | ContentBlock[] }
  | { role: "tool"; content: string; tool_call_id: string };

// ── Tool ─────────────────────────────────────────────────────

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>; // JSON Schema — passed verbatim to the LLM
  execute(input: unknown, ctx: AgentContext): Promise<unknown>;
}

// Returned by the LLM when it decides to call one or more tools.
export interface ToolCall {
  id: string;   // echoed back in the tool_result block so the LLM links call → result
  name: string;
  input: unknown;
}

// ── LLMProvider ──────────────────────────────────────────────

export interface LLMCompleteOptions {
  tools?: readonly Tool[];
  signal?: AbortSignal;   // honors ctx.signal — lets the orchestrator cancel mid-call
  maxTokens?: number;
  // Optional context handle so the provider can (a) check the budget before calling,
  // (b) record usage afterwards, attributed to ctx.parentAgentName. Optional because
  // FakeLLMProvider in tests doesn't need it; in production, callers always pass it.
  ctx?: AgentContext;
}

// Raw counts returned by every provider's response.
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

// Aggregated view of one run's spend — returned from Orchestrator.run().
export interface CostSummary {
  totalUsd: number;
  totalTokens: number;
  byAgent: Record<string, { tokens: number; usd: number }>;
  byModel: Record<string, { tokens: number; usd: number }>;
}

// Tracks token + dollar spend across one run. Implementations live in src/framework/.
// Lives in core/ because both providers (which call record) and orchestrator (which reads
// summary) depend on the shape — putting it elsewhere creates a backwards dependency.
export interface CostTracker {
  record(agentName: string, model: string, usage: TokenUsage): void;
  totalUsd(): number;
  summary(): CostSummary;
  // Throws BudgetExceededError if spend has already reached the cap. Called by providers
  // BEFORE the request, so the next call cannot push the run past budget.
  assertWithinBudget(): void;
}

// Discriminated union: the tool loop branches on `kind`, never on duck-typing.
export type LLMResponse =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; calls: ToolCall[] };

export interface LLMProvider {
  complete(messages: Message[], opts?: LLMCompleteOptions): Promise<LLMResponse>;
  stream(messages: Message[], opts?: LLMCompleteOptions): AsyncIterable<string>;
  tokenCount(messages: Message[]): Promise<number>;
}

// ── MemoryStore ──────────────────────────────────────────────

export interface MemoryHit {
  key: string;
  value: unknown;
  score?: number; // 0–1 relevance; absent for non-vector backends (e.g. ShortTermMemory)
}

export interface MemoryStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  // search semantics are backend-specific: substring match for in-memory, vector similarity for embeddings
  search(query: string, opts?: { topK?: number }): Promise<MemoryHit[]>;
}

// ── RunState ─────────────────────────────────────────────────

export interface RunState<T extends Record<string, unknown>> {
  readonly data: Readonly<T>;
  // Funneling all writes through one method lets the implementation log every mutation.
  update(patch: Partial<T>): void;
}

// ── Observability ────────────────────────────────────────────

export interface ScopedLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface TraceEvent {
  spanId: string;
  agentName: string;
  runId: string;
  kind: "agent_start" | "agent_end" | "tool_call";
  durationMs?: number;
  payload: unknown;
}

export interface TraceCollector {
  startSpan(agentName: string, runId: string, input: AgentInput): string; // returns spanId
  endSpan(spanId: string, output: AgentOutput, durationMs: number): void;
  recordToolCall(spanId: string, toolName: string, input: unknown, output: unknown, durationMs: number): void;
  getEvents(): readonly TraceEvent[];
}

// ── Agent ────────────────────────────────────────────────────

// The public face of every agent — what the registry stores and the orchestrator calls.
// BaseAgent (src/framework/agent.ts) implements this; agents never expose more than this to peers.
export interface Agent {
  readonly name: string;
  readonly description: string; // used by the orchestrator's planner to decide which agent to call
  run(input: AgentInput, ctx: AgentContext): Promise<AgentOutput>;
}

// ── AgentContext ─────────────────────────────────────────────

// Passed into every agent call and every tool execute().
// No global state — each run gets its own context instance.
export interface AgentContext {
  readonly runId: string;
  readonly parentAgentName: string;
  readonly depth: number;                            // guards against infinite orchestrator recursion
  readonly state: RunState<Record<string, unknown>>; // narrowed to project shape in src/state/
  readonly logger: ScopedLogger;
  readonly tracer: TraceCollector;
  readonly signal: AbortSignal;                      // cancelled by the orchestrator to stop a run cleanly
  readonly costTracker: CostTracker;                 // accumulates spend; providers record + check budget here
  readonly memory: MemoryStore;                      // per-run scratch or persistent KB — wired in main.ts
}
