import { describe, expect, it } from "bun:test";
import { InMemoryCostTracker, NoOpCostTracker } from "@framework/cost-tracker";
import { BudgetExceededError } from "@framework/errors";

const prices = {
  "gpt-4o":      { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60 },
};

describe("InMemoryCostTracker", () => {
  it("computes USD from token usage and the price table", () => {
    const t = new InMemoryCostTracker({ prices });
    // 1M input + 1M output on gpt-4o → $2.50 + $10.00 = $12.50
    t.record("analyst", "gpt-4o", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(t.totalUsd()).toBeCloseTo(12.5, 5);
  });

  it("attributes spend per-agent and per-model", () => {
    const t = new InMemoryCostTracker({ prices });
    t.record("analyst",    "gpt-4o",      { promptTokens: 100_000, completionTokens: 100_000 });
    t.record("researcher", "gpt-4o-mini", { promptTokens: 200_000, completionTokens: 200_000 });

    const s = t.summary();
    expect(s.byAgent["analyst"]?.tokens).toBe(200_000);
    expect(s.byAgent["researcher"]?.tokens).toBe(400_000);
    expect(s.byModel["gpt-4o"]?.usd).toBeCloseTo(0.25 + 1.0, 5);
    expect(s.byModel["gpt-4o-mini"]?.usd).toBeCloseTo(0.03 + 0.12, 5);
  });

  it("does not crash on unknown models — tokens count, USD stays zero", () => {
    let warnCount = 0;
    const t = new InMemoryCostTracker({
      prices,
      logger: {
        info: () => {},
        warn: () => warnCount++,
        error: () => {},
        debug: () => {},
      },
    });

    // Two calls to the same unknown model — the warn must fire exactly once, not twice.
    // Repeat-spam would drown real logs in misconfigured deployments.
    t.record("agent", "self-hosted-llama-3", { promptTokens: 500, completionTokens: 500 });
    t.record("agent", "self-hosted-llama-3", { promptTokens: 500, completionTokens: 500 });

    expect(warnCount).toBe(1);
    expect(t.summary().totalTokens).toBe(2000);
    expect(t.totalUsd()).toBe(0);
  });

  it("throws BudgetExceededError when accumulated spend reaches the cap", () => {
    const t = new InMemoryCostTracker({ prices, budgetUsd: 1.0 });
    // 100k input on gpt-4o = $0.25 — under cap.
    t.record("a", "gpt-4o", { promptTokens: 100_000, completionTokens: 0 });
    expect(() => t.assertWithinBudget()).not.toThrow();

    // Push past the cap.
    t.record("a", "gpt-4o", { promptTokens: 400_000, completionTokens: 0 });
    expect(() => t.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it("is a no-op when budgetUsd is omitted", () => {
    const t = new InMemoryCostTracker({ prices });
    t.record("a", "gpt-4o", { promptTokens: 100_000_000, completionTokens: 100_000_000 });
    // Massive spend, no cap — must not throw.
    expect(() => t.assertWithinBudget()).not.toThrow();
  });
});

describe("NoOpCostTracker", () => {
  it("records nothing, never throws, returns an empty summary", () => {
    const t = new NoOpCostTracker();
    t.record("a", "gpt-4o", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(t.totalUsd()).toBe(0);
    expect(() => t.assertWithinBudget()).not.toThrow();
    expect(t.summary()).toEqual({
      totalUsd: 0,
      totalTokens: 0,
      byAgent: {},
      byModel: {},
    });
  });
});
