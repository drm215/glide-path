import type { SyncRequest, SyncResponse } from './sync';
import type { AccountUser, CourseDetails, CourseLayout, HoleLayout } from './types';

// Set EXPO_PUBLIC_API_URL to test against a local server, e.g. http://192.168.1.20:3000.
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://glide-path.onrender.com').replace(/\/$/, '');

// The free server sleeps when idle and can take up to a minute to wake.
const REQUEST_TIMEOUT_MS = 75_000;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const request = async <T>(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(data?.error ?? `Request failed (${response.status}).`, response.status);
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? 'The server took too long to respond. Try again.' : 'Could not reach Glide Path. Check your connection.', 0);
  } finally {
    clearTimeout(timer);
  }
};

type AuthResponse = { token: string; user: AccountUser };

export const register = (email: string, password: string, displayName: string) =>
  request<AuthResponse>('POST', '/api/auth/register', { body: { email, password, displayName } });

export const signIn = (email: string, password: string) => request<AuthResponse>('POST', '/api/auth/login', { body: { email, password } });

// Emails a 6-digit code; answers the same whether or not the email has an account.
export const requestPasswordReset = (email: string) => request<{ ok: true; message: string }>('POST', '/api/auth/forgot', { body: { email } });

// Sets a new password with the emailed code and signs in.
export const resetPassword = (email: string, code: string, password: string) =>
  request<AuthResponse>('POST', '/api/auth/reset', { body: { email, code, password } });

export const deleteAccount = (token: string) => request<null>('DELETE', '/api/me', { token });

export const syncWithServer = (token: string, body: SyncRequest) => request<SyncResponse>('POST', '/api/sync', { token, body });

export type PublicCourseSummary = {
  uid: string; name: string; holes: number; city: string | null; state: string | null; mappedBy: string;
  distanceMiles: number | null; mappedHoles: number; par: number | null; parHoles: number; distanceFeet: number;
  layoutCount: number;
};

export type PublicCourse = {
  uid: string; name: string; holes: number; layouts: HoleLayout[]; details: CourseDetails; mappedBy: string;
  mappedHoles: number; par: number | null; parHoles: number; distanceFeet: number;
  layoutName?: string; extraLayouts?: CourseLayout[];
};

export const searchCourses = (query: string, near?: { latitude: number; longitude: number }) => {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (near) params.set('near', `${near.latitude.toFixed(5)},${near.longitude.toFixed(5)}`);
  return request<{ courses: PublicCourseSummary[] }>('GET', `/api/public/courses?${params.toString()}`);
};

export const getPublicCourse = (uid: string) => request<{ course: PublicCourse }>('GET', `/api/public/courses/${encodeURIComponent(uid)}`);

export const courseShareUrl = (uid: string) => `${API_URL}/c/${uid}`;

export const roundShareUrl = (shareToken: string) => `${API_URL}/r/${shareToken}`;
