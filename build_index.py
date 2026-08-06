"""dump/pages.jsonl を、検索・回答に使える index.json に変換する。

設計方針は docs/01-設計方針.md §5-1「データ品質」に対応。

主な処理:
  - wikitext を Markdown 寄りに整形（テンプレートが実質ゼロなので直接処理できる）
  - 画像キャプションを本文に残す / 表を Markdown 表に変換
  - 節（中央値191字と細かすぎる）をマージして 800〜2500字のチャンクにする
    ただし **最上位見出しをまたいでマージしない**。またぐとパンくずが嘘になる
  - 全チャンクにパンくず（ページ名 > H2 > H3）を付与。検索精度に最も効く
  - タイトル＋本文から代（世代）を抽出し、根拠の強さを source で区別する
  - 短いページも検索対象に含める（98字の「作業場移転履歴」に答えが完結していた）

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

# 「中身が薄い」ことを目次で示すための閾値。検索対象からは外さない。
# 当初はこの閾値未満を検索対象外にしていたが、98字の「作業場移転履歴」に
# 移転年・移転先・理由が完結して書かれており、答えがあるのに引けなくなっていた。
# 短い＝価値がない、ではない。除外するのは実質的に空のページだけにする。
STUB_CHARS = 120
MIN_INDEX_CHARS = 20  # これ未満は本当に空。チャンクを作らない
CHUNK_TARGET = 1200  # チャンクの目標サイズ
CHUNK_MAX = 2500     # レンダリング後にこれを超えたら分割する
CHUNK_MIN = 200      # これ未満の末尾チャンクは直前に吸収する

# 個人情報のマスキング。氏名・役職・班は「40代の駆動班長は誰か」に答えるため残す。
# 連絡先と生年月日は回答に不要な一方、外部API送信・パスワード漏洩時の露出面になる。
MASK_PII = True
EMAIL = re.compile(r"[\w.+-]+\s*@\s*[\w-]+(?:\.[\w-]+)+")
BIRTHDAY = re.compile(r"\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?\s*生まれ")
PHONE = re.compile(r"(?<![\d-])0\d{1,4}[-‐（(]\d{1,4}[-‐)）]\d{3,4}(?![\d-])")

IMAGE_PREFIX = re.compile(r"^\s*(ファイル|File|画像|Image)\s*:", re.I)
CATEGORY_PREFIX = re.compile(r"^\s*(Category|カテゴリ)\s*:", re.I)
REDIRECT = re.compile(r"^\s*#\s*(REDIRECT|転送)\s*\[\[([^\]|]+)", re.I)

# 画像埋め込みの「キャプションではない」パラメータ
IMAGE_MODIFIERS = re.compile(
    r"^(thumb|thumbnail|frame|frameless|border|right|left|center|none|baseline|"
    r"top|middle|bottom|text-top|text-bottom|sub|super|\d+\s*px|x\d+px|upright.*|"
    r"link=.*|alt=.*|lang=.*|page=.*|class=.*)$",
    re.I,
)

# 班の判定。上から順に当てるので、複合語（駆動・フレーム）を先に置く
TEAM_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("電装", ("電装", "パワーメータ", "ESP32", "RP2040", "マイコン", "7セグ", "回路", "基板")),
    ("駆動・フレーム", ("駆動", "フレーム")),
    ("プロペラ", ("プロペラ", "ペラ", "回転試験")),
    ("フェアリング", ("フェアリング", "COOLTHRUST")),
    ("空力", ("空力", "飛行力学", "抗力", "翼型", "最適化")),
    ("構造", ("構造", "桁", "リブ", "荷重試験", "全組試験", "重心測定")),
    ("翼", ("翼班", "翼")),
    ("パイロット", ("パイロット",)),
    ("TF・大会", ("TF", "テストフライト", "鳥コン", "鳥人間コンテスト", "飛行場",
                  "滑空場", "エアポート", "滑走路", "積み込み", "桟橋", "プラホ")),
    ("運営", ("代表", "広報", "新歓", "理工展", "書類", "作業場", "合宿", "役職",
              "OB", "交流会", "予算", "ホームページ", "アカウント", "記事の作り方", "ゼミ")),
]


# ==========================================================================
# wikitext のクリーニング
# ==========================================================================

def protect(text: str) -> tuple[str, list[str]]:
    """<nowiki>/<pre>/<code> の中身を退避する。

    これをやらないと、中に書かれた [[ や '' が
    後続のマークアップ変換に巻き込まれて壊れる。
    """
    stash: list[str] = []

    def keep(m: re.Match) -> str:
        tag, inner = m.group(1).lower(), m.group(2)
        rendered = inner if tag == "nowiki" else (
            f"\n```\n{inner.strip()}\n```\n" if tag == "pre" else f"`{inner.strip()}`"
        )
        stash.append(rendered)
        return f"\x00{len(stash) - 1}\x00"

    text = re.sub(r"<(nowiki|pre|code)>(.*?)</\1>", keep, text, flags=re.S | re.I)
    return text, stash


def restore(text: str, stash: list[str]) -> str:
    return re.sub(r"\x00(\d+)\x00", lambda m: stash[int(m.group(1))], text)


def bracket_spans(text: str) -> list[tuple[int, int, str]]:
    """[[...]] を入れ子を数えながら走査し、最外側の (開始, 終了, 中身) を返す。

    キャプションの中にリンクが入っている画像（実データに存在する）を
    正規表現で扱うと壊れるため、明示的に対応を取る。
    """
    spans: list[tuple[int, int, str]] = []
    i = 0
    while (start := text.find("[[", i)) != -1:
        depth, j = 0, start
        while j < len(text) - 1:
            if text[j : j + 2] == "[[":
                depth += 1
                j += 2
            elif text[j : j + 2] == "]]":
                depth -= 1
                j += 2
                if depth == 0:
                    spans.append((start, j, text[start + 2 : j - 2]))
                    break
            else:
                j += 1
        else:
            break
        i = j
    return spans


def resolve_brackets(text: str, images: list[dict], links: list[str], cats: list[str]) -> str:
    """[[...]] を画像・カテゴリ・内部リンクに振り分けて平文化する。"""
    out, last = [], 0
    for start, end, inner in bracket_spans(text):
        out.append(text[last:start])
        if IMAGE_PREFIX.match(inner):
            out.append(render_image(inner, images, links, cats))
        elif CATEGORY_PREFIX.match(inner):
            cats.append(inner.split(":", 1)[1].split("|")[0].strip())
        else:
            target, _, display = inner.partition("|")
            target = target.split("#")[0].strip()
            if target:
                links.append(target)
            out.append((display or target).strip())
        last = end
    out.append(text[last:])
    return "".join(out)


def render_image(inner: str, images: list[dict], links: list[str], cats: list[str]) -> str:
    """画像埋め込みからキャプションを取り出す。キャプションは重要な情報なので本文に残す。"""
    body = inner.split(":", 1)[1]
    # キャプション内のリンクを先に潰してから | で割らないと、リンクのパイプで誤分割する
    parts = [p.strip() for p in resolve_brackets(body, images, links, cats).split("|")]
    filename, caption = parts[0], ""
    for part in reversed(parts[1:]):
        if part and not IMAGE_MODIFIERS.match(part):
            caption = part
            break
    images.append({"file": filename, "caption": caption})
    return f"\n［図: {caption or filename}］\n"


def strip_cell_attrs(cell: str) -> str:
    """`style="..." | 中身` の形からセルの中身だけを取り出す。"""
    if "|" in cell and re.match(r'^[a-zA-Z-]+\s*=\s*("|\')', cell):
        cell = cell.split("|", 1)[1]
    return cell.strip().replace("\n", " ")


def convert_tables(text: str) -> str:
    """wikitable を Markdown 表に変換する。ネストは想定しない（実データに存在しない）。

    rowspan / colspan は未対応。セルは結合前の位置にそのまま置かれる。
    """
    out: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith("{|"):
            out.append(lines[i])
            i += 1
            continue

        i += 1
        rows: list[list[str]] = []
        current: list[str] = []
        while i < len(lines) and not lines[i].lstrip().startswith("|}"):
            line = lines[i].strip()
            if line.startswith("|+"):
                out.append(f"**{line[2:].strip()}**")
            elif line.startswith("|-"):
                if current:
                    rows.append(current)
                    current = []
            elif line.startswith("!"):
                current.extend(
                    strip_cell_attrs(c) for c in re.split(r"\s*!!\s*", line.lstrip("!").strip())
                )
            elif line.startswith("|"):
                current.extend(
                    strip_cell_attrs(c) for c in re.split(r"\s*\|\|\s*", line.lstrip("|").strip())
                )
            elif line and current:
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
            out.extend("| " + " | ".join(r) + " |" for r in rows[1:])
            out.append("")
    return "\n".join(out)


def clean(text: str) -> tuple[str, list[dict], list[str], list[str]]:
    """wikitext を Markdown 寄りのプレーンテキストにする。"""
    # マスキングはパース前に行う。後段だと links やキャプションに取り残しが出る
    # （実際 [[Mailto:...]] が内部リンク扱いで links 配列に残った）
    if MASK_PII:
        text = EMAIL.sub("［メールアドレス］", text)
        text = BIRTHDAY.sub("［生年月日］", text)
        text = PHONE.sub("［電話番号］", text)

    text, stash = protect(text)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"\{\{\s*(DISPLAYTITLE|DEFAULTSORT)\s*:[^}]*\}\}", "", text, flags=re.I)
    text = re.sub(r"__[A-Z]+__", "", text)  # __TOC__ などの魔法語

    images: list[dict] = []
    links: list[str] = []
    cats: list[str] = []
    text = resolve_brackets(text, images, links, cats)
    text = convert_tables(text)

    # 外部リンク: [url ラベル] → [ラベル](url) / [url] → url
    text = re.sub(r"\[(https?://\S+)\s+([^\]]+)\]", r"[\2](\1)", text)
    text = re.sub(r"\[(https?://\S+)\]", r"\1", text)

    text = re.sub(r"'''''(.+?)'''''", r"***\1***", text)
    text = re.sub(r"'''(.+?)'''", r"**\1**", text)
    text = re.sub(r"''(.+?)''", r"*\1*", text)

    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</?blockquote[^>]*>", "\n", text, flags=re.I)
    # 残りのタグは中身を残して剥がす（<u> <s> <big> <sup> <sub> <div> ...）
    text = re.sub(r"</?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?/?>", "", text)

    text = restore(text, stash)
    text = re.sub(r"^-{4,}\s*$", "---", text, flags=re.M)
    text = re.sub(r"[ \t]+$", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip(), images, sorted(set(links)), sorted(set(cats))


# ==========================================================================
# 節の分割とチャンク化
# ==========================================================================

HEADING = re.compile(r"^(={2,6})\s*(.+?)\s*\1\s*$", re.M)


def split_sections(text: str) -> list[dict]:
    """本文を節に割り、各節に見出し階層（パンくずの元）を持たせる。"""
    sections: list[dict] = []
    matches = list(HEADING.finditer(text))

    lead = text[: matches[0].start()] if matches else text
    if lead.strip():
        sections.append({"level": 0, "heading": None, "path": [], "body": lead.strip()})

    path: dict[int, str] = {}
    for idx, match in enumerate(matches):
        level = len(match.group(1))
        path = {k: v for k, v in path.items() if k < level}
        path[level] = match.group(2).strip()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        sections.append(
            {
                "level": level,
                "heading": path[level],
                "path": [path[k] for k in sorted(path)],
                "body": text[match.end() : end].strip(),
            }
        )
    return sections


def group_sections(sections: list[dict]) -> list[list[dict]]:
    """最上位見出しごとにまとめ、小さすぎるグループ同士は隣と結合する。

    ページによって最上位が H2 とは限らない（H3 始まりもある）ため、
    そのページに実在する最小レベルを基準にする。

    最上位の境界は「できれば割りたい線」であって絶対ではない。
    厳密に守ると、見出しだけで中身が数行しかない節が大量に独立チャンク化して
    検索のノイズになる。結合してもパンくずは共通接頭辞から作るので嘘にはならない
    （ページ名だけに縮むだけ）。
    """
    levels = [s["level"] for s in sections if s["level"] > 0]
    top = min(levels) if levels else 0

    groups: list[list[dict]] = []
    for sec in sections:
        if sec["level"] <= top or not groups:
            groups.append([sec])
        else:
            groups[-1].append(sec)

    def weight(group: list[dict]) -> int:
        return sum(len(s["body"]) + len(s["heading"] or "") + 8 for s in group)

    merged: list[list[dict]] = []
    for group in groups:
        if merged and weight(merged[-1]) + weight(group) <= CHUNK_TARGET:
            merged[-1].extend(group)
        else:
            merged.append(group)
    return merged


def split_text(body: str, limit: int) -> list[str]:
    """長すぎる本文を、段落 → 行 → 句点 の順で妥協しながら分割する。

    段落（空行）だけを頼りにすると、空行のない長い箇条書きが
    上限を超えたまま残る。実データに存在するので必ず下位の区切りまで落とす。
    """
    def chop(unit: str, sep: str, keep_sep: bool = False) -> list[str]:
        if len(unit) <= limit:
            return [unit]
        parts = unit.split(sep)
        if keep_sep:  # 句点は残さないと文が壊れる
            parts = [p + sep for p in parts[:-1]] + parts[-1:]
        pieces, buf = [], ""
        for part in parts:
            joined = buf + ("" if keep_sep else sep) + part if buf else part
            if buf and len(joined) > limit:
                pieces.append(buf)
                buf = part
            else:
                buf = joined
        if buf:
            pieces.append(buf)
        return pieces

    out: list[str] = []
    for para in chop(body, "\n\n"):
        for line in chop(para, "\n"):
            for sentence in chop(line, "。", keep_sep=True):
                if len(sentence) > limit:
                    # ここまで割ってもなお長い（URLの羅列など）場合は機械的に切る
                    out.extend(sentence[i : i + limit] for i in range(0, len(sentence), limit))
                else:
                    out.append(sentence)
    return [p.strip() for p in out if p.strip()]


def outline(text: str) -> tuple[str, list[str]]:
    """目次用に、リード文と最上位見出しの一覧を取り出す。

    見出し一覧は目次の情報密度を大きく上げる。「駆動・フレーム班」という
    タイトルだけでは中身が分からないが、「40代引き継ぎ / ギア比 / チェーン」
    まで見えれば、どのページを開くべきかLLMが判断できる。
    """
    sections = split_sections(text)
    if not sections:
        return "", []

    levels = [s["level"] for s in sections if s["level"] > 0]
    top = min(levels) if levels else 0
    headings = [s["heading"] for s in sections if s["level"] == top and s["heading"]]

    # リード文は本文の書き出し。表・図・箇条書き記号は目次では邪魔になる
    lines = [
        ln.strip().lstrip("*#:;").strip()
        for ln in sections[0]["body"].split("\n")
        if ln.strip() and not ln.lstrip().startswith(("|", "［図:", "---"))
    ]
    lead = re.sub(r"\s+", " ", " ".join(lines)).strip()
    return lead, headings


def common_prefix(paths: list[list[str]]) -> list[str]:
    """チャンクに含まれる全節に共通する見出し階層。これが正しいパンくずになる。"""
    if not paths:
        return []
    prefix = paths[0]
    for path in paths[1:]:
        prefix = [a for a, b in zip(prefix, path) if a == b]
    return prefix


def render(title: str, sections: list[dict]) -> tuple[str, str]:
    """チャンク本文とパンくずを組み立てる。"""
    breadcrumb = " > ".join([title] + common_prefix([s["path"] for s in sections]))
    lines = [f"［{breadcrumb}］", ""]
    for sec in sections:
        if sec["heading"]:
            lines.append("#" * min(max(sec["level"], 2), 6) + " " + sec["heading"])
        if sec["body"]:
            lines.append(sec["body"])
        lines.append("")
    return "\n".join(lines).strip(), breadcrumb


def build_chunks(page_id: int, title: str, text: str) -> list[dict]:
    chunks: list[dict] = []

    for group in group_sections(split_sections(text)):
        group_chunks: list[dict] = []
        buf: list[dict] = []

        def flush() -> None:
            nonlocal buf
            if not buf:
                return
            body, breadcrumb = render(title, buf)
            if len(body) > CHUNK_MAX:  # レンダリング後に超えていたら割り直す
                head = buf[0]
                for part in split_text(body, CHUNK_MAX):
                    group_chunks.append({"breadcrumb": " > ".join([title] + head["path"]),
                                         "text": part})
            else:
                group_chunks.append({"breadcrumb": breadcrumb, "text": body})
            buf = []

        for sec in group:
            # レンダリング後の長さで判断する（見出し・改行分を無視すると上限を超える）
            cost = len(sec["body"]) + len(sec["heading"] or "") + 8
            if cost > CHUNK_MAX:
                flush()
                for part in split_text(sec["body"], CHUNK_MAX - 200):
                    body, breadcrumb = render(title, [{**sec, "body": part}])
                    group_chunks.append({"breadcrumb": breadcrumb, "text": body})
            elif buf and sum(len(s["body"]) for s in buf) + cost > CHUNK_TARGET:
                flush()
                buf = [sec]
            else:
                buf.append(sec)
        flush()

        # 末尾に取り残された小さすぎるチャンクは直前に吸収する
        if len(group_chunks) >= 2 and len(group_chunks[-1]["text"]) < CHUNK_MIN:
            tail = group_chunks.pop()
            if len(group_chunks[-1]["text"]) + len(tail["text"]) <= CHUNK_MAX:
                group_chunks[-1]["text"] += "\n\n" + tail["text"]
            else:
                group_chunks.append(tail)
        chunks.extend(group_chunks)

    for i, chunk in enumerate(chunks):
        chunk["id"] = f"p{page_id}-c{i}"
        chunk["chars"] = len(chunk["text"])
    return chunks


# ==========================================================================
# メタデータ抽出
# ==========================================================================

GEN_TITLE = [
    re.compile(r"(\d{2})\s*(?:st|nd|rd|th)\b", re.I),
    re.compile(r"(\d{2})\s*代"),
    re.compile(r"^(\d{2})\s"),  # 「40 Kosei Ozaki」のような人物ページ
]
GEN_BODY = re.compile(r"\b(3[0-9]|4[0-9])\s*(?:st|nd|rd|th|代)\b", re.I)


def extract_gen(title: str, body: str) -> dict:
    """代（世代）を抽出する。タイトル由来と本文由来を区別して持つ。

    タイトルに代が入っているのは全117ページ中28ページしかない。
    本文にも当たらないと大半が「不明」になってしまう。ただし本文中の
    「40代では〜だったが」のような言及は、そのページ自体の代とは限らない。
    根拠の強さが違うので source で区別し、フィルタ側で使い分ける。
    """
    normalized = unicodedata.normalize("NFKC", title)
    for pattern in GEN_TITLE:
        if m := pattern.search(normalized):
            return {"gen": int(m.group(1)), "gen_source": "title", "gens_mentioned": []}

    mentioned = Counter(
        int(g) for g in GEN_BODY.findall(unicodedata.normalize("NFKC", body))
    )
    if mentioned:
        return {
            "gen": mentioned.most_common(1)[0][0],
            "gen_source": "body",
            "gens_mentioned": sorted(mentioned),
        }
    return {"gen": None, "gen_source": None, "gens_mentioned": []}


# 「40代」「42nd」「40 Kosei Ozaki」のような、代のまとめページ・人物ページ
GEN_PAGE = re.compile(r"^\d{2}\s*(代|st|nd|rd|th)?(\s|$)")


def extract_team(title: str, body: str) -> str | None:
    """班・カテゴリを推定する。タイトル優先、無ければ本文冒頭で補う。

    代のまとめページ・人物ページを先に弾くのが重要。本文に「空力設計」と
    書かれた名簿ページが空力班に混ざると、班フィルタが信用できなくなる。
    """
    if GEN_PAGE.match(unicodedata.normalize("NFKC", title)):
        return "代まとめ・人物"
    for scope in (title, body[:400]):
        for team, keywords in TEAM_RULES:
            if any(kw in scope for kw in keywords):
                return team
    return None


# ==========================================================================

def main() -> None:
    raw_pages = [json.loads(line) for line in DUMP.open(encoding="utf-8")]
    content = [p for p in raw_pages if p["ns"] == 0]

    # リダイレクトは本文ではなく「別名」。転送先の別名として保持する
    aliases: dict[str, list[str]] = {}
    articles = []
    for raw in content:
        if m := REDIRECT.match(raw["wikitext"]):
            aliases.setdefault(m.group(2).strip(), []).append(raw["title"])
        else:
            articles.append(raw)

    pages: list[dict] = []
    for raw in articles:
        body, images, links, cats = clean(raw["wikitext"])
        is_stub = len(body) < STUB_CHARS
        lead, headings = outline(body)
        pages.append(
            {
                "id": raw["pageid"],
                "title": raw["title"],
                "aliases": aliases.get(raw["title"], []),
                "url": PAGE_URL_BASE + urllib.parse.quote(raw["title"].replace(" ", "_")),
                "revid": raw.get("revid"),
                "last_edited": raw["last_edited"][:10],
                "team": extract_team(raw["title"], body),
                **extract_gen(raw["title"], body),
                "categories": cats,
                "chars": len(body),
                "is_stub": is_stub,
                "lead": lead,
                "headings": headings,
                "images": images,
                "links": links,
                "chunks": (
                    build_chunks(raw["pageid"], raw["title"], body)
                    if len(body) >= MIN_INDEX_CHARS
                    else []
                ),
            }
        )

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"pages": pages}, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- 結果レポート ----
    searchable = [p for p in pages if p["chunks"]]
    chunks = [c for p in pages for c in p["chunks"]]
    sizes = sorted(c["chars"] for c in chunks)
    gens = Counter(p["gen_source"] for p in pages)
    teams = Counter(p["team"] for p in pages)

    print("=" * 58)
    print(f"ページ          : {len(pages)}  （検索対象 {len(searchable)} / スタブ {len(pages) - len(searchable)}）")
    print(f"リダイレクト    : {sum(len(v) for v in aliases.values())} 件を別名として吸収")
    print(f"チャンク総数    : {len(chunks)}")
    print(f"チャンク文字数  : 中央値 {sizes[len(sizes) // 2]} / 最小 {sizes[0]} / 最大 {sizes[-1]}")
    print(f"  上限{CHUNK_MAX}超  : {sum(1 for s in sizes if s > CHUNK_MAX)} 件")
    print(f"  下限{CHUNK_MIN}未満 : {sum(1 for s in sizes if s < CHUNK_MIN)} 件")
    print(f"出力            : {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")

    print(f"\n代の抽出        : タイトル由来 {gens['title']} / 本文由来 {gens['body']} / 不明 {gens[None]}")
    print(f"班の抽出        : 成功 {sum(v for k, v in teams.items() if k)} / 不明 {teams[None]}")
    for team, n in teams.most_common():
        print(f"    {str(team):<16} {n:>3}")

    if unknown := [p["title"] for p in pages if p["gen"] is None and not p["is_stub"]]:
        print(f"\n代が不明な本文ページ（LLM補完の候補 {len(unknown)}件）:\n    {' / '.join(unknown[:20])}")
    print(f"\n画像参照        : {sum(len(p['images']) for p in pages)} 箇所")
    print("=" * 58)


if __name__ == "__main__":
    main()
