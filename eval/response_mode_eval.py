"""回答モードの検索段だけを、小さな層化標本で比較する。

回答生成とJudgeまで一度に回すと費用が大きく、どの段で差が出たかも分からない。
まずページ選択について fast / standard / deep を比較し、改善が確認できた組み合わせだけ
本番の環境変数へ設定する。

  LLM_PROVIDER=gemini python eval/response_mode_eval.py --questions 10 --repeats 3

出力: eval/response_mode_results.json（非公開Wiki由来の設問を含むためgitignore対象）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv  # noqa: E402
from rag.llm import GeminiLLM, make_llm  # noqa: E402
from rag.pipeline import Pipeline, profile_for  # noqa: E402

GOLDEN = Path("eval/golden.json")
OUT = Path("eval/response_mode_results.json")
MODES = ("fast", "standard", "deep")


def stratified(questions: list[dict], limit: int) -> list[dict]:
    """設問種別を順番に1件ずつ拾い、factだけに偏らない標本を作る。"""
    buckets: dict[str, list[dict]] = defaultdict(list)
    for question in questions:
        if question.get("evidence_pages"):
            buckets[question["type"]].append(question)

    selected: list[dict] = []
    while len(selected) < limit:
        added = False
        for qtype in sorted(buckets):
            if buckets[qtype] and len(selected) < limit:
                selected.append(buckets[qtype].pop(0))
                added = True
        if not added:
            break
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=int, default=10, help="比較する設問数")
    parser.add_argument("--repeats", type=int, default=3, help="同一条件の反復数")
    args = parser.parse_args()
    if args.questions <= 0 or args.repeats <= 0:
        raise SystemExit("--questions と --repeats は1以上にしてください")

    load_dotenv()
    if os.environ.get("LLM_PROVIDER", "ollama").lower() != "gemini":
        raise SystemExit("モデル／推論量の比較には LLM_PROVIDER=gemini を指定してください")

    questions = json.loads(GOLDEN.read_text(encoding="utf-8"))["questions"]
    sample = stratified(questions, args.questions)
    llm = make_llm()
    if not isinstance(llm, GeminiLLM):
        raise SystemExit("Geminiクライアントを初期化できませんでした")
    pipeline = Pipeline(Path("data/index.json"), Path("data/toc.md"), llm)

    records: list[dict] = []
    for question in sample:
        gold = set(question["evidence_pages"])
        for mode in MODES:
            for repeat in range(1, args.repeats + 1):
                before = llm.seconds
                pages, _, dropped = pipeline.select_pages(
                    question["question"], question.get("history"), mode
                )
                profile = profile_for(mode, question["question"], "selection")
                record = {
                    "id": question["id"],
                    "type": question["type"],
                    "mode": mode,
                    "profile": profile,
                    "model": llm.models[profile],
                    "repeat": repeat,
                    "page_hit": bool(gold & set(pages)),
                    "seconds": round(llm.seconds - before, 3),
                    "pages": pages,
                    "gold_pages": sorted(gold),
                    "dropped_titles": dropped,
                }
                records.append(record)
                mark = "○" if record["page_hit"] else "×"
                print(f"{mark} {question['id']} {mode:<8} {record['seconds']:>6.1f}秒")

    summary: dict[str, dict] = {}
    for mode in MODES:
        subset = [record for record in records if record["mode"] == mode]
        hits = sum(record["page_hit"] for record in subset)
        summary[mode] = {
            "hits": hits,
            "total": len(subset),
            "page_recall": hits / len(subset) if subset else 0,
            "average_seconds": sum(record["seconds"] for record in subset) / len(subset) if subset else 0,
        }

    OUT.write_text(
        json.dumps({"settings": vars(args), "summary": summary, "records": records}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("\nページ選択の比較")
    for mode, result in summary.items():
        print(
            f"  {mode:<8} {result['hits']}/{result['total']} "
            f"({result['page_recall'] * 100:.1f}%) / 平均{result['average_seconds']:.1f}秒"
        )
    print(f"詳細は {OUT} に保存しました")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        # API残高不足など、待っても直らない失敗で長いスタックトレースを出さない。
        raise SystemExit(str(error)) from error
