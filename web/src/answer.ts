/**
 * 回答本文の後始末。
 *
 * 出典は**サーバーが索引から組み立ててカードで出す**のが正であり、
 * 本番のプロンプトもモデルへ「回答内に出典一覧を作らない」と指示している
 * （docs/08 M2b・M19）。ここにあるのは、それでもモデルが書いてしまったときに
 * 二重表示にしないための保険である。
 */

/** 旧形式の見出し。「出典:」で始まる行から後ろを落とす。 */
const CITATION_HEADING = /^\s*(\*\*)?出典[:：]/;

/** 出典として残したい補足。落とす範囲の中でもこれだけは残す。 */
const NOTE_LINE = /^\s*[※注]/;

/**
 * 現行形式の出典行。`- [ページ名](URL)（Wiki、本文の年代: 2025年）`。
 *
 * **末尾の括弧まで含めて一致したときだけ**出典とみなす。回答本文にも
 * 「資料本文にあるURLをそのまま載せる」ことがあり、ただのリンク箇条書きを
 * 出典と誤認して消すと、必要な情報が消えてしまうためである。
 */
const CITATION_LINE =
  /^\s*[-*]\s*\[[^\]]+\]\(https?:\/\/[^)]+\)\s*[（(][^）)]*(?:Wiki|公式サイト|フライトシミュレータ|本文の年代)[^）)]*[）)]\s*$/;

export function stripCitation(text: string): string {
  let lines = text.split("\n");

  // 現行形式は末尾に並ぶ。**末尾から連続する分だけ**落とす。
  // 途中に出てくる同じ形の行は、本文の一部として書かれた可能性がある
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (!line.trim()) {
      end--;
      continue;
    }
    if (!CITATION_LINE.test(line)) break;
    end--;
  }
  if (end < lines.length) lines = lines.slice(0, end);

  const start = lines.findIndex((line) => CITATION_HEADING.test(line));
  if (start === -1) return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const notes = lines.slice(start).filter((line) => NOTE_LINE.test(line));
  return [...lines.slice(0, start), ...notes].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
