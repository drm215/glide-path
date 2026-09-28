import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';

const TOKEN_LIFETIME = '90d';

export type AuthUser = { id: string };

export type AuthedRequest = Request & { user: AuthUser };

export const createAuth = (secret: string) => {
  const key = new TextEncoder().encode(secret);

  const issueToken = (userId: string) =>
    new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(TOKEN_LIFETIME).sign(key);

  const requireUser = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      if (!payload.sub) throw new Error('Token has no subject');
      (req as AuthedRequest).user = { id: payload.sub };
      next();
    } catch {
      res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }
  };

  return { issueToken, requireUser };
};

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
