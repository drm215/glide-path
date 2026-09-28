import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.ts';
import { migrate, type Db, type Queryable } from '../src/db.ts';

// Real Postgres running in-process, so tests need no database server.
const createTestDb = async (): Promise<Db> => {
  const pglite = new PGlite();
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

export const startTestServer = async () => {
  const db = await createTestDb();
  const app = createApp({ db, authSecret: 'test-secret-with-enough-length-for-hs256', rateLimitAuth: false });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = async (method: string, path: string, options: { body?: unknown; token?: string } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const register = async (email: string, displayName = 'Tester') => {
    const response = await request('POST', '/api/auth/register', { body: { email, password: 'correct horse', displayName } });
    return response.body.token as string;
  };

  const stop = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };

  return { request, register, stop };
};
