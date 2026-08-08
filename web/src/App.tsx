import { useEffect, useRef, useState } from "react";
import {
  ask,
  createAssistant,
  deleteAssistant,
  deleteChat,
  listAssistants,
  listChats,
  login,
  logout,
  saveChat,
  session,
  updateAssistant,
  type Assistant,
  type AssistantDraft,
  type Chat,
  type Turn,
} from "./api";
import { AssistantAvatar, DefaultAvatar, toIconDataURL } from "./avatar";
import { Markdown } from "./markdown";

type Announcement = {
  id: string;
  title: string;
  body: string;
  date: string;
};

const MAX_CHATS = 30;
const ANNOUNCEMENT_READ_KEY = "wasa-chat-read-announcements";
const ASSISTANT_KEY = "wasa-chat-assistant";

const emptyDraft: AssistantDraft = { id: "", name: "", description: "", instruction: "" };

/** 名前からIDの候補を作る。日本語名だとほぼ空になるので、そのときは呼び出し側で補う。 */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
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

function clearLegacyChats(username: string) {
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
 * Firestore導入前のsessionStorage履歴を初回ログイン時に移行する。
 * 読み込み時には途中だったストリーミング状態を解除する。
 */
function loadLegacyChats(username: string): Chat[] {
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
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  // 選んだアシスタントは端末に覚える。毎回選び直させると、結局
  // 誰も使わない機能になる（サーバーに持つほどの情報でもない）
  const [assistantId, setAssistantId] = useState(() => localStorage.getItem(ASSISTANT_KEY) ?? "");
  // チャット画面とアシスタント一覧を切り替える。モーダルではなく画面ごと
  // 差し替えるのは、一覧が「選ぶ場所」であって会話の付随物ではないため
  const [view, setView] = useState<"chat" | "assistants">("chat");
  // 一覧の中で作成／編集フォームを開いているか。editing にIDが入れば編集
  const [assistantForm, setAssistantForm] = useState<{ editing: string | null } | null>(null);
  const [assistantDraft, setAssistantDraft] = useState<AssistantDraft>(emptyDraft);
  const [assistantError, setAssistantError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const headerMenus = useRef<HTMLDivElement>(null);
  const historyArea = useRef<HTMLElement>(null);
  const syncedChats = useRef<Map<string, string>>(new Map());

  const activeAssistant = assistants.find((item) => item.id === assistantId);
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const streaming = chats.some((chat) => chat.turns.some((turn) => turn.streaming));
  const unreadCount = announcements.filter((announcement) => !readAnnouncementIds.includes(announcement.id)).length;
  const historySections = groupChats(chats);

  async function restoreHistory(user: string) {
    const legacy = loadLegacyChats(user);
    try {
      const remote = await listChats();
      const merged = new Map(remote.map((chat) => [chat.id, chat]));
      const migrate: Chat[] = [];
      for (const chat of legacy) {
        const saved = merged.get(chat.id);
        if (!saved || chat.updatedAt > saved.updatedAt) {
          merged.set(chat.id, chat);
          migrate.push(chat);
        }
      }
      const restored = Array.from(merged.values())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_CHATS)
        .map((chat) => ({
          ...chat,
          turns: chat.turns.map((turn) => ({ ...turn, status: "", streaming: false })),
        }));
      await Promise.all(migrate.map((chat) => saveChat(chat)));
      clearLegacyChats(user);
      syncedChats.current = new Map(restored.map((chat) => [chat.id, JSON.stringify(chat)]));
      setChats(restored);
      setActiveChatId((current) => current && restored.some((chat) => chat.id === current)
        ? current
        : restored[0]?.id ?? null);
    } catch {
      // 一時的にFirestoreへ接続できない場合も、移行前の現在タブの履歴は失わない。
      syncedChats.current = new Map();
      setChats(legacy);
      setActiveChatId(legacy[0]?.id ?? null);
      setToast("チャット履歴を同期できませんでした");
      window.setTimeout(() => setToast(""), 3000);
    }
  }

  useEffect(() => {
    session().then((current) => {
      setAuthed(current.authenticated);
      setUsername(current.username);
      setRemaining(current.remaining);
      if (current.authenticated) {
        void restoreHistory(current.username);
        void refreshAssistants();
      }
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
      const pending = chats.slice(0, MAX_CHATS).filter((chat) => (
        syncedChats.current.get(chat.id) !== JSON.stringify(chat)
      ));
      void Promise.allSettled(pending.map(async (chat) => {
        await saveChat(chat);
        syncedChats.current.set(chat.id, JSON.stringify(chat));
      })).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          setToast("チャット履歴を同期できませんでした");
          window.setTimeout(() => setToast(""), 3000);
        }
      });
    }, 400);
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
    void restoreHistory(current.username);
    void refreshAssistants();
  }

  async function handleLogout() {
    setNoticeOpen(false);
    setProfileOpen(false);
    await logout();
    setAuthed(false);
    setUsername("");
    syncedChats.current.clear();
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
    setView("chat");
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

  async function handleDeleteChat(chat: Chat) {
    setHistoryMenuId(null);
    if (chat.turns.some((turn) => turn.streaming)) return;
    if (!window.confirm(`「${chat.title}」を削除しますか？`)) return;
    const next = chats.filter((item) => item.id !== chat.id);
    setChats(next);
    syncedChats.current.delete(chat.id);
    if (activeChatId === chat.id) setActiveChatId(next[0]?.id ?? null);
    try {
      await deleteChat(chat.id);
    } catch {
      setToast("チャット履歴を削除できませんでした");
      window.setTimeout(() => setToast(""), 3000);
      void restoreHistory(username);
    }
  }

  async function refreshAssistants() {
    try {
      const { assistants: list, teams: names } = await listAssistants();
      setAssistants(list);
      setTeams(names);
      // 削除済みのIDを選んだままだと、絞り込みが効いているつもりで
      // 効いていない状態になる。存在しなければ汎用へ戻す
      setAssistantId((current) => (list.some((item) => item.id === current) ? current : ""));
    } catch {
      // アシスタントが読めなくても汎用チャットは使えるので、画面は止めない。
      // ただし選択も外す。一覧だけ空にすると、画面は「汎用」と表示しながら
      // 質問には古いIDを送る状態になり、表示と実際の参照範囲が食い違う
      setAssistants([]);
      setAssistantId("");
      localStorage.removeItem(ASSISTANT_KEY);
    }
  }

  function chooseAssistant(id: string) {
    setAssistantId(id);
    localStorage.setItem(ASSISTANT_KEY, id);
    // 選んだらチャットへ戻る。選ぶために開いた画面なので、留まる理由がない
    setAssistantForm(null);
    setView("chat");
  }

  function openAssistants() {
    setAssistantError("");
    setAssistantForm(null);
    setView("assistants");
  }

  function startCreate() {
    setAssistantDraft(emptyDraft);
    setAssistantError("");
    setAssistantForm({ editing: null });
  }

  function startEdit(item: Assistant) {
    setAssistantDraft({
      id: item.id,
      name: item.name,
      description: item.description,
      instruction: item.instruction,
      team: item.team,
      origin: item.origin,
      icon: item.icon,
    });
    setAssistantError("");
    setAssistantForm({ editing: item.id });
  }

  async function handleSubmitAssistant(event: React.FormEvent) {
    event.preventDefault();
    setAssistantError("");
    const editing = assistantForm?.editing ?? null;
    try {
      if (editing) {
        const saved = await updateAssistant(editing, assistantDraft);
        setAssistants((current) => current.map((item) => (item.id === editing ? saved : item)));
        setAssistantForm(null);
        setToast(`「${saved.name}」を保存しました`);
        return;
      }
      const created = await createAssistant({
        ...assistantDraft,
        // 日本語名だとslugがほぼ空になるので、そのときは時刻から作る
        id: assistantDraft.id || slugify(assistantDraft.name) || `assistant-${Date.now().toString(36)}`,
      });
      setAssistants((current) => [...current, created]);
      setAssistantDraft(emptyDraft);
      chooseAssistant(created.id);
      setToast(`「${created.name}」を作成しました`);
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : "保存できませんでした");
    }
  }

  async function handleDeleteAssistant(target: Assistant) {
    if (!window.confirm(`「${target.name}」を削除しますか？元に戻せません。`)) return;
    try {
      await deleteAssistant(target.id);
      setAssistants((current) => current.filter((item) => item.id !== target.id));
      if (assistantId === target.id) chooseAssistant("");
      setToast(`「${target.name}」を削除しました`);
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : "削除できませんでした");
    }
  }

  async function handlePickIcon(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // 同じ画像を選び直せるようにする
    if (!file) return;
    setAssistantError("");
    try {
      setAssistantDraft((d) => ({ ...d, icon: undefined }));
      const icon = await toIconDataURL(file);
      setAssistantDraft((d) => ({ ...d, icon }));
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : "画像を読み込めませんでした");
    }
  }

  /** 他人のアシスタントは編集できない。複製してから直す（編集権の調整を発生させないため）。 */
  function duplicateAssistant(source: Assistant) {
    setAssistantDraft({
      id: "",
      name: `${source.name}のコピー`,
      description: source.description,
      instruction: source.instruction,
      team: source.team,
      origin: source.origin,
      icon: source.icon,
    });
    setAssistantError("");
    setAssistantForm({ editing: null });
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
      // 後から一覧が変わっても、この回答を出したアシスタントを辿れるようにする
      assistantId: activeAssistant?.id,
      assistantName: activeAssistant?.name,
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

    try {
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
      }, undefined, assistantId);
    } catch (error) {
      // fetch自体の失敗やストリームの切断は ask() の中でイベントにならない。
      // ここで拾わないと streaming が立ったままになり、入力欄が永久に
      // disabled のまま、履歴同期も残回数の更新も止まる
      patch((current) => ({
        ...current,
        error: error instanceof Error && error.name === "AbortError"
          ? "送信を中止しました"
          : "通信に失敗しました。接続を確認してもう一度お試しください",
        streaming: false,
        status: "",
        retryAt: undefined,
      }));
    } finally {
      patch((current) => ({ ...current, streaming: false, status: "" }));
      // Gemini側の制限などでサーバーが回数を返却する場合もあるため、推測で1回減らさない。
      try {
        const current = await session();
        setRemaining(current.remaining);
      } catch {
        // 残回数が取れなくても操作は続けられる。次の質問で取り直す
      }
    }
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

        {/* 選択中の名前をここに出す。ヘッダーの表示をやめた分、どのアシスタントで
            答えているかが分かる場所がここだけになるため、入口と現在値を兼ねさせる */}
        <button
          type="button"
          className={`sidebar-assistant ${activeAssistant ? "on" : ""} ${view === "assistants" ? "active" : ""}`}
          onClick={openAssistants}
          aria-current={view === "assistants"}
        >
          {activeAssistant
            ? <AssistantAvatar name={activeAssistant.name} icon={activeAssistant.icon} size={22} />
            : <DefaultAvatar size={22} />}
          <span className="sidebar-assistant-label">アシスタント</span>
          <span className="sidebar-assistant-current">{activeAssistant?.name ?? "汎用"}</span>
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
                        setView("chat");
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
            <h1>{view === "assistants" ? "アシスタント" : activeChat?.title ?? "新しいチャット"}</h1>
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

        {view === "assistants" ? (
          <main className="assistant-page">
            {assistantForm ? (
              <form className="assistant-form" onSubmit={(event) => void handleSubmitAssistant(event)}>
                <header>
                  <h2>{assistantForm.editing ? "アシスタントを編集" : "アシスタントを作る"}</h2>
                  <p className="muted">
                    書けるのは<strong>口調・書き方・参照範囲</strong>だけです。
                    出典の一覧と参照範囲はサーバー側で決まるため、指示では変えられません。
                  </p>
                </header>
                <div className="assistant-identity">
                  <div className="assistant-icon-pick">
                    {/* 画像が無くても頭文字で成立させる。用意しないと見栄えが悪い状態にすると、
                        結局だれもアシスタントを作らなくなる */}
                    <AssistantAvatar name={assistantDraft.name || "?"} icon={assistantDraft.icon} size={72} />
                    <label className="assistant-icon-button">
                      <span>{assistantDraft.icon ? "変更" : "画像を選ぶ"}</span>
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handlePickIcon(event)} />
                    </label>
                    {assistantDraft.icon && (
                      <button type="button" className="linkish" onClick={() => setAssistantDraft((d) => ({ ...d, icon: undefined }))}>
                        画像を外す
                      </button>
                    )}
                  </div>
                  <label>
                    <span>名前</span>
                    <input value={assistantDraft.name} maxLength={40} required
                      onChange={(event) => setAssistantDraft((d) => ({ ...d, name: event.target.value }))} />
                  </label>
                </div>
                <label>
                  <span>説明（一覧に出ます）</span>
                  <input value={assistantDraft.description} maxLength={120}
                    onChange={(event) => setAssistantDraft((d) => ({ ...d, description: event.target.value }))} />
                </label>
                <label>
                  <span>指示（口調・書き方）</span>
                  <textarea value={assistantDraft.instruction} rows={8} maxLength={1500} required
                    placeholder="例: 語尾を「〜しゅよ」にする。一人称は「ぼく」。明るくのんびりした調子で話す。"
                    onChange={(event) => setAssistantDraft((d) => ({ ...d, instruction: event.target.value }))} />
                </label>
                <div className="assistant-scope">
                  <label>
                    <span>参照する出所</span>
                    <select value={assistantDraft.origin ?? ""}
                      onChange={(event) => setAssistantDraft((d) => ({ ...d, origin: (event.target.value || undefined) as AssistantDraft["origin"] }))}>
                      <option value="">すべて</option>
                      <option value="wiki">引き継ぎWikiのみ</option>
                      <option value="site">公式サイトのみ（部外に出せる情報だけ）</option>
                    </select>
                  </label>
                  <label>
                    <span>参照する班</span>
                    <select value={assistantDraft.team ?? ""}
                      onChange={(event) => setAssistantDraft((d) => ({ ...d, team: event.target.value || undefined }))}>
                      <option value="">すべて</option>
                      {teams.map((team) => <option key={team} value={team}>{team}班</option>)}
                    </select>
                  </label>
                </div>
                {assistantError && <p className="assistant-error" role="alert">{assistantError}</p>}
                <div className="assistant-actions">
                  <button type="button" onClick={() => setAssistantForm(null)}>戻る</button>
                  <button type="submit" className="primary" disabled={!assistantDraft.name.trim() || !assistantDraft.instruction.trim()}>
                    {assistantForm.editing ? "保存する" : "作成する"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <header className="assistant-page-head">
                  <div>
                    <h2>アシスタント</h2>
                    <p className="muted">
                      口調や参照範囲を決めた設定です。誰でも作れて、全員が使えます。
                      <strong>出典の一覧と参照範囲はサーバー側で決まるので、どれを選んでも同じ根拠から答えます。</strong>
                    </p>
                  </div>
                  <button type="button" className="primary" onClick={startCreate}>新しく作る</button>
                </header>
                {assistantError && <p className="assistant-error" role="alert">{assistantError}</p>}
                <ul className="assistant-grid">
                  <li>
                    <button type="button" className={`assistant-card ${assistantId === "" ? "on" : ""}`} onClick={() => chooseAssistant("")}>
                      <DefaultAvatar size={64} />
                      <span className="assistant-name">汎用</span>
                      <span className="assistant-desc">資料全体から、ふつうの口調で答えます</span>
                    </button>
                  </li>
                  {assistants.map((item) => (
                    <li key={item.id}>
                      <button type="button" className={`assistant-card ${assistantId === item.id ? "on" : ""}`} onClick={() => chooseAssistant(item.id)}>
                        <AssistantAvatar name={item.name} icon={item.icon} size={64} />
                        <span className="assistant-name">{item.name}</span>
                        {item.description && <span className="assistant-desc">{item.description}</span>}
                        <span className="assistant-meta">
                          {item.author}
                          {item.scope && <><br />{item.scope}</>}
                        </span>
                      </button>
                      <div className="assistant-card-actions">
                        {/* 他人のものは編集ではなく複製。編集権をめぐる調整を起こさないため */}
                        {item.canEdit
                          ? <button type="button" onClick={() => startEdit(item)}>編集</button>
                          : <button type="button" onClick={() => duplicateAssistant(item)}>複製</button>}
                        {item.canEdit && (
                          <button type="button" className="danger" onClick={() => void handleDeleteAssistant(item)}>削除</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </main>
        ) : (
        <>
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
                {/* 誰が答えたかを毎回出す。しゅよっくんに切り替えたのに
                    WASAロゴのままだと、口調が変わった理由が画面から分からない */}
                {turn.assistantName
                  ? <AssistantAvatar name={turn.assistantName} icon={assistants.find((a) => a.id === turn.assistantId)?.icon} size={34} />
                  : <img src="/assets/wasa-logo.jpeg" alt="" className="assistant-avatar" />}
                <div className="assistant-content">
                  <div className="answer-author">{turn.assistantName ?? "WASA Chat"}</div>
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
        </>
        )}
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
