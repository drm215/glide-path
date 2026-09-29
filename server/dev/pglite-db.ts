import { PGlite } from '@electric-sql/pglite';
import { migrate, type Db, type Queryable } from '../src/db.ts';

// Real Postgres running in-process, for tests and local development without a database server.
// Pass a directory to keep data between runs; omit it for a throwaway in-memory database.
export const createPgliteDb = async (dataDir?: string): Promise<Db> => {
  const pglite = new PGlite(dataDir);
  const toQueryable = (target: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async (sql, params) => {
      // Multi-statement SQL (the schema) has to go through exec.
      if (params === undefined) {
        const results = await target.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as never[] };
      }
      return (await target.query(sql, params)) as never;
    },
  });
  const db: Db = {
    ...toQueryable(pglite),
    transaction: (work) => pglite.transaction((tx) => work(toQueryable(tx))),
    close: () => pglite.close(),
  };
  await migrate(db);
  return db;
};
