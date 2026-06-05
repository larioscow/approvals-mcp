import { describe, expect, it } from 'vitest';
import {
  deliverWebhook,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  signBody,
  verifySignature,
  type WebhookEvent,
} from '../src/webhook';

const event: WebhookEvent = { type: 'decision.approved', decisionId: 'dec_1', data: { ok: true } };

/** A fetch stand-in driven by a fixed sequence of statuses or thrown errors. */
function sequenceFetch(steps: Array<number | Error>) {
  const calls: RequestInit[] = [];
  let i = 0;
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return new Response(null, { status: step ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const base = { url: 'https://hook.test/in', secret: 's3cret', event, idempotencyKey: 'evt-1' };
const noWait = async () => {};

describe('signatures', () => {
  it('verifies a body signed with the same secret', () => {
    const body = JSON.stringify(event);
    expect(verifySignature('s3cret', body, signBody('s3cret', body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature('s3cret', 'tampered', signBody('s3cret', 'original'))).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = JSON.stringify(event);
    expect(verifySignature('s3cret', body, signBody('other', body))).toBe(false);
  });
});

describe('deliverWebhook', () => {
  it('signs the body and sends the idempotency key', async () => {
    const { fn, calls } = sequenceFetch([200]);
    await deliverWebhook({ ...base, fetchImpl: fn, sleep: noWait });

    const headers = calls[0]?.headers as Record<string, string> | undefined;
    expect(headers?.[IDEMPOTENCY_HEADER]).toBe('evt-1');
    expect(headers?.[SIGNATURE_HEADER]).toBe(signBody('s3cret', JSON.stringify(event)));
  });

  it('retries a 5xx and then succeeds', async () => {
    const { fn } = sequenceFetch([503, 200]);
    const result = await deliverWebhook({ ...base, fetchImpl: fn, sleep: noWait });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('retries a 429 rate-limit response', async () => {
    const { fn } = sequenceFetch([429, 200]);
    const result = await deliverWebhook({ ...base, fetchImpl: fn, sleep: noWait });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('does not retry a 4xx', async () => {
    const { fn, calls } = sequenceFetch([400]);
    const result = await deliverWebhook({ ...base, fetchImpl: fn, sleep: noWait });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the attempt budget', async () => {
    const { fn, calls } = sequenceFetch([500]);
    const result = await deliverWebhook({ ...base, maxAttempts: 3, fetchImpl: fn, sleep: noWait });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('retries a thrown network error', async () => {
    const { fn } = sequenceFetch([new Error('ECONNRESET'), 200]);
    const result = await deliverWebhook({ ...base, fetchImpl: fn, sleep: noWait });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('aborts a hung attempt via the per-attempt timeout instead of hanging', async () => {
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const result = await deliverWebhook({
      ...base,
      fetchImpl: hangingFetch,
      timeoutMs: 5,
      maxAttempts: 2,
      sleep: noWait,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it('returns a clean failure (not a throw) for a non-serializable event', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { fn } = sequenceFetch([200]);
    const result = await deliverWebhook({
      ...base,
      event: { type: 't', decisionId: 'dec_1', data: circular } as unknown as WebhookEvent,
      fetchImpl: fn,
      sleep: noWait,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.error).toContain('not serializable');
  });
});
