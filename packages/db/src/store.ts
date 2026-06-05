import type { Decision, DecisionStatus, DecisionStore, ListQuery, Page } from '@approvals-mcp/core';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { type DecisionRow, decisions } from './schema';

type Db<Q extends PgQueryResultHKT> = PgDatabase<Q, Record<string, never>>;

export interface ConnectedStore {
  store: DecisionStore;
  close: () => Promise<void>;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return 20;
  return Math.min(Math.max(limit, 1), 100);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor || !/^\d+$/.test(cursor)) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(n) ? n : 0;
}

function normalizeStatuses(status: ListQuery['status']): DecisionStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

function toDecision(row: DecisionRow): Decision {
  const decision: Decision = {
    id: row.id,
    status: row.status,
    action: row.action,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    audit: row.audit,
  };
  if (row.idempotencyKey !== null) decision.idempotencyKey = row.idempotencyKey;
  if (row.decidedAt !== null) decision.decidedAt = row.decidedAt;
  if (row.decidedBy !== null) decision.decidedBy = row.decidedBy;
  if (row.reason !== null) decision.reason = row.reason;
  if (row.execution !== null) decision.execution = row.execution;
  return decision;
}

function toRow(d: Decision): DecisionRow {
  return {
    id: d.id,
    status: d.status,
    action: d.action,
    idempotencyKey: d.idempotencyKey ?? null,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    decidedAt: d.decidedAt ?? null,
    decidedBy: d.decidedBy ?? null,
    reason: d.reason ?? null,
    execution: d.execution ?? null,
    audit: d.audit,
  };
}

/**
 * Postgres-backed DecisionStore. `transition` is a single conditional UPDATE
 * (`WHERE id = $ AND status = $expected RETURNING *`), so the database itself
 * enforces that exactly one caller wins a guarded state change, the same
 * exactly-once guarantee the in-memory store gets from single-threaded Map ops.
 */
export class DrizzleDecisionStore<Q extends PgQueryResultHKT = PgQueryResultHKT>
  implements DecisionStore
{
  constructor(private readonly db: Db<Q>) {}

  async create(decision: Decision): Promise<Decision> {
    const rows = await this.db.insert(decisions).values(toRow(decision)).returning();
    return rows[0] ? toDecision(rows[0]) : decision;
  }

  async get(id: string): Promise<Decision | undefined> {
    const rows = await this.db.select().from(decisions).where(eq(decisions.id, id)).limit(1);
    return rows[0] ? toDecision(rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<Decision | undefined> {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.idempotencyKey, key))
      .limit(1);
    return rows[0] ? toDecision(rows[0]) : undefined;
  }

  async save(decision: Decision): Promise<Decision> {
    const row = toRow(decision);
    const rows = await this.db
      .insert(decisions)
      .values(row)
      .onConflictDoUpdate({ target: decisions.id, set: row })
      .returning();
    return rows[0] ? toDecision(rows[0]) : decision;
  }

  async transition(
    id: string,
    expectedStatus: DecisionStatus,
    next: Decision,
  ): Promise<Decision | undefined> {
    const rows = await this.db
      .update(decisions)
      .set(toRow(next))
      .where(and(eq(decisions.id, id), eq(decisions.status, expectedStatus)))
      .returning();
    return rows[0] ? toDecision(rows[0]) : undefined;
  }

  async list(query: ListQuery = {}): Promise<Page<Decision>> {
    const limit = clampLimit(query.limit);
    const offset = parseCursor(query.cursor);
    const statuses = normalizeStatuses(query.status);
    const where = statuses ? inArray(decisions.status, statuses) : undefined;

    const rows = await this.db
      .select()
      .from(decisions)
      .where(where)
      .orderBy(asc(decisions.createdAt), asc(decisions.id))
      .limit(limit)
      .offset(offset);

    const totals = await this.db.select({ total: count() }).from(decisions).where(where);
    const total = totals[0]?.total ?? 0;

    const page: Page<Decision> = { items: rows.map(toDecision), total };
    if (offset + rows.length < total) page.nextCursor = String(offset + rows.length);
    return page;
  }
}

const DDL_TABLE = sql`
  CREATE TABLE IF NOT EXISTS decisions (
    id text PRIMARY KEY,
    status text NOT NULL,
    action jsonb NOT NULL,
    idempotency_key text UNIQUE,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    decided_at bigint,
    decided_by text,
    reason text,
    execution jsonb,
    audit jsonb NOT NULL
  )
`;

const DDL_INDEX = sql`
  CREATE INDEX IF NOT EXISTS decisions_status_created_idx ON decisions (status, created_at)
`;

/** Idempotent schema bootstrap. For production prefer real migrations. */
export async function createSchema<Q extends PgQueryResultHKT>(db: Db<Q>): Promise<void> {
  await db.execute(DDL_TABLE);
  await db.execute(DDL_INDEX);
}
