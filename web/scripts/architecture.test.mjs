import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("../src/admin/AdminPage.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const adminApi = readFileSync(new URL("../src/admin/api.ts", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");

test("通常画面と管理画面はローディングとトーストを共通部品から使う", () => {
  for (const source of [app, admin]) {
    assert.match(source, /<LoadingScreen|import \{ LoadingScreen \}/);
    assert.match(source, /<Toast message=\{toast\}/);
    assert.match(source, /useToast\(\)/);
  }
});

test("管理APIを通常画面の通信モジュールへ混在させない", () => {
  assert.doesNotMatch(api, /\/api\/admin|AdminOverview|AdminUserUsage/);
  assert.match(adminApi, /\/api\/admin\/overview/);
  assert.match(adminApi, /async function adminRequest/);
});

test("公開URLと画面上限はconfigへ集約する", () => {
  assert.match(config, /export const APP_URLS/);
  assert.match(config, /export const APP_LIMITS/);
  assert.doesNotMatch(app, /import\.meta\.env\.VITE_|wasa-chat-logo-photo-trimmed\.png/);
  assert.doesNotMatch(admin, /import\.meta\.env\.VITE_|wasa-chat-logo-photo-trimmed\.png/);
});
