"""dump/pages.jsonl を、検索・回答に使える index.json に変換する。

設計方針は docs/01-設計方針.md §5-1「データ品質」に対応:
  - wikitext を Markdown 寄りに整形（テンプレートが実質ゼロなので直接処理できる）
  - 画像キャプションを本文に残す
  - 表を Markdown 表に変換
  - 節（中央値191字と細かすぎる）を親見出しの下でマージし 800〜2000字のチャンクにする
  - 全チャンクにパンくず（ページ名 > H2 > H3）を付与
  - タイトルから代（世代）・班を機械抽出
  - スタブ（200字未満）を除外

  python build_index.py
出力: data/index.json（Wiki本文を含むため .gitignore 対象）
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.parse
from collections import Counter
from pathlib import Path

DUMP = Path("dump/pages.jsonl")
OUT = Path("data/index.json")
PAGE_URL_BASE = "https://wasabirdman.sakura.ne.jp/wbwiki/w/index.php/"

STUB_CHARS = 200  # これ未満は本文なしとみなす
CHUNK_TARGET = 1200  # チャンクの目標サイズ
CHUNK_MAX = 2500  # これを超える節は段落で分割する

# 画像埋め込みの「キャプションではない」パラメータ
IMAGE_MODIFIERS = re.compile(
    r"^(thumb|thumbnail|frame|frameless|border|right|left|center|none|baseline|"
    r"top|middle|bottom|text-top|text-bottom|sub|super|\d+\s*px|x\d+px|upright.*|link=.*|alt=.*)$",
    re.I,
)

# 班の判定。上から順に当てるので、複合語（駆動・フレーム）を先に置く
TEAM_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("電装", ("電装", "パワーメータ", "ESP32", "RP2040", "マイコン", "7セグ")),
    ("駆動・フレーム", ("駆動", "フレーム")),
    ("プロペラ", ("プロペラ", "ペラ", "回転試験")),
    ("フェアリング", ("フェアリング", "COOLTHRUST")),
    ("空力", ("空力", "飛行力学", "抗力", "最適化")),
    ("構造", ("構造", "桁", "荷重試験", "全組試験", "重心測定")),
    ("翼", ("翼班", "翼")),
    ("パイロット", ("パイロット",)),
    ("TF・大会", ("TF", "鳥コン", "飛行場", "滑空場", "エアポート", "滑走路", "積み込み", "桟橋")),
    ("運営", ("代表", "広報", "新歓", "理工展", "書類", "作業場", "合宿", "役職", "OB", "交流会", "予算")),
]


# --------------------------------------------------------------------------
# wikitext のクリーニング
# --------------------------------------------------------------------------

def convert_tables(text: str) -> str:
    """wikitable を Markdown 表に変換する。ネストは想定しない（実データに存在しない）。"""
    out: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith("{|"):
            out.append(lines[i])
            i += 1
            continue

        # 表の終端まで読む
        i += 1
        rows: list[list[str]] = []
        current: list[str] = []
        has_header = False
        header_len = 0
        while i < len(lines) and not lines[i].lstrip().startswith("|}"):
            line = lines[i].strip()
            if line.startswith("|+"):  # キャプション
                out.append(f"**{line[2:].strip()}**")
            elif line.startswith("|-"):  # 行区切り
                if current:
                    rows.append(current)
                    current = []
            elif line.startswith("!"):  # ヘッダセル
                cells = [c.strip() for c in re.split(r"\s*!!\s*", line.lstrip("!").strip())]
                current.extend(strip_cell_attrs(c) for c in cells)
                if not rows:
                    has_header, header_len = True, len(current)
            elif line.startswith("|"):  # データセル
                cells = [c.strip() for c in re.split(r"\s*\|\|\s*", line.lstrip("|").strip())]
                current.extend(strip_cell_attrs(c) for c in cells)
            elif line and current:  # セルの続き行
                current[-1] += " " + line
            i += 1
        if current:
            rows.append(current)
        i += 1  # |} を飛ばす

        if rows:
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            out.append("| " + " | ".join(rows[0]) + " |")
            out.append("|" + "---|" * width)
            for row in rows[1:]:
                out.append("| " + " | ".join(row) + " |")
            out.append("")
    return "\n".join(out)


def strip_cell_attrs(cell: str) -> str:
    """`style="..." | 中身` の形からセルの中身だけを取り出す。"""
    if "|" in cell and re.match(r'^[a-zA-Z-]+\s*=\s*("|\')', cell):
        cell = cell.split("|", 1)[1]
    return cell.strip().replace("\n", " ")


def extract_images(text: str) -> tuple[str, list[dict]]:
    """画像埋め込みを取り除き、キャプションを本文に残す。"""
    images: list[dict] = []

    def repl(m: re.Match) -> str:
        parts = [p.strip() for p in m.group(2).split("|")]
        filename = parts[0]
        caption = ""
        for part in reversed(parts[1:]):
            if part and not IMAGE_MODIFIERS.match(part):
                caption = part
                break
        images.append({"file": filename, "caption": caption})
        # キャプションは情報を持つので本文に残す（図の存在も明示する）
        return f"\n［図: {caption}］\n" if caption else f"\n［図: {filename}］\n"

    text = re.sub(
        r"\[\[\s*(ファイル|File|画像|Image)\s*:\s*([^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*)\]\]",
        repl,
        text,
        flags=re.I,
    )
    return text, images


def clean(text: str) -> tuple[str, list[dict], list[str]]:
    """wikitext を Markdown 寄りのプレーンテキストにする。"""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"\{\{\s*(DISPLAYTITLE|DEFAULTSORT)\s*:[^}]*\}\}", "", text, flags=re.I)

    text, images = extract_images(text)
    text = convert_tables(text)

    # カテゴリは本文から外す
    text = re.sub(r"\[\[\s*(Category|カテゴリ)\s*:[^\]]*\]\]", "", text, flags=re.I)

    # 内部リンク: [[記事|表示]] → 表示、[[記事]] → 記事。リンク先は関連ページとして退避
    links: list[str] = []

    def link_repl(m: re.Match) -> str:
        target, _, display = m.group(1).partition("|")
        target = target.split("#")[0].strip()
        if target:
            links.append(target)
        return (display or target).strip()

    text = re.sub(r"\[\[([^\[\]]+)\]\]", link_repl, text)

    # 外部リンク: [url ラベル] → [ラベル](url) / [url] → url
    text = re.sub(r"\[(https?://\S+)\s+([^\]]+)\]", r"[\2](\1)", text)
    text = re.sub(r"\[(https?://\S+)\]", r"\1", text)

    text = re.sub(r"'''''(.+?)'''''", r"***\1***", text)
    text = re.sub(r"'''(.+?)'''", r"**\1**", text)
    text = re.sub(r"''(.+?)''", r"*\1*", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</?(div|span|center|font|small|big)[^>]*>", "", text, flags=re.I)
    text = re.sub(r"^-{4,}\s*$", "---", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip(), images, links


# --------------------------------------------------------------------------
# 節の分割とチャンク化
# --------------------------------------------------------------------------

HEADING = re.compile(r"^(={2,6})\s*(.+?)\s*\1\s*$", re.M)


def split_sections(text: str) -> list[dict]:
    """本文を節に割り、各節に見出し階層（パンくずの元）を持たせる。"""
    sections: list[dict] = []
    path: dict[int, str] = {}
    pos = 0
    lead = text[: m.start()] if (m := HEADING.search(text)) else text
    if lead.strip():
        sections.append({"level": 1, "heading": None, "path": [], "body": lead.strip()})

    matches = list(HEADING.finditer(text))
    for idx, match in enumerate(matches):
        level = len(match.group(1))
        heading = match.group(2).strip()
        path = {k: v for k, v in path.items() if k < level}
        path[level] = heading
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip()
        pos = end
        sections.append(
            {
                "level": level,
                "heading": heading,
                "path": [path[k] for k in sorted(path)],
                "body": body,
            }
        )
    return sections


def split_paragraphs(body: str, limit: int) -> list[str]:
    """大きすぎる節を段落境界で割る。"""
    parts, buf = [], ""
    for para in body.split("\n\n"):
        if buf and len(buf) + len(para) > limit:
            parts.append(buf.strip())
            buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf.strip():
        parts.append(buf.strip())
    return parts


def render(title: str, sections: list[dict]) -> tuple[str, str]:
    """チャンク本文とパンくずを組み立てる。パンくずは検索精度に最も効くので必ず付ける。"""
    first = sections[0]
    breadcrumb = " > ".join([title] + first["path"])
    lines = [f"［{breadcrumb}］", ""]
    for sec in sections:
        if sec["heading"]:
            lines.append("#" * min(sec["level"], 6) + " " + sec["heading"])
        lines.append(sec["body"])
        lines.append("")
    return "\n".join(lines).strip(), breadcrumb


def build_chunks(page_id: int, title: str, text: str) -> list[dict]:
    sections = split_sections(text)
    chunks: list[dict] = []
    buf: list[dict] = []
    buf_len = 0

    def flush() -> None:
        nonlocal buf, buf_len
        if not buf:
            return
        body, breadcrumb = render(title, buf)
        chunks.append({"breadcrumb": breadcrumb, "text": body})
        buf, buf_len = [], 0

    for sec in sections:
        size = len(sec["body"])
        if size > CHUNK_MAX:
            flush()
            for part in split_paragraphs(sec["body"], CHUNK_MAX):
                body, breadcrumb = render(title, [{**sec, "body": part}])
                chunks.append({"breadcrumb": breadcrumb, "text": body})
        elif buf and buf_len + size > CHUNK_TARGET:
            flush()
            buf, buf_len = [sec], size
        else:
            buf.append(sec)
            buf_len += size
    flush()

    for i, chunk in enumerate(chunks):
        chunk["id"] = f"p{page_id}-c{i}"
        chunk["chars"] = len(chunk["text"])
    return chunks


# --------------------------------------------------------------------------
# メタデータ抽出
# --------------------------------------------------------------------------

def extract_gen(title: str) -> int | None:
    """代（世代）をタイトルから取る。全角括弧・「代」表記・序数表記に対応。"""
    normalized = unicodedata.normalize("NFKC", title)
    if m := re.search(r"(\d{2})\s*(?:st|nd|rd|th)\b", normalized, re.I):
        return int(m.group(1))
    if m := re.search(r"(\d{2})\s*代", normalized):
        return int(m.group(1))
    if m := re.match(r"^(\d{2})\s", normalized):  # 「40 Kosei Ozaki」のような人物ページ
        return int(m.group(1))
    return None


def extract_team(title: str, body: str) -> str | None:
    """班・カテゴリを推定する。タイトル優先、無ければ本文冒頭で補う。"""
    for scope in (title, body[:400]):
        for team, keywords in TEAM_RULES:
            if any(kw in scope for kw in keywords):
                return team
    return None


# --------------------------------------------------------------------------

def main() -> None:
    pages_raw = [json.loads(line) for line in DUMP.open(encoding="utf-8")]
    content = [p for p in pages_raw if p["ns"] == 0]

    pages: list[dict] = []
    stubs: list[str] = []
    for raw in content:
        body, images, links = clean(raw["wikitext"])
        if len(body) < STUB_CHARS:
            stubs.append(raw["title"])
            continue
        pages.append(
            {
                "id": raw["pageid"],
                "title": raw["title"],
                "url": PAGE_URL_BASE + urllib.parse.quote(raw["title"].replace(" ", "_")),
                "gen": extract_gen(raw["title"]),
                "team": extract_team(raw["title"], body),
                "last_edited": raw["last_edited"][:10],
                "chars": len(body),
                "images": images,
                "links": sorted(set(links)),
                "chunks": build_chunks(raw["pageid"], raw["title"], body),
            }
        )

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        json.dumps({"pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    # ---- 結果レポート ----
    chunks = [c for p in pages for c in p["chunks"]]
    sizes = sorted(c["chars"] for c in chunks)
    print("=" * 56)
    print(f"採用ページ      : {len(pages)}  （スタブ除外 {len(stubs)}）")
    print(f"チャンク総数    : {len(chunks)}")
    print(f"チャンク文字数  : 中央値 {sizes[len(sizes) // 2]} / 最小 {sizes[0]} / 最大 {sizes[-1]}")
    print(f"出力            : {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")

    gens = Counter(p["gen"] for p in pages)
    teams = Counter(p["team"] for p in pages)
    print(f"\n代の抽出        : 成功 {sum(v for k, v in gens.items() if k)} / 不明 {gens[None]}")
    print("   ", {k: v for k, v in sorted(gens.items(), key=lambda kv: (kv[0] is None, kv[0]))})
    print(f"\n班の抽出        : 成功 {sum(v for k, v in teams.items() if k)} / 不明 {teams[None]}")
    for team, n in teams.most_common():
        print(f"    {str(team):<16} {n:>3}")

    unlabeled = [p["title"] for p in pages if p["team"] is None]
    if unlabeled:
        print(f"\n班が不明なページ（LLMでの補完候補）:\n    {' / '.join(unlabeled)}")
    print(f"\n画像参照        : {sum(len(p['images']) for p in pages)} 箇所")
    print("=" * 56)


if __name__ == "__main__":
    main()
