import { useEffect, useRef, useState } from "react";
import { ask, login, logout, session, type Source } from "./api";
import { Markdown } from "./markdown";

type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  status: string;
  error?: string;
  streaming: boolean;
};

type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
};

const MAX_CHATS = 30;
const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL ?? "https://wasa-birdman.com/";

/**
 * 回答末尾の「出典: ページ名（最終更新: YYYY-MM）」を落とす。
 * 同じ情報を構造化された出典カードでも表示するため、本文との重複だけを除く。
 */
function stripCitation(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*(\*\*)?出典[:：]/.test(line));
  if (start === -1) return text.trim();
  const notes = lines.slice(start).filter((line) => /^\s*[※注]/.test(line));
  return [...lines.slice(0, start), ...notes].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 新入生や代替わり直後でも質問を始められるよう、具体的な入口を用意する。 */
const SUGGESTIONS: { title: string; body: string }[] = [
  { title: "空力設計の手順", body: "空力設計の設計手順について、詳しく分かりやすく説明してください" },
  { title: "荷重試験の申請", body: "荷重試験の申請方法を教えてください。申請先のメールアドレスも知りたいです" },
  { title: "鳥コンまでの流れ", body: "鳥人間コンテストまでにやっておくべきことを教えてください" },
  { title: "代ごとの違い", body: "空力設計は38代から41代にかけて何が変化しましたか？" },
  { title: "テストフライト", body: "テストフライトの申請方法と、TF前日までにやるべきことを教えてください" },
  // 公式サイト側にしかない情報。Wikiだけでは答えられない問いも入口に置く。
  { title: "WASAの成り立ち", body: "WASAはどんなサークルですか？設立年や歴代の機体名も教えてください" },
];

const storageKey = (username: string) => `wasa-chat-history:${encodeURIComponent(username)}`;
const makeId = () => crypto.randomUUID();
const chatTitle = (question: string) =>
  Array.from(question.trim()).slice(0, 28).join("") + (Array.from(question.trim()).length > 28 ? "…" : "");

function clearStoredChats(username: string) {
  try {
    sessionStorage.removeItem(storageKey(username));
  } catch {
    // ストレージが無効でも、React上の履歴消去とログアウトは続ける。
  }
}

/**
 * 非公開Wikiの内容を端末へ恒久保存しないよう、履歴は現在のタブだけに置く。
 * 読み込み時には途中だったストリーミング状態を解除し、再送信と誤認させない。
 */
function loadChats(username: string): Chat[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey(username)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (chat): chat is Chat =>
          typeof chat === "object" &&
          chat !== null &&
          typeof (chat as Chat).id === "string" &&
          typeof (chat as Chat).title === "string" &&
          Array.isArray((chat as Chat).turns),
      )
      .slice(0, MAX_CHATS)
      .map((chat) => ({
        ...chat,
        turns: chat.turns.map((turn) => ({ ...turn, status: "", streaming: false })),
      }));
  } catch {
    return [];
  }
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h16v11H8l-4 3v-14Z" />
    </svg>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [form, setForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  const bottom = useRef<HTMLDivElement>(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const streaming = chats.some((chat) => chat.turns.some((turn) => turn.streaming));

  function restoreHistory(user: string) {
    const saved = loadChats(user);
    setChats(saved);
    setActiveChatId(saved[0]?.id ?? null);
  }

  useEffect(() => {
    session().then((current) => {
      setAuthed(current.authenticated);
      setUsername(current.username);
      setRemaining(current.remaining);
      if (current.authenticated) restoreHistory(current.username);
    });
  }, []);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 901px)");
    const followViewport = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    wide.addEventListener("change", followViewport);
    return () => wide.removeEventListener("change", followViewport);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeChat?.turns]);

  useEffect(() => {
    if (!authed || !username || streaming) return;
    const timer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(storageKey(username), JSON.stringify(chats.slice(0, MAX_CHATS)));
      } catch {
        // ブラウザ設定でストレージが無効でも、現在の画面内では会話を続けられる。
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [authed, chats, streaming, username]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoginError("");
    setBusy(true);
    const error = await login(form.username, form.password);
    setBusy(false);
    // 成否にかかわらず、入力したWikiパスワードは即座に画面から消す。
    setForm((current) => ({ ...current, password: "" }));
    if (error) {
      setLoginError(error);
      return;
    }
    const current = await session();
    setAuthed(true);
    setUsername(current.username);
    setRemaining(current.remaining);
    restoreHistory(current.username);
  }

  async function handleLogout() {
    await logout();
    clearStoredChats(username);
    setAuthed(false);
    setUsername("");
    setChats([]);
    setActiveChatId(null);
  }

  function handleNewChat() {
    if (streaming) return;
    setActiveChatId(null);
    setQuestion("");
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
  }

  function handleClearHistory() {
    if (streaming || !window.confirm("このタブのチャット履歴をすべて削除しますか？")) return;
    clearStoredChats(username);
    setChats([]);
    setActiveChatId(null);
  }

  async function handleAsk(text: string) {
    const q = text.trim();
    if (!q || streaming) return;
    setQuestion("");

    const now = new Date().toISOString();
    const chatId = activeChat?.id ?? makeId();
    const turnIndex = activeChat?.turns.length ?? 0;
    const turn: Turn = {
      question: q,
      answer: "",
      sources: [],
      status: "送信中",
      streaming: true,
    };

    // 送信した瞬間に質問の吹き出しを出し、過去の会話への追質問なら履歴の先頭へ戻す。
    setChats((current) => {
      const existing = current.find((chat) => chat.id === chatId);
      const updated: Chat = existing
        ? { ...existing, updatedAt: now, turns: [...existing.turns, turn] }
        : {
            id: chatId,
            title: chatTitle(q),
            createdAt: now,
            updatedAt: now,
            turns: [turn],
          };
      return [updated, ...current.filter((chat) => chat.id !== chatId)].slice(0, MAX_CHATS);
    });
    setActiveChatId(chatId);

    const patch = (update: (turn: Turn) => Turn) =>
      setChats((current) =>
        current.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                turns: chat.turns.map((item, index) => (index === turnIndex ? update(item) : item)),
              }
            : chat,
        ),
      );

    await ask(q, (event) => {
      switch (event.type) {
        case "status":
          patch((current) => ({ ...current, status: event.message }));
          break;
        case "pages":
          patch((current) => ({ ...current, sources: event.pages }));
          break;
        case "delta":
          patch((current) => ({ ...current, answer: current.answer + event.text, status: "" }));
          break;
        case "error":
          patch((current) => ({ ...current, error: event.message, streaming: false, status: "" }));
          break;
        case "done":
          patch((current) => ({ ...current, streaming: false, status: "" }));
          break;
      }
    });
    patch((current) => ({ ...current, streaming: false }));
    setRemaining((count) => Math.max(0, count - 1));
  }

  if (authed === null) return <div className="center muted">読み込み中…</div>;

  if (!authed) {
    return (
      <div className="center login-page">
        <form className="card gate" onSubmit={handleLogin}>
          <img src="/assets/wasa-logo.jpeg" alt="WASA 鳥人間プロジェクト" className="logo-large" />
          <div className="login-heading">
            <p className="eyebrow">WASA 鳥人間プロジェクト</p>
            <h1>WASA Chat</h1>
            <p className="muted">WASA Wiki と同じ利用者名・パスワードでログインしてください。</p>
          </div>
          <label>
            <span>利用者名</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              autoFocus
            />
          </label>
          <label>
            <span>パスワード</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </label>
          {loginError && <p className="error" role="alert">{loginError}</p>}
          <button type="submit" disabled={busy || !form.username || !form.password}>
            {busy ? "Wikiで確認中…" : "ログイン"}
          </button>
          <p className="note">パスワードはWikiで本人確認するためだけに使い、保存やログ出力はしません。</p>
        </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="history-panel" aria-label="チャット履歴" aria-hidden={!sidebarOpen}>
        <div className="brand-row">
          <div className="brand">
            <img src="/assets/wasa-logo.jpeg" alt="" className="logo" />
            <span>WASA Chat</span>
          </div>
          <button type="button" className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="履歴を閉じる">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          </button>
        </div>

        <button type="button" className="new-chat" onClick={handleNewChat} disabled={streaming}>
          <span aria-hidden="true">＋</span> 新しいチャット
        </button>

        <div className="history-heading">
          <span>チャット履歴</span>
          {chats.length > 0 && (
            <button type="button" onClick={handleClearHistory} disabled={streaming}>すべて削除</button>
          )}
        </div>
        <nav className="history-list">
          {chats.length === 0 ? (
            <p className="history-empty">このタブの履歴はまだありません</p>
          ) : (
            chats.map((chat) => (
              <button
                type="button"
                key={chat.id}
                className={chat.id === activeChatId ? "active" : ""}
                aria-current={chat.id === activeChatId ? "page" : undefined}
                onClick={() => {
                  setActiveChatId(chat.id);
                  if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
                }}
              >
                <HistoryIcon />
                <span>{chat.title}</span>
                {chat.turns.some((turn) => turn.streaming) && <i aria-label="回答中" />}
              </button>
            ))
          )}
        </nav>

        <div className="account-card">
          <div>
            <span className="account-name">{username}</span>
            <span>本日はあと{remaining}回</span>
          </div>
          <button type="button" className="linkish" onClick={handleLogout}>ログアウト</button>
        </div>
      </aside>
      {sidebarOpen && (
        <button type="button" className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="履歴を閉じる" />
      )}

      <section className="chat-panel">
        <header className="chat-header">
          <div className="header-title">
            <button type="button" className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="チャット履歴を開く" aria-expanded={sidebarOpen}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <div>
              <span className="header-kicker">WASA Chat</span>
              <h1>{activeChat?.title ?? "新しいチャット"}</h1>
            </div>
          </div>
          <div className="header-actions">
            <a className="support-link" href={SUPPORT_URL} target="_blank" rel="noreferrer noopener">
              <span className="help-icon" aria-hidden="true">?</span>
              <span>サポートサイト</span>
            </a>
            <span className="header-organization">WASA</span>
            <button type="button" className="header-icon" aria-label="通知" title="通知はありません" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>
            </button>
            <span className="profile-avatar" title={username} aria-label={`利用者: ${username}`}>
              {Array.from(username)[0] ?? "W"}
            </span>
          </div>
        </header>

        <main className="conversation" aria-live="polite">
          {!activeChat && (
            <div className="intro">
              <img src="/assets/wasa-logo.jpeg" alt="" className="logo-large" />
              <h2>引き継ぎ資料を、会話で探す</h2>
              <p className="muted">
                部内Wikiと公式サイトを横断して回答し、参照した資料を示します。
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion.title}
                    className="suggestion"
                    onClick={() => handleAsk(suggestion.body)}
                  >
                    <span className="suggestion-title">{suggestion.title}</span>
                    <span className="suggestion-body">{suggestion.body}</span>
                    <span className="suggestion-arrow" aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeChat?.turns.map((turn, index) => (
            <article key={index} className="turn">
              <div className="user-row">
                <div className="question">{turn.question}</div>
              </div>

              <div className="assistant-row">
                <img src="/assets/wasa-logo.jpeg" alt="" className="assistant-avatar" />
                <div className="assistant-content">
                  {turn.status && (
                    <div className="status"><span className="dot" />{turn.status}</div>
                  )}
                  {turn.answer && (
                    <div>
                      <Markdown text={stripCitation(turn.answer)} />
                      {turn.streaming && <span className="caret" />}
                    </div>
                  )}
                  {turn.error && <div className="error" role="alert">{turn.error}</div>}

                  {turn.sources.length > 0 && (
                    <section className="sources">
                      <h2>{turn.streaming ? "参照中の資料" : "出典"}</h2>
                      <ul>
                        {turn.sources.map((source) => (
                          <li key={source.url}>
                            <a href={source.url} target="_blank" rel="noreferrer noopener">
                              <span className={`source-origin ${source.origin === "site" ? "public" : ""}`}>
                                {source.origin === "site" ? "公式サイト" : "Wiki"}
                              </span>
                              <span className="source-title">{source.title}</span>
                              <span className="source-meta">最終更新 {source.last_edited}</span>
                              <span className="source-arrow" aria-hidden="true">↗</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              </div>
            </article>
          ))}
          <div ref={bottom} />
        </main>

        <div className="composer-area">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              handleAsk(question);
            }}
          >
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleAsk(question);
                }
              }}
              aria-label="質問"
              placeholder="引き継ぎ資料について質問する"
              maxLength={500}
              rows={1}
              disabled={streaming}
            />
            <button
              type="submit"
              className="send"
              aria-label="送信"
              title="送信"
              disabled={!question.trim() || streaming}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m4 12 16-8-5.5 16-3-6.5L4 12Zm7.5 1.5L20 4" />
              </svg>
            </button>
          </form>
          <p className="composer-hint">Enterで送信・Shift + Enterで改行</p>
          <p className="disclaimer">生成AIの回答には誤りが含まれることがあります。重要な判断の前に出典をご確認ください。</p>
        </div>
      </section>
    </div>
  );
}
