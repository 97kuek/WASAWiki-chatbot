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

test("通常画面と同じブランドと利用者メニューを管理画面にも表示する", () => {
  assert.match(page, /wasa-chat-logo-photo-trimmed\.png/);
  assert.match(page, /className="profile-avatar"/);
  assert.match(page, /WASA Wikiを開く/);
  assert.match(page, /ログアウト/);
});

test("要対応と画面・API・索引のバージョンを表示する", () => {
  assert.match(page, /id="admin-alerts-title">要対応/);
  assert.match(page, /id="admin-version-title">本番バージョン/);
  assert.match(page, /__WASA_BUILD_VERSION__/);
  assert.match(page, /data\.system\.indexVersion/);
});

test("資料更新の4段階と監査ログの絞り込みを表示する", () => {
  for (const label of ["公開元を確認", "再構築・差分確認", "本番へ反映", "反映後を再確認"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /aria-label="利用ログの絞り込み"/);
  assert.match(page, /aria-label="管理者操作ログの絞り込み"/);
  assert.match(page, /usageLogOutcome/);
  assert.match(page, /auditLogAction/);
});
