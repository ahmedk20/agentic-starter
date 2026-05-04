import type { MemoryHit, MemoryStore } from "@core/types";

// Abstract base for persistent backends (SQLite, Redis, Postgres, ...).
// Adds close() and namespacedKey() — things all backends share but the MemoryStore
// interface cannot express (interfaces carry no constructor or concrete methods).
export abstract class LongTermMemory implements MemoryStore {
  // namespace prefixes every key so two agents sharing one backend never collide.
  // e.g. analyst writing "result" becomes "analyst:result", not the same key as researcher's "result".
  constructor(protected readonly namespace: string) {}

  abstract get(key: string): Promise<unknown>;
  abstract set(key: string, value: unknown): Promise<void>;
  abstract delete(key: string): Promise<void>;
  abstract search(query: string, opts?: { topK?: number }): Promise<MemoryHit[]>;

  // Backends hold open connections (file handles, TCP sockets) — callers must await close() when done.
  abstract close(): Promise<void>;

  // Concrete helper available to every subclass — DRY without duplicating the prefix logic.
  protected namespacedKey(key: string): string {
    return `${this.namespace}:${key}`;
  }
}
