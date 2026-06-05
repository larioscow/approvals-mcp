import type { Action, AuditEvent, DecisionStatus, ExecutionResult } from '@approvals-mcp/core';
import { bigint, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    status: text('status').$type<DecisionStatus>().notNull(),
    action: jsonb('action').$type<Action>().notNull(),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    decidedAt: bigint('decided_at', { mode: 'number' }),
    decidedBy: text('decided_by'),
    reason: text('reason'),
    execution: jsonb('execution').$type<ExecutionResult>(),
    audit: jsonb('audit').$type<AuditEvent[]>().notNull(),
  },
  (t) => [index('decisions_status_created_idx').on(t.status, t.createdAt)],
);

export type DecisionRow = typeof decisions.$inferSelect;
