import type { LLMCompleteOptions, LLMProvider, LLMResponse, Message } from "@core/types";

export class FakeLLMProvider implements LLMProvider {
  // Immutable snapshot of the scripted responses passed at construction time.
  private readonly queue: LLMResponse[];

  // Every complete() call is recorded here so tests can assert on what was sent.
  readonly calls: Array<{ messages: Message[]; opts?: LLMCompleteOptions }> = [];

  private callIndex = 0;

  constructor(responses: LLMResponse[]) {
    // Copy so callers can't mutate the array after construction.
    this.queue = [...responses];
  }

  async complete(messages: Message[], opts?: LLMCompleteOptions): Promise<LLMResponse> {
    this.calls.push({ messages, ...(opts !== undefined ? { opts } : {}) });

    const response = this.queue[this.callIndex];
    if (response === undefined) {
      // Throw loudly — a missing scripted response is a test authoring bug, not a runtime error.
      throw new Error(
        `FakeLLMProvider: no scripted response for call #${this.callIndex}. ` +
          `Add more responses to the constructor array.`,
      );
    }

    this.callIndex++;
    return response;
  }

  async *stream(messages: Message[], opts?: LLMCompleteOptions): AsyncIterable<string> {
    // Reuse complete() so stream() calls are also recorded in this.calls.
    const response = await this.complete(messages, opts);
    if (response.kind === "text") yield response.text;
  }

  async tokenCount(messages: Message[]): Promise<number> {
    // Deterministic stub — predictable in snapshots, never hits a real API.
    return messages.length * 10;
  }
}
