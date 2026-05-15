# AI Engineering Interview Prep — Multi-Agent TypeScript Framework

This document is a study guide built from the project in this repo. Use it to:
1. Explain the project end-to-end in an interview (2-minute pitch + deep dive).
2. Defend the architectural decisions when pushed back on.
3. Practice the kinds of AI engineering questions a real interviewer will ask.

Everything here maps to actual code in `src/`. If you can't point to the file when answering, your answer isn't ready.

---

## 1. Elevator Pitch (memorize this)

> I built a production-grade multi-agent framework in TypeScript with a supervisor/orchestrator pattern. An orchestrator takes a user task, asks an LLM to decompose it into an execution plan of named agents, dispatches them — in parallel where the dependency graph allows — and synthesizes their outputs into a final answer. The framework is split into three layers: pure contracts in `src/core/`, a reusable engine in `src/framework/` + `src/llm/` + `src/memory/` + `src/observability/`, and per-project agents in `src/agents/`. Adding a new agent is three new files plus two lines in `main.ts`. Nothing else changes.

Memorize the last sentence. It's the punchline that proves the architecture works.

---

## 2. Architecture at a Glance

```
main.ts (composition root)
   │
   ▼
Orchestrator ── plan() ── dispatch() ── synthesize()
   │
   ▼ (via AgentRegistry, never direct imports)
[ Analyst ] [ Researcher ] [ ...more agents ]
   │
   ▼ (each agent)
BaseAgent.run() → execute() → runToolLoop() → LLM ↔ Tools
   │
   ▼ (everywhere)
AgentContext { runId, logger, tracer, signal, state }
```

**Three layers, strict import rules:**

| Layer | Folder | Purpose | May import |
|---|---|---|---|
| Contracts | `src/core/` | Pure interfaces & types, zero `new` | TypeScript built-ins only |
| Framework | `src/framework/`, `src/llm/`, `src/memory/`, `src/observability/` | Reusable engine | `core/` + npm packages |
| Application | `src/agents/`, `src/tools/`, `src/state/`, `src/config/`, `src/main.ts` | Per-project logic | Everything above it |

---

## 3. The Five Architectural Decisions You Will Be Quizzed On

### 3.1 Registry over Singleton

**File:** `src/framework/registry.ts`

`AgentRegistry` is a plain class instantiated once in `main.ts` and passed to the `Orchestrator` via constructor. No `getInstance()`, no static state.

**Why:** Singletons leak state across tests (order-dependence, parallel test runners stepping on each other) and prevent two orchestrators with different rosters from coexisting. Constructor injection makes wiring explicit — if something's wrong, the bug is in `main.ts`, not hidden in a global.

**Push-back response:** "But singletons are simpler" → "Until you write the second test. The boilerplate to reset singleton state between tests grows nonlinearly. Constructor injection is one extra line and pays for itself the first time you write `new AgentRegistry()` in a test."

### 3.2 Contracts in `src/core/`, implementations elsewhere

**Files:** `src/core/types.ts` defines `LLMProvider`, `MemoryStore`. Implementations live in `src/llm/openai-provider.ts` and `src/memory/short-term.ts`.

**Why:** If `LLMProvider` lived next to its OpenAI implementation, swapping to Anthropic would mean either editing the OpenAI file (wrong — that file is OpenAI-specific) or having the framework depend on the OpenAI folder (wrong — that's a backwards dependency). Contracts in `core/` invert the dependency: framework code depends on the interface, both providers depend on the interface, providers don't depend on each other.

This is the **Dependency Inversion Principle** — name it in the interview.

### 3.3 Template Method in `BaseAgent`

**File:** `src/framework/agent.ts`

`BaseAgent.run()` is concrete (logging, tracing, error wrapping, abort check). `execute()` is `abstract`. Subclasses implement `execute()`, get the rest for free.

**Why:** Centralized cross-cutting concerns. If every agent had to write its own try/catch and tracing calls, three things would happen: (1) they'd diverge, (2) some agents would forget tracing, (3) errors would lack `agentName` and the orchestrator couldn't tell who failed.

**The killer detail:** `run()` re-throws `AgentError` unchanged but wraps unknown errors. Why? Because `AgentCancelledError` extends `AgentError`, and double-wrapping would lose the cancellation type — the orchestrator wouldn't know "this run was cancelled" vs "this agent crashed." Look at `agent.ts:48-52`.

### 3.4 Tool loop extracted from `BaseAgent`

**File:** `src/framework/tool-loop.ts`

`runToolLoop()` is a free function, not a method on `BaseAgent`. It takes `{ llm, messages, tools, ctx, maxIterations = 10 }` and returns a string.

**Why three reasons:**
1. **Testable in isolation** with `FakeLLMProvider` — no real API calls in tests.
2. **`maxIterations` guard** — models can get stuck in tool-call loops; without a hard limit you'll burn an entire API budget on one bad run.
3. **Per-call error isolation** — a single tool throwing becomes a `tool_result` with `is_error: true` so the model can recover. An LLM error, by contrast, bubbles up — that's a real failure, not something to retry blindly.

**Why `Promise.all` over the tool calls?** When the model requests `search` + `calculator` in one turn, there's no reason to serialize. Caveat: tools that mutate shared state (two `write_file` calls to the same path) are dangerous in parallel — that's the agent designer's problem to flag at tool-definition time.

### 3.5 `AgentContext` threaded everywhere — no globals

**File:** `src/core/types.ts:131-139`

Every agent call and every tool execute receives an `AgentContext` with `runId`, `logger`, `tracer`, `signal`, `state`, `depth`.

**Why:**
- **`signal: AbortSignal`** — the orchestrator can cancel mid-run. If you used globals you'd have no way to cancel run A without affecting run B.
- **`logger` is scoped** — auto-prefixes `[agentName][runId]`. Two concurrent runs don't interleave their logs.
- **`depth` guards recursion** — prevents an agent that secretly invokes another orchestrator from looping forever.
- **`state`** is per-run, not per-process — multiple runs can share the same agent code without contaminating each other.

This is the "no global state" rule made physical. Anyone tempted to add `currentLogger` as a module-level singleton has just made concurrent runs impossible.

---

## 4. AI Engineering Concepts the Project Demonstrates

These are the conceptual hooks. Be ready to recognize when an interviewer is fishing for them.

| Concept | Where in the code | One-line definition |
|---|---|---|
| **Supervisor / Orchestrator pattern** | `src/framework/orchestrator.ts` | Central planner decides which agents run; agents don't talk to each other |
| **Plan-and-execute** | `Orchestrator.plan()` + `dispatch()` | LLM produces a plan first, then a deterministic dispatcher executes it |
| **DAG-based parallel dispatch** | `Orchestrator.dispatch()` ready/remaining loop | Steps with no unmet deps run in `Promise.all`; cycles throw |
| **Tool calling / function calling** | `runToolLoop()` + `LLMResponse` discriminated union | Model returns either text or `tool_use`; loop executes tools, feeds results back |
| **Discriminated unions for safety** | `LLMResponse`, `Message`, `ContentBlock` in `core/types.ts` | TypeScript narrows on `kind`/`role` — no duck-typing, no runtime checks |
| **Dependency injection** | `BaseAgent` constructor takes `LLMProvider`; `Orchestrator` takes registry + llm | Wiring is explicit and tests can swap fakes in trivially |
| **Cancellation via AbortSignal** | `ctx.signal` threaded through every async call | Cooperative cancellation; long runs stay killable |
| **Structured logging** | `src/observability/logger.ts` | Logs are `{ message, meta }` objects, not free-form strings — searchable, filterable |
| **Span-based tracing** | `TraceCollector.startSpan/endSpan` | Every agent run is a span with input, output, duration — observability primitive |
| **Fake/stub for LLM in tests** | `src/llm/fake.ts` | `FakeLLMProvider` returns scripted responses — zero API cost in CI |
| **Template Method pattern** | `BaseAgent.run` (concrete) calls `execute` (abstract) | Framework owns the lifecycle, subclass owns the logic |
| **Open/Closed principle** | Adding an agent = 3 files + 2 lines, orchestrator unchanged | Open for extension, closed for modification |
| **Dependency Inversion** | `core/types.ts` interfaces, implementations in sibling folders | High-level code depends on abstractions, not concretes |
| **Composition root** | `src/main.ts` | The one file that knows every concrete type — wiring lives in one place |

---

## 5. Interview Questions — Practice Battery

### A. Warm-up / system explanation (5 minutes each)

1. Walk me through what happens from the moment `bun src/main.ts "Compare SQL vs NoSQL"` runs to the final answer printed in the terminal.
2. A new engineer joins your team and wants to add a `TraderAgent`. What files do they create, what do they edit, and what do they not touch?
3. Why does `src/core/` exist as a separate folder? What would go wrong if you deleted it and moved everything into `src/framework/`?
4. The `Orchestrator` has three methods: `plan`, `dispatch`, `synthesize`. Explain each one's single responsibility and why splitting them is better than one monolithic `run()`.
5. What is `AgentContext` and why is it a parameter on every call instead of being read from globals?

### B. Architectural defense (be ready to push back)

6. "Why didn't you just use LangChain / LlamaIndex / CrewAI?" — defend a from-scratch framework. (Hint: type safety, no hidden state, explicit wiring, can swap LLMs without rewriting agents, learning value, no transitive dependency surface.)
7. "Singletons are simpler. Why constructor injection?" — give the test-flakiness answer.
8. "Why not let agents import each other if they need to collaborate?" — explain why orchestrator-mediated coordination scales and direct imports don't.
9. "Your orchestrator's planner is just a JSON-emitting LLM call — what happens when it returns malformed JSON?" — point to the `fallbackPlan()` path in `orchestrator.ts:84`. Discuss the tradeoff between strict (fail fast) vs lenient (degrade to parallel execution).
10. "Promise.all on tool calls — what if two tools both write to disk?" — admit it's a hazard and explain it's the tool designer's responsibility to mark tools as parallel-safe or not. (Worth proposing as a future improvement.)
11. "Why an abstract class `BaseAgent` instead of just an interface `Agent`?" — interfaces can't hold the `run` template; you'd have to copy the try/catch into every agent.

### C. AI engineering depth

12. What is "function calling" / "tool use" at the API level? Walk through the JSON shape OpenAI expects and how `runToolLoop` constructs it.
13. Why is there a `maxIterations` on the tool loop? What real-world failure does it prevent?
14. The LLM response is a discriminated union `{ kind: "text" } | { kind: "tool_use" }`. Why a discriminated union and not, say, an object with optional `text` and optional `calls` fields?
15. How would you add **streaming** to this framework? Which interfaces change and which don't? (Hint: `LLMProvider.stream` already exists in the contract; the orchestrator doesn't use it yet — only the tool loop would need a streaming variant.)
16. How would you add **memory / RAG**? Walk through what `LongTermMemory` would need and how an agent would query it. Why is `MemoryStore.search()` on the interface rather than the concrete class? (Substring search for in-memory, vector for embeddings — agents don't care which.)
17. The planner is itself an LLM call — how do you evaluate its quality? Describe a small eval harness you'd build. (Golden tasks, expected agent set, accuracy on agent selection, plan validity, end-to-end answer quality with judge-model.)
18. How would you add **cost tracking**? Where do tokens get counted, where do dollars get attributed? (Hint: `LLMProvider.tokenCount` is on the interface for exactly this reason.)
19. How would you add **caching** of LLM responses? What's the cache key? (Messages array hash + tools list + model.) What's the invalidation strategy? (Tools changing = different key automatically.)
20. The orchestrator's plan format includes `dependsOn`. Draw the execution timeline for a 4-step plan: A and B independent, C depends on A, D depends on both B and C.
21. What's the failure mode if the model hallucinates an agent name in its plan? Trace the code path. (`registry.get()` throws → bubbles to dispatch → run aborts.)
22. Compare this pattern to **ReAct**. Is `runToolLoop` ReAct? (Yes — it's reason/act/observe loop, with the LLM doing reasoning between tool calls.) When does ReAct break down and when is a pre-planned orchestrator better?

### D. Code-level / production concerns

23. The tool loop catches per-tool errors but not LLM errors. Defend that choice. What's the right error policy at each layer?
24. `ctx.signal.aborted` is checked at the top of `run()`. Is once enough? What if `execute()` runs for 5 minutes? (Tools and LLM calls must also honor `signal` — that's why `LLMCompleteOptions.signal` exists.)
25. How would you add **retry with exponential backoff** for transient LLM failures? Where does it belong — inside `OpenAIProvider`, inside `runToolLoop`, or inside `BaseAgent.run`? Defend the choice. (Inside `OpenAIProvider` — it's transport-layer concern; `maxRetries: 3` is already configured on the SDK client.)
26. The codebase uses `noUncheckedIndexedAccess`. What does this catch? Show a line in the code that would fail without it.
27. Why named exports over default exports throughout? (Refactor renames work, IDE auto-import is reliable, no anonymous "default" in stack traces.)
28. What's the testing strategy for the orchestrator without hitting OpenAI? (Inject `FakeLLMProvider` configured with a scripted plan response, register fake agents, assert the dispatch order and final synthesis.)
29. The agent's `tools` field is `readonly Tool[]`. Why `readonly`? (Prevents an agent from mutating its tool list at runtime — predictable surface; the `readonly` modifier travels with the type through every consumer.)
30. If you wanted to support **human-in-the-loop** approval before a tool runs, where would you add it without breaking the existing interface? (A `before` hook on `Tool`, or a wrapping `Tool` decorator that prompts; the loop itself doesn't change.)

### E. Behavioral / tradeoffs

31. What was the hardest decision in this project and why?
32. What's one thing you would do differently if you started over?
33. What's the next feature you'd add if given another week?
34. Where is the architecture over-engineered for the current scope, and why did you accept that?
35. How does this code change when you go from one user to thousands of concurrent runs?

---

## 6. Sample Answers to the Hardest Three

### Q9. What if the planner returns malformed JSON?

> The planner is an LLM call so non-deterministic output is a real risk. `Orchestrator.plan()` parses the response inside a try/catch (`orchestrator.ts:77-87`). On parse failure it logs a warning and falls back to `fallbackPlan()` which returns every registered agent as a parallel step with the original task. That's a deliberate "degrade, don't die" choice — the user still gets an answer. The cost is that synthesis becomes the safety net; if the planner is broken and synthesis is also broken, the user sees the raw agent outputs concatenated. In a higher-stakes deployment I'd add a retry with a more constrained prompt before falling back, and a circuit breaker that surfaces a real error after N consecutive plan failures so we don't silently regress to "run everything" forever.

### Q15. How would you add streaming?

> The `LLMProvider` interface already has `stream(messages, opts)` returning `AsyncIterable<string>`. The OpenAI implementation needs to wire `stream: true` on the SDK call and yield deltas. The non-trivial part is the tool loop — streaming and tool calls interact awkwardly because you can't start streaming text until you know the model isn't going to issue a tool call instead. The right pattern is: stream into a buffer, watch for a `tool_use` block; if one appears, stop streaming, execute the tool, and resume. The `BaseAgent` and `Orchestrator` don't need to know about streaming at all if we keep streaming opt-in at the tool loop level. The synthesis call in the orchestrator is the obvious first place to stream end-to-end since it produces the final user-facing text.

### Q22. Is this ReAct? When does ReAct break down?

> Yes, `runToolLoop` is essentially the act-observe half of ReAct — the model reasons in its response text, calls a tool, observes the result, and reasons again. It's not pure ReAct because we don't force a "Thought:" prefix; we let the model use OpenAI's structured tool-call format instead, which is cleaner and doesn't waste tokens on scaffolding. ReAct breaks down when (a) the task needs multiple specialists with incompatible tool sets — that's exactly what the orchestrator solves by routing to named agents; (b) when the plan is well-known up front and you'd rather pay one planning call than N reasoning calls; (c) when you need parallelism — ReAct is inherently sequential, but the orchestrator's `dispatch()` runs independent agents in parallel. The hybrid we have — pre-planned DAG of ReAct-style agents — is more expensive than pure ReAct on simple tasks and cheaper on complex ones.

---

## 7. Pre-Interview Checklist

The day before, run through this:

- [ ] Open `src/main.ts`. Read the wiring out loud.
- [ ] Open `src/framework/orchestrator.ts`. Trace `run()` → `plan()` → `dispatch()` → `synthesize()` without looking away.
- [ ] Open `src/framework/agent.ts`. Explain why `run` is concrete and `execute` is abstract in one sentence.
- [ ] Open `src/framework/tool-loop.ts`. Find the three places error handling decisions matter (LLM error, tool error, max iterations).
- [ ] Open `src/core/types.ts`. Point at `LLMResponse` and explain discriminated unions in 30 seconds.
- [ ] Run `bun src/main.ts "What is the best database for a real-time chat app?"`. Watch the log lines. Be ready to narrate them.
- [ ] Practice the elevator pitch out loud twice.
- [ ] Pick any three questions from section 5 at random and answer them out loud against a timer (2 minutes each).

If any of those feel shaky, that's where to spend the rest of your prep time.
