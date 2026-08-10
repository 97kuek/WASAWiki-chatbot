/**
 * markdown.tsx の回帰テスト。
 *
 *   npm test
 *
 * 新しい依存は入れていない。Node標準のテストランナーと、Viteが持っている
 * esbuild だけで動かす。TypeScript/JSX と CSS の import があるので、
 * 一度バンドルしてから読み込む。
 *
 * ここを守りたい一番の理由は、**描画が止まらなくなるとタブごと落ちる**ことである。
 * 例外なら境界が受け止められるが、無限ループは受け止められない。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const outfile = join(mkdtempSync(join(tmpdir(), "wasa-md-")), "markdown.mjs");
await build({
  entryPoints: ["src/markdown.tsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  loader: { ".css": "empty" },
});
const { renderMarkdown } = await import(pathToFileURL(outfile).href);

/** 無限ループを「時間切れ」ではなく確実に捕まえる。 */
function renderWithin(text, maxOperations = 100_000) {
  const originalPush = Array.prototype.push;
  let operations = 0;
  Array.prototype.push = function (...items) {
    if (++operations > maxOperations) {
      Array.prototype.push = originalPush;
      throw new Error("描画が終わりません（無限ループの可能性）");
    }
    return originalPush.apply(this, items);
  };
  try {
    return renderMarkdown(text);
  } finally {
    Array.prototype.push = originalPush;
  }
}

// 回答はSSEで少しずつ届く。**途中のどの状態でも描画が終わらなければならない。**
// 表の1行目だけが届いた状態で無限ループし、タブが固まって落ちていた（2026-08-10）。
test("届きかけの本文でも、どの長さで切っても描画が終わる", () => {
  const answer = [
    "## 40代の空力設計",
    "",
    "主翼の翼型には **DAE31** を採用しています。",
    "",
    "| 項目 | 40代 | 41代 |",
    "|---|---|---|",
    "| 翼型 | DAE31 | DAE31改 |",
    "",
    "揚抗比は \\( C_L / C_D \\) で表され、$L/D = 38$ を狙います。",
    "",
    "> 引用も混ぜておく",
    "",
    "1. 手順その1",
    "2. 手順その2",
    "",
    "- [空力設計(41st)](https://example.org/a)（Wiki、本文の年代: 2025年）",
  ].join("\n");

  for (let length = 1; length <= answer.length; length++) {
    const partial = answer.slice(0, length);
    assert.doesNotThrow(
      () => renderWithin(partial),
      `${length}字目で止まらなくなりました: ${JSON.stringify(partial.slice(-30))}`,
    );
  }
});

test("区切り行の無い表の行は、段落として1行ずつ進む", () => {
  const html = renderWithin("| 項目 | 40代 |");
  assert.match(html, /<p>/);
  assert.doesNotMatch(html, /<table>/);
});

test("区切り行が揃っていれば表として描く", () => {
  const html = renderWithin("| 項目 | 40代 |\n|---|---|\n| 翼型 | DAE31 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>項目<\/th>/);
  assert.match(html, /<td>DAE31<\/td>/);
});

// 生成文にはWiki本文が入る。人が書いたHTMLが混ざっても通してはいけない。
test("HTMLは常にエスケープする", () => {
  const html = renderWithin('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("javascript: のリンクは素通しせず、文字として残す", () => {
  const html = renderWithin("[押して](javascript:alert(1))");
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /押して/);
});

test("見出し・箇条書き・強調・コードを描く", () => {
  assert.match(renderWithin("# 見出し"), /<h3>見出し<\/h3>/);
  assert.match(renderWithin("- ひとつ\n- ふたつ"), /<ul><li>ひとつ<\/li><li>ふたつ<\/li><\/ul>/);
  assert.match(renderWithin("**太字**"), /<strong>太字<\/strong>/);
  assert.match(renderWithin("`code`"), /<code>code<\/code>/);
});

// コード中の $ を数式にすると、金額や変数名が壊れる
test("コード中の $ は数式にしない", () => {
  const html = renderWithin("`$HOME` と `$PATH`");
  assert.match(html, /<code>\$HOME<\/code>/);
  assert.match(html, /<code>\$PATH<\/code>/);
});

test("閉じていない数式ブロックは原文のまま段落へ戻す", () => {
  assert.doesNotThrow(() => renderWithin("$$\n\\frac{1}{2}\n"));
});
