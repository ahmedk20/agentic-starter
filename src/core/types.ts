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

// Mirrors Anthropic's content-block model so AnthropicProvider
// needs zero translation between our types and the SDK types.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

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
}
