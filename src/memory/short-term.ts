import type { MemoryHit, MemoryStore } from "@core/types";

export class ShortTermMemory implements MemoryStore {
  // One Map per run — instantiated in main.ts, garbage collected when the run ends.
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async search(query: string, opts?: { topK?: number }): Promise<MemoryHit[]> {
    // No embeddings — match keys that contain the query string (case-insensitive).
    // score is omitted: relevance ranking requires a vector backend, not a Map scan.
    const lower = query.toLowerCase();
    const hits: MemoryHit[] = [];

    for (const [key, value] of this.store) {
      if (key.toLowerCase().includes(lower)) {
        hits.push({ key, value });
        // Check topK inside the loop so we never build a huge intermediate array.
        if (opts?.topK !== undefined && hits.length >= opts.topK) break;
      }
    }

    return hits;
  }
}
