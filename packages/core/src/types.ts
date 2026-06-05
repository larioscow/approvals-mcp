/** Plain JSON data. Payloads and outputs must be JSON-serializable: they are
 *  deep-copied by the store and may be sent over a webhook. No class instances,
 *  functions, Date, BigInt, Map/Set, or circular references. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RiskTier = 'low' | 'medium' | 'high';

export const RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];

/**
 * Lifecycle of a single proposed action.
 *
 *   pending ─approve─▶ approved ─claim─▶ executing ─▶ executed
 *      │                  │                             │
 *      ├─reject─▶ rejected│                             └─(fail)─▶ failed ─retry─▶ approved
 *      ├─cancel─▶ cancelled
 *      └─(ttl)──▶ expired
 *
 * Every transition out of `pending`, plus the approved→executing claim, goes
 * through an atomic compare-and-set so exactly one caller can win it.
 */
export type DecisionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'expired';

/** A side effect an agent proposes to take, held until a human decides. */
export interface Action {
  /** Routes the action to a registered executor, e.g. 'send_message'. */
  kind: string;
  /** Human-readable one-liner shown on the review card. */
  summary: string;
  /** Validated by the executor registered for `kind`; must be JSON data. */
  payload: JsonValue;
  riskTier: RiskTier;
}

export type AuditEventType =
  | 'submitted'
  | 'auto_approved'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'execution_started'
  | 'executed'
  | 'execution_failed'
  | 'expired'
  | 'retry_armed';

export interface AuditEvent {
  type: AuditEventType;
  /** Epoch milliseconds. */
  at: number;
  /** Reviewer id, 'system', or 'agent'. */
  actor: string;
  detail?: string;
}

export interface ExecutionResult {
  ok: boolean;
  attempts: number;
  output?: JsonValue;
  error?: string;
}

export interface Decision {
  id: string;
  status: DecisionStatus;
  action: Action;
  /** When set, a repeat submit with the same key returns this decision unchanged. */
  idempotencyKey?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
  execution?: ExecutionResult;
  audit: AuditEvent[];
}
