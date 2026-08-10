/**
 * attachment.ts の回帰テスト。
 *
 * 画像の縮小はブラウザのcanvasが要るのでここでは扱わない。
 * 文字列だけで完結する部分（ファイル名の短縮）を対象にする。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const outfile = join(mkdtempSync(join(tmpdir(), "wasa-attach-")), "attachment.mjs");
await build({
  entryPoints: ["src/attachment.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const { shortenFileName } = await import(pathToFileURL(outfile).href);

test("短い名前はそのまま", () => {
  assert.equal(shortenFileName("IMG_5346.JPG"), "IMG_5346.JPG");
});

// 末尾を切ると「何のファイルか」が分からなくなる
test("長い名前は真ん中を省き、拡張子を残す", () => {
  const short = shortenFileName("2026年度テストフライト第10回の記録写真.jpeg");
  assert.ok(short.endsWith(".jpeg"), `拡張子が消えました: ${short}`);
  assert.ok(short.includes("…"), `省略されていません: ${short}`);
  assert.ok(Array.from(short).length <= 24, `長すぎます: ${short}`);
});

test("拡張子が無ければ末尾を省くだけ", () => {
  const short = shortenFileName("あ".repeat(40));
  assert.ok(short.endsWith("…"), short);
  assert.ok(Array.from(short).length <= 24, short);
});

// 「.」の後ろが長いものは拡張子ではない。丸ごと残すと短くならない
test("点の後ろが長い名前でも上限を超えない", () => {
  const short = shortenFileName("スクリーンショット.2026-08-10 11.57.30 の写真");
  assert.ok(Array.from(short).length <= 24, `長すぎます: ${short}`);
});

test("絵文字を含む名前でも文字単位で数える", () => {
  const short = shortenFileName("🛩️".repeat(30) + ".png");
  assert.ok(Array.from(short).length <= 24, `長すぎます: ${short}`);
  assert.ok(short.endsWith(".png"), short);
});
