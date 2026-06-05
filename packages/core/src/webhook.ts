import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JsonValue } from './types';
import { describeError } from './util';

export const SIGNATURE_HEADER = 'x-approvals-signature';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time check so a caller can't probe the secret by timing. */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signBody(secret, body));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export interface WebhookEvent {
  type: string;
  decisionId: string;
  data: JsonValue;
}

export interface DeliverOptions {
  url: string;
  secret: string;
  event: WebhookEvent;
  /** Lets the receiver drop duplicates from retries. */
  idempotencyKey: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Per-attempt timeout. A hung receiver aborts instead of pinning the caller. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 429 || status === 408;

/**
 * POST a signed event with bounded exponential backoff and a per-attempt
 * timeout. Retries network errors, timeouts, 5xx, 429, and 408; any other 4xx
 * is treated as permanent. Never throws; a non-serializable event or an
 * exhausted budget comes back as `{ ok: false }`.
 */
export async function deliverWebhook(opts: DeliverOptions): Promise<DeliveryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let body: string;
  try {
    body = JSON.stringify(opts.event);
  } catch (err) {
    return { ok: false, attempts: 0, error: `event not serializable: ${describeError(err)}` };
  }

  const headers = {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: signBody(opts.secret, body),
    [IDEMPOTENCY_HEADER]: opts.idempotencyKey,
  };

  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(opts.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true, attempts: attempt, status: res.status };
      lastError = `HTTP ${res.status}`;
      if (!isRetryableStatus(res.status)) {
        return { ok: false, attempts: attempt, status: res.status, error: lastError };
      }
    } catch (err) {
      lastError = describeError(err);
    }
    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return { ok: false, attempts: maxAttempts, error: lastError };
}
