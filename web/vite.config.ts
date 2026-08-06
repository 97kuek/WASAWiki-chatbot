import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開発時は Vite の dev server から Go のAPIへプロキシする。
// こうすると同一オリジンになり、Cookie と SSE の扱いが本番と同じ形で試せる。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.API_ORIGIN ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
