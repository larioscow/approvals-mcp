import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, isAutoApproved, type Policy, policyFor } from '../src/policy';
import type { Action } from '../src/types';

function action(riskTier: Action['riskTier'], kind = 'send_message'): Action {
  return { kind, summary: 's', payload: {}, riskTier };
}

describe('isAutoApproved', () => {
  it('requires a human for everything under the default policy', () => {
    expect(isAutoApproved(DEFAULT_POLICY, action('low'))).toBe(false);
    expect(isAutoApproved(DEFAULT_POLICY, action('high'))).toBe(false);
  });

  it('auto-approves at or below the configured tier', () => {
    const policy: Policy = { default: { ttlSeconds: 60, autoApproveAtOrBelow: 'medium' } };
    expect(isAutoApproved(policy, action('low'))).toBe(true);
    expect(isAutoApproved(policy, action('medium'))).toBe(true);
    expect(isAutoApproved(policy, action('high'))).toBe(false);
  });

  it('never auto-approves a high-risk action', () => {
    const policy: Policy = { default: { ttlSeconds: 60, autoApproveAtOrBelow: 'high' } };
    expect(isAutoApproved(policy, action('high'))).toBe(false);
    expect(isAutoApproved(policy, action('medium'))).toBe(true);
  });
});

describe('policyFor', () => {
  it('prefers a per-kind policy over the default', () => {
    const policy: Policy = {
      default: { ttlSeconds: 60 },
      byKind: { send_message: { ttlSeconds: 3_600, autoApproveAtOrBelow: 'low' } },
    };
    expect(policyFor(policy, 'send_message').ttlSeconds).toBe(3_600);
    expect(policyFor(policy, 'other').ttlSeconds).toBe(60);
  });
});
