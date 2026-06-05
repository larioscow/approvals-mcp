import { type Clock, systemClock } from './clock';
import { DecisionNotFoundError, InvalidTransitionError, UnknownActionKindError } from './errors';
import type { Executor, ExecutorRegistry } from './executors';
import { newDecisionId } from './ids';
import { DEFAULT_POLICY, isAutoApproved, type Policy, policyFor } from './policy';
import type { DecisionStore, ListOptions, ListQuery, Page } from './store';
import type {
  AuditEvent,
  AuditEventType,
  Decision,
  DecisionStatus,
  ExecutionResult,
} from './types';
import { describeError } from './util';

export interface SubmitInput {
  action: Decision['action'];
  /** A repeat submit with the same key returns the existing decision unchanged. */
  idempotencyKey?: string;
}

export interface DecideInput {
  reviewer: string;
  reason?: string;
}

export interface CancelInput {
  /** Who withdrew the proposal, typically the agent or 'system'. */
  actor: string;
  reason?: string;
}

/** Audit entries are emitted to `onEvent` except 'execution_started', which is audit-only. */
export type ApprovalEventType = Exclude<AuditEventType, 'execution_started'>;

export interface ApprovalEvent {
  type: ApprovalEventType;
  decision: Decision;
}

export type ExecuteReason =
  | 'executed'
  | 'failed'
  | 'not_approved'
  | 'already_executed'
  | 'claim_lost';

export interface ExecuteOutcome {
  executed: boolean;
  reason: ExecuteReason;
  decision: Decision;
}

export interface ApprovalServiceOptions {
  store: DecisionStore;
  executors: ExecutorRegistry;
  policy?: Policy;
  clock?: Clock;
  /** Retries after the first execution attempt. Default 2 (3 attempts total). */
  executionRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Fires on every state change; wire it to webhooks or tracing. */
  onEvent?: (event: ApprovalEvent) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds an agent's proposed action until a human decides, then runs it exactly
 * once. All I/O is injected (store, clock, executors, sleep), so the whole
 * state machine is exercisable without a network or a database. Every guarded
 * transition goes through the store's atomic compare-and-set, so concurrent
 * approve/reject/cancel/expire/execute calls resolve to a single winner and a
 * single emitted event.
 */
export class ApprovalService {
  private readonly store: DecisionStore;
  private readonly executors: ExecutorRegistry;
  private readonly policy: Policy;
  private readonly clock: Clock;
  private readonly executionRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent: ((event: ApprovalEvent) => void) | undefined;

  constructor(opts: ApprovalServiceOptions) {
    if (
      opts.executionRetries !== undefined &&
      (!Number.isInteger(opts.executionRetries) || opts.executionRetries < 0)
    ) {
      throw new RangeError('executionRetries must be a non-negative integer');
    }
    if (opts.retryBaseDelayMs !== undefined && opts.retryBaseDelayMs < 0) {
      throw new RangeError('retryBaseDelayMs must be non-negative');
    }
    this.store = opts.store;
    this.executors = opts.executors;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.clock = opts.clock ?? systemClock;
    this.executionRetries = opts.executionRetries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 200;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onEvent = opts.onEvent;
  }

  async submit(input: SubmitInput): Promise<Decision> {
    if (input.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    if (!this.executors.has(input.action.kind)) {
      throw new UnknownActionKindError(input.action.kind);
    }

    const now = this.clock.now();
    const { ttlSeconds } = policyFor(this.policy, input.action.kind);
    const auto = isAutoApproved(this.policy, input.action);

    const audit: AuditEvent[] = [{ type: 'submitted', at: now, actor: 'agent' }];
    if (auto) audit.push({ type: 'auto_approved', at: now, actor: 'system' });

    const decision: Decision = {
      id: newDecisionId(),
      status: auto ? 'approved' : 'pending',
      action: input.action,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      audit,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(auto ? { decidedAt: now, decidedBy: 'system' } : {}),
    };

    const saved = await this.store.create(decision);
    this.emit(auto ? 'auto_approved' : 'submitted', saved);
    return saved;
  }

  async get(id: string): Promise<Decision> {
    const found = await this.store.get(id);
    if (!found) throw new DecisionNotFoundError(id);
    return this.expireIfStale(found);
  }

  async list(query?: ListQuery): Promise<Page<Decision>> {
    const page = await this.store.list(query);
    const items: Decision[] = [];
    for (const decision of page.items) items.push(await this.expireIfStale(decision));
    return { ...page, items };
  }

  /**
   * The review queue. Just-expired rows are dropped, so a page may hold fewer
   * than `limit` items, so paginate on `nextCursor`, not on page length.
   */
  async listPending(opts?: ListOptions): Promise<Page<Decision>> {
    const page = await this.list({ ...opts, status: 'pending' });
    return { ...page, items: page.items.filter((d) => d.status === 'pending') };
  }

  approve(id: string, input: DecideInput): Promise<Decision> {
    return this.decide(id, 'approved', input.reviewer, input.reason);
  }

  reject(id: string, input: DecideInput): Promise<Decision> {
    return this.decide(id, 'rejected', input.reviewer, input.reason);
  }

  /** Withdraw a still-pending proposal (agent changed its mind, context went stale). */
  cancel(id: string, input: CancelInput): Promise<Decision> {
    return this.decide(id, 'cancelled', input.actor, input.reason);
  }

  /** Re-arm a failed decision for another execution, preserving its audit trail. */
  async retry(id: string): Promise<Decision> {
    const decision = await this.get(id);
    if (decision.status !== 'failed') throw new InvalidTransitionError(decision.status, 'retry');
    const { execution: _dropped, ...rest } = decision;
    const next: Decision = {
      ...rest,
      status: 'approved',
      audit: [...decision.audit, { type: 'retry_armed', at: this.clock.now(), actor: 'system' }],
    };
    const saved = await this.store.transition(id, 'failed', next);
    if (!saved) throw new InvalidTransitionError((await this.get(id)).status, 'retry');
    this.emit('retry_armed', saved);
    return saved;
  }

  async execute(id: string): Promise<ExecuteOutcome> {
    const current = await this.get(id);
    if (current.status === 'executed') {
      return { executed: false, reason: 'already_executed', decision: current };
    }
    if (current.status !== 'approved') {
      return { executed: false, reason: 'not_approved', decision: current };
    }

    // Resolve the executor BEFORE claiming, so a missing one leaves the decision
    // 'approved' (recoverable on a node that has it) instead of burning it.
    const executor = this.executors.get(current.action.kind);
    if (!executor) throw new UnknownActionKindError(current.action.kind);

    const executing: Decision = {
      ...current,
      status: 'executing',
      audit: [
        ...current.audit,
        { type: 'execution_started', at: this.clock.now(), actor: 'system' },
      ],
    };
    const claimed = await this.store.transition(id, 'approved', executing);
    if (!claimed) {
      const fresh = await this.get(id);
      const reason: ExecuteReason = fresh.status === 'executed' ? 'already_executed' : 'claim_lost';
      return { executed: false, reason, decision: fresh };
    }

    const result = await this.runWithRetries(executor, claimed);
    const saved = await this.store.save(this.withResult(claimed, result));
    this.emit(result.ok ? 'executed' : 'execution_failed', saved);
    return { executed: result.ok, reason: result.ok ? 'executed' : 'failed', decision: saved };
  }

  private async decide(
    id: string,
    status: 'approved' | 'rejected' | 'cancelled',
    actor: string,
    reason: string | undefined,
  ): Promise<Decision> {
    const decision = await this.get(id);
    if (decision.status !== 'pending') {
      throw new InvalidTransitionError(decision.status, verb(status));
    }
    const now = this.clock.now();
    const event: AuditEvent = {
      type: status,
      at: now,
      actor,
      ...(reason !== undefined ? { detail: reason } : {}),
    };
    const updated: Decision = {
      ...decision,
      status,
      decidedAt: now,
      decidedBy: actor,
      audit: [...decision.audit, event],
      ...(reason !== undefined ? { reason } : {}),
    };
    const saved = await this.store.transition(id, 'pending', updated);
    if (!saved) throw new InvalidTransitionError((await this.get(id)).status, verb(status));
    this.emit(status, saved);
    return saved;
  }

  private async runWithRetries(executor: Executor, decision: Decision): Promise<ExecutionResult> {
    const maxAttempts = Math.max(1, this.executionRetries + 1);
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const output = await executor.execute(decision.action.payload, {
          decisionId: decision.id,
          attempt,
        });
        return { ok: true, attempts: attempt, output };
      } catch (err) {
        lastError = describeError(err);
        if (attempt < maxAttempts) await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastError };
  }

  private withResult(decision: Decision, result: ExecutionResult): Decision {
    const event: AuditEvent = {
      type: result.ok ? 'executed' : 'execution_failed',
      at: this.clock.now(),
      actor: 'system',
      ...(result.error !== undefined ? { detail: result.error } : {}),
    };
    return {
      ...decision,
      status: result.ok ? 'executed' : 'failed',
      execution: result,
      audit: [...decision.audit, event],
    };
  }

  private async expireIfStale(decision: Decision): Promise<Decision> {
    if (decision.status !== 'pending' || this.clock.now() <= decision.expiresAt) {
      return decision;
    }
    const expired: Decision = {
      ...decision,
      status: 'expired',
      audit: [...decision.audit, { type: 'expired', at: this.clock.now(), actor: 'system' }],
    };
    const saved = await this.store.transition(decision.id, 'pending', expired);
    if (!saved) {
      // Another caller decided or expired it first; report the current truth.
      return (await this.store.get(decision.id)) ?? decision;
    }
    this.emit('expired', saved);
    return saved;
  }

  private emit(type: ApprovalEventType, decision: Decision): void {
    this.onEvent?.({ type, decision });
  }
}

function verb(status: DecisionStatus): string {
  if (status === 'approved') return 'approve';
  if (status === 'rejected') return 'reject';
  if (status === 'cancelled') return 'cancel';
  return status;
}
