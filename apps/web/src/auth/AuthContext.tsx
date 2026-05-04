import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  SessionUser,
  SignInInput,
  SignInResponse,
} from "@university-hub/shared";

import { ApiClientError } from "@/lib/api";
import { fetchMe, signIn as apiSignIn, signOut as apiSignOut } from "@/lib/auth";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /**
   * Initiates sign-in. Returns the worker's `SignInResponse` so the caller
   * can branch on `status === "mfa_required"` and route to the MFA step.
   * On `status === "ok"` the auth state is also flipped to authenticated
   * here, so existing call sites that ignore the return value still work.
   */
  signIn: (input: SignInInput) => Promise<SignInResponse>;
  /** Used by the MFA step after a successful TOTP / recovery verification. */
  setSessionUser: (user: SessionUser) => void;
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
    if (next.status === "ok") {
      setUser(next.user);
      setStatus("authenticated");
    }
    return next;
  }, []);

  const setSessionUser = useCallback((next: SessionUser) => {
    setUser(next);
    setStatus("authenticated");
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
      setSessionUser,
      signOut,
      refresh: () => refresh(),
    }),
    [status, user, signIn, setSessionUser, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
