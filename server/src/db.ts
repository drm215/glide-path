import pg from 'pg';
import { SCHEMA_SQL } from './schema.ts';

export type Queryable = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type Db = Queryable & {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export const migrate = async (db: Queryable) => {
  await db.query(SCHEMA_SQL);
};

export const createPostgresDb = (connectionString: string): Db => {
  // TLS settings come from the connection string (Neon's includes sslmode=require).
  const pool = new pg.Pool({ connectionString, idleTimeoutMillis: 30_000 });
  // Neon suspends idle databases and closes their connections. Without this handler the
  // resulting error on an idle pooled client would crash the process; the pool reconnects on next use.
  pool.on('error', (error) => {
    console.warn('Idle database connection closed:', error.message);
  });
  return {
    query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: async (sql, params) => client.query(sql, params as unknown[]) as never });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
};
