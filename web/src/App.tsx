import { useEffect, useRef, useState } from "react";
import { ask, login, logout, session, type Source } from "./api";
import { Markdown } from "./markdown";

type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  status: string;
  retryAt?: string;
  error?: string;
  errorCode?: "daily_quota" | "rate_limit" | "user_daily_limit" | "unavailable";
  streaming: boolean;
};

type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  pinned?: boolean;
};

type Announcement = {
  id: string;
  title: string;
  body: string;
  date: string;
};

const MAX_CHATS = 30;
const ANNOUNCEMENT_READ_KEY = "wasa-chat-read-announcements";
const WIKI_URL = import.meta.env.VITE_WIKI_URL ?? "https://wasabirdman.sakura.ne.jp/wbwiki/w/index.php";

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

type HistorySection = { label: string; chats: Chat[] };

function groupChats(chats: Chat[]): HistorySection[] {
  const ordered = [...chats].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sections = new Map<string, Chat[]>();

  for (const chat of ordered) {
    const updated = new Date(chat.updatedAt);
    let label = "以前";
    if (chat.pinned) {
      label = "ピン留め";
    } else if (!Number.isNaN(updated.getTime())) {
      const day = new Date(updated);
      day.setHours(0, 0, 0, 0);
      const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
      if (daysAgo === 0) label = "今日";
      else if (daysAgo === 1) label = "昨日";
      else if (daysAgo <= 7) label = "過去7日間";
      else label = `${updated.getFullYear()}年${updated.getMonth() + 1}月`;
    }
    const section = sections.get(label) ?? [];
    section.push(chat);
    sections.set(label, section);
  }
  return Array.from(sections, ([label, grouped]) => ({ label, chats: grouped }));
}

function shareText(chat: Chat): string {
  const turns = chat.turns.map((turn) => {
    const sources = turn.sources.length > 0
      ? `\n\n出典:\n${turn.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`
      : "";
    return `質問:\n${turn.question}\n\n回答:\n${turn.answer || turn.error || "回答なし"}${sources}`;
  });
  return `${chat.title}\n\n${turns.join("\n\n---\n\n")}`;
}

function retryLabel(value: string | undefined, now: number): string {
  if (!value) return "";
  const at = new Date(value);
  const milliseconds = at.getTime() - now;
  if (Number.isNaN(at.getTime())) return "";
  if (milliseconds <= 0) return "まもなく再開予定です";
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.ceil(milliseconds / 60_000);
  const duration = seconds < 60
    ? `約${seconds}秒後`
    : minutes < 60
      ? `約${minutes}分後`
    : `約${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ""}後`;
  const clock = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(at);
  return `再開目安: ${duration}（${clock}頃）`;
}

function clearStoredChats(username: string) {
  try {
    sessionStorage.removeItem(storageKey(username));
  } catch {
    // ストレージが無効でも、React上の履歴消去とログアウトは続ける。
  }
}

function loadReadAnnouncementIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANNOUNCEMENT_READ_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
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
        pinned: chat.pinned === true,
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
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [readAnnouncementIds, setReadAnnouncementIds] = useState(loadReadAnnouncementIds);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [historyMenuId, setHistoryMenuId] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(Date.now());
  const bottom = useRef<HTMLDivElement>(null);
  const headerMenus = useRef<HTMLDivElement>(null);
  const historyArea = useRef<HTMLElement>(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const streaming = chats.some((chat) => chat.turns.some((turn) => turn.streaming));
  const unreadCount = announcements.filter((announcement) => !readAnnouncementIds.includes(announcement.id)).length;
  const historySections = groupChats(chats);

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
    fetch("/announcements.json")
      .then((response) => (response.ok ? response.json() : []))
      .then((value: unknown) => {
        if (!Array.isArray(value)) return;
        setAnnouncements(
          value.filter(
            (item): item is Announcement =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as Announcement).id === "string" &&
              typeof (item as Announcement).title === "string" &&
              typeof (item as Announcement).body === "string" &&
              typeof (item as Announcement).date === "string",
          ),
        );
      })
      .catch(() => setAnnouncements([]));
  }, []);

  useEffect(() => {
    if (!noticeOpen && !profileOpen && !historyMenuId && !renamingChatId) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!headerMenus.current?.contains(event.target as Node)) {
        setNoticeOpen(false);
        setProfileOpen(false);
      }
      if (!historyArea.current?.contains(event.target as Node)) setHistoryMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNoticeOpen(false);
        setProfileOpen(false);
        setHistoryMenuId(null);
        setRenamingChatId(null);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [historyMenuId, noticeOpen, profileOpen, renamingChatId]);

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

  useEffect(() => {
    if (!chats.some((chat) => chat.turns.some((turn) => turn.retryAt))) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [chats]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoginError("");
    setBusy(true);
    const error = await login(form.username, form.password);
    setBusy(false);
    // 成否にかかわらず、入力したWikiパスワードは即座に画面から消す。
    setForm((current) => ({ ...current, password: "" }));
    setShowPassword(false);
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
    setNoticeOpen(false);
    setProfileOpen(false);
    await logout();
    clearStoredChats(username);
    setAuthed(false);
    setUsername("");
    setChats([]);
    setActiveChatId(null);
  }

  function handleNoticeToggle() {
    const opening = !noticeOpen;
    setNoticeOpen(opening);
    setProfileOpen(false);
    if (!opening || announcements.length === 0) return;
    const ids = announcements.map((announcement) => announcement.id);
    setReadAnnouncementIds(ids);
    try {
      // お知らせIDだけなので、非公開Wikiの内容を端末へ保存することにはならない。
      localStorage.setItem(ANNOUNCEMENT_READ_KEY, JSON.stringify(ids));
    } catch {
      // 保存できなくても、現在の表示中は既読状態を維持する。
    }
  }

  function handleNewChat() {
    if (streaming) return;
    setActiveChatId(null);
    setQuestion("");
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
  }

  function handleTogglePin(chatId: string) {
    setChats((current) => current.map((chat) => (
      chat.id === chatId ? { ...chat, pinned: !chat.pinned } : chat
    )));
    setHistoryMenuId(null);
  }

  function handleRenameStart(chat: Chat) {
    setRenameTitle(chat.title);
    setRenamingChatId(chat.id);
    setHistoryMenuId(null);
  }

  function handleRenameSubmit(event: React.FormEvent) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!title || !renamingChatId) return;
    setChats((current) => current.map((chat) => (
      chat.id === renamingChatId ? { ...chat, title } : chat
    )));
    setRenamingChatId(null);
  }

  async function handleShare(chat: Chat) {
    setHistoryMenuId(null);
    if (!window.confirm("このチャットには非公開Wikiの内容が含まれる可能性があります。共有してよいですか？")) return;
    const text = shareText(chat);
    if (navigator.share) {
      try {
        await navigator.share({ title: chat.title, text });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setToast("チャットをクリップボードにコピーしました");
      window.setTimeout(() => setToast(""), 3000);
    } catch {
      setToast("共有できませんでした");
      window.setTimeout(() => setToast(""), 3000);
    }
  }

  function handleDeleteChat(chat: Chat) {
    setHistoryMenuId(null);
    if (chat.turns.some((turn) => turn.streaming)) return;
    if (!window.confirm(`「${chat.title}」を削除しますか？`)) return;
    const next = chats.filter((item) => item.id !== chat.id);
    setChats(next);
    if (activeChatId === chat.id) setActiveChatId(next[0]?.id ?? null);
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
          patch((current) => ({ ...current, status: event.message, retryAt: event.retry_at }));
          break;
        case "pages":
          patch((current) => ({ ...current, sources: event.pages }));
          break;
        case "delta":
          patch((current) => ({ ...current, answer: current.answer + event.text, status: "", retryAt: undefined }));
          break;
        case "error":
          patch((current) => ({
            ...current,
            error: event.message,
            errorCode: event.code,
            streaming: false,
            status: "",
            retryAt: event.retry_at,
          }));
          break;
        case "done":
          patch((current) => ({ ...current, streaming: false, status: "", retryAt: undefined }));
          break;
      }
    });
    patch((current) => ({ ...current, streaming: false }));
    // Gemini側の制限などでサーバーが回数を返却する場合もあるため、推測で1回減らさない。
    const current = await session();
    setRemaining(current.remaining);
  }

  if (authed === null) return <div className="center muted">読み込み中…</div>;

  if (!authed) {
    return (
      <div className="center login-page">
        <form className="card gate" onSubmit={handleLogin}>
          <img src="/assets/wasa-logo.jpeg" alt="WASA 鳥人間プロジェクト" className="logo-large" />
          <div className="login-heading">
            <h1>WASA Chat</h1>
            <p className="muted">WASA Wikiと同じ利用者名・パスワードでログイン</p>
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
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.2 3.2M6.2 6.2C4.2 7.6 3 10 3 12c0 0 3.5 7 9 7 1.2 0 2.3-.3 3.3-.7" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                )}
              </button>
            </div>
          </label>
          {loginError && <p className="error" role="alert">{loginError}</p>}
          <button type="submit" disabled={busy || !form.username || !form.password}>
            {busy ? "Wikiで確認中…" : "ログイン"}
          </button>
          <p className="note">パスワードはWikiで本人確認をするためだけに使用します</p>
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
        </div>
        <nav className="history-list" ref={historyArea}>
          {chats.length === 0 ? (
            <p className="history-empty">このタブの履歴はまだありません</p>
          ) : (
            historySections.map((section) => (
              <section className="history-section" key={section.label}>
                <h2>{section.label}</h2>
                {section.chats.map((chat) => (
                  <div className={`history-item ${historyMenuId === chat.id ? "menu-open" : ""}`} key={chat.id}>
                    <button
                      type="button"
                      className={`history-select ${chat.id === activeChatId ? "active" : ""}`}
                      aria-current={chat.id === activeChatId ? "page" : undefined}
                      onClick={() => {
                        setActiveChatId(chat.id);
                        setHistoryMenuId(null);
                        if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
                      }}
                    >
                      <HistoryIcon />
                      <span>{chat.title}</span>
                      {chat.turns.some((turn) => turn.streaming) && <i aria-label="回答中" />}
                    </button>
                    <button
                      type="button"
                      className="history-more"
                      aria-label={`「${chat.title}」のメニュー`}
                      aria-expanded={historyMenuId === chat.id}
                      onClick={() => setHistoryMenuId((current) => current === chat.id ? null : chat.id)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
                      </svg>
                    </button>
                    {historyMenuId === chat.id && (
                      <div className="history-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => handleTogglePin(chat.id)}>
                          {chat.pinned ? "ピン留めを解除" : "ピン留め"}
                        </button>
                        <button type="button" role="menuitem" onClick={() => handleRenameStart(chat)}>タイトル変更</button>
                        <button type="button" role="menuitem" onClick={() => handleShare(chat)} disabled={chat.turns.some((turn) => turn.streaming)}>共有する</button>
                        <button type="button" role="menuitem" className="danger" onClick={() => handleDeleteChat(chat)} disabled={chat.turns.some((turn) => turn.streaming)}>削除</button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
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
          <div className="header-actions" ref={headerMenus}>
            <span className="header-organization">WASA</span>
            <div className="header-menu-wrap">
              <button
                type="button"
                className="header-icon"
                aria-label={`お知らせ${unreadCount > 0 ? `、未読${unreadCount}件` : ""}`}
                aria-expanded={noticeOpen}
                aria-controls="announcement-popover"
                onClick={handleNoticeToggle}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>
                {unreadCount > 0 && <span className="unread-dot" aria-hidden="true" />}
              </button>
              {noticeOpen && (
                <section className="header-popover announcement-popover" id="announcement-popover" aria-label="お知らせ">
                  <h2>お知らせ</h2>
                  {announcements.length === 0 ? (
                    <p className="popover-empty">現在のお知らせはありません</p>
                  ) : (
                    <div className="announcement-list">
                      {announcements.map((announcement) => (
                        <article key={announcement.id}>
                          <time dateTime={announcement.date}>{announcement.date}</time>
                          <h3>{announcement.title}</h3>
                          <p>{announcement.body}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
            <div className="header-menu-wrap">
              <button
                type="button"
                className="profile-avatar"
                aria-label={`利用者メニュー: ${username}`}
                aria-expanded={profileOpen}
                aria-controls="profile-popover"
                onClick={() => {
                  setProfileOpen((open) => !open);
                  setNoticeOpen(false);
                }}
              >
                {Array.from(username)[0] ?? "W"}
              </button>
              {profileOpen && (
                <section className="header-popover profile-popover" id="profile-popover" aria-label="利用者メニュー">
                  <div className="profile-summary">
                    <span>ログイン中</span>
                    <strong>{username}</strong>
                  </div>
                  <a href={WIKI_URL} target="_blank" rel="noreferrer noopener">WASA Wikiを開く</a>
                  <button type="button" onClick={handleLogout}>ログアウト</button>
                </section>
              )}
            </div>
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
                    <div className="status">
                      <span className="dot" />
                      <span>{turn.status}</span>
                      {turn.retryAt && <small>{retryLabel(turn.retryAt, clock)}</small>}
                    </div>
                  )}
                  {turn.answer && (
                    <div>
                      <Markdown text={stripCitation(turn.answer)} />
                      {turn.streaming && <span className="caret" />}
                    </div>
                  )}
                  {turn.error && (turn.errorCode ? (
                    <div className="service-alert" role="alert">
                      <strong>
                        {turn.errorCode === "daily_quota" ? "本日の無料枠を使い切りました" :
                          turn.errorCode === "rate_limit" ? "一時的な利用制限がかかっています" :
                            turn.errorCode === "user_daily_limit" ? "本日の質問上限に達しました" :
                            "Geminiに接続できません"}
                      </strong>
                      <span>{turn.error}</span>
                      {turn.retryAt && <small>{retryLabel(turn.retryAt, clock)}</small>}
                    </div>
                  ) : <div className="error" role="alert">{turn.error}</div>)}

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
            <div className="composer-actions">
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
            </div>
          </form>
          <p className="composer-hint">Enterで送信・Shift + Enterで改行</p>
          <p className="disclaimer">生成AIの回答には誤りが含まれることがあります。</p>
        </div>
      </section>
      {renamingChatId && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRenamingChatId(null);
        }}>
          <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={handleRenameSubmit}>
            <h2 id="rename-title">タイトルを変更</h2>
            <input
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              maxLength={80}
              autoFocus
              aria-label="新しいタイトル"
            />
            <div>
              <button type="button" onClick={() => setRenamingChatId(null)}>キャンセル</button>
              <button type="submit" className="primary" disabled={!renameTitle.trim()}>保存</button>
            </div>
          </form>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
