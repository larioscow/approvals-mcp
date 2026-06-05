import {
  ApprovalService,
  type Decision,
  DecisionNotFoundError,
  type Executor,
  ExecutorRegistry,
  type JsonValue,
} from '@approvals-mcp/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteStore } from '../src/pglite';
import type { ConnectedStore } from '../src/store';

class FakeExecutor implements Executor {
  readonly kind = 'send_message';
  calls = 0;
  async execute(): Promise<JsonValue> {
    this.calls += 1;
    return { ok: true };
  }
}

function action(summary = 'Reply to a member') {
  return {
    kind: 'send_message',
    summary,
    payload: { channel: '#general', text: 'Hi!' } as JsonValue,
    riskTier: 'medium' as const,
  };
}

let conn: ConnectedStore;
let service: ApprovalService;
let executor: FakeExecutor;

beforeEach(async () => {
  conn = await createPgliteStore();
  executor = new FakeExecutor();
  service = new ApprovalService({
    store: conn.store,
    executors: new ExecutorRegistry().register(executor),
    retryBaseDelayMs: 0,
    sleep: async () => {},
  });
});

afterEach(async () => {
  await conn.close();
});

describe('DrizzleDecisionStore over the service', () => {
  it('round-trips a decision through submit, approve, execute', async () => {
    const pending = await service.submit({ action: action() });
    expect(pending.status).toBe('pending');

    const fetched = await service.get(pending.id);
    expect(fetched.action.summary).toBe('Reply to a member');

    await service.approve(pending.id, { reviewer: 'ana', reason: 'ok' });
    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(true);
    expect(outcome.decision.status).toBe('executed');
    expect(outcome.decision.reason).toBe('ok');
    expect(outcome.decision.audit.map((e) => e.type)).toContain('executed');
  });

  it('throws DecisionNotFoundError for an unknown id', async () => {
    await expect(service.get('dec_nope')).rejects.toBeInstanceOf(DecisionNotFoundError);
  });

  it('dedupes on idempotency key (unique column)', async () => {
    const first = await service.submit({ action: action(), idempotencyKey: 'req-1' });
    const second = await service.submit({ action: action(), idempotencyKey: 'req-1' });
    expect(second.id).toBe(first.id);
  });

  it('executes exactly once when two execute() calls race (SQL compare-and-set)', async () => {
    const pending = await service.submit({ action: action() });
    await service.approve(pending.id, { reviewer: 'ana' });

    const outcomes = await Promise.all([service.execute(pending.id), service.execute(pending.id)]);
    expect(outcomes.filter((o) => o.executed)).toHaveLength(1);
    expect(executor.calls).toBe(1);
  });

  it('approves exactly once when two reviewers race', async () => {
    const pending = await service.submit({ action: action() });
    const results = await Promise.allSettled([
      service.approve(pending.id, { reviewer: 'ana' }),
      service.approve(pending.id, { reviewer: 'ben' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('does not execute a rejected action', async () => {
    const pending = await service.submit({ action: action() });
    await service.reject(pending.id, { reviewer: 'ana' });
    const outcome = await service.execute(pending.id);
    expect(outcome.executed).toBe(false);
    expect(executor.calls).toBe(0);
  });

  it('filters by status and lists the pending queue', async () => {
    const a = await service.submit({ action: action('first') });
    await service.submit({ action: action('second') });
    await service.approve(a.id, { reviewer: 'ana' });

    const approved = await service.list({ status: 'approved' });
    expect(approved.items.map((d: Decision) => d.id)).toEqual([a.id]);

    const pending = await service.listPending();
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.action.summary).toBe('second');
  });

  it('paginates the pending queue via nextCursor', async () => {
    for (let i = 0; i < 5; i++) await service.submit({ action: action(`item ${i}`) });

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.list({
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
});
