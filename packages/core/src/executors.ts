import type { JsonValue } from './types';

export interface ExecutionContext {
  decisionId: string;
  /** 1-based attempt number; greater than 1 means a retry is in progress. */
  attempt: number;
}

/** Performs the real side effect once a decision is approved. */
export interface Executor {
  readonly kind: string;
  execute(payload: JsonValue, ctx: ExecutionContext): Promise<JsonValue>;
}

export class ExecutorRegistry {
  private readonly byKind = new Map<string, Executor>();

  /** Last registration for a kind wins. */
  register(executor: Executor): this {
    this.byKind.set(executor.kind, executor);
    return this;
  }

  get(kind: string): Executor | undefined {
    return this.byKind.get(kind);
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  /** The action kinds this registry can execute. */
  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/**
 * A no-network executor that hands the payload to a sink. Defaults to logging,
 * which makes the whole pipeline runnable with no credentials.
 */
export function createConsoleExecutor(
  kind: string,
  sink: (payload: JsonValue) => void = (payload) => {
    console.log(`[execute:${kind}]`, payload);
  },
): Executor {
  return {
    kind,
    async execute(payload) {
      sink(payload);
      return { delivered: true };
    },
  };
}
