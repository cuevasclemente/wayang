import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, stack: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, stack: info.componentStack ?? "" });
    console.error("[wayang] React render error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
        <div className="max-w-3xl rounded border border-red-900/70 bg-red-950/30 p-5 shadow-xl shadow-black/40">
          <h1 className="text-base font-semibold text-red-200">Wayang crashed while rendering</h1>
          <p className="mt-2 text-sm text-red-100/80">
            This fallback is shown instead of a blank black screen. Copy the error below if this happens again.
          </p>
          <pre className="mt-4 max-h-80 overflow-auto rounded bg-neutral-950 p-3 text-xs text-red-100">
            {this.state.error.stack || this.state.error.message}
            {this.state.stack ? `\n\n${this.state.stack}` : ""}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-950 hover:bg-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
