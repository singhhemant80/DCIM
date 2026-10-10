import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@crapplet/shared';
import { ApiError, api } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const me = q.data ?? null;
  const perms = new Set(me?.permissions ?? []);
  const value: AuthState = {
    me,
    loading: q.isLoading,
    can: (p) => perms.has(p),
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    signOut: async () => {
      try {
        await api.post('/auth/logout');
      } finally {
        qc.clear();
        qc.setQueryData(['me'], null);
      }
    },
  };
  if (q.isError) {
    return (
      <div role="alert" className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-base font-semibold">NexoraDC is unreachable</p>
          <p className="mt-1 text-ink-2">{(q.error as Error).message}</p>
          <button className="mt-4 rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink" onClick={() => q.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
