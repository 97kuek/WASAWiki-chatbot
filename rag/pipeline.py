"""回答パイプライン本体。目次 → ページ選択 → チャンク絞り込み → 回答生成。

設計方針 docs/01-設計方針.md §2 の Phase 1（L0/L1/L3）に対応する。
**このモジュールのロジックが、後段でGoに移植される対象**である。プロンプトと
段構成はここを正本とする。

M2a（docs/02-測定結果.md）で判明した課題への対処が入っている:
  - 存在しないページ名を8件返した      → 目次との照合で落とす（§stage1）
  - 選択3ページが最大48,100字になった  → チャンク単位の2段絞り込み（§stage2）

LLMは呼び出し可能オブジェクトとして注入する。測定はローカル（Ollama）で行うが、
本番はClaudeに差し替わるため、パイプライン側はモデルに依存しない。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

MAX_PAGES = 3
# 選択ページの本文をそのまま渡す上限。超えたらチャンク単位に絞る。
# M2aでは3ページの合計が最大48,100字になった（36,261字の「駆動・フレーム班」が原因）
DIRECT_CONTEXT_LIMIT = 12_000
MAX_CHUNKS = 8


class LLM(Protocol):
    """プロンプトとJSONスキーマを受け取り、パース済みの結果を返す。"""

    def __call__(self, prompt: str, schema: dict | None = None, max_tokens: int = 800) -> Any: ...


@dataclass
class Answer:
    question: str
    text: str
    pages: list[str] = field(default_factory=list)
    chunk_ids: list[str] = field(default_factory=list)
    answerable: bool = True
    dropped_titles: list[str] = field(default_factory=list)  # 照合で落とした架空のページ名
    context_chars: int = 0


class Pipeline:
    def __init__(self, index_path: Path, toc_path: Path, llm: LLM):
        index = json.loads(Path(index_path).read_text(encoding="utf-8"))
        self.toc = Path(toc_path).read_text(encoding="utf-8")
        self.llm = llm
        self.pages = {p["title"]: p for p in index["pages"]}
        self.chunks = {c["id"]: c for p in index["pages"] for c in p["chunks"]}
        self.chunk_page = {c["id"]: p["title"] for p in index["pages"] for c in p["chunks"]}
        # 別名（リダイレクト）でも引けるようにする
        self.alias = {a: p["title"] for p in index["pages"] for a in p["aliases"]}

    # ------------------------------------------------------------------
    # Stage 1: 目次を見てページを選ぶ
    # ------------------------------------------------------------------

    SELECT_SCHEMA = {
        "type": "object",
        "properties": {
            "titles": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_PAGES},
            "answerable": {"type": "boolean"},
        },
        "required": ["titles", "answerable"],
    }

    SELECT_PROMPT = f"""---
上はWikiの目次です。次の質問に答えるために読むべきページを、目次のタイトルから
最大{MAX_PAGES}件選んでください。

厳守すること:
- **目次に実在するページタイトルを、一字一句そのまま**書き写すこと
- 班の名前（空力、構造など）や節の名前をページタイトルとして書かないこと
- 目次に無いページ名を推測して作らないこと
- 関連が薄いものを埋め合わせで入れないこと

目次を見る限りWikiに答えが無いと判断できる場合は answerable を false にし、
titles には最も近そうなページだけを挙げてください。

質問: """

    def resolve(self, title: str) -> str | None:
        """モデルが返したタイトルを実在ページに解決する。解決できなければ None。

        M2aでは班名「空力」、節名「鳥コンまでの流れ」、推測で生成した
        「構造設計 41st」などが返ってきた。ここで落とさないと後段が壊れる。
        """
        title = title.strip()
        # 目次は「タイトル（別名: X）」と表示するため、モデルが注記ごと
        # コピーしてくることがある（M2a-gemini で2件発生）。剥がしてから照合する
        title = re.sub(r"\s*（別名:[^）]*）\s*$", "", title)
        if title in self.pages:
            return title
        if title in self.alias:
            return self.alias[title]
        # 部分一致は、候補が1件に定まるときだけ採用する。
        # 「空力」のように多数にマッチする語は班名なので採用してはいけない
        candidates = [t for t in self.pages if title and title in t]
        return candidates[0] if len(candidates) == 1 else None

    def select_pages(self, question: str) -> tuple[list[str], bool, list[str]]:
        result = self.llm(self.toc + self.SELECT_PROMPT + question, self.SELECT_SCHEMA, 200)
        titles = [t for t in result.get("titles", []) if isinstance(t, str)]

        resolved, dropped = [], []
        for raw in titles:
            hit = self.resolve(raw)
            if hit and hit not in resolved:
                resolved.append(hit)
            elif not hit:
                dropped.append(raw)
        return resolved, bool(result.get("answerable", True)), dropped

    # ------------------------------------------------------------------
    # Stage 2: ページ内のチャンクを絞る
    # ------------------------------------------------------------------

    CHUNK_SCHEMA = {
        "type": "object",
        "properties": {"ids": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_CHUNKS}},
        "required": ["ids"],
    }

    def select_chunks(self, question: str, titles: list[str]) -> list[str]:
        """選択ページのチャンクを集める。総量が小さければ絞らない。

        36,261字の「駆動・フレーム班」のようなページを丸ごと渡すと文脈を圧迫するので、
        パンくずの一覧だけをLLMに見せて必要な節を選ばせる。パンくずは
        「ページ名 > H2 > H3」の形で節の内容を要約しているため、これだけで判断できる。
        """
        ids = [c["id"] for t in titles for c in self.pages[t]["chunks"]]
        total = sum(self.chunks[i]["chars"] for i in ids)
        if total <= DIRECT_CONTEXT_LIMIT:
            return ids

        catalog = "\n".join(
            f"{i}\t{self.chunks[i]['breadcrumb']}（{self.chunks[i]['chars']}字）" for i in ids
        )
        prompt = (
            f"以下はWikiの節の一覧です。各行は「ID\tページ名 > 見出し > 見出し（文字数）」です。\n\n"
            f"{catalog}\n\n---\n"
            f"質問「{question}」に答えるために必要な節を、最大{MAX_CHUNKS}件選び、IDだけをJSONで返してください。"
        )
        result = self.llm(prompt, self.CHUNK_SCHEMA, 300)
        picked = [i for i in result.get("ids", []) if i in self.chunks]
        return picked or ids[:MAX_CHUNKS]  # 選べなかったら先頭から詰める

    # ------------------------------------------------------------------
    # Stage 3: 回答する
    # ------------------------------------------------------------------

    ANSWER_PROMPT = """あなたは早稲田大学の鳥人間サークル WASA の引き継ぎ資料Wikiに詳しいアシスタントです。
以下の資料**だけ**を根拠に、質問に答えてください。

厳守すること:
- **必ず日本語で答える**
- 思考の過程は書かず、結論から書く
- 資料に書かれていないことは、推測で補わず「Wikiには記載がありません」と明示する
- 資料の一部しか答えられない場合は、**何が書かれていて何が書かれていないか**を分けて述べる
- 質問の前提が資料と食い違う場合は、まず前提の誤りを指摘する
- 回答の最後に、参照した資料を「出典: ページ名（最終更新: YYYY-MM）」の形で必ず挙げる
- 参照元が2年以上前の場合は、情報が古い可能性があることを添える

# 資料

{context}

# 質問

{question}
"""

    def fallback_pages(self, question: str) -> list[str]:
        """LLMがページを1件も返せなかったときの保険。

        M2b の q15 でモデルが空文字列のタイトルを3件返し、照合で全部落ちて
        文脈ゼロになった。目次に対する素朴な字面一致で拾い直す。
        精度は高くないが「何も答えられない」よりはよい。
        """
        scores: list[tuple[int, str]] = []
        grams = {question[i : i + 2] for i in range(len(question) - 1)}
        for title, page in self.pages.items():
            hay = title + " " + " ".join(page["headings"]) + " " + page["lead"][:200]
            scores.append((sum(1 for g in grams if g in hay), title))
        scores.sort(reverse=True)
        return [t for score, t in scores[:MAX_PAGES] if score > 0]

    def answer(self, question: str) -> Answer:
        titles, answerable, dropped = self.select_pages(question)
        if not titles:
            titles = self.fallback_pages(question)
        if not titles:
            return Answer(question, "Wikiの目次から関連するページを特定できませんでした。",
                          answerable=False, dropped_titles=dropped)

        chunk_ids = self.select_chunks(question, titles)
        blocks = []
        for cid in chunk_ids:
            page = self.pages[self.chunk_page[cid]]
            blocks.append(
                f"## {self.chunks[cid]['breadcrumb']}\n"
                f"（ページ: {page['title']} / 最終更新: {page['last_edited']}）\n\n"
                f"{self.chunks[cid]['text']}"
            )
        context = "\n\n---\n\n".join(blocks)

        text = self.llm(self.ANSWER_PROMPT.format(context=context, question=question), None, 900)
        return Answer(
            question=question,
            text=text if isinstance(text, str) else json.dumps(text, ensure_ascii=False),
            pages=titles,
            chunk_ids=chunk_ids,
            answerable=answerable,
            dropped_titles=dropped,
            context_chars=len(context),
        )
