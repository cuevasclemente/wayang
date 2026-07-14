import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendUrl = process.env.VITE_WAYANG_BACKEND_URL || "http://127.0.0.1:8787";
const backendWsUrl = backendUrl.replace(/^http/, "ws");
const proxy = {
  // Preserve the browser-facing Host authority so Wayang's DNS-rebinding
  // protection can validate it against WAYANG_PUBLIC_ORIGIN.
  "/api": { target: backendUrl, changeOrigin: false },
  "/ws": { target: backendWsUrl, ws: true, changeOrigin: false },
  "/healthz": { target: backendUrl, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "esnext",
  },
  // noVNC publishes ESM with top-level await. Vite's dependency pre-bundler
  // otherwise lowers it for its default browser target and fails before the
  // isolated Playwright frontend can start. Serve noVNC as native ESM instead;
  // the production build keeps its explicit esnext target above.
  optimizeDeps: {
    exclude: ["@novnc/novnc"],
    esbuildOptions: { target: "esnext" },
  },
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    proxy,
  },
});
