import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /drive and /docs to the Cloud Run services so the
// browser makes same-origin requests — no CSP/CORS wall like the artifact
// sandbox had. In production the app calls the Cloud Run URLs directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/drive": {
        target: "https://fafo-drive-proxy-134533637471.us-central1.run.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/drive/, ""),
      },
      "/docs-mcp": {
        target: "https://fafo-docs-mcp-134533637471.us-central1.run.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/docs-mcp/, ""),
      },
    },
  },
});
