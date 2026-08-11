import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/AdminPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("管理タブ名と表示中の画面タイトルを同じ定義から描く", () => {
  for (const label of ["概要", "資料更新", "利用者・権限", "API利用状況", "監査ログ"]) {
    assert.match(page, new RegExp(`label: "${label}"`));
  }
  assert.match(page, /<h2>\{currentTab\.label\}<\/h2>/);
  assert.match(page, /role="tab" aria-selected=/);
});

test("管理通知は通常チャットと共通の黒色トーストを使う", () => {
  assert.match(page, /className="toast"/);
  assert.doesNotMatch(page, /admin-toast/);
  assert.match(styles, /\.toast\s*\{[\s\S]*background: var\(--text\)/);
});

test("資料更新に再構築と本番反映の手順を表示する", () => {
  assert.match(page, /python rebuild\.py/);
  assert.match(page, /sh tools\/publish-index\.sh/);
  assert.match(page, /専用Cloud Run Job/);
});

test("更新中はSVGを回さず固定寸法のスピナーへ切り替える", () => {
  assert.match(page, /loading \? <span className="admin-spinner"/);
  assert.match(styles, /\.admin-spinner\s*\{[\s\S]*width: 17px;[\s\S]*height: 17px;/);
  assert.doesNotMatch(styles, /admin-refresh\.is-loading svg/);
});
