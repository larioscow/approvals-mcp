import { randomUUID } from 'node:crypto';

export function newDecisionId(): string {
  return `dec_${randomUUID().replace(/-/g, '')}`;
}
