import { PGlite } from '@electric-sql/pglite';
import type { MobileDatabase } from '../server/presence';

// Real PostgreSQL SQL execution in memory, with pg-compatible pooling semantics.
export async function createTestDatabase() {
  const postgres = await PGlite.create();
  let tail = Promise.resolve();
  async function acquire() {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(text: string, values: unknown[] = []) {
    const multiple = !values.length && text.split(';').filter(part => part.trim()).length > 1;
    const result = multiple ? (await postgres.exec(text)).at(-1) : await postgres.query(text, values);
    return { rows: result?.rows || [], rowCount: result?.rows.length || result?.affectedRows || 0 };
  }
  const database = {
    query: async (text: string, values?: unknown[]) => {
      const release = await acquire();
      try { return await query(text, values); } finally { release(); }
    },
    connect: async () => {
      const release = await acquire();
      return { query, release };
    },
  } as unknown as MobileDatabase;
  return { database, close: () => postgres.close() };
}
