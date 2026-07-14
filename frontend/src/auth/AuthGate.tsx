import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  fetchAuthStatus,
  login,
  logout,
  subscribeToUnauthorized,
  type AuthStatus,
} from "../api/client";

type GateState =
  | { kind: "checking" }
  | { kind: "ready"; status: AuthStatus }
  | { kind: "login" }
  | { kind: "error"; message: string };

interface AuthGateProps {
  children: (auth: { enabled: boolean; onLogout: () => Promise<void> }) => ReactNode;
}

function currentRelativeUrl(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function AuthGate({ children }: AuthGateProps) {
  const requestedUrlRef = useRef(currentRelativeUrl());
  const [state, setState] = useState<GateState>({ kind: "checking" });

  const checkStatus = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const status = await fetchAuthStatus();
      setState(status.enabled && !status.authenticated
        ? { kind: "login" }
        : { kind: "ready", status });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to check authentication status",
      });
    }
  }, []);

  useEffect(() => subscribeToUnauthorized(() => {
    // Unmounting the application clears transcripts and live transports from
    // memory. The requested URL stays in the address bar for the next login.
    setState({ kind: "login" });
  }), []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const handleAuthenticated = useCallback((status: AuthStatus) => {
    const requestedUrl = requestedUrlRef.current;
    if (currentRelativeUrl() !== requestedUrl) {
      window.history.replaceState(window.history.state, "", requestedUrl);
    }
    setState({ kind: "ready", status });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      setState({ kind: "login" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ kind: "login" });
        return;
      }
      setState({
        kind: "error",
        message: "Unable to log out. Check the connection and try again.",
      });
    }
  }, []);

  if (state.kind === "checking") return <AuthLoading />;
  if (state.kind === "error") {
    return <AuthStatusError message={state.message} onRetry={() => void checkStatus()} />;
  }
  if (state.kind === "login") {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }
  return <>{children({ enabled: state.status.enabled, onLogout: handleLogout })}</>;
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-full bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <section className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900/70 p-6 shadow-2xl">
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">Wayang</div>
          {children}
        </div>
      </section>
    </main>
  );
}

function AuthLoading() {
  return (
    <AuthShell>
      <h1 className="mt-2 text-xl font-semibold">Checking access…</h1>
      <p className="mt-2 text-sm text-neutral-400">Connecting securely to this Wayang instance.</p>
    </AuthShell>
  );
}

function AuthStatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AuthShell>
      <h1 className="mt-2 text-xl font-semibold">Wayang is unavailable</h1>
      <p role="alert" className="mt-2 text-sm text-red-300">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-semibold text-neutral-950 hover:bg-white"
      >
        Retry
      </button>
    </AuthShell>
  );
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (status: AuthStatus) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const status = await login(password);
      setPassword("");
      onAuthenticated(status);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        setError("The password was not accepted.");
      } else if (requestError instanceof ApiError && requestError.status === 429) {
        setError("Too many login attempts. Wait a moment and try again.");
      } else {
        setError("Unable to sign in. Check the connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-400">
        Enter the shared password for this Wayang instance.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="wayang-password" className="mb-1.5 block text-sm font-medium text-neutral-200">
            Password
          </label>
          <input
            id="wayang-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
