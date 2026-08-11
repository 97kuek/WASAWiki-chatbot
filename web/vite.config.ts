import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildVersion = (process.env.CF_PAGES_COMMIT_SHA ?? process.env.VITE_APP_VERSION ?? "local").slice(0, 7);

// 開発時は Vite の dev server から Go のAPIへプロキシする。
// こうすると同一オリジンになり、Cookie と SSE の扱いが本番と同じ形で試せる。
export default defineConfig({
  plugins: [react()],
  // Cloudflare PagesとCloud Runが同じコミットかを管理画面で照合する。
  // 秘密値ではなく公開済みのGitコミットだけを配信物へ埋め込む。
  define: {
    __WASA_BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.API_ORIGIN ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
