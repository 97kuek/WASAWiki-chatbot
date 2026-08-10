"""M2a: 目次方式によるページ選択の精度を測る（検索層なし）。

設計方針 docs/01-設計方針.md §2 の Phase 1（L1 目次層）の検証。
「目次だけをコンテキストに置いて、LLMが正しいページを選べるか」を測り、
BM25ベースライン（docs/02-測定結果.md M1）と**ページ単位で**突き合わせる。

チャンク単位ではなくページ単位で比較するのは、目次方式が返すのがページだからである。
指標の粒度を揃えないと比較にならない。

**目次を必ずプロンプトの先頭に固定する。** llama.cpp のKVキャッシュが再利用され、
プロンプト処理が 80秒 → 0.8秒 になる（実測）。本番のGo実装でも同じ構造にすること。

  ollama serve  # OLLAMA_CONTEXT_LENGTH=32768 で起動しておく
  python eval/toc_eval.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv  # noqa: E402
from rag.llm import make_llm  # noqa: E402
from rag.pipeline import resolve_title  # noqa: E402

INDEX = Path("data/index.json")
# 目次を差し替えて A/B を測れるようにしておく（例: 公式サイトを含む/含まない）。
# 設問29問では1問=3.4ポイント動くため、1回の実行だけで優劣を語ってはいけない
TOC = Path(os.getenv("TOC_PATH", "data/toc.md"))
GOLDEN = Path("eval/golden.json")

TOP_N = 3  # 選ばせるページ数。BM25の Page Recall@3 と比較する

SCHEMA = {
    "type": "object",
    "properties": {
        "titles": {"type": "array", "items": {"type": "string"}, "maxItems": TOP_N},
        "answerable": {"type": "boolean"},
    },
    "required": ["titles", "answerable"],
}

INSTRUCTION = f"""---
上はWikiの目次です。次の質問に答えるために読むべきページを、目次のタイトルから
最大{TOP_N}件選んでください。関連が薄いものを埋め合わせで入れないこと。

目次を見る限りWikiに答えが存在しないと判断できる場合は、answerable を false にし、
titles には最も近そうなページだけを挙げてください。

質問: """


def select(llm, toc: str, question: str) -> tuple[dict, float]:
    started = time.time()
    # 目次を先頭に固定する（キャッシュのため）
    parsed = llm(toc + INSTRUCTION + question, SCHEMA, 200)
    if not isinstance(parsed, dict):
        parsed = {"titles": [], "answerable": True}
    return parsed, time.time() - started


def question_with_history(question: dict) -> str:
    """指示語を含む多ターン問題だけ、直近の会話をページ選択へ添える。"""
    history = question.get("history") or []
    if not history:
        return question["question"]
    lines = ["# 直近の会話（参照解決用）"]
    for turn in history:
        lines += [f"利用者: {turn['question']}", f"以前の回答: {turn['answer']}"]
    lines += ["# 現在の質問", question["question"]]
    return "\n".join(lines)


def main() -> None:
    # --ids は answer_eval.py と同じ形。無料枠のレート制限では全35問で
    # 1問あたり60秒待たされることがあり、1回の測定に30分かかる。
    # 影響しうる設問だけを繰り返し測る方が、1回の全問測定より判断に効く
    parser = argparse.ArgumentParser(description="目次方式のページ選択精度を測ります")
    parser.add_argument("--ids", help="測る設問をカンマ区切りで指定します（例: q10,q21）")
    args = parser.parse_args()

    index = json.loads(INDEX.read_text(encoding="utf-8"))
    questions = json.loads(GOLDEN.read_text(encoding="utf-8"))["questions"]
    if args.ids:
        wanted = {i.strip() for i in args.ids.split(",") if i.strip()}
        questions = [q for q in questions if q["id"] in wanted]
        if missing := wanted - {q["id"] for q in questions}:
            raise SystemExit(f"ゴールデンデータに無い設問です: {', '.join(sorted(missing))}")
    toc = TOC.read_text(encoding="utf-8")

    load_dotenv()
    llm = make_llm()
    # 本番と同じ照合を使う。評価側だけ生の文字列で突き合わせると、
    # 本番では解決できているものを「存在しないページ名」と数えてしまう
    known = {p["title"] for p in index["pages"]}
    aliases = {a: p["title"] for p in index["pages"] for a in p["aliases"]}
    chunks_of = {p["title"]: len(p["chunks"]) for p in index["pages"]}
    chars_of = {p["title"]: p["chars"] for p in index["pages"]}

    scored = [q for q in questions if q["evidence_pages"]]
    print(f"目次 {len(toc):,}字 / 設問 {len(questions)}問（ページ採点対象 {len(scored)}問）")
    print(f"モデル: {llm.name()}\n")

    hit_any = hit_all = 0
    hit_top1 = 0
    hallucinated: list[tuple[str, str]] = []
    per_type: dict[str, dict[str, int]] = defaultdict(lambda: {"n": 0, "hit": 0})
    fed_chars: list[int] = []
    misses: list[tuple[str, str, list[str], list[str]]] = []
    answerable_correct = 0
    elapsed = 0.0

    for q in questions:
        result, dt = select(llm, toc, question_with_history(q))
        elapsed += dt
        raw_titles = [t.strip() for t in result.get("titles", []) if t.strip()]

        # 本番と同じ解決をかけてから採点する。解決できなかったものだけが
        # 実際に捨てられる＝ハルシネーションである
        titles = []
        for t in raw_titles:
            hit = resolve_title(t, known, aliases)
            if hit is None:
                hallucinated.append((q["id"], t))
            elif hit not in titles:
                titles.append(hit)

        # answerable の判定が合っているか
        if result.get("answerable") == q["answerable"]:
            answerable_correct += 1

        fed_chars.append(sum(chars_of.get(t, 0) for t in titles))

        if q["evidence_pages"]:
            gold = set(q["evidence_pages"])
            picked = set(titles)
            per_type[q["type"]]["n"] += 1
            if gold & picked:
                hit_any += 1
                per_type[q["type"]]["hit"] += 1
            if gold <= picked:
                hit_all += 1
            if titles and titles[0] in gold:
                hit_top1 += 1
            if not (gold & picked):
                misses.append((q["id"], q["question"][:30], sorted(gold), titles))

        mark = "○" if not q["evidence_pages"] or set(q["evidence_pages"]) & set(titles) else "×"
        print(f"  {mark} {q['id']} {dt:4.1f}s  {' / '.join(titles) or '(なし)'}")

    n = len(scored)
    print(f"\n{'=' * 64}\nM2a: 目次方式によるページ選択（上位{TOP_N}件）\n{'=' * 64}")
    print(f"Page Recall@{TOP_N}      : {hit_any}/{n} = {hit_any / n * 100:.1f}%")
    print(f"All-Pages Recall@{TOP_N} : {hit_all}/{n} = {hit_all / n * 100:.1f}%")
    print(f"1位が正解            : {hit_top1}/{n} = {hit_top1 / n * 100:.1f}%")
    print(f"回答可否の判定        : {answerable_correct}/{len(questions)} "
          f"= {answerable_correct / len(questions) * 100:.1f}%")
    print(f"存在しないページ名     : {len(hallucinated)}件 {hallucinated or ''}")
    print(f"選択ページの合計文字数 : 中央値 {sorted(fed_chars)[len(fed_chars) // 2]:,}字 "
          f"/ 最大 {max(fed_chars):,}字")
    print(f"所要                 : 合計 {elapsed:.0f}秒 / 平均 {elapsed / len(questions):.1f}秒")

    print("\n種別ごとの Hit:")
    for qtype, v in sorted(per_type.items()):
        print(f"  {qtype:<14} {v['hit']:>2}/{v['n']:<2} {'#' * round(v['hit'] / v['n'] * 20)}")

    if misses:
        print(f"\n選べなかった質問 ({len(misses)}件):")
        for qid, text, gold, got in misses:
            print(f"  {qid} {text}")
            print(f"      正解: {' / '.join(gold)}")
            print(f"      選択: {' / '.join(got) or '(なし)'}")

    print(f"\n{'=' * 64}\nBM25ベースライン（M1）との比較 ※ページ単位で揃えてある\n{'=' * 64}")
    print(f"  BM25 Page Recall@3 : 69.0%")
    print(f"  BM25 Page Recall@5 : 72.4%")
    print(f"  目次方式  @{TOP_N}       : {hit_any / n * 100:.1f}%")


if __name__ == "__main__":
    main()
