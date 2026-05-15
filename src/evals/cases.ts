import type { PlanStep } from "@framework/orchestrator";

// A single eval scenario. In fake mode, scriptedPlan + scriptedAgentResponses +
// scriptedSynthesis fully determine what the FakeLLMProvider and stub agents return,
// so the test exercises the orchestrator's plumbing under a known-good control.
// In real mode (not built yet) only `task` would be used and the LLM would do the
// planning + responding + synthesis live.
export interface EvalCase {
  id: string;
  description: string;
  task: string;
  scriptedPlan: PlanStep[];
  scriptedAgentResponses: Record<string, string>;
  scriptedSynthesis: string;
  // What the orchestrator must dispatch successfully for the case to pass —
  // subset match (extra agents allowed, missing agents fail).
  expectedAgents: string[];
  // Substrings the final synthesized answer must contain (case-sensitive).
  expectedKeywords: string[];
  // When true, the case is EXPECTED to fail the score. The runner inverts the result:
  // the case "passes" iff the scorer flags it as failing. Used to verify the scorer
  // itself catches gaps rather than silently accepting a bad answer.
  xfail?: boolean;
}

// Sentinel a stub agent recognises and throws on — used to script controlled failures.
export const FAIL_SENTINEL = "__FAIL__";

// Ten cases covering the routing + coverage signal we care about. Failure-path cases
// (cascade-skip, mid-plan failure) live in orchestrator.test.ts; here we measure whether
// the full plan→dispatch→synthesise pipeline produces an answer that addresses the task.
export const EVAL_CASES: EvalCase[] = [
  {
    id: "math-only",
    description: "Simple arithmetic should route to analyst only",
    task: "What is 15% of 2400?",
    scriptedPlan: [{ agentName: "analyst", task: "Calculate 15% of 2400" }],
    scriptedAgentResponses: { analyst: "15% of 2400 is 360." },
    scriptedSynthesis: "The answer is 360.",
    expectedAgents: ["analyst"],
    expectedKeywords: ["360"],
  },
  {
    id: "outline-only",
    description: "Pure outline request routes to researcher only",
    task: "Outline the main differences between Python and JavaScript.",
    scriptedPlan: [{ agentName: "researcher", task: "Outline Python vs JS" }],
    scriptedAgentResponses: {
      researcher: "1. Typing 2. Concurrency 3. Ecosystem",
    },
    scriptedSynthesis: "Python and JavaScript differ in Typing, Concurrency, and Ecosystem.",
    expectedAgents: ["researcher"],
    expectedKeywords: ["Typing", "Concurrency"],
  },
  {
    id: "both-parallel",
    description: "Independent angles run both agents without a dependency",
    task: "Analyze SQL vs NoSQL and outline the comparison.",
    scriptedPlan: [
      { agentName: "researcher", task: "Outline SQL vs NoSQL" },
      { agentName: "analyst",    task: "Analyse tradeoffs" },
    ],
    scriptedAgentResponses: {
      researcher: "Outline: schema, consistency, scaling models.",
      analyst:    "Tradeoffs: ACID guarantees vs eventual consistency.",
    },
    scriptedSynthesis:
      "SQL offers ACID and a strict schema; NoSQL prioritises scaling with eventual consistency.",
    expectedAgents: ["analyst", "researcher"],
    expectedKeywords: ["ACID", "scal"],
  },
  {
    id: "researcher-then-analyst",
    description: "Sequential: research first, then analyse using the research output",
    task: "Research the major web frameworks and recommend one for a startup.",
    scriptedPlan: [
      { agentName: "researcher", task: "List major web frameworks" },
      { agentName: "analyst",    task: "Recommend for a startup", dependsOn: ["researcher"] },
    ],
    scriptedAgentResponses: {
      researcher: "React, Vue, Svelte, Angular are the major options.",
      analyst:    "For a startup, React — largest hiring pool and ecosystem.",
    },
    scriptedSynthesis:
      "React is the recommendation; alternatives include Vue, Svelte, and Angular.",
    expectedAgents: ["researcher", "analyst"],
    expectedKeywords: ["React"],
  },
  {
    id: "missing-keyword-detected",
    description: "Vague synthesis fails the keyword check — proves scorer catches gaps",
    task: "Explain HTTP caching headers.",
    scriptedPlan: [{ agentName: "researcher", task: "List HTTP caching headers" }],
    scriptedAgentResponses: {
      researcher: "Cache-Control, ETag, Expires, Last-Modified",
    },
    // Intentionally vague — expectedKeywords requires "Cache-Control" and "ETag" but
    // this synthesis only says "Some headers." Scoring must flag this as a failure.
    scriptedSynthesis: "Some headers exist for caching purposes.",
    expectedAgents: ["researcher"],
    expectedKeywords: ["Cache-Control", "ETag"],
    xfail: true,
  },
  {
    id: "deep-keyword-coverage",
    description: "Answer must hit multiple specific terms",
    task: "Explain the SOLID principles.",
    scriptedPlan: [{ agentName: "researcher", task: "Outline SOLID" }],
    scriptedAgentResponses: {
      researcher:
        "S - Single Responsibility, O - Open/Closed, L - Liskov, I - Interface Segregation, D - Dependency Inversion",
    },
    scriptedSynthesis:
      "SOLID is: Single Responsibility, Open/Closed, Liskov substitution, Interface Segregation, and Dependency Inversion.",
    expectedAgents: ["researcher"],
    expectedKeywords: ["Single Responsibility", "Liskov", "Dependency Inversion"],
  },
  {
    id: "domain-research",
    description: "Domain-specific research-only routing",
    task: "What is the difference between TCP and UDP?",
    scriptedPlan: [{ agentName: "researcher", task: "Compare TCP and UDP" }],
    scriptedAgentResponses: {
      researcher: "TCP is connection-oriented, reliable, ordered. UDP is connectionless, fast.",
    },
    scriptedSynthesis: "TCP guarantees ordered delivery; UDP trades reliability for speed.",
    expectedAgents: ["researcher"],
    expectedKeywords: ["TCP", "UDP"],
  },
  {
    id: "calculation-with-explanation",
    description: "Analyst-led with a clear numeric answer",
    task: "Calculate compound interest on $1000 at 5% for 3 years.",
    scriptedPlan: [{ agentName: "analyst", task: "Compute compound interest" }],
    scriptedAgentResponses: {
      analyst: "1000 * 1.05^3 = $1157.625",
    },
    scriptedSynthesis: "Compound interest yields approximately $1157.63 after 3 years.",
    expectedAgents: ["analyst"],
    expectedKeywords: ["1157"],
  },
  {
    id: "mixed-synthesis",
    description: "Synthesis must combine BOTH agents' outputs into one answer",
    task: "Survey REST vs GraphQL and pick one for a mobile-first app.",
    scriptedPlan: [
      { agentName: "researcher", task: "Survey REST vs GraphQL" },
      { agentName: "analyst",    task: "Pick one for mobile-first", dependsOn: ["researcher"] },
    ],
    scriptedAgentResponses: {
      researcher: "REST is stateless and cache-friendly. GraphQL gives clients precise queries.",
      analyst:    "Mobile-first favours GraphQL — less over-fetching on metered networks.",
    },
    scriptedSynthesis:
      "GraphQL is preferred for mobile-first apps; REST remains simpler and cache-friendly.",
    expectedAgents: ["researcher", "analyst"],
    expectedKeywords: ["GraphQL", "mobile"],
  },
  {
    id: "agent-failure-recovers",
    description: "One agent fails — synthesis still produces an answer from the survivor",
    task: "Multi-angle task where the analyst fails mid-plan.",
    scriptedPlan: [
      { agentName: "researcher", task: "Research the topic" },
      { agentName: "analyst",    task: "Analyse the result" },
    ],
    scriptedAgentResponses: {
      researcher: "Research findings present.",
      analyst:    FAIL_SENTINEL, // stub throws — orchestrator allSettled keeps survivor
    },
    scriptedSynthesis:
      "Partial answer based on research findings; analysis was not available.",
    // Only researcher counted as succeeded — analyst is excluded because it failed.
    expectedAgents: ["researcher"],
    expectedKeywords: ["Partial", "research"],
  },
];
