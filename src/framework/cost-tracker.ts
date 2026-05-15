import type { CostSummary, CostTracker, ScopedLogger, TokenUsage } from "@core/types";
import { BudgetExceededError } from "@framework/errors";

// USD per 1M tokens — matches the unit OpenAI publishes prices in, so config copy/paste
// from their pricing page is a one-line entry rather than a per-token decimal conversion.
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface InMemoryCostTrackerOptions {
  prices: Record<string, ModelPrice>;
  // Hard ceiling in USD. Omit to disable enforcement (still records, never throws).
  budgetUsd?: number;
  // Optional — used to log the one-time warning about unpriced models.
  logger?: ScopedLogger;
}

// Per-run, in-memory cost ledger. One instance per Orchestrator.run() call —
// totals do not persist across runs, which is the correct lifecycle: budgets are
// enforced per task, and a long-running process should not silently accumulate.
export class InMemoryCostTracker implements CostTracker {
  private _totalUsd = 0;
  private _totalTokens = 0;
  private readonly byAgent = new Map<string, { tokens: number; usd: number }>();
  private readonly byModel = new Map<string, { tokens: number; usd: number }>();
  // Suppress repeat warnings — a misconfigured deployment shouldn't spam logs on every call.
  private readonly warnedUnknownModels = new Set<string>();

  constructor(private readonly opts: InMemoryCostTrackerOptions) {}

  record(agentName: string, model: string, usage: TokenUsage): void {
    const price = this.opts.prices[model];
    if (!price && !this.warnedUnknownModels.has(model)) {
      this.warnedUnknownModels.add(model);
      this.opts.logger?.warn("no price configured for model — usage will not be costed", {
        model,
      });
    }
    // Missing-price models still get token-counted; they just contribute $0 to the ledger.
    // Crashing here would be hostile to self-hosted / proxy deployments where price is zero.
    const usd = price
      ? (usage.promptTokens / 1_000_000) * price.inputPerMillion +
        (usage.completionTokens / 1_000_000) * price.outputPerMillion
      : 0;
    const tokens = usage.promptTokens + usage.completionTokens;

    this._totalUsd += usd;
    this._totalTokens += tokens;
    bump(this.byAgent, agentName, tokens, usd);
    bump(this.byModel, model, tokens, usd);
  }

  totalUsd(): number {
    return this._totalUsd;
  }

  assertWithinBudget(): void {
    if (this.opts.budgetUsd === undefined) return;
    // Check >= so a call that exactly reaches the cap blocks the NEXT one — prevents
    // an off-by-one where we narrowly stay under cap but fire one more billable request.
    if (this._totalUsd >= this.opts.budgetUsd) {
      throw new BudgetExceededError(this._totalUsd, this.opts.budgetUsd);
    }
  }

  summary(): CostSummary {
    return {
      totalUsd: this._totalUsd,
      totalTokens: this._totalTokens,
      byAgent: Object.fromEntries(this.byAgent),
      byModel: Object.fromEntries(this.byModel),
    };
  }
}

// Stub for tests and contexts where cost tracking is irrelevant. Required because
// CostTracker is non-optional on AgentContext — making it optional would force every
// provider to null-check, and a forgotten check in production silently loses cost data.
export class NoOpCostTracker implements CostTracker {
  // Signature matches the interface so callers can pass args; we just ignore them.
  // Zero-arg `record()` would be valid LSP-wise but produces a less-helpful TS error at
  // call sites that destructure the interface — match the real signature for ergonomics.
  record(_agentName: string, _model: string, _usage: TokenUsage): void {}
  totalUsd(): number {
    return 0;
  }
  assertWithinBudget(): void {}
  summary(): CostSummary {
    return { totalUsd: 0, totalTokens: 0, byAgent: {}, byModel: {} };
  }
}

function bump(
  m: Map<string, { tokens: number; usd: number }>,
  key: string,
  tokens: number,
  usd: number,
): void {
  const cur = m.get(key) ?? { tokens: 0, usd: 0 };
  m.set(key, { tokens: cur.tokens + tokens, usd: cur.usd + usd });
}
