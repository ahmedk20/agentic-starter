# STARTER.md — Spin Up a New Project From This Codebase

This is the practical "fork-and-adapt" guide. CLAUDE.md teaches you *why* the
architecture is shaped the way it is. This document tells you *what to do* when
you clone this repo to start a new agent project.

Read time: 5 minutes. Time to first running agent: about 20 minutes.

---

## What you get out of the box

A reusable foundation for building multi-agent systems in TypeScript:

- **Orchestrator** that plans, dispatches agents in parallel (with `dependsOn`
  for partial ordering), and synthesizes their outputs into one answer.
- **`BaseAgent`** with the template-method pattern — logging, tracing, error
  wrapping, and abort handling are free; subclasses just implement `execute()`.
- **Tool loop** (`runToolLoop`) — agent ↔ tool calls, parallel tool execution,
  iteration cap, recoverable per-tool errors.
- **LLM provider** — OpenAI implementation today; swap in your own behind the
  `LLMProvider` interface in `src/core/types.ts`.
- **Memory** — `ShortTermMemory` (Map-backed, per-run) and
  `SqliteLongTermMemory` (file-backed, persistent).
- **Cost tracking + budget enforcement** — per-run ledger, per-agent breakdown,
  hard USD ceiling, BudgetExceededError thrown when exceeded.
- **AbortSignal threaded through every long call** — runs cancel cleanly.
- **Eval harness** in `src/evals/` for regression-testing your agents.
- **Tests** for the framework layer — fake LLM provider, no network calls.

---

## The 60-second mental model

```
KEEP (the framework — generic, no business logic)
  src/core/            interfaces and types
  src/framework/       BaseAgent, Orchestrator, AgentRegistry, runToolLoop, ...
  src/llm/             provider implementations
  src/memory/          memory backends
  src/observability/   logger, tracer
  src/evals/           eval harness

REPLACE (the application — yours, per project)
  src/agents/          one folder per agent
  src/tools/           your project-specific tools
  src/state/           your RunState shape
  src/config/          env vars, model names, prices
  src/main.ts          composition root — wires everything together
```

Rule of thumb: if your domain knowledge (prompts, tool names, API keys, data
shapes) shows up anywhere in the KEEP list, you've put it in the wrong place.

---

## Starting a new project

```bash
# 1. Clone (or fork) and rename
git clone <this-repo> my-new-project
cd my-new-project
rm -rf .git && git init

# 2. Update package.json — change "name" and reset "version" to 0.1.0

# 3. Install
bun install

# 4. Set up env
cp .env.example .env   # if .env.example exists; otherwise create .env
# Fill in OPENAI_API_KEY (or whichever provider env vars your project uses)

# 5. Strip the example application layer
rm -rf src/agents/*
rm -rf src/tools/*
rm -rf src/state/*
# (Keep the folders — they're referenced by tsconfig path aliases.)

# 6. Clear src/main.ts — you'll rewrite it in step "Wiring it up" below.
```

You now have a clean framework with no application code. Time to build yours.

---

## Building the application layer

The four things you write per project: **state, tools, agents, main**. In that
order — each step depends on the previous.

### 1. Define your RunState (`src/state/`)

`RunState<T>` is the typed read-mostly container threaded into every agent via
`AgentContext`. Define what data your agents share within a single run.

```typescript
// src/state/index.ts
export interface MyRunState {
  ticker?: string;
  marketReport?: string;
  newsReport?: string;
  finalDecision?: "buy" | "sell" | "hold";
}
```

Mutations flow through `ctx.state.update(patch)` — not direct field assignment —
so every state change is loggable.

### 2. Write a tool (`src/tools/`)

Tools are values. Each agent declares the tools it needs as a
`readonly Tool[]` field. No central tool registry — agents just import what
they use.

```typescript
// src/tools/get-price.ts
import { z } from "zod";
import type { Tool } from "@core/types";

const InputSchema = z.object({
  ticker: z.string().min(1).max(10),
});

export const getPriceTool: Tool = {
  name: "get_price",
  description: "Fetch the latest closing price for a stock ticker.",
  inputSchema: InputSchema,
  async execute(input, ctx) {
    const { ticker } = InputSchema.parse(input);
    ctx.logger.info("fetching price", { ticker });
    // ... your fetch logic ...
    return { ticker, price: 142.30 };
  },
};
```

Tools must honor `ctx.signal` if they make long-running calls — otherwise the
orchestrator can't cancel them mid-flight.

### 3. Write an agent (`src/agents/<name>/`)

Three files per agent. The agent class only knows about its own prompts, its
own tools, and the `LLMProvider` injected via the constructor. It never
imports other agents and never sees the registry.

```typescript
// src/agents/trader/prompts.ts
export const TRADER_SYSTEM_PROMPT = `You are a trading analyst...`;

// src/agents/trader/tools.ts
import { getPriceTool } from "@tools/get-price";
export const traderTools = [getPriceTool] as const;

// src/agents/trader/index.ts
import type { AgentContext, AgentInput, AgentOutput } from "@core/types";
import { BaseAgent } from "@framework/agent";
import { runToolLoop } from "@framework/tool-loop";
import { TRADER_SYSTEM_PROMPT } from "./prompts";
import { traderTools } from "./tools";

export class TraderAgent extends BaseAgent {
  readonly name = "trader";
  readonly description = "Decides buy/sell/hold for a ticker";
  readonly systemPrompt = TRADER_SYSTEM_PROMPT;
  readonly tools = traderTools;

  protected async execute(input: AgentInput, ctx: AgentContext): Promise<AgentOutput> {
    const result = await runToolLoop({
      llm: this.llm,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: input.task },
      ],
      tools: this.tools,
      ctx,
    });
    return { result, confidence: 0.8 };
  }
}
```

### 4. Wire it up (`src/main.ts`)

`main.ts` is the **only file that knows about every concrete type**. If
something is wired wrong, this is the only place to look.

```typescript
import { TraderAgent } from "@agents/trader";
import { env } from "@config/env";
import { PRICES } from "@config/models";
import { Orchestrator } from "@framework/orchestrator";
import { AgentRegistry } from "@framework/registry";
import { OpenAIProvider } from "@llm/openai-provider";

const llm      = new OpenAIProvider(env.openaiKey, env.model);
const registry = new AgentRegistry();

registry.register(new TraderAgent(llm));

const orchestrator = new Orchestrator(registry, llm, {
  prices: PRICES,
  budgetUsd: 1.0,
});

const task = process.argv[2] ?? "Should I buy AAPL?";
const { answer, cost } = await orchestrator.run(task);

console.log(answer);
console.log(`Cost: $${cost.totalUsd.toFixed(4)}`);
```

Run it:

```bash
bun src/main.ts "Should I buy NVDA?"
```

That's a complete agent project. Everything beyond this is variation.

---

## Configuration (`src/config/`)

Two files. Keep your project-specific config local; never let model names or
API keys leak into the framework layer.

```typescript
// src/config/env.ts — validate env vars with Zod at startup
import { z } from "zod";

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  MODEL: z.string().default("gpt-4o-mini"),
});

const parsed = EnvSchema.parse(process.env);
export const env = {
  openaiKey: parsed.OPENAI_API_KEY,
  model: parsed.MODEL,
};
```

```typescript
// src/config/models.ts — price table for cost tracking
import type { ModelPrice } from "@framework/cost-tracker";

export const PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini":  { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  "gpt-4o":       { inputPerMTok: 2.50, outputPerMTok: 10.00 },
};
```

---

## Common modifications cheatsheet

| You want to... | Touch... | Don't touch... |
|---|---|---|
| Add an agent | new folder under `src/agents/`, register in `main.ts` | orchestrator, any other agent |
| Add a tool | new file in `src/tools/`, import in agent's `tools.ts` | tool loop, framework |
| Swap LLM provider | implement `LLMProvider` in `src/llm/`, update `main.ts` | any agent |
| Add persistent memory | use `SqliteLongTermMemory` in `main.ts`; or extend `LongTermMemory` for a new backend | agents (they only see `MemoryStore`) |
| Raise/lower budget | `Orchestrator` `budgetUsd` option in `main.ts` | framework |
| Cancel a run mid-flight | pass `AbortSignal` to `orchestrator.run(task, signal)` | nothing — already plumbed |
| Add an eval | new case in `src/evals/cases.ts` | framework |

---

## Don't-touch list (preserves the architecture)

Editing these breaks the contract that makes the framework reusable:

- **`src/core/`** — interfaces only. Adding a class breaks the layer rule.
- **`src/framework/orchestrator.ts`** — must never import a specific agent.
- **`src/framework/registry.ts`** — keep it a plain class. No `getInstance()`,
  no static state, no global singletons.
- **`src/framework/agent.ts`** — `BaseAgent.run()` is the template; subclasses
  override `execute()`. Don't break this contract.
- **Cross-agent imports** — agents never import each other. If two agents need
  to share something, it goes through `RunState` or `MemoryStore`.

If you find yourself wanting to break one of these rules, re-read the matching
section of CLAUDE.md first — there's usually a cleaner way.

---

## Running + testing

```bash
bun src/main.ts "your task here"       # run end-to-end
bun test                                # run all framework + agent tests
bun run typecheck                       # tsc --noEmit
bun src/evals/run.ts                    # run eval suite
```

If `bun test` is green and `typecheck` passes, your wiring is sound. If
`main.ts` runs but the answer is wrong, that's a prompt or tool problem — not
a framework problem.

---

## Where to look when stuck

| Symptom | First place to look |
|---|---|
| "Agent X not found" | `main.ts` — did you `registry.register(...)` it? |
| Tool isn't being called | The agent's `tools.ts` — is the tool in the array? |
| TypeScript can't resolve `@core/...` | `tsconfig.json` `paths` — match the directory layout |
| Run hangs forever | Tool not honoring `ctx.signal`, or `maxIterations` too high |
| `BudgetExceededError` | Raise `budgetUsd` in `main.ts`, or shrink prompts/tools |
| Strange duplicate-agent error | `AgentRegistry.register()` throws on collision — deliberate |
| Test is order-dependent / flaky | Probably global state somewhere it shouldn't be |

For deeper architectural questions, CLAUDE.md is the source of truth. For
day-to-day "how do I do X," this file is.

---

## A note on scope

This codebase is a **starter foundation**, not a published framework. There's
no npm package to install, no plugin system, no abstractions designed for
strangers. You're expected to fork it, adapt it, and own the result. That's
the point — clean bones you can build on, without the magic of a heavy
framework getting in the way.

When your project outgrows something here, change it. The architecture is
designed to survive that. When you find an improvement that's truly generic
(not project-specific), upstream it so the next project benefits.

Happy building.
