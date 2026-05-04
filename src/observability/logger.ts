import type { ScopedLogger } from "@core/types";

// Implements ScopedLogger — every method outputs a single JSON line.
// agentName + runId are baked in at construction time (not passed per-call)
// because the logger is always scoped to one agent inside one run.
export class ConsoleScopedLogger implements ScopedLogger {
  constructor(
    private readonly agentName: string,
    private readonly runId: string,
  ) {}

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", message, meta);
  }

  // One private method owns the shape of every log line — change the format once, it propagates everywhere.
  private emit(level: string, message: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({
      level,
      agent: this.agentName,
      runId: this.runId,
      message,
      ts: Date.now(),
      ...meta,
    });
    // Route error/warn to stderr so they survive log-level filters in production pipelines.
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
