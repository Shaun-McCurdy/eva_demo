import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the React app runs on 5173 and the Python server on 8080.
// Both /api and /ws are proxied so the browser only ever talks to one origin,
// which keeps cookies and WebSocket origin checks behaving like production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
