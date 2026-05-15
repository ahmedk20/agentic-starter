import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SqliteLongTermMemory } from "@memory/sqlite";

// Per-test DB paths in the OS temp dir — cross-platform, cleaned up after each test.
// Two memories sharing one file is how we validate namespace isolation (can't be done
// with :memory: because each :memory: open creates a fresh, unshared database).
const sharedPaths: string[] = [];

afterEach(() => {
  for (const p of sharedPaths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      const f = `${p}${suffix}`;
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // Windows can briefly hold the WAL handle after close() — best-effort cleanup,
        // the OS temp dir self-clears so a leaked file isn't an indefinite problem.
      }
    }
  }
});

function tempDbPath(): string {
  const p = join(tmpdir(), `agentic-fw-test-${crypto.randomUUID()}.db`);
  sharedPaths.push(p);
  return p;
}

describe("SqliteLongTermMemory", () => {
  it("round-trips set / get / delete with JSON-serialisable values", async () => {
    const m = new SqliteLongTermMemory("test");
    await m.set("greeting", { hello: "world", count: 3 });

    expect(await m.get("greeting")).toEqual({ hello: "world", count: 3 });

    await m.delete("greeting");
    expect(await m.get("greeting")).toBeUndefined();
    await m.close();
  });

  it("set on an existing key updates rather than throwing on the PRIMARY KEY", async () => {
    // Without ON CONFLICT DO UPDATE, the second set() would throw SQLITE_CONSTRAINT.
    const m = new SqliteLongTermMemory("test");
    await m.set("k", "v1");
    await m.set("k", "v2");
    expect(await m.get("k")).toBe("v2");
    await m.close();
  });

  it("search finds matches in keys and values, ordered most-recent-first", async () => {
    const m = new SqliteLongTermMemory("test");
    await m.set("user-1",   "Alice studies databases");
    await m.set("user-2",   "Bob studies compilers");
    await m.set("topic-db", "indexing and B-trees");

    const hits = await m.search("databases");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.value).toBe("Alice studies databases");
    await m.close();
  });

  it("search respects topK", async () => {
    const m = new SqliteLongTermMemory("test");
    for (let i = 0; i < 20; i++) await m.set(`item-${i}`, "match-me");
    const hits = await m.search("match-me", { topK: 5 });
    expect(hits.length).toBe(5);
    await m.close();
  });

  it("namespace isolation — two stores sharing a file do not see each other's keys", async () => {
    // The load-bearing test for this backend. Without the namespace prefix in stmtSearch,
    // a search() on memory A would surface memory B's writes when they share a DB file.
    const path = tempDbPath();
    const analyst    = new SqliteLongTermMemory("analyst", path);
    const researcher = new SqliteLongTermMemory("researcher", path);

    await analyst.set("note", "analysis-only");
    await researcher.set("note", "research-only");

    // Same logical key, different namespaces → different values returned.
    expect(await analyst.get("note")).toBe("analysis-only");
    expect(await researcher.get("note")).toBe("research-only");

    // Search must NOT cross namespaces. A search for "research-only" from the analyst
    // store finds nothing — even though the row physically exists in the same file.
    const analystHits = await analyst.search("research-only");
    expect(analystHits).toEqual([]);

    const researcherHits = await researcher.search("research-only");
    expect(researcherHits.length).toBe(1);

    await analyst.close();
    await researcher.close();
  });
});
