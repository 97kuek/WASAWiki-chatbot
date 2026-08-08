/**
 * 回答本文のMarkdownを描画する。
 *
 * 外部ライブラリを使わず自前で持っている理由は安全性である。
 * 生成文にはWiki本文（＝人が書いたHTMLが混ざりうるテキスト）が入る。
 * ライブラリ＋サニタイザの構成は「危険なものを後から除く」形になるが、
 * ここでは **先にすべてエスケープしてから整形する** ので、
 * 生のHTMLが通る経路が構造的に存在しない。
 *
 * 対応する記法は生成文に実際に出るものだけ:
 * 見出し / 箇条書き / 番号付き / 表 / 引用 / 水平線 / 強調 / コード / リンク。
 */

type Inline = { html: string };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** リンク先は http/https だけ許可する（javascript: などを弾く） */
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : null);

function inline(raw: string): Inline {
  let html = escapeHtml(raw);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    const href = safeHref(url);
    return href
      ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
      : label;
  });
  // 素のURLもリンクにする
  html = html.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>',
  );
  return { html };
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const isDivider = (line: string) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim());

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushList = (ordered: boolean) => {
    const tag = ordered ? "ol" : "ul";
    const items: string[] = [];
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    while (i < lines.length) {
      const m = lines[i].match(pattern);
      if (!m) break;
      items.push(`<li>${inline(m[1]).html}</li>`);
      i++;
    }
    out.push(`<${tag}>${items.join("")}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 表: ヘッダ行 + 区切り行 が揃っているときだけ表として扱う
    if (line.trim().startsWith("|") && isDivider(lines[i + 1] ?? "")) {
      const head = cells(line).map((c) => `<th>${inline(c).html}</th>`).join("");
      i += 2;
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c).html}</td>`).join("")}</tr>`);
        i++;
      }
      out.push(
        `<div class="table-scroll"><table><thead><tr>${head}</tr></thead>` +
          `<tbody>${body.join("")}</tbody></table></div>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // 本文中なのでh3始まりにする
      out.push(`<h${level}>${inline(heading[2]).html}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushList(false);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushList(true);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(inline(lines[i].replace(/^>\s?/, "")).html);
        i++;
      }
      out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 段落: 空行までをひとまとまりにする
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("|") &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(inline(lines[i]).html);
      i++;
    }
    out.push(`<p>${para.join("<br>")}</p>`);
  }

  return out.join("");
}

export function Markdown({ text }: { text: string }) {
  // renderMarkdown はエスケープ済みの文字列しか組み立てないため、
  // ここで生HTMLとして差し込んでも外部由来のタグは通らない
  return <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
