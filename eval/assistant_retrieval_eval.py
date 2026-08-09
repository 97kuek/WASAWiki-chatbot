"""汎用と区分アシスタントのページ選択を、同じ質問で対比較する。

回答品質全体ではなく、専門範囲を付けたときに正しいページを選べるかだけを測る。
モデル出力には揺らぎがあるため、既定で各条件を3回実行する。

  python eval/assistant_retrieval_eval.py

対象を増やす前に、まず空力2問・駆動1問で差が実在するかを見る。18リクエストで済み、
32問すべてを2条件で回してAPI枠を消費しない。
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv  # noqa: E402
from rag.llm import make_llm  # noqa: E402
from rag.pipeline import MAX_PAGES, Pipeline, resolve_title  # noqa: E402

INDEX = Path("data/index.json")
TOC = Path("data/toc.md")
GOLDEN = Path("eval/golden.json")
PILOT = {"q10": ("空力", "空力設計"), "q11": ("空力", "空力設計"), "q30": ("駆動・フレーム", "駆動・フレーム班")}
REPEATS = int(os.getenv("ASSISTANT_EVAL_REPEATS", "3"))


def main() -> None:
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    toc = TOC.read_text(encoding="utf-8")
    all_questions = json.loads(GOLDEN.read_text(encoding="utf-8"))["questions"]
    questions = [q for q in all_questions if q["id"] in PILOT]
    pages = {p["title"]: p for p in index["pages"]}
    aliases = {alias: p["title"] for p in index["pages"] for alias in p["aliases"]}

    load_dotenv()
    llm = make_llm()
    print(f"モデル: {llm.name()} / {len(questions)}問 × 2条件 × {REPEATS}回")

    hits: dict[str, int] = defaultdict(int)
    totals: dict[str, int] = defaultdict(int)
    details: list[tuple[str, str, bool, list[str]]] = []
    for question in questions:
        team, label = PILOT[question["id"]]
        for condition in ("汎用", label):
            for _ in range(REPEATS):
                scope = "" if condition == "汎用" else (
                    f"\n**このアシスタントは「{label}の資料のみ」しか参照できません。"
                    "範囲外のページを選んでも捨てられます。**\n"
                )
                result = llm(toc + Pipeline.SELECT_PROMPT + question["question"] + scope,
                             Pipeline.SELECT_SCHEMA, 300)
                selected: list[str] = []
                for raw in result.get("titles", []):
                    if not isinstance(raw, str):
                        continue
                    title = resolve_title(raw, pages, aliases)
                    if title and title not in selected and (condition == "汎用" or pages[title]["team"] == team):
                        selected.append(title)
                    if len(selected) == MAX_PAGES:
                        break
                hit = bool(set(selected) & set(question["evidence_pages"]))
                hits[condition] += hit
                totals[condition] += 1
                if condition != "汎用":
                    hits["区分アシスタント"] += hit
                    totals["区分アシスタント"] += 1
                details.append((question["id"], condition, hit, selected))

    for qid, condition, hit, selected in details:
        print(f"  {'○' if hit else '×'} {qid} {condition:<10} {' / '.join(selected) or '(なし)'}")
    print("\nページ選択の的中:")
    for condition in ("汎用", "区分アシスタント", "空力設計", "駆動・フレーム班"):
        if totals[condition]:
            print(f"  {condition:<14} {hits[condition]}/{totals[condition]} "
                  f"= {hits[condition] / totals[condition] * 100:.1f}%")
    print(f"\nLLM呼び出し {llm.calls}回 / 合計 {llm.seconds:.0f}秒")
    print("注意: これはページ選択だけの小規模パイロットで、回答精度全体の差ではない。")


if __name__ == "__main__":
    main()
