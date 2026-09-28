import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { checkPassword, createAuth, hashPassword, type AuthedRequest } from './auth.ts';
import { loginRequest, registerRequest, syncRequest } from './contract.ts';
import type { Db } from './db.ts';
import { getPublishedCourse, getSharedRound, searchPublishedCourses } from './public.ts';
import { runSync } from './sync.ts';

type AppOptions = { db: Db; authSecret: string; corsOrigin?: string; rateLimitAuth?: boolean };

type UserRow = { id: string; email: string; password_hash: string; display_name: string };

const publicUser = (user: UserRow) => ({ id: user.id, email: user.email, displayName: user.display_name });

const nearParam = z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).transform((value) => {
  const [latitude, longitude] = value.split(',').map(Number);
  return { latitude, longitude };
});

const courseSearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  near: nearParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const createApp = ({ db, authSecret, corsOrigin = '*', rateLimitAuth = true }: AppOptions) => {
  const app = express();
  const { issueToken, requireUser } = createAuth(authSecret);

  app.set('trust proxy', 1);
  // Auth uses bearer tokens rather than cookies, so allowing other origins is safe.
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '5mb' }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const limitAuth = rateLimitAuth ? authLimiter : (_req: Request, _res: Response, next: NextFunction) => next();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/auth/register', limitAuth, async (req, res) => {
    const body = registerRequest.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }
    const { rows } = await db.query<UserRow>(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *',
      [email, await hashPassword(body.password), body.displayName],
    );
    res.status(201).json({ token: await issueToken(rows[0].id), user: publicUser(rows[0]) });
  });

  app.post('/api/auth/login', limitAuth, async (req, res) => {
    const body = loginRequest.parse(req.body);
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [body.email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !(await checkPassword(body.password, user.password_hash))) {
      res.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }
    res.json({ token: await issueToken(user.id), user: publicUser(user) });
  });

  app.get('/api/me', requireUser, async (req, res) => {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [(req as AuthedRequest).user.id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    res.json({ user: publicUser(rows[0]) });
  });

  // Apple requires apps with accounts to offer account deletion. Cascades to courses, rounds and bag.
  app.delete('/api/me', requireUser, async (req, res) => {
    await db.query('DELETE FROM users WHERE id = $1', [(req as AuthedRequest).user.id]);
    res.status(204).end();
  });

  app.post('/api/sync', requireUser, async (req, res) => {
    const input = syncRequest.parse(req.body);
    const result = await db.transaction((tx) => runSync(tx, (req as AuthedRequest).user.id, input));
    res.json(result);
  });

  app.get('/api/public/courses', async (req, res) => {
    const query = courseSearchQuery.parse(req.query);
    res.json({ courses: await searchPublishedCourses(db, { query: query.q || undefined, near: query.near, limit: query.limit }) });
  });

  app.get('/api/public/courses/:uid', async (req, res) => {
    const uid = z.uuid().safeParse(req.params.uid);
    const course = uid.success ? await getPublishedCourse(db, uid.data) : null;
    if (!course) {
      res.status(404).json({ error: 'Course not found.' });
      return;
    }
    res.json({ course });
  });

  app.get('/api/public/rounds/:token', async (req, res) => {
    const token = z.string().regex(/^[\w-]{10,40}$/).safeParse(req.params.token);
    const round = token.success ? await getSharedRound(db, token.data) : null;
    if (!round) {
      res.status(404).json({ error: 'Round not found or no longer shared.' });
      return;
    }
    res.json({ round });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request.', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      return;
    }
    // Body-parser errors (bad JSON, payload too large) carry their own 4xx status.
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? 'Request is too large.' : 'Invalid request body.' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
};
