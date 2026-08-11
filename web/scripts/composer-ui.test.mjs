import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("EnterとShift Enterは送信せず改行し、送信ボタンだけで送る", () => {
  assert.doesNotMatch(page, /onKeyDown=\{\(event\).*event\.key === "Enter"/s);
  assert.doesNotMatch(page, /composer-hint/);
  assert.match(page, /<button\s+type="submit"\s+className="send"/s);
});

test("回答完了後は出典カードを重ねて表示しない", () => {
  assert.match(page, /<ReferenceSummary sources=\{turn\.sources\} active=\{turn\.streaming\}/);
  assert.doesNotMatch(page, /className="sources"|参照中の資料/);
});

test("入力欄は5行まで自動で伸び、その後だけ内部スクロールする", () => {
  assert.match(config, /composerVisibleLines: 5/);
  assert.match(page, /resizeComposerTextarea\(event\.currentTarget\)/);
  assert.match(page, /target\.style\.overflowY = .* \? "auto" : "hidden"/);
  assert.match(styles, /\.composer textarea\s*\{[\s\S]*overflow-y: hidden/);
});

test("入力欄の案内は質問することだけを簡潔に示す", () => {
  assert.match(page, /placeholder="引き継ぎ資料について質問する"/);
  assert.doesNotMatch(page, /画像は貼り付けもできます/);
});
