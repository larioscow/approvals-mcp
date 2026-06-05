import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type ConnectedStore, createSchema, DrizzleDecisionStore } from './store';

/** Production store over a real Postgres connection string. */
export async function createPostgresStore(url: string): Promise<ConnectedStore> {
  const client = postgres(url);
  const db = drizzle(client);
  await createSchema(db);
  return {
    store: new DrizzleDecisionStore(db),
    close: async () => {
      await client.end();
    },
  };
}
