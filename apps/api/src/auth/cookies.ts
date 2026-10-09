import type { CookieOptions, Response } from 'express';
import type { IssuedSession } from './session.service';

export const SESSION_COOKIE = 'cdcim_session';
export const CSRF_COOKIE = 'cdcim_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Session cookie: HttpOnly so scripts (and therefore XSS) cannot read it.
 * CSRF cookie: readable by the SPA, which echoes it in the X-CSRF-Token
 * header on every state-changing request. The server compares the header to
 * the hash stored on the session (synchronizer token bound to the session),
 * so a cross-site form post — which can send cookies but not set headers —
 * is rejected.
 */
export function setSessionCookies(res: Response, issued: IssuedSession, secure: boolean): void {
  const maxAge = Math.max(0, issued.session.expiresAt.getTime() - Date.now());
  const base: CookieOptions = { secure, path: '/', maxAge };
  res.cookie(SESSION_COOKIE, issued.token, { ...base, httpOnly: true, sameSite: 'lax' });
  res.cookie(CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false, sameSite: 'strict' });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' });
  res.clearCookie(CSRF_COOKIE, { path: '/', secure, sameSite: 'strict' });
}
