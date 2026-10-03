import type { AddressInfo } from 'node:net';
import { createPgliteDb } from '../dev/pglite-db.ts';
import { createApp } from '../src/app.ts';
import type { Mailer } from '../src/mailer.ts';

// `mailer: null` simulates a server without email set up; by default, sent codes are collected.
export const startTestServer = async ({ mailer }: { mailer?: Mailer | null } = {}) => {
  const db = await createPgliteDb();
  const sentCodes: { to: string; code: string }[] = [];
  const collectingMailer: Mailer = { sendPasswordResetCode: async (to, code) => { sentCodes.push({ to, code }); } };
  const app = createApp({ db, authSecret: 'test-secret-with-enough-length-for-hs256', rateLimitAuth: false, mailer: mailer === undefined ? collectingMailer : mailer });
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
    const isJson = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, body: text && isJson ? JSON.parse(text) : text || null };
  };

  const register = async (email: string, displayName = 'Tester') => {
    const response = await request('POST', '/api/auth/register', { body: { email, password: 'correct horse', displayName } });
    return response.body.token as string;
  };

  const stop = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };

  return { baseUrl, db, request, register, sentCodes, stop };
};
