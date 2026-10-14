import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { checkPassword, createAuth, hashPassword, type AuthedRequest } from './auth.ts';
import { courseRecord, forgotPasswordRequest, loginRequest, registerRequest, resetPasswordRequest, syncRequest } from './contract.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mailer.ts';
import { renderCoursePage, renderNotFoundPage, renderRoundPage } from './pages.ts';
import { getPublishedCourse, getSharedRound, searchPublishedCourses } from './public.ts';
import { AccessError, addOwner, listOwners, playCourse, removeOwner } from './access.ts';
import { combineCourses, deleteAccount, listAllCourses, listUsers, requireAdmin, setAdmin } from './admin.ts';
import { courseForEditor, deleteCourse, moveLayout, saveCourse } from './courses.ts';
import { runSync } from './sync.ts';

type AppOptions = {
  db: Db; authSecret: string; corsOrigin?: string; rateLimitAuth?: boolean;
  // Satellite imagery for the website's maps; set TILE_URL to use a keyed or different provider.
  tileUrl?: string; tileAttribution?: string;
  // Sends password reset codes; without one, password reset reports that it isn't set up.
  mailer?: Mailer | null;
};

const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
// Codes emailed to one account per window, so the endpoint can't be used to flood an inbox.
const RESET_MAX_PER_WINDOW = 3;

const DEFAULT_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DEFAULT_TILE_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';

// The website's files live in server/public, one level up from both src/ and dist/.
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const LEAFLET_DIR = dirname(createRequire(import.meta.url).resolve('leaflet/dist/leaflet.js'));
// The 3D hole view's map library (an ES module that loads its worker from the same folder).
const MAPLIBRE_DIR = dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
// Public terrain tiles for the 3D view; must match TERRAIN_TILES in public/js/hole3d.js.
const TERRAIN_ORIGIN = 'https://elevation-tiles-prod.s3.amazonaws.com';

type UserRow = { id: string; email: string; password_hash: string; display_name: string; token_version: number; is_admin?: boolean };

const publicUser = (user: UserRow) => ({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: Boolean(user.is_admin) });

// What the website's course editor sends: the course's own content (see courses.ts).
const courseEdit = z.object({
  course: courseRecord.pick({ name: true, holes: true, layouts: true, layoutName: true, extraLayouts: true, details: true }),
  baseUpdatedAt: z.number().int().nonnegative(),
});

const nearParam = z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).transform((value) => {
  const [latitude, longitude] = value.split(',').map(Number);
  return { latitude, longitude };
});

const courseSearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  near: nearParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const createApp = ({
  db, authSecret, corsOrigin = '*', rateLimitAuth = true, tileUrl = DEFAULT_TILE_URL, tileAttribution = DEFAULT_TILE_ATTRIBUTION, mailer = null,
}: AppOptions) => {
  // Reset codes are stored as keyed hashes, so a database leak doesn't reveal live codes.
  const hashResetCode = (code: string) => createHmac('sha256', authSecret).update(`password-reset:${code}`).digest();
  const app = express();
  const { issueToken, requireUser } = createAuth(authSecret, db);
  // Hash of a password no account has, checked when logging in with an unknown email. Made on first use.
  let unknownUserHashPromise: Promise<string> | null = null;
  const unknownUserHash = () => (unknownUserHashPromise ??= hashPassword(randomBytes(16).toString('hex')));
  const tileOrigin = new URL(tileUrl.replace(/[{}]/g, '')).origin;

  app.set('trust proxy', 1);
  app.use(compression());
  // Website pages only load their own scripts; user text is never trusted as markup.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!req.path.startsWith('/api/')) {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        // Terrain tiles are read as images for hole elevations (and fetched by the 3D view).
        `img-src 'self' data: blob: ${tileOrigin} ${TERRAIN_ORIGIN}`,
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        // The 3D view fetches satellite and terrain tiles itself.
        `connect-src 'self' ${tileOrigin} ${TERRAIN_ORIGIN}`,
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '));
    }
    next();
  });
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
    res.status(201).json({ token: await issueToken(rows[0].id, rows[0].token_version), user: publicUser(rows[0]) });
  });

  app.post('/api/auth/login', limitAuth, async (req, res) => {
    const body = loginRequest.parse(req.body);
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [body.email.trim().toLowerCase()]);
    const user = rows[0];
    // An unknown email still checks a password, so the response time doesn't reveal who has an account.
    if (!(await checkPassword(body.password, user?.password_hash ?? await unknownUserHash())) || !user) {
      res.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }
    res.json({ token: await issueToken(user.id, user.token_version), user: publicUser(user) });
  });

  // Emails a 6-digit reset code. Always answers the same way whether or not the email has an
  // account, so it can't be used to find out who has signed up.
  app.post('/api/auth/forgot', limitAuth, async (req, res) => {
    if (!mailer) {
      res.status(503).json({ error: 'Password reset isn’t set up yet. Please contact support.' });
      return;
    }
    const email = forgotPasswordRequest.parse(req.body).email.toLowerCase();
    const sent = { ok: true, message: 'If that email has an account, a reset code is on its way.' };
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) {
      res.json(sent);
      return;
    }
    const recent = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '${RESET_CODE_MINUTES} minutes'`,
      [user.id],
    );
    if (Number(recent.rows[0].count) >= RESET_MAX_PER_WINDOW) {
      res.json(sent);
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Codes are useless once expired; a day's grace keeps them for troubleshooting.
    await db.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
    // Only the newest code works.
    await db.query('UPDATE password_resets SET used = true WHERE user_id = $1 AND NOT used', [user.id]);
    await db.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '${RESET_CODE_MINUTES} minutes')`,
      [user.id, hashResetCode(code).toString('hex')],
    );
    try {
      await mailer.sendPasswordResetCode(user.email, code);
    } catch (error) {
      console.error('Could not send password reset email:', error);
      res.status(502).json({ error: 'The reset email couldn’t be sent. Try again in a few minutes.' });
      return;
    }
    res.json(sent);
  });

  // Checks the code, sets the new password, and signs the user in.
  app.post('/api/auth/reset', limitAuth, async (req, res) => {
    const body = resetPasswordRequest.parse(req.body);
    const invalid = () => res.status(400).json({ error: 'That code is incorrect or has expired. Request a new one.' });
    const { rows: users } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [body.email.toLowerCase()]);
    const user = users[0];
    if (!user) {
      invalid();
      return;
    }
    const { rows: resets } = await db.query<{ id: string; code_hash: string; attempts: number }>(
      'SELECT id, code_hash, attempts FROM password_resets WHERE user_id = $1 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1',
      [user.id],
    );
    const reset = resets[0];
    if (!reset || reset.attempts >= RESET_MAX_ATTEMPTS) {
      invalid();
      return;
    }
    const matches = timingSafeEqual(hashResetCode(body.code), Buffer.from(reset.code_hash, 'hex'));
    if (!matches) {
      await db.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]);
      invalid();
      return;
    }
    await db.query('UPDATE password_resets SET used = true WHERE user_id = $1', [user.id]);
    // Raising token_version signs out every other session, in case the old password was stolen.
    const { rows: updated } = await db.query<{ token_version: number }>(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version',
      [await hashPassword(body.password), user.id],
    );
    res.json({ token: await issueToken(user.id, updated[0].token_version), user: publicUser(user) });
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
    const userId = (req as AuthedRequest).user.id;
    try {
      // Courses it created pass to another owner first, since others play them.
      await db.transaction((tx) => deleteAccount(tx, userId));
      res.status(204).end();
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });

  // Courses: their owners, playing them, and editing them on the website (see access.ts and
  // courses.ts); and site admins' tools (see admin.ts).
  const accessRoute = (handler: (req: Request, res: Response, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await handler(req, res, (req as AuthedRequest).user.id);
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  };
  const courseUid = (req: Request) => {
    const uid = z.uuid().safeParse(req.params.uid);
    if (!uid.success) throw new AccessError(404, 'Course not found.');
    return uid.data;
  };
  app.get('/api/courses/:uid', requireUser, accessRoute(async (req, res, userId) => {
    res.json(await courseForEditor(db, courseUid(req), userId));
  }));
  app.put('/api/courses/:uid', requireUser, accessRoute(async (req, res, userId) => {
    const uid = courseUid(req);
    const { course, baseUpdatedAt } = courseEdit.parse(req.body);
    res.json(await db.transaction((tx) => saveCourse(tx, uid, userId, course, baseUpdatedAt, Date.now())));
  }));
  app.delete('/api/courses/:uid', requireUser, accessRoute(async (req, res, userId) => {
    const uid = courseUid(req);
    await db.transaction((tx) => deleteCourse(tx, uid, userId, Date.now()));
    res.status(204).end();
  }));
  app.post('/api/courses/:uid/layouts/move', requireUser, accessRoute(async (req, res, userId) => {
    const uid = courseUid(req);
    const move = z.object({ sourceUid: z.uuid(), layoutId: z.string().min(1).max(100), replaceLayoutId: z.string().min(1).max(100).optional() }).parse(req.body);
    res.json(await db.transaction((tx) => moveLayout(tx, uid, userId, move, Date.now())));
  }));
  app.get('/api/courses/:uid/owners', requireUser, accessRoute(async (req, res, userId) => {
    res.json(await listOwners(db, courseUid(req), userId));
  }));
  app.post('/api/courses/:uid/owners', requireUser, accessRoute(async (req, res, userId) => {
    const { email } = z.object({ email: z.string().trim().min(1).max(254) }).parse(req.body);
    res.json(await addOwner(db, courseUid(req), userId, email, Date.now()));
  }));
  app.delete('/api/courses/:uid/owners/:ownerId', requireUser, accessRoute(async (req, res, userId) => {
    const ownerId = z.uuid().safeParse(req.params.ownerId);
    if (!ownerId.success) throw new AccessError(404, 'Not found.');
    await removeOwner(db, courseUid(req), userId, ownerId.data, Date.now());
    res.status(204).end();
  }));
  app.post('/api/courses/:uid/play', requireUser, accessRoute(async (req, res, userId) => {
    await playCourse(db, courseUid(req), userId, Date.now());
    res.status(204).end();
  }));

  const searchText = (req: Request) => z.string().max(200).catch('').parse(req.query.q ?? '');
  app.get('/api/admin/courses', requireUser, accessRoute(async (req, res, userId) => {
    await requireAdmin(db, userId);
    res.json({ courses: await listAllCourses(db, searchText(req)) });
  }));
  app.get('/api/admin/users', requireUser, accessRoute(async (req, res, userId) => {
    await requireAdmin(db, userId);
    res.json({ users: await listUsers(db, searchText(req)) });
  }));
  app.put('/api/admin/users/:userId', requireUser, accessRoute(async (req, res, userId) => {
    await requireAdmin(db, userId);
    const target = z.uuid().safeParse(req.params.userId);
    if (!target.success) throw new AccessError(404, 'Account not found.');
    const { isAdmin } = z.object({ isAdmin: z.boolean() }).parse(req.body);
    await setAdmin(db, target.data, isAdmin);
    res.status(204).end();
  }));
  app.delete('/api/admin/users/:userId', requireUser, accessRoute(async (req, res, userId) => {
    await requireAdmin(db, userId);
    const target = z.uuid().safeParse(req.params.userId);
    if (!target.success) throw new AccessError(404, 'Account not found.');
    await db.transaction((tx) => deleteAccount(tx, target.data));
    res.status(204).end();
  }));
  app.post('/api/admin/combine', requireUser, accessRoute(async (req, res, userId) => {
    await requireAdmin(db, userId);
    const { sourceUid, targetUid } = z.object({ sourceUid: z.uuid(), targetUid: z.uuid() }).parse(req.body);
    res.json(await db.transaction((tx) => combineCourses(tx, sourceUid, targetUid, Date.now())));
  }));

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

  // Map settings, loaded as a classic script before the page's modules (see lib.js satelliteMap).
  app.get('/js/config.js', (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache')
      .send(`window.GLIDE_PATH_TILES = ${JSON.stringify({ url: tileUrl, attribution: tileAttribution })};\n`);
  });

  app.use('/vendor/leaflet', express.static(LEAFLET_DIR, { maxAge: '7d' }));
  app.use('/vendor/maplibre', express.static(MAPLIBRE_DIR, { maxAge: '7d' }));
  // The site's own files change with each deploy, so browsers revalidate them on every load
  // (a cheap 304 when unchanged) instead of keeping a stale copy.
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  // Course and shared-round pages (also the links the app shares).
  app.get('/r/:token', async (req, res) => {
    const token = z.string().regex(/^[\w-]{10,40}$/).safeParse(req.params.token);
    const round = token.success ? await getSharedRound(db, token.data) : null;
    res.status(round ? 200 : 404).type('html').send(round ? renderRoundPage(round as Parameters<typeof renderRoundPage>[0]) : renderNotFoundPage('round'));
  });

  app.get('/c/:uid', async (req, res) => {
    const uid = z.uuid().safeParse(req.params.uid);
    const course = uid.success ? await getPublishedCourse(db, uid.data) : null;
    res.status(course ? 200 : 404).type('html').send(course ? renderCoursePage(course) : renderNotFoundPage('course'));
  });

  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) res.status(404).json({ error: 'Not found.' });
    else res.status(404).type('html').send(renderNotFoundPage('page'));
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
