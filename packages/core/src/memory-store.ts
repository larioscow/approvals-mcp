import type { DecisionStore, ListQuery, Page } from './store';
import type { Decision, DecisionStatus } from './types';

const clone = <T>(value: T): T => structuredClone(value);

function parseCursor(cursor: string | undefined): number {
  if (!cursor || !/^\d+$/.test(cursor)) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(n) ? n : 0;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return 20;
  return Math.min(Math.max(limit, 1), 100);
}

/**
 * In-process store for local runs and tests. Map operations are atomic on a
 * single thread, so `transition` is a correct compare-and-set here.
 */
export class InMemoryDecisionStore implements DecisionStore {
  private readonly byId = new Map<string, Decision>();

  async create(decision: Decision): Promise<Decision> {
    this.byId.set(decision.id, clone(decision));
    return clone(decision);
  }

  async get(id: string): Promise<Decision | undefined> {
    const found = this.byId.get(id);
    return found ? clone(found) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<Decision | undefined> {
    for (const decision of this.byId.values()) {
      if (decision.idempotencyKey === key) return clone(decision);
    }
    return undefined;
  }

  async save(decision: Decision): Promise<Decision> {
    this.byId.set(decision.id, clone(decision));
    return clone(decision);
  }

  async transition(
    id: string,
    expectedStatus: DecisionStatus,
    next: Decision,
  ): Promise<Decision | undefined> {
    const current = this.byId.get(id);
    if (!current || current.status !== expectedStatus) return undefined;
    this.byId.set(id, clone(next));
    return clone(next);
  }

  async list(query: ListQuery = {}): Promise<Page<Decision>> {
    const limit = clampLimit(query.limit);
    const offset = parseCursor(query.cursor);
    const statuses = normalizeStatuses(query.status);

    const matched = [...this.byId.values()]
      .filter((d) => statuses === undefined || statuses.includes(d.status))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const slice = matched.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const page: Page<Decision> = { items: slice.map(clone), total: matched.length };
    if (nextOffset < matched.length) page.nextCursor = String(nextOffset);
    return page;
  }
}

function normalizeStatuses(status: ListQuery['status']): DecisionStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}
