import type { Decision, DecisionStatus } from './types';

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface ListQuery extends ListOptions {
  /** Restrict to one or more statuses. Omit to list everything. */
  status?: DecisionStatus | DecisionStatus[];
}

export interface Page<T> {
  items: T[];
  /** Opaque, server-issued. Pass it back as `cursor`; do not hand-craft it. */
  nextCursor?: string;
  total: number;
}

export interface DecisionStore {
  create(decision: Decision): Promise<Decision>;
  get(id: string): Promise<Decision | undefined>;
  findByIdempotencyKey(key: string): Promise<Decision | undefined>;
  /**
   * Non-atomic full replacement. Safe only when the caller already holds the
   * decision exclusively (e.g. after a successful `transition` to 'executing').
   * Do NOT use it for guarded state changes; use `transition`.
   */
  save(decision: Decision): Promise<Decision>;
  /**
   * Atomic compare-and-set: replace the stored decision with `next` only if its
   * current status equals `expectedStatus`. Returns the saved decision on a win,
   * or undefined if the status no longer matched (lost race / already moved on).
   * This is the single primitive every guarded transition is built on.
   */
  transition(
    id: string,
    expectedStatus: DecisionStatus,
    next: Decision,
  ): Promise<Decision | undefined>;
  list(query?: ListQuery): Promise<Page<Decision>>;
}
