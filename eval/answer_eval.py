"""M2b: エンドツーエンドの回答品質を測る。

設計方針 docs/01-設計方針.md §5-3 に対応。評価は2層に分ける。

  1. ルールベース（決定的・無料）
     - 出典を明示したか
     - 回答不能な問いで「記載がない」と言えたか（ハルシネーション検出）
     - 検索段でのページ選択が当たっているか

  2. LLM-as-a-Judge（Faithfulness）
     - 回答が渡した資料だけで裏付けられるか
     - ⚠️ **判定器がローカルモデルの間は暫定値**。設計方針 §5-3 の通り、
       人手評価との一致率（κ）を測るまで、この数字は指標として信用しない

  ollama serve  # OLLAMA_CONTEXT_LENGTH=32768 で起動しておく
  python eval/answer_eval.py
出力: eval/answers.json（人手レビュー用。Wiki由来の内容を含むため .gitignore 対象）
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dotenv import load_dotenv  # noqa: E402
from rag.llm import make_llm  # noqa: E402
from rag.pipeline import Pipeline  # noqa: E402

GOLDEN = Path("eval/golden.json")
OUT = Path("eval/answers.json")

# 「記載がない」と言えているかの検出。表現の揺れを拾う
NO_INFO = re.compile(
    r"記載(が|は)?(あり|ござい)?ませ|記述(が|は)?(あり|ござい)?ませ|書かれてい(ませ|ない)|"
    r"見当たりませ|情報(が|は)(あり|ござい)?ませ|特定できませ|含まれてい(ませ|ない)"
)
CITATION = re.compile(r"出典|参照|最終更新")


def body_only(text: str) -> str:
    """出典欄を除いた本文。出典に含まれる語で判定が揺れるのを防ぐ。"""
    return re.sub(r"出典[:：].*", "", text, flags=re.S).strip()


def answered_well(qtype: str, text: str) -> bool:
    """回答の出し方が種別に対して適切かを判定する。

    ⚠️ 当初は「本文に『記載がありません』が出たら拒否」と一律に数えていたが、
    プロンプトは「何が書かれていて何が書かれていないかを分けて述べる」と
    指示している。つまり**指示どおりに答えた回答ほど誤検知される**構造だった。
    種別ごとに基準を分ける。
    """
    body = body_only(text)
    says_missing = bool(NO_INFO.search(body))
    if qtype == "unanswerable":
        return says_missing and len(body) < 300          # 明確に断る
    if qtype == "partial":
        return says_missing and len(body) >= 120         # 欠落を認めつつ中身も出す
    if qtype == "false_premise":
        return says_missing or "ではなく" in body        # 前提の誤りを指摘する
    return not (says_missing and len(body) < 160)        # 実質的に答えている

FAITHFUL_SCHEMA = {
    "type": "object",
    "properties": {
        # 理由を先に書かせる。判定を先に置くと、根拠を考える前に決めてしまい
        # 判定基準の文をそのままオウム返しする（M2bで実際に起きた）
        "unsupported_claim": {"type": "string"},
        "faithful": {"type": "boolean"},
    },
    "required": ["unsupported_claim", "faithful"],
}


def judge_faithfulness(llm, context: str, answer: str) -> dict:
    prompt = f"""以下の「資料」と「回答」を読み、回答の内容が資料だけで裏付けられるかを判定してください。

手順:
1. 回答の中に、資料で裏付けられない具体的な記述があれば、その一文を
   unsupported_claim にそのまま引用する。無ければ空文字列にする
2. unsupported_claim が空なら faithful = true、そうでなければ false

注意:
- 「記載がない」と述べているだけなら faithful = true
- 資料の要約・言い換えは faithful = true

# 資料
{context}

# 回答
{answer}
"""
    result = llm(prompt, FAITHFUL_SCHEMA, 300)
    claim = (result.get("unsupported_claim") or "").strip()
    return {"faithful": not claim, "reason": claim}


def main() -> None:
    questions = json.loads(GOLDEN.read_text(encoding="utf-8"))["questions"]
    load_dotenv()
    llm = make_llm()
    print(f'モデル: {llm.name()}')
    pipeline = Pipeline(Path("data/index.json"), Path("data/toc.md"), llm)

    records = []
    stats = {
        "page_hit": 0, "page_scored": 0,
        "cited": 0, "said_no_info": 0, "should_say_no_info": 0,
        "wrongly_said_no_info": 0, "faithful": 0,
        "dropped": [],
    }
    per_type = defaultdict(lambda: {"n": 0, "page_hit": 0, "faithful": 0})

    for q in questions:
        answer = pipeline.answer(q["question"])
        gold = set(q["evidence_pages"])
        picked = set(answer.pages)

        # --- ルールベース ---
        page_hit = bool(gold & picked) if gold else None
        if page_hit is not None:
            stats["page_scored"] += 1
            stats["page_hit"] += page_hit
        cited = bool(CITATION.search(answer.text))
        no_info = not answered_well(q["type"], answer.text)
        stats["cited"] += cited
        stats["dropped"] += [(q["id"], t) for t in answer.dropped_titles]

        stats["should_say_no_info"] += 1
        stats["said_no_info"] += not no_info  # 種別に対して適切に答えられたか

        # --- LLM-as-a-Judge（暫定） ---
        context = "\n\n".join(pipeline.chunks[c]["text"] for c in answer.chunk_ids)
        verdict = judge_faithfulness(llm, context[:20000], answer.text) if answer.chunk_ids else \
            {"faithful": True, "reason": "資料なし"}
        stats["faithful"] += verdict["faithful"]

        bucket = per_type[q["type"]]
        bucket["n"] += 1
        bucket["page_hit"] += bool(page_hit)
        bucket["faithful"] += verdict["faithful"]

        records.append({
            "id": q["id"], "type": q["type"], "question": q["question"],
            "expected": q["expected"], "answer": answer.text,
            "pages": answer.pages, "gold_pages": q["evidence_pages"],
            "chunk_ids": answer.chunk_ids, "gold_chunks": q["evidence_chunks"],
            "page_hit": page_hit, "cited": cited, "said_no_info": no_info,
            "answerable_gold": q["answerable"], "faithful": verdict["faithful"],
            "faithful_reason": verdict["reason"], "context_chars": answer.context_chars,
            "dropped_titles": answer.dropped_titles,
        })
        mark = "○" if page_hit is not False else "×"
        print(f"  {mark} {q['id']} 文脈{answer.context_chars:>6,}字 "
              f"{'出典○' if cited else '出典×'} {'忠実○' if verdict['faithful'] else '忠実×'} "
              f"{' / '.join(answer.pages)}")

    OUT.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

    n = len(questions)
    ps = stats["page_scored"]
    print(f"\n{'=' * 66}\nM2b: エンドツーエンドの回答品質（{n}問）\n{'=' * 66}")
    print("【ルールベース（決定的）】")
    print(f"  ページ選択が的中     : {stats['page_hit']}/{ps} = {stats['page_hit'] / ps * 100:.1f}%")
    print(f"  出典を明示           : {stats['cited']}/{n} = {stats['cited'] / n * 100:.1f}%")
    print(f"  回答の出し方が種別に対して適切     : "
          f"{stats['said_no_info']}/{stats['should_say_no_info']} "
          f"= {stats['said_no_info'] / stats['should_say_no_info'] * 100:.1f}%")
    print(f"  照合で落とした架空ページ名          : {len(stats['dropped'])}件 {stats['dropped'] or ''}")
    print(f"  文脈量               : 中央値 "
          f"{sorted(r['context_chars'] for r in records)[n // 2]:,}字 / "
          f"最大 {max(r['context_chars'] for r in records):,}字")

    print("\n【LLM-as-a-Judge（⚠️ 判定器がローカルモデルのため暫定値）】")
    print(f"  Faithfulness         : {stats['faithful']}/{n} = {stats['faithful'] / n * 100:.1f}%")

    print("\n種別ごと（ページ的中 / 忠実性）:")
    for qtype, v in sorted(per_type.items()):
        print(f"  {qtype:<14} {v['page_hit']:>2}/{v['n']:<2}   {v['faithful']:>2}/{v['n']}")

    print(f"\nLLM呼び出し {llm.calls}回 / 合計 {llm.seconds:.0f}秒")
    print(f"回答全文は {OUT} に保存（人手レビュー用）")


if __name__ == "__main__":
    main()
