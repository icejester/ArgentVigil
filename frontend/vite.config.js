import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Serve the pipeline cache JSON at /cot_data.json during dev
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [".."] },
  },
  publicDir: path.resolve(__dirname, "../pipeline/cache"),
});
