// バックエンドとの通信。SSEでの逐次受信をここに閉じ込める。

export type Source = {
  title: string;
  url: string;
  last_edited: string;
};

/** サーバーから流れてくる進捗イベント。pipeline.Event と対応する。 */
export type Event =
  | { type: "status"; message: string }
  | { type: "pages"; pages: Source[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

const base = import.meta.env.VITE_API_ORIGIN ?? "";

export async function login(password: string): Promise<boolean> {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return res.ok;
}

export async function session(): Promise<{ authenticated: boolean; remaining: number }> {
  const res = await fetch(`${base}/api/session`, { credentials: "include" });
  if (!res.ok) return { authenticated: false, remaining: 0 };
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
  const res = await fetch(`${base}/api/ask?q=${encodeURIComponent(question)}`, {
    credentials: "include",
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
