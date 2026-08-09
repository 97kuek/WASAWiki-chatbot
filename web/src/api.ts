// バックエンドとの通信。SSEでの逐次受信をここに閉じ込める。

export type Source = {
  title: string;
  url: string;
  last_edited: string;
  /** "wiki" = 部内限定の引き継ぎWiki、"site" = 一般公開の公式サイト。
   *  部外に出せる情報かどうかの判断に要るので、出典に必ず出す。 */
  origin?: "wiki" | "site";
};

export type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  status: string;
  retryAt?: string;
  error?: string;
  errorCode?: "daily_quota" | "rate_limit" | "user_daily_limit" | "unavailable";
  streaming: boolean;
  /** どのアシスタントで答えたか。過去の回答でも口調の理由が分かるように残す。
   *  アイコンは持たない（履歴が肥大するため、現在の一覧から引く）。 */
  assistantId?: string;
  assistantName?: string;
};

export type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  pinned?: boolean;
};

/** 指示語を解決するため質問APIへ送る直近の会話。出典や状態は再送しない。 */
export type ConversationContextTurn = Pick<Turn, "question" | "answer">;

/** サーバーから流れてくる進捗イベント。pipeline.Event と対応する。 */
export type Event =
  | { type: "status"; message: string; retry_at?: string }
  | { type: "pages"; pages: Source[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string; code?: "daily_quota" | "rate_limit" | "user_daily_limit" | "unavailable"; retry_at?: string };

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

/** 全員で共有するアシスタント。作成者名は隠さない（誰に聞けばよいか分かるため）。 */
export type Assistant = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  team?: string;
  origin?: "wiki" | "site";
  /** data URI の画像。未設定なら画面側が名前の頭文字で描く。 */
  icon?: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  /** 参照範囲の説明。サーバー側で組み立てた文言をそのまま出す。 */
  scope: string;
  /** 作成者本人か管理者のときだけ true。編集と削除で同じ権限。 */
  canEdit: boolean;
};

/** 参照範囲に使える区分。呼び方はサーバー側が持つ（「空力班」のような
 *  存在しない呼び方を画面で組み立てないため）。 */
export type Team = { value: string; label: string };

export async function listAssistants(): Promise<{ assistants: Assistant[]; teams: Team[] }> {
  const res = await fetch(`${base}/api/assistants`, { credentials: "include" });
  if (!res.ok) throw new Error("アシスタントを読み込めませんでした");
  const body = await res.json() as { assistants?: Assistant[]; teams?: Team[] };
  return { assistants: body.assistants ?? [], teams: body.teams ?? [] };
}

export type AssistantDraft = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  team?: string;
  origin?: "wiki" | "site";
  icon?: string;
};

export async function createAssistant(draft: AssistantDraft): Promise<Assistant> {
  const res = await fetch(`${base}/api/assistants`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "アシスタントを作成できませんでした");
  return body as Assistant;
}

export async function updateAssistant(id: string, draft: AssistantDraft): Promise<Assistant> {
  const res = await fetch(`${base}/api/assistants/${encodeURIComponent(id)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "アシスタントを保存できませんでした");
  return body as Assistant;
}

export async function deleteAssistant(id: string): Promise<void> {
  const res = await fetch(`${base}/api/assistants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "アシスタントを削除できませんでした");
  }
}

export async function listChats(): Promise<Chat[]> {
  const res = await fetch(`${base}/api/chats`, { credentials: "include" });
  if (!res.ok) throw new Error("チャット履歴を読み込めませんでした");
  const body = await res.json() as { chats?: Chat[] };
  return Array.isArray(body.chats) ? body.chats : [];
}

export async function saveChat(chat: Chat): Promise<void> {
  const res = await fetch(`${base}/api/chats/${encodeURIComponent(chat.id)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chat),
  });
  if (!res.ok) throw new Error("チャット履歴を保存できませんでした");
}

export async function deleteChat(chatId: string): Promise<void> {
  const res = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error("チャット履歴を削除できませんでした");
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
  assistantId?: string,
  context: ConversationContextTurn[] = [],
): Promise<void> {
  // 非公開Wikiに関する質問をURLへ載せるとアクセスログに残るため、本文で送る。
  const res = await fetch(`${base}/api/ask`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, assistantId: assistantId ?? "", context }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: "通信に失敗しました", code: undefined }));
    onEvent({
      type: "error",
      message: body.error ?? "通信に失敗しました",
      code: body.code,
      retry_at: body.retry_at,
    });
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
