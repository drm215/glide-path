import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import type { Queryable } from './db.ts';

const TOKEN_LIFETIME = '90d';

export type AuthUser = { id: string };

export type AuthedRequest = Request & { user: AuthUser };

// `tokenVersion` is the user's token_version: a token issued before it was raised, or for a
// deleted account, is refused.
export const createAuth = (secret: string, db: Queryable) => {
  const key = new TextEncoder().encode(secret);

  const issueToken = (userId: string, tokenVersion: number) =>
    new SignJWT({ ver: tokenVersion }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(TOKEN_LIFETIME).sign(key);

  const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    const expired = () => res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    let userId: string;
    let tokenVersion: number;
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      if (!payload.sub) throw new Error('Token has no subject');
      userId = payload.sub;
      // Tokens issued before versions existed have none and count as version 0.
      tokenVersion = typeof payload.ver === 'number' ? payload.ver : 0;
    } catch {
      expired();
      return;
    }
    // Outside the try: a database error must not look like an expired session, which signs the app out.
    const { rows } = await db.query<{ token_version: number }>('SELECT token_version FROM users WHERE id = $1', [userId]);
    if (!rows[0] || rows[0].token_version !== tokenVersion) {
      expired();
      return;
    }
    (req as AuthedRequest).user = { id: userId };
    next();
  };

  return { issueToken, requireUser };
};

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
