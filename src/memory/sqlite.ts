import { Database, type Statement } from "bun:sqlite";
import type { MemoryHit } from "@core/types";
import { LongTermMemory } from "@memory/long-term";

// Concrete LongTermMemory backed by SQLite via bun:sqlite (zero-dep, sync driver).
// Single-process, single-file persistence — for distributed setups, swap this out for a
// Postgres or Redis backend; the agent code does not change because it only sees MemoryStore.
export class SqliteLongTermMemory extends LongTermMemory {
  private readonly db: Database;
  // Prepared statements: parsed once at construction, reused per call. Material throughput
  // gain at scale AND injection-safe — keys/values are bound, never concatenated into SQL.
  private readonly stmtGet: Statement;
  private readonly stmtSet: Statement;
  private readonly stmtDelete: Statement;
  private readonly stmtSearch: Statement;

  // dbPath defaults to ":memory:" so tests don't have to clean up files. Production code
  // passes a real path; bun:sqlite creates the file on first open if it doesn't exist.
  constructor(namespace: string, dbPath = ":memory:") {
    super(namespace);
    this.db = new Database(dbPath);

    // WAL: writers don't block readers and vice-versa. Without it, a concurrent search()
    // during a set() can fail with SQLITE_BUSY in long-running processes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.stmtGet = this.db.prepare("SELECT value FROM memory WHERE key = ?");
    // UPSERT — INSERT...ON CONFLICT is atomic, so two set() calls for the same key
    // can't produce a duplicate-key error or a lost write race.
    this.stmtSet = this.db.prepare(`
      INSERT INTO memory (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.stmtDelete = this.db.prepare("DELETE FROM memory WHERE key = ?");
    // Three bound params: namespace prefix (isolation), key LIKE, value LIKE.
    // ORDER BY updated_at DESC — most recently touched entries first; matches the
    // "fresh memories beat stale ones" expectation an agent has about a scratchpad.
    this.stmtSearch = this.db.prepare(`
      SELECT key, value FROM memory
      WHERE key LIKE ?
        AND (key LIKE ? OR value LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `);
  }

  async get(key: string): Promise<unknown> {
    const row = this.stmtGet.get(this.namespacedKey(key)) as { value: string } | null;
    // undefined for "not found" matches Map.get's contract — agents already handle this shape.
    return row ? JSON.parse(row.value) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const now = Date.now();
    this.stmtSet.run(this.namespacedKey(key), JSON.stringify(value), now, now);
  }

  async delete(key: string): Promise<void> {
    this.stmtDelete.run(this.namespacedKey(key));
  }

  async search(query: string, opts?: { topK?: number }): Promise<MemoryHit[]> {
    // Namespace prefix scopes search to this instance's keys only — without it, an analyst's
    // memory could surface a researcher's keys when they share a DB file.
    const namespacePrefix = `${this.namespace}:%`;
    const like = `%${query}%`;
    const limit = opts?.topK ?? 10;

    const rows = this.stmtSearch.all(namespacePrefix, like, like, limit) as Array<{
      key: string;
      value: string;
    }>;

    // score is intentionally omitted — LIKE has no relevance ranking. Matches the
    // documented contract in core/types.ts: "score absent for non-vector backends".
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
