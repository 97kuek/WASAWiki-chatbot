/**
 * chat.ts の回帰テスト。
 *
 *   npm test
 *
 * ここにある関数は、もともと App.tsx の中にあった。切り出した理由は
 * **テストが書けなかったせいで「画像だけを送るとチャットのタイトルが空になる」
 * 不具合を見逃していた**ためである（2026-08-11に確認）。
 *
 * markdown.test.mjs と同じく、新しい依存は入れていない。Node標準の
 * テストランナーと、Viteが持っている esbuild だけで動かす。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const outfile = join(mkdtempSync(join(tmpdir(), "wasa-chat-")), "chat.mjs");
await build({
  entryPoints: ["src/chat.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
});
const {
  answerPlainText, chatTitle, groupChats, referenceSections,
  retryLabel, shareText, slugify, IMAGE_ONLY_TITLE,
} = await import(pathToFileURL(outfile).href);

const turn = (over = {}) => ({
  question: "質問",
  answer: "回答",
  sources: [],
  status: "",
  streaming: false,
  ...over,
});

const chat = (over = {}) => ({
  id: "c1",
  title: "タイトル",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  turns: [turn()],
  ...over,
});

// ---- chatTitle ----------------------------------------------------------

// 「これでツイート作って」のように画像だけを送る使い方がある。
// 空文字を返していたため、履歴一覧に名前の無い行ができていた。
test("本文が空でも、画像を添えていれば名前が付く", () => {
  assert.equal(chatTitle("", true), IMAGE_ONLY_TITLE);
  assert.notEqual(chatTitle("", true).trim(), "");
});

test("本文も添付も無ければ既定の名前にする", () => {
  assert.equal(chatTitle("", false), "新しいチャット");
  assert.equal(chatTitle("   "), "新しいチャット");
});

test("短い質問はそのまま、長い質問は28文字で省く", () => {
  assert.equal(chatTitle("荷重試験の申請方法"), "荷重試験の申請方法");
  const long = "あ".repeat(40);
  assert.equal(chatTitle(long), "あ".repeat(28) + "…");
});

test("絵文字を含む質問でも文字単位で数える", () => {
  // サロゲートペアを .length で数えると途中で割れる
  assert.equal(chatTitle("🐦".repeat(40)), "🐦".repeat(28) + "…");
});

// ---- slugify ------------------------------------------------------------

test("日本語名のIDはほぼ空になる（呼び出し側で補う前提）", () => {
  assert.equal(slugify("しゅよっくん"), "");
});

test("英数字はハイフン区切りへ落とし、前後のハイフンは残さない", () => {
  assert.equal(slugify("  Kouhou Neta Bot!! "), "kouhou-neta-bot");
});

test("IDは64文字を超えない", () => {
  assert.equal(slugify("a".repeat(200)).length, 64);
});

// ---- groupChats ---------------------------------------------------------

const NOW = new Date("2026-08-11T12:00:00+09:00");
const at = (iso) => chat({ id: iso, updatedAt: iso });

test("今日・昨日・過去7日間・年月へ分ける", () => {
  const sections = groupChats(
    [
      at("2026-08-11T09:00:00+09:00"),
      at("2026-08-10T09:00:00+09:00"),
      at("2026-08-06T09:00:00+09:00"),
      at("2026-07-01T09:00:00+09:00"),
    ],
    NOW,
  );
  assert.deepEqual(sections.map((s) => s.label), ["今日", "昨日", "過去7日間", "2026年7月"]);
});

test("ピン留めは日付によらず先頭の節へ集める", () => {
  const sections = groupChats(
    [at("2026-08-11T09:00:00+09:00"), chat({ id: "old", updatedAt: "2025-01-01T00:00:00+09:00", pinned: true })],
    NOW,
  );
  assert.equal(sections[0].label, "ピン留め");
  assert.equal(sections[0].chats[0].id, "old");
});

test("同じ節の中は新しい順に並べる", () => {
  const sections = groupChats(
    [at("2026-08-11T01:00:00+09:00"), at("2026-08-11T10:00:00+09:00")],
    NOW,
  );
  assert.deepEqual(sections[0].chats.map((c) => c.id), [
    "2026-08-11T10:00:00+09:00",
    "2026-08-11T01:00:00+09:00",
  ]);
});

// 履歴の日付が壊れていても、画面が落ちるより「以前」へ寄せるほうがよい
test("日付が壊れていても節に落とす", () => {
  const sections = groupChats([chat({ updatedAt: "こわれた日付" })], NOW);
  assert.equal(sections[0].label, "以前");
});

test("履歴が空なら節も空", () => {
  assert.deepEqual(groupChats([], NOW), []);
});

// ---- shareText ----------------------------------------------------------

test("共有文には質問・回答・出典のURLを含める", () => {
  const text = shareText(
    chat({
      title: "尾翼設計",
      turns: [turn({ question: "尾翼の設計手順は？", answer: "まず…", sources: [{ title: "尾翼班", url: "https://example.org/a", last_edited: "2025-05" }] })],
    }),
  );
  assert.match(text, /^尾翼設計/);
  assert.match(text, /尾翼の設計手順は？/);
  assert.match(text, /- 尾翼班: https:\/\/example\.org\/a/);
});

test("回答が無い往復はエラー文を、それも無ければ「回答なし」を出す", () => {
  assert.match(shareText(chat({ turns: [turn({ answer: "", error: "通信に失敗しました" })] })), /通信に失敗しました/);
  assert.match(shareText(chat({ turns: [turn({ answer: "" })] })), /回答なし/);
});

// ---- referenceSections / answerPlainText --------------------------------

const src = (over = {}) => ({ title: "リファラルご飯制度", url: "https://example.org/a", last_edited: "2026-05", ...over });

test("読んだ節を順に並べ、重複は落とす", () => {
  const sections = referenceSections([
    src({ sections: ["福利厚生 > リファラルご飯制度", "福利厚生 > リファラルご飯制度"] }),
    src({ title: "経費申請方法", sections: ["経理 > 経費申請方法"] }),
  ]);
  assert.deepEqual(sections, ["福利厚生 > リファラルご飯制度", "経理 > 経費申請方法"]);
});

// 節が取れなくても、どのページかは分かるようにする
test("節が無ければページ名で代替する", () => {
  assert.deepEqual(referenceSections([src()]), ["リファラルご飯制度"]);
  assert.deepEqual(referenceSections([src({ sections: [] })]), ["リファラルご飯制度"]);
});

test("出典が無ければ参照行は出さない", () => {
  assert.deepEqual(referenceSections([]), []);
});

// [1] を消すと、どの文がどの資料に基づくのか分からなくなる
test("コピーした平文は本文の番号を残し、番号付きの出典を添える", () => {
  const text = answerPlainText({
    answer: "税込2,500円まで出ます。[1]",
    sources: [src({ sections: ["福利厚生 > リファラルご飯制度"] })],
  });
  assert.match(text, /\[1\]/);
  assert.match(text, /出典:/);
  assert.match(text, /\[1\] リファラルご飯制度: https:\/\/example\.org\/a/);
  assert.match(text, /参照: 福利厚生 > リファラルご飯制度/);
});

test("出典が無ければ本文だけをコピーする", () => {
  assert.equal(answerPlainText({ answer: "  本文だけ  ", sources: [] }), "本文だけ");
});

// ---- retryLabel ---------------------------------------------------------

const BASE = Date.parse("2026-08-11T12:00:00+09:00");

test("再開予定が無ければ何も出さない", () => {
  assert.equal(retryLabel(undefined, BASE), "");
  assert.equal(retryLabel("こわれた日付", BASE), "");
});

test("過ぎていれば「まもなく」にする", () => {
  assert.equal(retryLabel("2026-08-11T11:59:00+09:00", BASE), "まもなく再開予定です");
});

test("秒・分・時間で単位を切り替える", () => {
  assert.match(retryLabel("2026-08-11T12:00:39+09:00", BASE), /約39秒後/);
  assert.match(retryLabel("2026-08-11T12:05:00+09:00", BASE), /約5分後/);
  // 日次上限は数時間先を指すことがある（M34）
  assert.match(retryLabel("2026-08-11T15:30:00+09:00", BASE), /約3時間30分後/);
});

test("再開の時刻も添える", () => {
  assert.match(retryLabel("2026-08-11T12:05:00+09:00", BASE), /（\d{2}:\d{2}頃）$/);
});
