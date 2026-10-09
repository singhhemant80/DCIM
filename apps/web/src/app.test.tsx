import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_SECTIONS } from '@crapplet/shared';
import { IMPLEMENTED } from './App';
import { ApiError, api, qs } from './lib/api';
import { describeAgent, relativeTime } from './lib/format';
import { LoginPage } from './pages/Login';

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = 'cdcim_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const r = handler(String(input), init ?? {});
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('navigation honesty', () => {
  it('every section marked available has a real page, and every page is marked available', () => {
    const available = NAV_SECTIONS.filter((s) => s.status === 'available').map((s) => s.key).sort();
    expect(Object.keys(IMPLEMENTED).sort()).toEqual(available);
  });
});

describe('api client', () => {
  it('sends the CSRF token on unsafe methods only', async () => {
    document.cookie = 'cdcim_csrf=tok%2Den';
    const f = mockFetch(() => ({ status: 200, body: { ok: true } }));
    await api.get('/x');
    await api.post('/y', { a: 1 });
    const [, getInit] = f.mock.calls[0]!;
    const [, postInit] = f.mock.calls[1]!;
    expect((getInit!.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
    expect((postInit!.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-en');
    expect(postInit!.credentials).toBe('same-origin');
  });

  it('turns error responses into ApiError with code and request id', async () => {
    mockFetch(() => ({ status: 409, body: { error: 'conflict', message: 'Already exists', requestId: 'r1' } }));
    const err = await api.post('/z').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', message: 'Already exists', requestId: 'r1' });
  });

  it('reports network failures plainly', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api.get('/z').catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('builds query strings without empty values', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x+y');
    expect(qs({})).toBe('');
  });
});

describe('formatting', () => {
  it('describes devices and relative times', () => {
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Chrome/130 Safari/537')).toBe('Chrome on macOS');
    expect(describeAgent(null)).toBe('Unknown device');
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime(null)).toBe('never');
  });
});

describe('login page', () => {
  const renderLogin = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('shows the server error message on bad credentials', async () => {
    mockFetch(() => ({ status: 401, body: { error: 'invalid_credentials', message: 'Invalid email or password', requestId: 'abc' } }));
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('moves to the code step when MFA is required and submits the challenge', async () => {
    const f = mockFetch((url) =>
      url.endsWith('/auth/login') ? { status: 200, body: { mfaRequired: true, challengeToken: 'c'.repeat(43) } } : { status: 200, body: { ok: true } },
    );
    renderLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'right-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Authentication code');
    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ challengeToken: 'c'.repeat(43), code: '123456' });
  });
});
