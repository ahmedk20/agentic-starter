import type {
  AgentContext,
  CostTracker,
  MemoryStore,
  RunState,
  ScopedLogger,
  TraceCollector,
} from "@core/types";
import { NoOpCostTracker } from "@framework/cost-tracker";
import { ShortTermMemory } from "@memory/short-term";
import { ConsoleScopedLogger } from "@observability/logger";
import { ConsoleTraceCollector } from "@observability/tracer";

export interface BuildContextOptions {
  runId: string;
  parentAgentName: string;
  signal?: AbortSignal;
  depth?: number;
  // Optional overrides — pass silent stubs in tests to suppress console output.
  logger?: ScopedLogger;
  tracer?: TraceCollector;
  costTracker?: CostTracker;
  memory?: MemoryStore;
}

export function buildContext({
  runId,
  parentAgentName,
  depth = 0,
  signal,
  logger,
  tracer,
  costTracker,
  memory,
}: BuildContextOptions): AgentContext {
  return {
    runId,
    parentAgentName,
    depth,
    // createRunState is exported so tests can build isolated state without calling buildContext.
    state: createRunState({}),
    logger: logger ?? new ConsoleScopedLogger(parentAgentName, runId),
    tracer: tracer ?? new ConsoleTraceCollector(),
    // Default signal is never aborted — safe for runs that don't need cancellation.
    signal: signal ?? new AbortController().signal,
    // Default to NoOp so any context built without explicit cost tracking still satisfies
    // the type. Production callers (Orchestrator.run) always pass a real InMemoryCostTracker.
    costTracker: costTracker ?? new NoOpCostTracker(),
    // Default to a per-run ShortTermMemory — every run gets its own scratchpad even when
    // the application doesn't plug in a persistent backend. main.ts can swap in SQLite/Postgres.
    memory: memory ?? new ShortTermMemory(),
  };
}

// Concrete RunState — exported so application code can build typed state in src/state/.
export function createRunState<T extends Record<string, unknown>>(initial: T): RunState<T> {
  // Spread into a new object so callers can't mutate data by keeping a reference to initial.
  let current = { ...initial } as T;

  return {
    get data(): Readonly<T> {
      return current;
    },
    update(patch: Partial<T>): void {
      // Each update produces a new object — no shared references, safe to read concurrently.
      current = { ...current, ...patch } as T;
    },
  };
}
