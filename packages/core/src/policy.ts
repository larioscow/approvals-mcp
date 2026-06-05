import type { Action, RiskTier } from './types';

export interface ActionPolicy {
  /**
   * Auto-approve when the action's tier is at or below this one. Omit to always
   * require a human. 'high' actions are never auto-approved regardless.
   */
  autoApproveAtOrBelow?: RiskTier;
  /** Seconds a pending decision stays actionable before it expires. */
  ttlSeconds: number;
}

export interface Policy {
  default: ActionPolicy;
  byKind?: Record<string, ActionPolicy>;
}

const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/** Human approval required for everything, pending decisions live for 24h. */
export const DEFAULT_POLICY: Policy = {
  default: { ttlSeconds: 24 * 60 * 60 },
};

export function policyFor(policy: Policy, kind: string): ActionPolicy {
  return policy.byKind?.[kind] ?? policy.default;
}

/** True when policy lets this action skip human review. */
export function isAutoApproved(policy: Policy, action: Action): boolean {
  if (action.riskTier === 'high') return false;
  const threshold = policyFor(policy, action.kind).autoApproveAtOrBelow;
  if (threshold === undefined) return false;
  return RANK[action.riskTier] <= RANK[threshold];
}
