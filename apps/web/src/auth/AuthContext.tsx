import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { SessionUser, SignInInput } from "@university-hub/shared";

import { ApiClientError } from "@/lib/api";
import { fetchMe, signIn as apiSignIn, signOut as apiSignOut } from "@/lib/auth";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  signIn: (input: SignInInput) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const me = await fetchMe(signal);
      if (signal?.aborted) return;
      setUser(me);
      setStatus("authenticated");
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiClientError && error.status === 401) {
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      // Network or unknown error: treat as unauthenticated so the app remains
      // usable; the protected route will surface the sign-in screen.
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const signIn = useCallback(async (input: SignInInput) => {
    const next = await apiSignIn(input);
    setUser(next);
    setStatus("authenticated");
    return next;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiSignOut();
    } finally {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn,
      signOut,
      refresh: () => refresh(),
    }),
    [status, user, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
