import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthGate } from "./auth/AuthGate";
import { applyStoredUiScale } from "./lib/uiScale";
import "./index.css";

// Apply the saved display scale before the first paint so a reload never
// flashes the default size.
applyStoredUiScale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>
        {({ enabled, onLogout }) => <App authEnabled={enabled} onLogout={onLogout} />}
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
