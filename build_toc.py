"""data/index.json から、常時コンテキストに載せる目次を生成する。

設計方針 docs/01-設計方針.md §2 の L1（目次層）にあたる。
114ページという規模だからこそ、Wiki全体の見取り図をコンテキストに置ける。
Claudeは常に「どこに何があるか」を把握した状態で、必要なページだけを取りに行く。

情報密度で効いているのは **見出し一覧** である。「駆動・フレーム班」という
タイトルだけでは中身が分からないが、「40代引き継ぎ / ギア比 / チェーン」まで
見えれば、開くべきページかどうかを判断できる。要約LLMを呼ばなくても、
Wikiが持っている構造をそのまま使えばよい。

  python build_toc.py
出力: data/toc.md（Wiki本文を含むため .gitignore 対象）
"""

from __future__ import annotations

import json
from pathlib import Path

INDEX = Path("data/index.json")
OUT = Path("data/toc.md")

LEAD_CHARS = 90  # リード文の長さ。目次全体のサイズはほぼここで決まる
MAX_HEADINGS = 10  # 1ページあたりに載せる見出しの数

# 班の並び順。技術班を先、運営系を後ろに置く
TEAM_ORDER = [
    "空力", "構造", "翼", "駆動・フレーム", "プロペラ", "フェアリング",
    "電装", "パイロット", "TF・大会", "運営", "代まとめ・人物", None,
]


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def render_page(page: dict) -> list[str]:
    tags = []
    if page["gen"]:
        # 本文由来の代は推定でしかないので「?」で区別する（タイトル由来は確定）
        tags.append(f"{page['gen']}代" + ("?" if page["gen_source"] == "body" else ""))
    tags.append(page["last_edited"][:7])
    if page["is_stub"]:
        tags.append("中身なし")
    else:
        tags.append(f"{page['chars'] // 1000}k字" if page["chars"] >= 1000 else f"{page['chars']}字")

    title = page["title"]
    if page["aliases"]:
        title += "（別名: " + "、".join(page["aliases"]) + "）"

    lines = [f"- **{title}** [{' | '.join(tags)}] {clip(page['lead'], LEAD_CHARS)}"]
    if page["headings"]:
        shown = page["headings"][:MAX_HEADINGS]
        more = len(page["headings"]) - len(shown)
        lines.append("  節: " + " / ".join(shown) + (f" ほか{more}件" if more else ""))
    return lines


def main() -> None:
    pages = json.loads(INDEX.read_text(encoding="utf-8"))["pages"]

    order = {team: i for i, team in enumerate(TEAM_ORDER)}
    pages.sort(
        key=lambda p: (
            order.get(p["team"], len(TEAM_ORDER)),
            -(p["gen"] or 0),  # 新しい代を上に
            p["title"],
        )
    )

    lines = [
        "# WASA Wiki 目次",
        "",
        f"全{len(pages)}ページ。「中身なし」はページは存在するが本文がほぼ無いもの。",
        "代の「?」は本文からの推定で、そのページ自体の代とは限らない。",
        "",
    ]
    current_team = object()
    for page in pages:
        if page["team"] != current_team:
            current_team = page["team"]
            lines += ["", f"## {current_team or 'その他'}", ""]
        lines += render_page(page)

    toc = "\n".join(lines) + "\n"
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(toc, encoding="utf-8")

    # ---- サイズ報告 ----
    # 日本語はおおむね 1〜1.5 字/トークン。正確な値は API の count_tokens で測る
    chars = len(toc)
    print("=" * 56)
    print(f"目次を生成      : {OUT}")
    print(f"ページ数        : {len(pages)}")
    print(f"文字数          : {chars:,} 字")
    print(f"推定トークン数  : {int(chars / 1.5):,} 〜 {chars:,}")
    print(f"1ページあたり   : {chars // len(pages)} 字")

    # プロンプトキャッシュに載る前提での概算（Sonnet 5 / 1時間TTL、$1=150円）
    tokens = chars  # 上振れ側で見積もる
    print(f"\nキャッシュ書込  : 約 ¥{tokens / 1_000_000 * 2 * 2 * 150:.0f}（1時間ごと）")
    print(f"キャッシュ読出  : 約 ¥{tokens / 1_000_000 * 0.2 * 150:.1f} / 質問")
    print("=" * 56)


if __name__ == "__main__":
    main()
