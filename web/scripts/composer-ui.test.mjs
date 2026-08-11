import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("EnterとShift Enterは送信せず改行し、送信ボタンだけで送る", () => {
  assert.doesNotMatch(page, /onKeyDown=\{\(event\).*event\.key === "Enter"/s);
  assert.doesNotMatch(page, /composer-hint/);
  assert.match(page, /<button\s+type="submit"\s+className="send"/s);
});

test("回答完了後は出典カードを重ねて表示しない", () => {
  assert.match(page, /turn\.streaming && turn\.sources\.length > 0/);
  assert.doesNotMatch(page, /turn\.streaming \? "参照中の資料" : "出典"/);
});
