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
  // Render's external URLs require TLS; internal ones do not.
  const needsSsl = /\.render\.com|sslmode=require/.test(connectionString);
  const pool = new pg.Pool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
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
