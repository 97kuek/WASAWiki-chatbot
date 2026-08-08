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
from datetime import date
from pathlib import Path
from typing import Any, Callable, Protocol

MAX_PAGES = 4  # 空力設計は代違いで4ページあり、3では構造的に全部入らない
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


def era_label(era: dict | None) -> str:
    """build_index.py の extract_era が入れた年代を、プロンプト用の短い表記にする。

    Go側 index.Era.Label と同じ出力にすること。プロンプトを片方だけ変えると、
    Pythonで測った数字が本番の説明にならなくなる。
    """
    years = (era or {}).get("years") or []
    if not years:
        return ""
    if years[0] == years[-1]:
        return f"{years[-1]}年"
    return f"{years[0]}〜{years[-1]}年（最新{years[-1]}年）"


def resolve_title(title: str, pages, alias) -> str | None:
    """モデルが返したタイトルを実在ページに解決する。解決できなければ None。

    M2aでは班名「空力」、節名「鳥コンまでの流れ」、推測で生成した
    「構造設計 41st」などが返ってきた。ここで落とさないと後段が壊れる。

    **評価スクリプトからも必ずこの関数を使うこと。** 評価側が生の文字列で
    突き合わせていると、本番では解決できているものを「存在しないページ名」と
    数えてしまい、実力を過小に報告する（M6でこの食い違いを実際に踏んだ）。
    """
    title = title.strip()
    # 目次は「タイトル（別名: X）」と表示するため、モデルが注記ごと
    # コピーしてくることがある（M2a-gemini で2件発生）。剥がしてから照合する
    title = re.sub(r"\s*（別名:[^）]*）\s*$", "", title)
    if title in pages:
        return title
    if title in alias:
        return alias[title]
    # 部分一致は、候補が1件に定まるときだけ採用する。
    # 「空力」のように多数にマッチする語は班名なので採用してはいけない
    candidates = [t for t in pages if title and title in t]
    return candidates[0] if len(candidates) == 1 else None


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
上は資料の目次です。引き継ぎWiki（部内限定）と公式サイト（一般公開）の2つが載っています。
次の質問に答えるために読むべきページを、目次のタイトルから最大{MAX_PAGES}件選んでください。

厳守すること:
- **目次に実在するページタイトルを、一字一句そのまま**書き写すこと
- 班の名前（空力、構造など）や節の名前をページタイトルとして書かないこと
- 目次に無いページ名を推測して作らないこと
- 関連が薄いものを埋め合わせで入れないこと
- **質問に出てくる語がそのままタイトルに含まれるページがあれば、必ず候補に入れること**
- **同じテーマで代（世代）違いのページが複数ある場合は、最新の代を必ず含めること**
  （例: 空力設計(38th) / (40th) / (41st) があるなら 41st は外さない）。
  引き継ぎ資料では最新代が最も重要であり、古い代だけを挙げるのは誤り
- サークルの成り立ち・歴代機体・対外的な説明を問われたら**公式サイト側も候補に入れる**。
  逆に作業手順や設計の詳細は引き継ぎWiki側にある

目次を見る限りどちらの資料にも答えが無いと判断できる場合は answerable を false にし、
titles には最も近そうなページだけを挙げてください。

質問: """

    def resolve(self, title: str) -> str | None:
        return resolve_title(title, self.pages, self.alias)

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

    ANSWER_PROMPT = """あなたは早稲田大学の鳥人間サークル WASA の資料に詳しいアシスタントです。
資料は部内の引き継ぎWikiと一般公開の公式サイトの2つからなります。
以下の資料を根拠に、質問に答えてください。

**今日は{today}（日本時間）です。** 「今年」「現在」「最新」「何年前」はこの日付を基準に判断すること。

**答えられることは答える。**
- 資料を読めば分かることは、質問と同じ言葉で書かれていなくても答えてよい
- 要約・比較・時系列の整理・複数箇所の突き合わせは「推測」ではない。積極的に行う
- 「記載がありません」と答えてよいのは、**資料を読んでも該当する情報が本当に無いとき**だけ

**分からないことは、分からないと言う。**
- 資料に無い事実を創作しない
- 一部しか分からない場合は、**分かることを先に述べてから**、何が欠けているかを述べる
- 質問の前提が資料と食い違う場合は、まず前提の誤りを指摘する

**資料には2つの出所がある。**
- **引き継ぎWiki**（部内限定）… 作業手順・設計の詳細・反省点。中身が濃いのはこちら
- **公式サイト**（一般公開）… 団体紹介・歴代機体・活動報告。対外的な説明はこちら
- 両方に書いてあって食い違う場合は、**引き継ぎWikiを優先**し、食い違い自体も述べる

**情報の古さは「最終更新」で判断しない。**
- **最終更新はページが編集された日**であって、そこに書かれている内容の年代ではない。
  誤字直しやリンク追加でも更新日は今日になる。実測では17%の節で、本文が扱う年代が
  最終更新より2年以上古かった（最終更新2026年・本文は2024年までしか書いていない、など）
- 各資料には「本文の年代」を添えてある。これは**本文中に出てくる西暦と代から機械的に
  拾ったもの**で、内容がいつの話かの手がかりになる。**古さに言及するときはこちらを根拠にする**
- 「本文の年代」が資料に無い（拾えなかった）ときは、**古さについて断定しない**。
  最終更新日を代わりに使ってはいけない
- 本文の年代が今日から2年以上前なら、その旨を一言添える。**何年前かは今日の日付から計算する**
- 代（世代）と西暦の対応は冒頭の基本情報にある。代が分かれば年も分かる

**書き方**
- 必ず日本語で書く。思考の過程は書かず、結論から書く
- 回答の最後に出典を必ず挙げる。形式は
  `- [ページ名](URL)（Wiki / 公式サイト、本文の年代: YYYY年）` の**Markdownリンク**。
  URLは各資料に添えてあるものを使い、書き換えたり推測で作ったりしない
- 本文中にURL（Googleドライブ・ドキュメント・写真など）が書かれていて、
  それが回答に関係するなら**URLをそのまま本文に載せる**。画面側でリンクになる

なお、冒頭には**人が保守している基本情報**と、**どんなページが存在するかの目次**が
出所ごとに載っている。基本情報は資料本文より優先される確定事実として扱うこと。
「どの分野の情報が薄いか」「そのページは存在するか」といった問いには、目次を根拠に答えてよい。

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
            origin = "公式サイト" if page.get("source") == "site" else "Wiki"
            # 年代は拾えないことがある（実測で38%）。空欄を出すとモデルが
            # 「不明」を「古い」と読み替えるので、その場合は項目ごと省く
            era = era_label(self.chunks[cid].get("era"))
            blocks.append(
                f"## {self.chunks[cid]['breadcrumb']}\n"
                f"（出所: {origin} / ページ: {page['title']} / URL: {page['url']} / "
                f"最終更新: {page['last_edited']}{' / 本文の年代: ' + era if era else ''}）\n\n"
                f"{self.chunks[cid]['text']}"
            )
        context = "\n\n---\n\n".join(blocks)

        text = self.llm(
            # 目次を先頭に置く。全体を見渡す問いに答えられるようにするためと、
            # プロンプトキャッシュを効かせるため
            self.toc + "\n\n" + self.ANSWER_PROMPT.format(
                today=date.today().strftime("%Y年%-m月%-d日"),
                context=context,
                question=question,
            ),
            None, 900)
        return Answer(
            question=question,
            text=text if isinstance(text, str) else json.dumps(text, ensure_ascii=False),
            pages=titles,
            chunk_ids=chunk_ids,
            answerable=answerable,
            dropped_titles=dropped,
            context_chars=len(context),
        )
