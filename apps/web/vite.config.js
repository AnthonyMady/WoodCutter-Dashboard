import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cloudflare Pages serves at /. Source maps disabled in prod (security).
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
