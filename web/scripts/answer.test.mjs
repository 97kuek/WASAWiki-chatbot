/**
 * answer.ts の回帰テスト。
 *
 * 出典はサーバーが索引から組み立ててカードで出すので、モデルが本文にも
 * 書いてしまったときに二重表示にしないための保険を確かめる。
 *
 * **消しすぎないこと**が同じくらい大事である。回答本文にも「資料本文にある
 * URLをそのまま載せる」ことがあり、ただのリンク箇条書きを出典と誤認すると
 * 必要な情報が消える。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const outfile = join(mkdtempSync(join(tmpdir(), "wasa-answer-")), "answer.mjs");
await build({
  entryPoints: ["src/answer.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const { stripCitation } = await import(pathToFileURL(outfile).href);

test("現行形式の出典行を末尾から落とす", () => {
  const answer = [
    "40代の翼型はDAE31です。",
    "",
    "- [空力設計(40th)](https://example.org/a)（Wiki、本文の年代: 2024年）",
    "- [空力設計(41st)](https://example.org/b)（Wiki、本文の年代: 2025年）",
  ].join("\n");
  assert.equal(stripCitation(answer), "40代の翼型はDAE31です。");
});

test("旧形式の「出典:」以降も落とす", () => {
  const answer = "本文です。\n\n出典: 空力設計(40th)（最終更新: 2024-11）";
  assert.equal(stripCitation(answer), "本文です。");
});

test("「出典:」の後ろでも ※ と注 の行は残す", () => {
  const answer = "本文です。\n\n出典: X\n※ 41代の資料は未整備です";
  assert.match(stripCitation(answer), /※ 41代の資料は未整備です/);
});

// ここが消えると、回答が指している資料へ辿り着けなくなる
test("本文中のリンク箇条書きは消さない", () => {
  const answer = [
    "手順は次のとおりです。",
    "",
    "- [申請フォーム](https://example.org/form)を開く",
    "- 内容を記入して送信する",
  ].join("\n");
  assert.equal(stripCitation(answer), answer);
});

test("出典の形をしていても末尾に連続していなければ残す", () => {
  const answer = [
    "- [空力設計(40th)](https://example.org/a)（Wiki、本文の年代: 2024年）",
    "",
    "この資料に書かれています。",
  ].join("\n");
  assert.match(stripCitation(answer), /空力設計\(40th\)/);
  assert.match(stripCitation(answer), /この資料に書かれています。/);
});

test("出典が無ければそのまま返す", () => {
  assert.equal(stripCitation("  ただの回答です。  "), "ただの回答です。");
});

test("出典しか無ければ空になる", () => {
  const answer = "- [空力設計(40th)](https://example.org/a)（Wiki、本文の年代: 2024年）";
  assert.equal(stripCitation(answer), "");
});
