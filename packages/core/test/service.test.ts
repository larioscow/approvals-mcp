import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import {
  DecisionNotFoundError,
  InvalidTransitionError,
  UnknownActionKindError,
} from '../src/errors';
import { type Executor, ExecutorRegistry } from '../src/executors';
import { InMemoryDecisionStore } from '../src/memory-store';
import type { Policy } from '../src/policy';
import { type ApprovalEvent, ApprovalService } from '../src/service';
import type { Action, JsonValue } from '../src/types';

class FakeExecutor implements Executor {
  readonly kind = 'send_message';
  calls = 0;
  failTimes = 0;
  lastPayload: JsonValue | undefined;

  async execute(payload: JsonValue): Promise<JsonValue> {
    this.calls += 1;
    this.lastPayload = payload;
    if (this.calls <= this.failTimes) throw new Error(`boom ${this.calls}`);
    return { delivered: true, on: this.calls };
  }
}

/** Blocks inside execute() until released, to force a real execution race. */
class GatedExecutor implements Executor {
  readonly kind = 'send_message';
  calls = 0;
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async execute(): Promise<JsonValue> {
    this.calls += 1;
    await this.gate;
    return { delivered: true };
  }

  open(): void {
    this.release();
  }
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    kind: 'send_message',
    summary: 'Reply to a member in #general',
    payload: { channel: '#general', text: 'Welcome aboard!' },
    riskTier: 'medium',
    ...overrides,
  };
}

function setup(opts: { policy?: Policy; events?: ApprovalEvent[]; executor?: Executor } = {}) {
  const clock = new FakeClock(1_000);
  const executor = opts.executor ?? new FakeExecutor();
  const store = new InMemoryDecisionStore();
  const executors = new ExecutorRegistry().register(executor);
  const service = new ApprovalService({
    store,
    executors,
    clock,
    retryBaseDelayMs: 0,
    sleep: async () => {},
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.events ? { onEvent: (e: ApprovalEvent) => opts.events?.push(e) } : {}),
  });
  return { service, store, executor: executor as FakeExecutor, clock };
}

describe('construction', () => {
  it('rejects a negative executionRetries', () => {
    const store = new InMemoryDecisionStore();
    const executors = new ExecutorRegistry();
    expect(() => new ApprovalService({ store, executors, executionRetries: -1 })).toThrow(
      RangeError,
    );
  });
});

describe('submit', () => {
  it('creates a pending decision that waits for a human', async () => {
    const { service } = setup();
    const decision = await service.submit({ action: action() });

    expect(decision.status).toBe('pending');
    expect(decision.id).toMatch(/^dec_/);
    expect(decision.audit.map((e) => e.type)).toEqual(['submitted']);
    expect('idempotencyKey' in decision).toBe(false);
  });

  it('auto-approves when policy allows the tier', async () => {
    const policy: Policy = { default: { ttlSeconds: 60, autoApproveAtOrBelow: 'medium' } };
    const { service } = setup({ policy });
    const decision = await service.submit({ action: action({ riskTier: 'low' }) });

    expect(decision.status).toBe('approved');
    expect(decision.decidedBy).toBe('system');
    expect(decision.audit.map((e) => e.type)).toEqual(['submitted', 'auto_approved']);
  });

  it('dedupes repeat submits with the same idempotency key', async () => {
    const { service } = setup();
    const first = await service.submit({ action: action(), idempotencyKey: 'req-1' });
    const second = await service.submit({ action: action(), idempotencyKey: 'req-1' });

    expect(second.id).toBe(first.id);
  });

  it('rejects an action with no registered executor', async () => {
    const { service } = setup();
    await expect(service.submit({ action: action({ kind: 'wire_money' }) })).rejects.toBeInstanceOf(
      UnknownActionKindError,
    );
  });
});

describe('get', () => {
  it('throws for an unknown id', async () => {
    const { service } = setup();
    await expect(service.get('dec_missing')).rejects.toBeInstanceOf(DecisionNotFoundError);
  });
});

describe('approve / reject / cancel', () => {
  it('records the reviewer and reason on approval', async () => {
    const { service } = setup();
    const pending = await service.submit({ action: action() });
    const approved = await service.approve(pending.id, { reviewer: 'ana', reason: 'looks fine' });

    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe('ana');
    expect(approved.reason).toBe('looks fine');
  });

  it('omits reason entirely when none is given (exactOptionalPropertyTypes)', async () => {
    const { service } = setup();
    const pending = await service.submit({ action: action() });
    const approved = await service.approve(pending.id, { reviewer: 'ana' });
    expect('reason' in approved).toBe(false);
  });

  it('refuses to approve a decision that is not pending', async () => {
    const { service } = setup();
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    await expect(service.approve(pending.id, { reviewer: 'ana' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it('cancels a pending proposal and blocks execution', async () => {
    const { service, executor } = setup();
    const pending = await service.submit({ action: action() });
    const cancelled = await service.cancel(pending.id, { actor: 'agent', reason: 'superseded' });

    expect(cancelled.status).toBe('cancelled');
    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(false);
    expect(outcome.reason).toBe('not_approved');
    expect(executor.calls).toBe(0);
  });

  it('does not execute a rejected action', async () => {
    const { service, executor } = setup();
    const pending = await service.submit({ action: action() });
    await service.reject(pending.id, { reviewer: 'ana', reason: 'off-policy' });

    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.status).toBe('rejected');
    expect(executor.calls).toBe(0);
  });
});

describe('execute', () => {
  it('runs the executor once an action is approved', async () => {
    const { service, executor } = setup();
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(true);
    expect(outcome.reason).toBe('executed');
    expect(outcome.decision.status).toBe('executed');
    expect(outcome.decision.execution?.attempts).toBe(1);
    expect(executor.calls).toBe(1);
    expect(executor.lastPayload).toEqual({ channel: '#general', text: 'Welcome aboard!' });
  });

  it('never runs an approved action twice (sequential)', async () => {
    const { service, executor } = setup();
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const first = await service.execute(pending.id);
    const second = await service.execute(pending.id);

    expect(first.executed).toBe(true);
    expect(second.executed).toBe(false);
    expect(second.reason).toBe('already_executed');
    expect(executor.calls).toBe(1);
  });

  it('runs exactly once when two execute() calls race', async () => {
    const gated = new GatedExecutor();
    const { service } = setup({ executor: gated });
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const both = Promise.all([service.execute(pending.id), service.execute(pending.id)]);
    gated.open();
    const outcomes = await both;

    expect(outcomes.filter((o) => o.executed)).toHaveLength(1);
    expect(gated.calls).toBe(1);
    const loser = outcomes.find((o) => !o.executed);
    expect(loser?.reason === 'claim_lost' || loser?.reason === 'already_executed').toBe(true);
  });

  it('reports not_approved when executed too early', async () => {
    const { service, executor } = setup();
    const pending = await service.submit({ action: action() });
    const outcome = await service.execute(pending.id);
    expect(outcome.reason).toBe('not_approved');
    expect(executor.calls).toBe(0);
  });

  it('throws if the executor is missing at execution time, leaving the decision approved', async () => {
    const store = new InMemoryDecisionStore();
    const withExec = new ApprovalService({
      store,
      executors: new ExecutorRegistry().register(new FakeExecutor()),
    });
    const pending = await withExec.submit({ action: action() });
    await withExec.approve(pending.id, { reviewer: 'ana' });

    // A second node that never registered the executor tries to run it.
    const withoutExec = new ApprovalService({ store, executors: new ExecutorRegistry() });
    await expect(withoutExec.execute(pending.id)).rejects.toBeInstanceOf(UnknownActionKindError);
    expect((await withExec.get(pending.id)).status).toBe('approved');
  });

  it('retries a flaky executor and then succeeds', async () => {
    const { service, executor } = setup();
    executor.failTimes = 2;
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(true);
    expect(outcome.decision.execution?.attempts).toBe(3);
    expect(executor.calls).toBe(3);
  });

  it('marks the decision failed after exhausting retries', async () => {
    const { service, executor } = setup();
    executor.failTimes = 99;
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(false);
    expect(outcome.reason).toBe('failed');
    expect(outcome.decision.status).toBe('failed');
    expect(outcome.decision.execution?.error).toContain('boom');
  });

  it('records a useful error when the executor throws a non-Error', async () => {
    const thrower: Executor = {
      kind: 'send_message',
      async execute() {
        throw { code: 42, reason: 'nope' };
      },
    };
    const { service } = setup({ executor: thrower });
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });
    const outcome = await service.execute(pending.id);

    expect(outcome.decision.execution?.error).not.toBe('[object Object]');
    expect(outcome.decision.execution?.error).toContain('42');
  });
});

describe('retry', () => {
  it('re-arms a failed decision and lets it execute', async () => {
    const { service, executor } = setup();
    executor.failTimes = 99;
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });
    await service.execute(pending.id);

    executor.failTimes = 0;
    const rearmed = await service.retry(pending.id);
    expect(rearmed.status).toBe('approved');
    expect(rearmed.audit.map((e) => e.type)).toContain('retry_armed');
    expect('execution' in rearmed).toBe(false);

    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(true);
  });

  it('refuses to retry a decision that has not failed', async () => {
    const { service } = setup();
    const pending = await service.submit({ action: action() });
    await expect(service.retry(pending.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('expiry', () => {
  it('expires a pending decision once its ttl passes', async () => {
    const policy: Policy = { default: { ttlSeconds: 60 } };
    const { service, clock } = setup({ policy });
    const pending = await service.submit({ action: action() });

    clock.advance(61_000);
    expect((await service.get(pending.id)).status).toBe('expired');
    await expect(service.approve(pending.id, { reviewer: 'ana' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it('keeps a pending decision actionable before its ttl', async () => {
    const policy: Policy = { default: { ttlSeconds: 60 } };
    const { service, clock } = setup({ policy });
    const pending = await service.submit({ action: action() });

    clock.advance(59_000);
    expect((await service.get(pending.id)).status).toBe('pending');
  });

  it('emits exactly one expired event under concurrent reads', async () => {
    const events: ApprovalEvent[] = [];
    const policy: Policy = { default: { ttlSeconds: 60 } };
    const { service, clock } = setup({ policy, events });
    const pending = await service.submit({ action: action() });

    clock.advance(61_000);
    await Promise.all([service.get(pending.id), service.get(pending.id), service.get(pending.id)]);
    expect(events.filter((e) => e.type === 'expired')).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('approves exactly once when two reviewers race, emitting one event', async () => {
    const events: ApprovalEvent[] = [];
    const { service } = setup({ events });
    const pending = await service.submit({ action: action() });

    const results = await Promise.allSettled([
      service.approve(pending.id, { reviewer: 'ana' }),
      service.approve(pending.id, { reviewer: 'ben' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'approved')).toHaveLength(1);
  });

  it('lets reject win over a racing approve without both succeeding', async () => {
    const { service } = setup();
    const pending = await service.submit({ action: action() });
    const results = await Promise.allSettled([
      service.approve(pending.id, { reviewer: 'ana' }),
      service.reject(pending.id, { reviewer: 'ben' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('events', () => {
  it('emits one event per state change on the happy path', async () => {
    const events: ApprovalEvent[] = [];
    const { service } = setup({ events });
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });
    await service.execute(pending.id);

    expect(events.map((e) => e.type)).toEqual(['submitted', 'approved', 'executed']);
  });

  it('emits auto_approved instead of submitted when auto-approved', async () => {
    const events: ApprovalEvent[] = [];
    const policy: Policy = { default: { ttlSeconds: 60, autoApproveAtOrBelow: 'high' } };
    const { service } = setup({ policy, events });
    await service.submit({ action: action({ riskTier: 'low' }) });
    expect(events.map((e) => e.type)).toEqual(['auto_approved']);
  });

  it('emits execution_failed on retry exhaustion', async () => {
    const events: ApprovalEvent[] = [];
    const { service, executor } = setup({ events });
    executor.failTimes = 99;
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });
    await service.execute(pending.id);
    expect(events.map((e) => e.type)).toEqual(['submitted', 'approved', 'execution_failed']);
  });
});

describe('list / listPending', () => {
  async function seedPending(n: number, service: ApprovalService) {
    for (let i = 0; i < n; i++) await service.submit({ action: action({ summary: `item ${i}` }) });
  }

  it('returns only pending decisions, oldest first', async () => {
    const { service } = setup();
    const first = await service.submit({ action: action({ summary: 'first' }) });
    await service.submit({ action: action({ summary: 'second' }) });
    await service.approve(first.id, { reviewer: 'ana' });

    const page = await service.listPending();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.action.summary).toBe('second');
  });

  it('lists decisions filtered by a non-pending status', async () => {
    const { service } = setup();
    const a = await service.submit({ action: action() });
    await service.submit({ action: action() });
    await service.approve(a.id, { reviewer: 'ana' });

    const approved = await service.list({ status: 'approved' });
    expect(approved.items).toHaveLength(1);
    expect(approved.items[0]?.id).toBe(a.id);
  });

  it('walks every page via nextCursor with no gaps or repeats', async () => {
    const { service } = setup();
    await seedPending(5, service);

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof service.list>> = await service.list({
        status: 'pending',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      for (const d of page.items) seen.add(d.id);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(seen.size).toBe(5);
    expect(pages).toBe(3);
  });

  it('clamps limit and tolerates a malformed cursor', async () => {
    const { service } = setup();
    await seedPending(5, service);

    expect((await service.list({ status: 'pending', limit: 0 })).items.length).toBeGreaterThan(0);
    expect((await service.list({ status: 'pending', limit: 1000 })).items).toHaveLength(5);
    expect((await service.list({ status: 'pending', cursor: 'not-a-number' })).items).toHaveLength(
      5,
    );
  });
});
