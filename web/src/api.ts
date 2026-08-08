// バックエンドとの通信。SSEでの逐次受信をここに閉じ込める。

export type Source = {
  title: string;
  url: string;
  last_edited: string;
  /** "wiki" = 部内限定の引き継ぎWiki、"site" = 一般公開の公式サイト。
   *  部外に出せる情報かどうかの判断に要るので、出典に必ず出す。 */
  origin?: "wiki" | "site";
};

/** サーバーから流れてくる進捗イベント。pipeline.Event と対応する。 */
export type Event =
  | { type: "status"; message: string }
  | { type: "pages"; pages: Source[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const base = import.meta.env.VITE_API_ORIGIN ?? "";

export type Session = { authenticated: boolean; username: string; remaining: number };

/**
 * Wikiのアカウントでログインする。
 *
 * パスワードはサーバーがWikiに中継して検証するだけで、保存もログ出力もしない。
 * 成功すると利用者名を載せた署名付きCookieが返る。
 * 失敗理由はサーバーの文言をそのまま出す（Wiki接続失敗と認証失敗を区別するため）。
 */
export async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.error ?? "ログインできませんでした";
}

export async function logout(): Promise<void> {
  await fetch(`${base}/api/logout`, { method: "POST", credentials: "include" });
}

export async function session(): Promise<Session> {
  const res = await fetch(`${base}/api/session`, { credentials: "include" });
  if (!res.ok) return { authenticated: false, username: "", remaining: 0 };
  return res.json();
}

/**
 * 質問を送り、イベントを逐次 onEvent に渡す。
 *
 * EventSource ではなく fetch + ReadableStream を使っているのは、
 * EventSource がエラー時に自動再接続してしまい、LLMの呼び出しが
 * 二重に走る（＝API費用が二重にかかる）ため。
 */
export async function ask(
  question: string,
  onEvent: (event: Event) => void,
  signal?: AbortSignal,
): Promise<void> {
  // 非公開Wikiに関する質問をURLへ載せるとアクセスログに残るため、本文で送る。
  const res = await fetch(`${base}/api/ask`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: "通信に失敗しました" }));
    onEvent({ type: "error", message: body.error ?? "通信に失敗しました" });
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSEのフレームは空行区切り
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame.replace(/^data: /, "").trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as Event);
      } catch {
        // 壊れたフレームは捨てる
      }
    }
  }
}
