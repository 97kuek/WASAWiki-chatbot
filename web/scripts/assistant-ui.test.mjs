import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const avatar = readFileSync(new URL("../src/avatar.tsx", import.meta.url), "utf8");

test("他人のアシスタントも設定を開いて指示をコピーできる", () => {
  assert.match(page, /setAssistantForm\(\{ mode: item\.canEdit \? "edit" : "view"/);
  assert.match(page, /指示は選択してコピーできます/);
  assert.match(page, /readOnly=\{assistantFormReadOnly\}/);
  assert.match(page, /onClick=\{\(\) => openAssistantSettings\(item\)\}>設定<\/button>/);
  assert.match(page, /複製して作る/);
});

test("回答横のアシスタントアイコンから設定を開く", () => {
  assert.match(page, /className="assistant-avatar-settings"/);
  assert.match(page, /aria-label=\{`「\$\{item\.name\}」の設定を見る`\}/);
  assert.match(page, /onClick=\{\(\) => openAssistantSettings\(item\)\}/);
});

test("アイコン画像は位置調整UIを持たず中央で切り抜く", () => {
  assert.doesNotMatch(page, /画像の位置|iconPosition|assistant-icon-position/);
  assert.doesNotMatch(avatar, /IconCropPosition|clampPercentage/);
  assert.match(avatar, /const sourceX = \(bitmap\.width - side\) \/ 2;/);
  assert.match(avatar, /const sourceY = \(bitmap\.height - side\) \/ 2;/);
});
