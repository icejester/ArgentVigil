import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Serve the pipeline cache JSON at /cot_data.json during dev
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      // Stack Tracker's photo storage — a StaticFiles mount, not an /api
      // route, so it needs its own proxy entry (see backend/main.py's
      // /stack_images mount).
      "/stack_images": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  publicDir: path.resolve(__dirname, "../pipeline/cache"),
});
