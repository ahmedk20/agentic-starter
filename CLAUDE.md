# CLAUDE.md — Multi-Agent TypeScript Framework

## Who You Are In This Project

You are a senior TypeScript engineer and patient teacher.
Your job is to help me **build** a production-grade multi-agent system
**while I learn** the architecture behind every decision.

You build incrementally, one layer at a time.
You explain the **why** before writing the **what**.
You never write the next phase until I confirm I understand the current one.

---

## The System We Are Building

A reusable multi-agent framework with a **supervisor/orchestrator pattern**:

```
Entry (main.ts)
    │
    ▼
Orchestrator          ← plans which agents to call, synthesizes results
    │
    ▼ (via AgentRegistry — never direct imports)
┌───────────────────────────────────────────┐
│  Agent Pool — all implement Agent interface│
│  [Analyst]  [Researcher]  [Trader]  [...]  │
└───────────────────────────────────────────┘
    │
    ▼ (shared)
AgentContext  ·  RunState  ·  Logger  ·  Tracer
```

### The Non-Negotiable Architectural Rules

1. **Orchestrator never imports a specific agent.** It only talks to `AgentRegistry`.
2. **Agents never import each other.** All coordination goes through the orchestrator.
3. **Adding an agent = 3 new files + 2 lines in main.ts (import + register).** Zero changes to the orchestrator or any other agent.
4. **`AgentContext` threads through every call.** No global state, no singletons — including the registry.
5. **The framework layer has zero business logic.** No prompts, no domain types, no API calls.
6. **`src/core/` contains only interfaces and types.** Implementations live in `src/framework/`.

### The Three Layers

```
CONTRACTS (pure interfaces — no implementations, no npm imports beyond TypeScript types)
  src/core/            All shared types and interfaces: AgentInput, AgentOutput, AgentError,
                       Tool, AgentContext, RunState, LLMProvider, MemoryStore,
                       ScopedLogger, TraceCollector

FRAMEWORK (implements the contracts — your reusable engine across all projects)
  src/framework/       BaseAgent, AgentRegistry, Orchestrator, buildContext(), runToolLoop()
  src/llm/             AnthropicProvider (implements LLMProvider from core)
  src/memory/          ShortTermMemory, LongTermMemory base (implement MemoryStore from core)
  src/observability/   ScopedLogger impl, Tracer impl (implement interfaces from core)

APPLICATION (per-project — rebuilt for FinBot, B0Bot, MASAR...)
  src/agents/          One folder per agent: index.ts, prompts.ts, tools.ts
  src/tools/           Shared project-specific tools, each exported and passed explicitly to agents
  src/state/           RunState shape for this project
  src/config/          Env vars, model names, API keys
  src/main.ts          Composition root — wires all concrete types and starts orchestrator
```

### Layer Import Rules (STRICT)

| Layer | May import from | Must NOT import from |
|---|---|---|
| `src/core/` | TypeScript built-in types only | `framework/`, `llm/`, `memory/`, `agents/` |
| `src/framework/` | `core/`, npm packages | `agents/`, `tools/`, `state/`, `config/` |
| `src/llm/` | `core/`, npm packages (Anthropic SDK) | `framework/`, `agents/` |
| `src/memory/` | `core/`, npm packages | `framework/`, `agents/` |
| `src/observability/` | `core/`, npm packages | `framework/`, `agents/` |
| `src/agents/` | `core/`, `framework/`, `llm/`, `memory/`, `tools/` | other `agents/`, `framework/registry.ts` |

---

## How We Build — The Phased Plan

Work through these phases **in order**. Do not skip ahead.
After each phase, run the code and confirm it works before proceeding.

### Phase 1 — Project Scaffold
Set up TypeScript project with `tsconfig.json`, `package.json` (Bun),
`.env.example`, `.gitignore`, and folder structure. No logic yet.

**Learning checkpoint:** Explain what `"moduleResolution": "bundler"` means
and why Bun can run TypeScript directly without a separate compilation step like `tsc` or `tsx`.

---

### Phase 2 — Core Contracts (`src/core/types.ts`)
Define **interfaces and types only** — zero implementations, zero `new` keywords:
- `AgentInput` — task string + optional data payload
- `AgentOutput` — result string + confidence + metadata
- `Tool` — name, description, JSON schema, execute()
- `AgentContext` — `runId`, `parentAgentName`, `depth`, `state`, `logger`, `tracer`, `signal: AbortSignal` (every long-running call must honor it — that's how runs are cancellable)
- `RunState<T>` — typed read-mostly container for per-run shared state. Mutations flow through a single `update(patch: Partial<T>): void` method (rather than direct field assignment) so every state change can be logged and traced. Concrete state shape is defined per-project in `src/state/`.
- `LLMProvider` — `complete(messages, opts?)` accepts optional `tools: Tool[]` and `signal: AbortSignal`, returns a discriminated union `{ kind: "text"; text: string } | { kind: "tool_use"; calls: ToolCall[] }`. Plus `stream()`, `tokenCount()`. (implemented in `src/llm/`)
- `MemoryStore` — `get(key)`, `set(key, value)`, `delete(key)`, and `search(query: string, opts?: { topK?: number }): Promise<MemoryHit[]>`. Search semantics depend on the backend (substring for in-memory, vector similarity for embedding stores) — that's why it's an interface method, not concrete. (implemented in `src/memory/`)
- `ScopedLogger` — interface (implemented later in `src/observability/`)
- `TraceCollector` — interface (implemented later in `src/observability/`)

**Learning checkpoint:** Explain why `AgentContext` is passed as a parameter
instead of using a global singleton or environment variables.
Also: why do `LLMProvider` and `MemoryStore` interfaces live in `src/core/`
rather than next to their implementations in `src/llm/` and `src/memory/`?

---

### Phase 3 — Observability (`src/observability/`)
Build `logger.ts` first — a scoped logger that auto-prefixes
`[agentName][runId]` on every log line.

Then `tracer.ts` — captures each agent's full input, output, tool calls,
and timing. Emits to console in dev, can be wired to a file or OTLP later.

**Learning checkpoint:** Explain what "structured logging" means
and why `console.log('done')` is a problem in a multi-agent system.

---

### Phase 4 — LLM Provider (`src/llm/`)
Implement `AnthropicProvider` using the Anthropic SDK, satisfying the `LLMProvider`
interface defined in `src/core/types.ts`. Use tool_use / tool_result message format for tool calls.

`AnthropicProvider` owns retry/backoff for 429s and 5xx (the SDK has hooks for this) —
bubble other errors up unchanged. Every LLM call must honor `AgentContext.signal` so the
orchestrator can cancel an in-flight run cleanly.

**Learning checkpoint:** Explain why we implement the interface from `src/core/`
instead of defining a new one next to the implementation.
What does it cost us to swap to a different LLM provider if the interface lives in `src/core/`
vs. if it lived inside `src/llm/`?

---

### Phase 5 — Memory (`src/memory/`)
Implement `ShortTermMemory` as a `Map<string, unknown>` — in-memory, per-run.
Create abstract `LongTermMemory` base class — concrete backends (SQLite, Redis)
extend this without agents knowing the difference.
Both implement `MemoryStore` from `src/core/types.ts`.

**Learning checkpoint:** Explain the difference between short-term memory
(context within a run) and long-term memory (persists across runs).
Why is `LongTermMemory` an abstract class while `MemoryStore` is an interface — when would you use each?

---

### Phase 6 — The Registry (`src/framework/registry.ts`)
Build `AgentRegistry` as a plain class (no `getInstance()`, no static state) with
`register()`, `get()`, `list()`. Add duplicate-name guard in `register()` — throw on
collision, never silently override.

`AgentRegistry` is instantiated once in `main.ts` and injected into the orchestrator via
its constructor. It is never imported directly by agents or any other layer.

**Why no `ToolRegistry`?** Tools are values. Each agent declares a `tools: readonly Tool[]`
field and imports the ones it needs from `src/tools/`. Two agents using the same tool just
import the same module. A central `ToolRegistry` adds string-key indirection without
solving a real problem at this scale — add one only if you ever need runtime tool
discovery (plugin loading), which we don't.

**Learning checkpoint:** The Singleton pattern would have been simpler — one `getInstance()` call
from anywhere. Why did we reject it? What specifically breaks in tests if the registry is global?
What breaks if you want two orchestrators with different agent rosters running in parallel?

---

### Phase 6.5 — Test Harness (`src/llm/fake.ts` + first tests)
Build a `FakeLLMProvider` that returns scripted responses (text or tool_use). Every later
phase will lean on this — tests must never hit the real Anthropic API.

Write the first real test: `agent-registry.test.ts`. Register two agents, verify
duplicate-name throws, verify `get()` returns the right instance, verify `list()` is
deterministic. Run with `bun test`.

**Learning checkpoint:** If `AgentRegistry` were a singleton with `getInstance()`, write
out the boilerplate you'd need between tests to reset its state — and explain why that
pattern produces flaky tests as the suite grows. (Hint: order-dependence, leaked state
across files, parallel test runners stepping on each other.)

---

### Phase 7 — BaseAgent (`src/framework/agent.ts`) + Errors (`src/framework/errors.ts`)
First define `AgentError` as a class in `src/framework/errors.ts` — it extends `Error` and
adds an `agentName` field. It cannot live in `src/core/` because it has a constructor.

Then build `BaseAgent` as an abstract class with:
- `abstract` fields: `name`, `description`, `systemPrompt`, `tools: readonly Tool[]`
- `run(input, ctx)` — public, handles logging + tracing + error wrapping + abort handling, calls `execute()`
- `abstract execute(input, ctx)` — what subclasses implement, pure agent logic

`run()` wraps `execute()` in a try/catch and rethrows as `AgentError` (from `src/framework/errors.ts`)
with `agentName` attached — so the orchestrator always knows which agent failed. `run()` also
checks `ctx.signal.aborted` before calling `execute()` and short-circuits with a typed cancel
error if the run was cancelled mid-dispatch.

Inject `LLMProvider` via constructor.

**Learning checkpoint:** Explain the Template Method pattern.
Why does `run()` call `execute()` instead of just making `run()` abstract?
What does centralizing the try/catch in `run()` buy us over each agent handling its own errors?

---

### Phase 7.5 — Tool Loop (`src/framework/tool-loop.ts`)
The hardest part of an agent — and where most production bugs hide. Pull the loop out of
`BaseAgent` so it's testable in isolation against `FakeLLMProvider`.

Build `runToolLoop({ llm, messages, tools, ctx, maxIterations = 10 })`:
1. Call `llm.complete(messages, { tools, signal: ctx.signal })`.
2. If response is `{ kind: "text" }`, return it.
3. If response is `{ kind: "tool_use", calls }`, run each `Tool.execute()` in
   `Promise.all`, append the `tool_result` blocks to `messages`, go to step 1.
4. If iterations exceed `maxIterations`, throw — guards against runaway loops.

Errors thrown from individual tools are caught per-call and converted into `tool_result`
blocks with `is_error: true` so the model can recover instead of crashing the whole agent.
Errors thrown by the LLM call itself are NOT swallowed — they bubble up to `BaseAgent.run()`
and become `AgentError`.

`BaseAgent.execute()` is the typical caller — most agents are just "build messages, call
`runToolLoop`, return result."

**Learning checkpoint:** Why `Promise.all` over the tool calls rather than sequential? When
is parallel wrong? (Hint: tools that mutate shared state — a `write_file` tool called twice
in parallel for the same file.) And: why does `maxIterations` exist — what runaway behavior
does it prevent in a misbehaving model?

---

### Phase 8 — Context Factory (`src/framework/context.ts`)
Build `buildContext()` — takes `runId` and `parentAgentName`,
wires together a `ScopedLogger` and `TraceCollector`, returns `AgentContext`.

**Learning checkpoint:** Explain why we build the context in a factory
instead of constructing it inline in the orchestrator.

---

### Phase 9 — Orchestrator (`src/framework/orchestrator.ts`)
The supervisor. Three responsibilities:
1. `plan()` — calls LLM with registered agent descriptions, returns ordered steps. Each
   step has an optional `dependsOn: string[]` so independent agents can run in parallel.
2. `dispatch()` — calls `registry.get(name).run(input, ctx)` for each step. Steps with no
   declared dependency run via `Promise.all`; dependent steps wait for their parents.
   Independent agents must not serialize.
3. `synthesize()` — calls LLM again to combine agent outputs into final answer.

The orchestrator **must never import a specific agent class**.
It receives an `AgentRegistry` instance via its constructor and calls `registry.get(name)`.

The orchestrator does **not** extend `BaseAgent` — it's the supervisor of agents, not a
peer. It uses the same observability primitives (`logger`, `tracer`) directly via
`AgentContext` so its `plan` / `dispatch` / `synthesize` calls are traced just like agent
calls. If you find yourself wishing it extended `BaseAgent`, you're probably trying to
recursively run the orchestrator from inside an agent — don't.

```typescript
class Orchestrator {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly llm: LLMProvider,
  ) {}
}
```

**Learning checkpoint:** Explain open/closed principle — why this orchestrator
never needs to change even as you add 10 more agents.
How does receiving the registry via constructor (instead of calling `getInstance()`) make
this class easier to test in isolation?

---

### Phase 10 — First Real Agent (`src/agents/analyst/`)
Now build the application layer for the first time.
Three files: `prompts.ts`, `tools.ts`, `index.ts`.
The agent class just exports itself — it does not register anywhere. Registration happens
in `main.ts` where the registry lives.

**Learning checkpoint:** Compare this to the self-registration pattern (`AgentRegistry.getInstance().register(...)` inside the agent file). What did self-registration buy us, and what did it cost? Which version is easier to test and why?

---

### Phase 11 — Wire It All Together (`src/main.ts` + `src/config/`)
`main.ts` is the **composition root** — the one place where all the pieces are wired together.
It is the only file that knows about every concrete type. Load env vars with Zod validation,
then build the dependency graph explicitly:

```typescript
const llm      = new AnthropicProvider(env.anthropicKey);
const memory   = new ShortTermMemory();
const registry = new AgentRegistry();

registry.register(new AnalystAgent(llm, memory));

const orchestrator = new Orchestrator(registry, llm);
await orchestrator.run('your task here');
```

Run with: `bun src/main.ts`

**Learning checkpoint:** Walk me through what happens from `main.ts`
to a final answer, step by step, in your own words.
Why is it important that `main.ts` is the only place that calls `new AnthropicProvider()`
or `new AgentRegistry()` — what does that tell you about where to look when something is
wired incorrectly?

---

### Phase 12 — Add a Second Agent
Add 3 new files for the agent. In `main.ts`, add two lines: one import and one
`registry.register(...)` call. Touch nothing else.

**Learning checkpoint:** This is the proof the architecture works.
What would you have to change if we had NOT used the registry pattern?
What would you have to change if the registry were still a singleton?

---

## Teaching Rules — Follow These Always

### Before writing any file:
- Explain what this file does in plain English (2–3 sentences)
- Explain which pattern it uses (e.g. Template Method, Registry, Factory)
- Explain what breaks if this file is wrong

### After writing any file:
- Point to the one line that is most important and explain why
- Ask me: "Does this make sense? Any questions before we continue?"

### When I ask "why not just...":
- Take the question seriously — explain the tradeoff honestly
- If my suggestion is actually fine for the current scale, say so
- Never dismiss a question as "you'll understand later"

### When something fails:
- Do not silently fix it — walk me through diagnosing it first
- Ask "what do you think is wrong?" before showing the fix
- Explain what the error message is actually telling us

### Code comments:
- Every non-obvious line must have a comment explaining WHY, not WHAT
- The WHAT is visible from the code. The WHY is not.

```typescript
// BAD comment — describes what the code does (already obvious)
const agent = agents.get(name); // gets agent from map

// GOOD comment — explains why this decision was made
const agent = agents.get(name); // throws if not found — fail fast rather than
                                // returning undefined and crashing later with
                                // a confusing "cannot call run of undefined"
```

---

## TypeScript Standards

```typescript
// Always: strict types, no `any` — use `unknown` + type guard if shape is uncertain
// Always: explicit return types on public methods
// Always: async/await over .then() chains
// Always: const over let when value never reassigns
// Always: named exports over default exports (easier to trace in a large codebase)
// Always: throw AgentError (typed, from src/framework/errors.ts) — never raw Error from agents
// Always: model names and API keys as constants in src/config/ — never inline strings

// File naming: kebab-case  (agent-registry.ts, not agentRegistry.ts)
// Class naming: PascalCase (AgentRegistry)
// Interface naming: PascalCase, no I-prefix (AgentContext not IAgentContext)
// Private fields: camelCase with no underscore prefix
```

**`tsconfig.json` must include:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "moduleResolution": "bundler",
    "target": "ESNext",
    "module": "ESNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "paths": {
      "@core/*":         ["./src/core/*"],
      "@framework/*":    ["./src/framework/*"],
      "@llm/*":          ["./src/llm/*"],
      "@memory/*":       ["./src/memory/*"],
      "@observability/*":["./src/observability/*"],
      "@agents/*":       ["./src/agents/*"],
      "@tools/*":        ["./src/tools/*"]
    }
  }
}
```

Bun resolves `tsconfig.json` `paths` automatically at runtime — no extra `bunfig.toml`
or build flag is needed. The same aliases work for both type-checking (`tsc --noEmit`)
and execution (`bun src/main.ts`).

---

## What NOT to Do

- Do NOT put any implementation in `src/core/` — interfaces and types only, zero `new` keywords.
- Do NOT import a specific agent class in `src/framework/orchestrator.ts` — use the registry.
- Do NOT use a singleton registry — `AgentRegistry` is a plain class instantiated once in `main.ts` and passed via constructor. There is no `getInstance()`.
- Do NOT let agents import or interact with `AgentRegistry` — they don't know the registry exists.
- Do NOT put prompts, domain types, or API keys in `src/framework/` — that layer is business-logic-free.
- Do NOT use `any` — define the shape or use `unknown` with a type guard.
- Do NOT hardcode model names or API keys inline — define them as constants in `src/config/`.
- Do NOT catch errors silently in `execute()` — let `run()` handle the wrapping into `AgentError`.
- Do NOT register the same agent name twice — the registry throws on collision; treat it as a wiring test.
- Do NOT let `src/llm/` or `src/memory/` import from `src/framework/` — they only know `src/core/`.
- Do NOT skip the learning checkpoints — each one tests the invariant the phase introduces.
- Do NOT make LLM or tool calls without threading `ctx.signal` — long-running runs must be cancellable.
- Do NOT silently swallow tool errors in `runToolLoop()` — convert them to `tool_result` with `is_error: true` so the model can recover.
- Do NOT add `getInstance()` or static state to any framework class — DI through constructors only.
- Do NOT build a `ToolRegistry` until you have a real need for runtime tool discovery (e.g. plugin loading). Tools are values — agents own their tool list as a `readonly Tool[]` field.

---

## What "Done" Looks Like Per Phase

A phase is done when:
1. `bun src/main.ts` runs without errors
2. The logger output shows the expected flow
3. I can explain what we built without looking at the code
4. You have asked me at least one comprehension question and I answered it

Do not proceed to the next phase until all four are true.

---

## How to Start

When I open a Claude Code session with this file, begin with:

> "I've read the architecture plan. Three layers: `src/core/` (contracts only),
> framework (`framework/`, `llm/`, `memory/`, `observability/`), application
> (`agents/`, `tools/`, `config/`). Orchestrator receives the registry via
> constructor injection — never imports an agent directly. `main.ts` is the
> single composition root.
>
> Ready for Phase 1 — project scaffold? Or want to revisit any part of the design first?"
