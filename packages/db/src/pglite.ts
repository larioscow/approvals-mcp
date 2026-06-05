import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { type ConnectedStore, createSchema, DrizzleDecisionStore } from './store';

/**
 * In-process Postgres (PGlite). Real SQL with no external database, for tests
 * and zero-setup local runs. Pass a directory to persist; omit for memory.
 */
export async function createPgliteStore(dataDir?: string): Promise<ConnectedStore> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client);
  await createSchema(db);
  return { store: new DrizzleDecisionStore(db), close: () => client.close() };
}
