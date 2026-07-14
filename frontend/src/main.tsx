import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthGate } from "./auth/AuthGate";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>
        {({ enabled, onLogout }) => <App authEnabled={enabled} onLogout={onLogout} />}
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
