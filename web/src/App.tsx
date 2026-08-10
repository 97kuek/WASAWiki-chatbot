import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ask,
  createAssistant,
  deleteAssistant,
  deleteChat,
  listAssistants,
  listChats,
  listFeedback,
  login,
  logout,
  saveChat,
  session,
  submitFeedback,
  updateAssistant,
  type Assistant,
  type AssistantDraft,
  type Chat,
  type Feedback,
  type FeedbackReason,
  type ResponseMode,
  type StageTimingName,
  type Team,
  type Turn,
} from "./api";
import { stripCitation } from "./answer";
import { ACCEPTED_IMAGE_TYPES, toAttachment, type Attachment } from "./attachment";
import { AssistantAvatar, DefaultAvatar, toIconDataURL, type IconCropPosition } from "./avatar";
import { SelectMenu, type SelectOption } from "./SelectMenu";
import {
  AnswerFeedback,
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_SOURCE_MAX,
  FeedbackPopover,
  feedbackNotificationMessage,
} from "./feedback";

// KaTeXは初期JSの大半を占めるが、回答が表示されるまでは不要である。
// 質問送信時に先読みし、ログイン画面の初期表示と回答開始時の待ち時間を両立する。
const loadMarkdownModule = () => import("./markdown");

const CHUNK_RELOAD_KEY = "wasa-chat-chunk-reload";
const readFlag = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // プライベートモードなどで読めなくても動作は続ける
  }
};
const writeFlag = (key: string, value: string | null) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* 保存できなくてもよい。1回だけ再読み込みする保険が効かなくなるだけ */
  }
};

const Markdown = lazy(async () => {
  try {
    const module = await loadMarkdownModule();
    writeFlag(CHUNK_RELOAD_KEY, null);
    return { default: module.Markdown };
  } catch (error) {
    // デプロイすると配信物のファイル名（ハッシュ）が変わり、開いたままのタブが
    // 参照している旧ファイルは消える。そのまま失敗させると lazy が描画中に
    // 例外を投げ、画面が真っ白になる（2026-08-09に本番で報告あり）。
    // 新しい配信物を取り直せば直るので、1回だけ再読み込みする。
    // 印を残すのは、取得そのものが壊れているときに再読み込みを繰り返さないため。
    if (!readFlag(CHUNK_RELOAD_KEY)) {
      writeFlag(CHUNK_RELOAD_KEY, "1");
      location.reload();
      await new Promise<never>(() => {}); // 再読み込みするので解決させない
    }
    throw error;
  }
});

type Announcement = {
  id: string;
  title: string;
  body: string;
  date: string;
};

const MAX_CHATS = 30;
const CHAT_TITLE_RUNES = 28;
const RECENT_HISTORY_DAYS = 7;
const CONVERSATION_CONTEXT_TURNS = 2;
const CONVERSATION_ANSWER_RUNES = 2_000;
const ASSISTANT_ID_MAX = 64;
const ANNOUNCEMENT_READ_KEY = "wasa-chat-read-announcements";
const ASSISTANT_KEY = "wasa-chat-assistant";
const ASSISTANT_FAVORITES_KEY = "wasa-chat-assistant-favorites";
const ASSISTANT_SORT_KEY = "wasa-chat-assistant-sort";
const RESPONSE_MODE_KEY = "wasa-chat-response-mode";
const TOAST_DURATION_MS = 3000;
const CENTER_ICON_POSITION: IconCropPosition = { x: 50, y: 50 };

type AssistantSort = "favorite" | "name" | "author";

const ORIGIN_OPTIONS: SelectOption[] = [
  { value: "", label: "すべて" },
  { value: "wiki", label: "引き継ぎWikiのみ" },
  { value: "site", label: "公式サイトのみ（部外に出せる情報だけ）" },
];

const ASSISTANT_SORT_OPTIONS: SelectOption[] = [
  { value: "favorite", label: "お気に入り順" },
  { value: "name", label: "名前順" },
  { value: "author", label: "作成者順" },
];

const RESPONSE_MODE_OPTIONS: SelectOption[] = [
  { value: "auto", label: "auto", description: "質問に合わせて自動調整" },
  { value: "deep", label: "thinking", description: "比較や変遷を時間をかけて整理" },
];

// 画面に出るのは auto と thinking だけ。fast / standard は自動判定の内部段階で、
// 通常画面には出さない（履歴の表示に使う保険として名前だけ持つ）。
const RESPONSE_MODE_LABELS: Record<ResponseMode, string> = {
  auto: "auto",
  fast: "fast",
  standard: "standard",
  deep: "thinking",
};

function loadResponseMode(): "auto" | "deep" {
  const saved = localStorage.getItem(RESPONSE_MODE_KEY);
  // 旧画面の高速・標準は内部の自動判定へ戻す。利用者に速度の細分を求めない。
  return saved === "deep" ? "deep" : "auto";
}

const emptyDraft: AssistantDraft = { id: "", name: "", description: "", instruction: "" };

/** 名前からIDの候補を作る。日本語名だとほぼ空になるので、そのときは呼び出し側で補う。 */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, ASSISTANT_ID_MAX);
}
const WIKI_URL = import.meta.env.VITE_WIKI_URL ?? "https://wasabirdman.sakura.ne.jp/wbwiki/w/index.php";
// 使い方・注意事項・プライバシーポリシーの静的ページ。SPAの初回JavaScriptを
// 増やさないよう、web/public/support.html として素のHTMLで置いてある。
const SUPPORT_URL = "/support.html";

/**
 * 回答末尾の「出典: ページ名（最終更新: YYYY-MM）」を落とす。
 * 同じ情報を構造化された出典カードでも表示するため、本文との重複だけを除く。
 */
function turnModeLabel(turn: Turn): string | null {
  if (!turn.responseMode) return null;
  if (turn.responseMode === "auto") return "自動";
  return RESPONSE_MODE_LABELS[turn.responseMode];
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

const makeId = () => crypto.randomUUID();
const chatTitle = (question: string) =>
  Array.from(question.trim()).slice(0, CHAT_TITLE_RUNES).join("") +
  (Array.from(question.trim()).length > CHAT_TITLE_RUNES ? "…" : "");

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
      else if (daysAgo <= RECENT_HISTORY_DAYS) label = "過去7日間";
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

function loadReadAnnouncementIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANNOUNCEMENT_READ_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadFavoriteAssistantIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSISTANT_FAVORITES_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadAssistantSort(): AssistantSort {
  try {
    const saved = localStorage.getItem(ASSISTANT_SORT_KEY);
    return saved === "name" || saved === "author" ? saved : "favorite";
  } catch {
    return "favorite";
  }
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h16v11H8l-4 3v-14Z" />
    </svg>
  );
}

/** 読込中を示す円形スピナー。待ち時間の表示に凝ると、待っている事実が伝わりにくい。 */
function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  // 添付は保存しない。**送信後も消すまで残す**ので、「もう5案」のような
  // 追質問で同じ画像を使い直せる。チップとして見えているので予測できる
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  // ドラッグは子要素をまたぐたびに enter/leave が飛ぶ。数えないと、
  // 画面の上を動かしただけで枠が点滅する
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [readAnnouncementIds, setReadAnnouncementIds] = useState(loadReadAnnouncementIds);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackItems, setFeedbackItems] = useState<Feedback[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [generalFeedbackId, setGeneralFeedbackId] = useState(makeId);
  const [generalReason, setGeneralReason] = useState<FeedbackReason | null>(null);
  const [generalComment, setGeneralComment] = useState("");
  const [generalSubmitting, setGeneralSubmitting] = useState(false);
  const [answerFeedbackOpen, setAnswerFeedbackOpen] = useState<string | null>(null);
  const [answerComments, setAnswerComments] = useState<Record<string, string>>({});
  const [historyMenuId, setHistoryMenuId] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [favoriteAssistantIds, setFavoriteAssistantIds] = useState(loadFavoriteAssistantIds);
  const [assistantSort, setAssistantSort] = useState<AssistantSort>(loadAssistantSort);
  const [responseMode, setResponseMode] = useState<"auto" | "deep">(loadResponseMode);
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
  const [pendingIcon, setPendingIcon] = useState<{ file: File; url: string } | null>(null);
  const [iconPosition, setIconPosition] = useState<IconCropPosition>(CENTER_ICON_POSITION);
  const bottom = useRef<HTMLDivElement>(null);
  const headerMenus = useRef<HTMLDivElement>(null);
  const historyArea = useRef<HTMLElement>(null);
  // ポップオーバーを閉じたときの戻り先。保持しないとフォーカスがbodyへ落ち、
  // キーボードだけの利用者はタブ順の最初からやり直しになる
  const feedbackTrigger = useRef<HTMLButtonElement>(null);
  const noticeTrigger = useRef<HTMLButtonElement>(null);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const historyMenuTrigger = useRef<HTMLButtonElement>(null);
  const syncedChats = useRef<Map<string, string>>(new Map());
  const toastTimer = useRef<number | null>(null);
  const toastMessage = useRef("");

  const activeAssistant = assistants.find((item) => item.id === assistantId);
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const streaming = chats.some((chat) => chat.turns.some((turn) => turn.streaming));
  const unreadCount = announcements.filter((announcement) => !readAnnouncementIds.includes(announcement.id)).length;
  const historySections = groupChats(chats);
  const sortedAssistants = [...assistants].sort((left, right) => {
    if (assistantSort === "favorite") {
      return Number(favoriteAssistantIds.includes(right.id)) - Number(favoriteAssistantIds.includes(left.id));
    }
    if (assistantSort === "author") {
      return left.author.localeCompare(right.author, "ja") || left.name.localeCompare(right.name, "ja");
    }
    return left.name.localeCompare(right.name, "ja");
  });

  function hideToast() {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastMessage.current = "";
    setToast("");
  }

  /** 同じ失敗の再通知でタイマーが延び続けないよう、表示中の同一文言は更新しない。 */
  function showToast(message: string) {
    if (toastMessage.current === message && toastTimer.current !== null) return;
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastMessage.current = message;
    setToast(message);
    toastTimer.current = window.setTimeout(() => {
      setToast("");
      toastTimer.current = null;
      toastMessage.current = "";
    }, TOAST_DURATION_MS);
  }

  async function restoreHistory() {
    try {
      const restored = (await listChats())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_CHATS)
        .map((chat) => ({
          ...chat,
          turns: chat.turns.map((turn) => ({ ...turn, status: "", streaming: false })),
        }));
      syncedChats.current = new Map(restored.map((chat) => [chat.id, JSON.stringify(chat)]));
      setChats(restored);
      setActiveChatId((current) => current && restored.some((chat) => chat.id === current)
        ? current
        : restored[0]?.id ?? null);
    } catch {
      syncedChats.current = new Map();
      setChats([]);
      setActiveChatId(null);
      showToast("チャット履歴を同期できませんでした");
    }
  }

  useEffect(() => {
    session().then((current) => {
      setAuthed(current.authenticated);
      setUsername(current.username);
      setRemaining(current.remaining);
      setIsAdmin(current.admin);
      if (current.authenticated) {
        void restoreHistory();
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
    if (!noticeOpen && !profileOpen && !historyMenuId && !renamingChatId && !feedbackOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!headerMenus.current?.contains(event.target as Node)) {
        setNoticeOpen(false);
        setProfileOpen(false);
        setFeedbackOpen(false);
      }
      if (!historyArea.current?.contains(event.target as Node)) setHistoryMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 開いていたものを開いた元へ戻す。同時に開くのは1つなので上から順で決まる
      const restore = feedbackOpen ? feedbackTrigger.current
        : noticeOpen ? noticeTrigger.current
        : profileOpen ? profileTrigger.current
        : historyMenuId ? historyMenuTrigger.current
        : null;
      setNoticeOpen(false);
      setProfileOpen(false);
      setFeedbackOpen(false);
      setHistoryMenuId(null);
      setRenamingChatId(null);
      restore?.focus();
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [feedbackOpen, historyMenuId, noticeOpen, profileOpen, renamingChatId]);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 901px)");
    const followViewport = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    wide.addEventListener("change", followViewport);
    return () => wide.removeEventListener("change", followViewport);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!pendingIcon) return;
    // 選び直しとフォーム終了の両方で、一時プレビューのメモリを解放する。
    return () => URL.revokeObjectURL(pendingIcon.url);
  }, [pendingIcon]);

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
          showToast("チャット履歴を同期できませんでした");
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
    setIsAdmin(current.admin);
    void restoreHistory();
    void refreshAssistants();
  }

  async function handleLogout() {
    setNoticeOpen(false);
    setProfileOpen(false);
    setFeedbackOpen(false);
    await logout();
    setAuthed(false);
    setUsername("");
    setIsAdmin(false);
    syncedChats.current.clear();
    setChats([]);
    setActiveChatId(null);
  }

  function handleNoticeToggle() {
    const opening = !noticeOpen;
    setNoticeOpen(opening);
    setProfileOpen(false);
    setFeedbackOpen(false);
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

  async function refreshFeedbackItems() {
    if (!isAdmin) return;
    setFeedbackLoading(true);
    try {
      setFeedbackItems(await listFeedback());
    } catch {
      showToast("フィードバック一覧を読み込めませんでした");
    } finally {
      setFeedbackLoading(false);
    }
  }

  function handleFeedbackToggle() {
    const opening = !feedbackOpen;
    setFeedbackOpen(opening);
    setNoticeOpen(false);
    setProfileOpen(false);
    if (!opening) return;
    setGeneralFeedbackId(makeId());
    setGeneralReason(null);
    setGeneralComment("");
    void refreshFeedbackItems();
  }

  async function sendGeneralFeedback() {
    if (!generalReason || generalSubmitting) return;
    setGeneralSubmitting(true);
    try {
      const notification = await submitFeedback({
        clientId: generalFeedbackId,
        kind: "general",
        reasons: [generalReason],
        comment: generalComment.trim(),
        page: view === "assistants" ? "assistants" : "chat",
      });
      setFeedbackOpen(false);
      showToast(feedbackNotificationMessage(notification));
      void refreshFeedbackItems();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "フィードバックを送信できませんでした");
    } finally {
      setGeneralSubmitting(false);
    }
  }

  function patchTurnFeedback(chatId: string, turnIndex: number, update: Partial<Turn>) {
    setChats((current) => current.map((chat) => chat.id === chatId
      ? { ...chat, turns: chat.turns.map((turn, index) => index === turnIndex ? { ...turn, ...update } : turn) }
      : chat));
  }

  async function sendAnswerFeedback(
    chat: Chat,
    turnIndex: number,
    turn: Turn,
    rating: "good" | "bad",
    reasons: FeedbackReason[],
    comment: string,
  ) {
    return submitFeedback({
      clientId: `${chat.id}:${turnIndex}`,
      kind: "answer",
      rating,
      reasons,
      comment,
      question: turn.question,
      answer: turn.answer.slice(0, FEEDBACK_ANSWER_MAX),
      sources: turn.sources.slice(0, FEEDBACK_SOURCE_MAX),
      assistantId: turn.assistantId,
      assistantName: turn.assistantName,
      responseMode: turn.responseMode,
      resolvedMode: turn.resolvedMode,
      timings: turn.timings,
      chatId: chat.id,
      turnIndex,
      page: "chat",
    });
  }

  async function handleAnswerRating(chat: Chat, turnIndex: number, turn: Turn, rating: "good" | "bad") {
    const key = `${chat.id}:${turnIndex}`;
    const previous = {
      feedbackRating: turn.feedbackRating,
      feedbackReasons: turn.feedbackReasons,
      feedbackComment: turn.feedbackComment,
    };
    const reasons = turn.feedbackRating === rating ? (turn.feedbackReasons ?? []) : [];
    const comment = turn.feedbackRating === rating ? (turn.feedbackComment ?? "") : "";
    patchTurnFeedback(chat.id, turnIndex, {
      feedbackRating: rating,
      feedbackReasons: reasons,
      feedbackComment: comment,
    });
    setAnswerFeedbackOpen(key);
    setAnswerComments((current) => ({ ...current, [key]: comment }));
    try {
      const notification = await sendAnswerFeedback(chat, turnIndex, turn, rating, reasons, comment);
      showToast(feedbackNotificationMessage(notification, "評価"));
      void refreshFeedbackItems();
    } catch (error) {
      patchTurnFeedback(chat.id, turnIndex, previous);
      showToast(error instanceof Error ? error.message : "評価を送信できませんでした");
    }
  }

  async function toggleAnswerReason(chat: Chat, turnIndex: number, turn: Turn, reason: FeedbackReason) {
    if (!turn.feedbackRating) return;
    const current = turn.feedbackReasons ?? [];
    const reasons = current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason];
    patchTurnFeedback(chat.id, turnIndex, { feedbackReasons: reasons });
    try {
      const notification = await sendAnswerFeedback(chat, turnIndex, turn, turn.feedbackRating, reasons, turn.feedbackComment ?? "");
      showToast(feedbackNotificationMessage(notification, "理由"));
      void refreshFeedbackItems();
    } catch (error) {
      patchTurnFeedback(chat.id, turnIndex, { feedbackReasons: current });
      showToast(error instanceof Error ? error.message : "理由を送信できませんでした");
    }
  }

  async function submitAnswerComment(chat: Chat, turnIndex: number, turn: Turn) {
    if (!turn.feedbackRating) return;
    const key = `${chat.id}:${turnIndex}`;
    const comment = (answerComments[key] ?? "").trim();
    patchTurnFeedback(chat.id, turnIndex, { feedbackComment: comment });
    try {
      const notification = await sendAnswerFeedback(chat, turnIndex, turn, turn.feedbackRating, turn.feedbackReasons ?? [], comment);
      showToast(feedbackNotificationMessage(notification, "補足"));
      void refreshFeedbackItems();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "補足を送信できませんでした");
    }
  }

  function handleNewChat() {
    if (streaming) return;
    setActiveChatId(null);
    setQuestion("");
    setView("chat");
    closeSidebarOnMobile();
  }

  function closeSidebarOnMobile() {
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
      showToast("チャットをクリップボードにコピーしました");
    } catch {
      showToast("共有できませんでした");
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
      showToast("チャット履歴を削除できませんでした");
      void restoreHistory();
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

  function chooseAssistant(id: string, selectedName?: string) {
    if (streaming) {
      showToast("回答が終わってからアシスタントを切り替えてください");
      return;
    }
    const changed = id !== assistantId;
    const name = selectedName ?? assistants.find((item) => item.id === id)?.name ?? "汎用";
    setAssistantId(id);
    localStorage.setItem(ASSISTANT_KEY, id);
    // 選んだらチャットへ戻る。選ぶために開いた画面なので、留まる理由がない
    closeAssistantForm();
    setView("chat");
    closeSidebarOnMobile();
    if (!changed) return;
    // 同じ履歴で参照範囲や一般知識の可否が途中から変わると、過去回答を
    // どの規則で読めばよいか分からなくなる。切り替え時は会話を分離する。
    setActiveChatId(null);
    setQuestion("");
    showToast(`「${name}」に切り替え、新しいチャットを開きました`);
  }

  function openAssistants() {
    if (streaming) {
      showToast("回答が終わってからアシスタントを切り替えてください");
      return;
    }
    setAssistantError("");
    closeAssistantForm();
    setView("assistants");
    closeSidebarOnMobile();
  }

  function toggleFavoriteAssistant(item: Assistant) {
    const adding = !favoriteAssistantIds.includes(item.id);
    const next = adding
      ? [...favoriteAssistantIds, item.id]
      : favoriteAssistantIds.filter((id) => id !== item.id);
    setFavoriteAssistantIds(next);
    try {
      localStorage.setItem(ASSISTANT_FAVORITES_KEY, JSON.stringify(next));
    } catch {
      // 保存できなくても、現在のタブではお気に入り状態を維持する。
    }
    showToast(adding
      ? `「${item.name}」をお気に入りに追加しました`
      : `「${item.name}」をお気に入りから外しました`);
  }

  function changeAssistantSort(value: string) {
    const next = value === "name" || value === "author" ? value : "favorite";
    setAssistantSort(next);
    try {
      localStorage.setItem(ASSISTANT_SORT_KEY, next);
    } catch {
      // 保存できなくても、現在のタブでは選んだ並び順を維持する。
    }
  }

  function clearPendingIcon() {
    setPendingIcon(null);
    setIconPosition({ ...CENTER_ICON_POSITION });
  }

  function closeAssistantForm() {
    clearPendingIcon();
    setAssistantForm(null);
  }

  function startCreate() {
    clearPendingIcon();
    setAssistantDraft(emptyDraft);
    setAssistantError("");
    setAssistantForm({ editing: null });
  }

  function startEdit(item: Assistant) {
    clearPendingIcon();
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
      // 位置調整は保存時の正方形画像へ焼き込む。表示側やFirestoreに
      // 別の位置情報を持たせないため、どこに出しても同じ切り抜きになる。
      const draft = pendingIcon
        ? { ...assistantDraft, icon: await toIconDataURL(pendingIcon.file, iconPosition) }
        : assistantDraft;
      if (editing) {
        const saved = await updateAssistant(editing, draft);
        setAssistants((current) => current.map((item) => (item.id === editing ? saved : item)));
        closeAssistantForm();
        showToast(`「${saved.name}」を保存しました`);
        return;
      }
      const created = await createAssistant({
        ...draft,
        // 日本語名だとslugがほぼ空になるので、そのときは時刻から作る
        id: draft.id || slugify(draft.name) || `assistant-${Date.now().toString(36)}`,
      });
      setAssistants((current) => [...current, created]);
      setAssistantDraft(emptyDraft);
      clearPendingIcon();
      chooseAssistant(created.id, created.name);
      showToast(`「${created.name}」を作成し、新しいチャットを開きました`);
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : "保存できませんでした");
    }
  }

  async function handleDeleteAssistant(target: Assistant) {
    if (!window.confirm(`「${target.name}」を削除しますか？元に戻せません。`)) return;
    try {
      await deleteAssistant(target.id);
      setAssistants((current) => current.filter((item) => item.id !== target.id));
      if (favoriteAssistantIds.includes(target.id)) {
        const nextFavorites = favoriteAssistantIds.filter((id) => id !== target.id);
        setFavoriteAssistantIds(nextFavorites);
        try {
          localStorage.setItem(ASSISTANT_FAVORITES_KEY, JSON.stringify(nextFavorites));
        } catch {
          // 削除そのものは成功しているため、端末の設定保存に失敗しても続行する。
        }
      }
      if (assistantId === target.id) chooseAssistant("");
      showToast(`「${target.name}」を削除しました`);
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
      const icon = await toIconDataURL(file);
      setAssistantDraft((d) => ({ ...d, icon }));
      setIconPosition({ ...CENTER_ICON_POSITION });
      setPendingIcon({ file, url: URL.createObjectURL(file) });
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : "画像を読み込めませんでした");
    }
  }

  /** 他人のアシスタントは編集できない。複製してから直す（編集権の調整を発生させないため）。 */
  function duplicateAssistant(source: Assistant) {
    clearPendingIcon();
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

  /**
   * 画像を添付する。ファイル選択・貼り付け・ドラッグの3経路で共通に使う。
   *
   * ミーム画像を扱う流れでは「コピーして貼る」が一番短い。ファイル選択だけに
   * すると、いったん保存してから選び直すことになる。
   */
  async function attachImage(file: File | null | undefined) {
    if (!file || streaming) return;
    try {
      setAttachment(await toAttachment(file));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "画像を添付できませんでした");
    }
  }

  /**
   * ドラッグ中は中身を読めないため、種別だけで画像かどうかを見る。
   * 文字の選択をドラッグしただけで枠が出ないようにするための判定である。
   */
  function imageTypeInDataTransfer(data: DataTransfer | null): boolean {
    if (!data) return false;
    return Array.from(data.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
  }

  /** 貼り付けられた中身から画像を1枚だけ取り出す。文字だけなら何もしない。 */
  function imageFromDataTransfer(data: DataTransfer | null): File | null {
    if (!data) return null;
    for (const item of Array.from(data.files)) {
      if (item.type.startsWith("image/")) return item;
    }
    return null;
  }

  async function handleAsk(text: string) {
    const q = text.trim();
    // 画像だけでも送れる。「これでツイート作って」のように、文章より
    // 画像のほうが本体である使い方があるため
    if ((!q && !attachment) || streaming) return;
    setQuestion("");
    // 送ったら添付も外す。**残すと次の質問にも黙って付いていく。**
    // 「もう5案」で使い回せるようにと残していたが、実際に使うと
    // 別の話題へ移ったときに前の画像が紛れ込むほうが困った
    // （2026-08-10に利用者から報告）。使い回したいときは選び直す
    const sent = attachment;
    setAttachment(null);
    // 先読みなので、失敗しても握りつぶす。実際に必要になった時点で
    // 上の lazy 側が読み直しと再読み込みを引き受ける
    void loadMarkdownModule().catch(() => {});

    const now = new Date().toISOString();
    const chatId = activeChat?.id ?? makeId();
    const turnIndex = activeChat?.turns.length ?? 0;
    // 全履歴を毎回送ると入力費用が増え続ける。指示語の解決に必要な直近2往復だけを送り、
    // 出典やエラー状態はサーバーへ再送しない。長さの上限はサーバー側でも検証する。
    const context = (activeChat?.turns ?? [])
      .filter((item) => !item.streaming && item.question.trim() && item.answer.trim())
      .slice(-CONVERSATION_CONTEXT_TURNS)
      .map((item) => ({ question: item.question, answer: item.answer.slice(0, CONVERSATION_ANSWER_RUNES) }));
    const turn: Turn = {
      question: q,
      answer: "",
      sources: [],
      status: "送信中",
      streaming: true,
      // 後から一覧が変わっても、この回答を出したアシスタントを辿れるようにする
      assistantId: activeAssistant?.id,
      assistantName: activeAssistant?.name,
      responseMode,
      // 画像そのものは履歴へ保存しない。印だけ残す
      hasAttachment: sent !== null,
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
        case "mode":
          patch((current) => ({ ...current, resolvedMode: event.mode }));
          break;
        case "status":
          patch((current) => ({ ...current, status: event.message, retryAt: event.retry_at }));
          break;
        case "timing": {
          const key: `${StageTimingName}Ms` = `${event.stage}Ms`;
          patch((current) => ({
            ...current,
            timings: { ...current.timings, [key]: event.milliseconds },
          }));
          break;
        }
        case "pages":
          // 該当ページが0件のとき、サーバーは pages を省いて送ってくる。
          // そのまま入れると undefined が履歴へ保存され、読み直したときに
          // sources が無い（＝null）状態になって描画時に落ちる
          patch((current) => ({ ...current, sources: event.pages ?? [] }));
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
      }, undefined, assistantId, context, responseMode, sent ? [sent.dataUrl] : []);
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

  if (authed === null) return (
    <div className="center app-loading" role="status" aria-label="WASA Chatを読み込んでいます">
      <img src="/assets/wasa-chat-logo-photo-trimmed.png" alt="WASA Chat" className="loading-wordmark" />
      <Spinner />
      <span className="muted">読み込み中…</span>
    </div>
  );

  if (!authed) {
    return (
      <div className="center login-page">
        <form className="card gate" onSubmit={handleLogin}>
          <img src="/assets/wasa-chat-logo-photo-trimmed.png" alt="WASA Chat" className="brand-logo-large" />
          <div className="login-heading">
            <h1 className="visually-hidden">WASA Chat</h1>
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
          {/* ログイン前に読めないと、初めて使う人が何に同意して入るのか分からない */}
          <p className="login-links">
            <a href={SUPPORT_URL} target="_blank" rel="noreferrer noopener">使い方</a>
            <a href={`${SUPPORT_URL}#terms`} target="_blank" rel="noreferrer noopener">注意事項</a>
            <a href={`${SUPPORT_URL}#privacy`} target="_blank" rel="noreferrer noopener">プライバシーポリシー</a>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="history-panel" aria-label="チャット履歴" aria-hidden={!sidebarOpen}>
        <div className="brand-row">
          <div className="brand">
            <img src="/assets/wasa-chat-logo-photo-trimmed.png" alt="WASA Chat" className="brand-logo" />
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
                        closeSidebarOnMobile();
                      }}
                    >
                      <HistoryIcon />
                      <span>{chat.title}</span>
                      {/* aria-labelは役割のない要素では読み上げられないので、
                          ボタン名へ足す隠し文字で伝える */}
                      {chat.turns.some((turn) => turn.streaming) && (
                        <>
                          <i aria-hidden="true" />
                          <span className="visually-hidden">回答中</span>
                        </>
                      )}
                    </button>
                    <button
                      ref={historyMenuId === chat.id ? historyMenuTrigger : undefined}
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
                      // role="menu" は矢印キーでの移動を約束する役割だが、それは実装していない。
                      // 素のボタンはTabで辿れるので、実装に合う「操作のまとまり」として示す
                      <div className="history-menu" role="group" aria-label={`「${chat.title}」の操作`}>
                        <button type="button" onClick={() => handleTogglePin(chat.id)}>
                          {chat.pinned ? "ピン留めを解除" : "ピン留め"}
                        </button>
                        <button type="button" onClick={() => handleRenameStart(chat)}>タイトル変更</button>
                        <button type="button" onClick={() => handleShare(chat)} disabled={chat.turns.some((turn) => turn.streaming)}>共有する</button>
                        <button type="button" className="danger" onClick={() => handleDeleteChat(chat)} disabled={chat.turns.some((turn) => turn.streaming)}>削除</button>
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

      <section
        className={`chat-panel${dragging ? " dragging" : ""}`}
        // 画面のどこへ落としても添付になる。入力欄の小さな的を狙わせない
        onDragEnter={(event) => {
          if (!imageTypeInDataTransfer(event.dataTransfer)) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          // 既定の動作を止めないとブラウザが画像を別タブで開いてしまう
          if (dragDepth.current > 0) event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          if (dragDepth.current === 0) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void attachImage(imageFromDataTransfer(event.dataTransfer));
        }}
      >
        {dragging && (
          <div className="drop-overlay" aria-hidden="true">
            <span>ここに画像を落とすと添付します</span>
          </div>
        )}
        <header className="chat-header">
          <div className="header-title">
            <button type="button" className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="チャット履歴を開く" aria-expanded={sidebarOpen}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <h1>{view === "assistants" ? "アシスタント" : activeChat?.title ?? "新しいチャット"}</h1>
          </div>
          <div className="header-actions" ref={headerMenus}>
            <div className="header-menu-wrap">
              <button
                ref={feedbackTrigger}
                type="button"
                className="feedback-trigger"
                aria-expanded={feedbackOpen}
                aria-controls="feedback-popover"
                onClick={handleFeedbackToggle}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.5A2.5 2.5 0 0 1 4 13.5v-8Z" />
                  <path d="M8 8h8M8 12h5" />
                </svg>
                <span>改善を送る</span>
              </button>
              {feedbackOpen && (
                <FeedbackPopover
                  reason={generalReason}
                  comment={generalComment}
                  submitting={generalSubmitting}
                  isAdmin={isAdmin}
                  items={feedbackItems}
                  loading={feedbackLoading}
                  onReason={setGeneralReason}
                  onComment={setGeneralComment}
                  onSubmit={() => void sendGeneralFeedback()}
                  onClose={() => {
                    setFeedbackOpen(false);
                    feedbackTrigger.current?.focus();
                  }}
                  onRefresh={() => void refreshFeedbackItems()}
                />
              )}
            </div>
            <div className="header-menu-wrap">
              <button
                ref={noticeTrigger}
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
                ref={profileTrigger}
                type="button"
                className="profile-avatar"
                aria-label={`利用者メニュー: ${username}`}
                aria-expanded={profileOpen}
                aria-controls="profile-popover"
                onClick={() => {
                  setProfileOpen((open) => !open);
                  setNoticeOpen(false);
                  setFeedbackOpen(false);
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
                  <a href={SUPPORT_URL} target="_blank" rel="noreferrer noopener">ヘルプとポリシー</a>
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
                    <br />
                    出典の一覧と参照範囲はサーバー側で決まるため、指示では変えられません。
                  </p>
                </header>
                <div className="assistant-icon-editor">
                  <div className="assistant-icon-pick">
                    {/* 画像が無くても頭文字で成立させる。用意しないと見栄えが悪い状態にすると、
                        結局だれもアシスタントを作らなくなる */}
                    {pendingIcon
                      ? (
                        <img
                          className="avatar assistant-icon-preview"
                          src={pendingIcon.url}
                          alt="アイコンの切り抜きプレビュー"
                          width={72}
                          height={72}
                          style={{ objectPosition: `${iconPosition.x}% ${iconPosition.y}%` }}
                        />
                      )
                      : <AssistantAvatar name={assistantDraft.name || "?"} icon={assistantDraft.icon} size={72} />}
                    <label className="assistant-icon-button">
                      <span>{assistantDraft.icon ? "変更" : "画像を選ぶ"}</span>
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handlePickIcon(event)} />
                    </label>
                    {assistantDraft.icon && (
                      <button type="button" className="linkish" onClick={() => {
                        clearPendingIcon();
                        setAssistantDraft((d) => ({ ...d, icon: undefined }));
                      }}>
                        画像を外す
                      </button>
                    )}
                  </div>
                  {pendingIcon && (
                    <fieldset className="assistant-icon-position">
                      <legend>画像の位置</legend>
                      <label>
                        <span>左右</span>
                        <input type="range" min="0" max="100" value={iconPosition.x}
                          onChange={(event) => setIconPosition((current) => ({ ...current, x: Number(event.target.value) }))} />
                      </label>
                      <label>
                        <span>上下</span>
                        <input type="range" min="0" max="100" value={iconPosition.y}
                          onChange={(event) => setIconPosition((current) => ({ ...current, y: Number(event.target.value) }))} />
                      </label>
                      <button type="button" className="linkish" onClick={() => setIconPosition({ ...CENTER_ICON_POSITION })}>
                        中央に戻す
                      </button>
                    </fieldset>
                  )}
                </div>
                <label>
                  <span>名前</span>
                  <input value={assistantDraft.name} maxLength={40} required
                    onChange={(event) => setAssistantDraft((d) => ({ ...d, name: event.target.value }))} />
                </label>
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
                  <div className="assistant-field">
                    <span>参照する出所</span>
                    <SelectMenu
                      label="参照する出所"
                      value={assistantDraft.origin ?? ""}
                      options={ORIGIN_OPTIONS}
                      onChange={(value) => setAssistantDraft((d) => ({
                        ...d,
                        origin: (value || undefined) as AssistantDraft["origin"],
                      }))}
                    />
                  </div>
                  <div className="assistant-field">
                    <span>参照する区分</span>
                    <SelectMenu
                      label="参照する区分"
                      value={assistantDraft.team ?? ""}
                      options={[
                        { value: "", label: "すべて" },
                        ...teams.map((team) => ({ value: team.value, label: team.label })),
                      ]}
                      onChange={(value) => setAssistantDraft((d) => ({ ...d, team: value || undefined }))}
                    />
                  </div>
                </div>
                {assistantError && <p className="assistant-error" role="alert">{assistantError}</p>}
                <div className="assistant-actions">
                  <button type="button" onClick={closeAssistantForm}>戻る</button>
                  <button type="submit" className="primary" disabled={!assistantDraft.name.trim() || !assistantDraft.instruction.trim()}>
                    {assistantForm.editing ? "保存する" : "作成する"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <header className="assistant-page-head">
                  <div className="assistant-page-copy">
                    <h2>アシスタント</h2>
                    <p className="muted">
                      口調や参照範囲を決めた設定です。誰でも作れて全員が使えます。
                    </p>
                  </div>
                  <div className="assistant-page-controls">
                    <span className="assistant-count">{assistants.length + 1}件</span>
                    {/* 見出しは付けない。SelectMenu自身が「アシスタントの並べ替え」を
                        名前として持っており、置くと同じ語を二度読み上げる */}
                    <div className="assistant-sort">
                      <SelectMenu
                        label="アシスタントの並べ替え"
                        value={assistantSort}
                        options={ASSISTANT_SORT_OPTIONS}
                        onChange={changeAssistantSort}
                      />
                    </div>
                    <button type="button" className="primary assistant-create" onClick={startCreate}>新しく作る</button>
                  </div>
                </header>
                {assistantError && <p className="assistant-error" role="alert">{assistantError}</p>}
                <ul className="assistant-grid">
                  <li>
                    <button type="button" className={`assistant-card assistant-card-default ${assistantId === "" ? "on" : ""}`} onClick={() => chooseAssistant("")}>
                      <DefaultAvatar size={64} />
                      <span className="assistant-card-copy">
                        <span className="assistant-name">汎用</span>
                        <span className="assistant-desc">資料全体から、ふつうの口調で答えます</span>
                        <span className="assistant-meta">標準アシスタント</span>
                      </span>
                    </button>
                  </li>
                  {sortedAssistants.map((item) => (
                    <li key={item.id}>
                      <button type="button" className={`assistant-card ${assistantId === item.id ? "on" : ""}`} onClick={() => chooseAssistant(item.id)}>
                        <AssistantAvatar name={item.name} icon={item.icon} size={64} />
                        <span className="assistant-card-copy">
                          <span className="assistant-name">{item.name}</span>
                          <span className="assistant-desc">{item.description || "説明はありません"}</span>
                          <span className="assistant-meta">
                            作成: {item.author}
                            {item.scope && <><br />{item.scope}</>}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="assistant-favorite"
                        aria-label={`「${item.name}」をお気に入り${favoriteAssistantIds.includes(item.id) ? "から外す" : "に追加"}`}
                        aria-pressed={favoriteAssistantIds.includes(item.id)}
                        title={favoriteAssistantIds.includes(item.id) ? "お気に入りから外す" : "お気に入りに追加"}
                        onClick={() => toggleFavoriteAssistant(item)}
                      >
                        <span aria-hidden="true">{favoriteAssistantIds.includes(item.id) ? "★" : "☆"}</span>
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
              <img src="/assets/wasa-chat-logo-photo-trimmed.png" alt="WASA Chat" className="intro-logo" />
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
                <div className="question">
                  {/* 画像そのものは保存していないので、添えたという事実だけを出す。
                      これが無いと、履歴を見返したときに質問だけが宙に浮く */}
                  {turn.hasAttachment && <span className="question-attachment">画像を添付</span>}
                  {turn.question || (turn.hasAttachment ? "（画像のみ）" : "")}
                </div>
              </div>

              <div className="assistant-row">
                {/* 誰が答えたかを毎回出す。しゅよっくんに切り替えたのに
                    WASAロゴのままだと、口調が変わった理由が画面から分からない */}
                {turn.assistantName
                  ? <AssistantAvatar name={turn.assistantName} icon={assistants.find((a) => a.id === turn.assistantId)?.icon} size={34} />
                  : <img src="/assets/wasa-chat-mark-photo-trimmed.png" alt="" className="assistant-avatar" />}
                <div className="assistant-content">
                  <div className="answer-author">
                    <span>{turn.assistantName ?? "WASA Chat"}</span>
                    {turnModeLabel(turn) && <span className="answer-mode">{turnModeLabel(turn)}</span>}
                  </div>
                  {turn.status && (
                    <div className="status">
                      <Spinner />
                      <span>{turn.status}</span>
                      {turn.retryAt && <small>{retryLabel(turn.retryAt, clock)}</small>}
                    </div>
                  )}
                  {turn.answer && (
                    <div>
                      <Suspense fallback={<div className="muted" role="status">回答を表示中…</div>}>
                        <Markdown text={stripCitation(turn.answer)} />
                      </Suspense>
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

                  {!turn.streaming && turn.answer && !turn.error && activeChat && (
                    <AnswerFeedback
                      turn={turn}
                      open={answerFeedbackOpen === `${activeChat.id}:${index}`}
                      comment={answerComments[`${activeChat.id}:${index}`] ?? turn.feedbackComment ?? ""}
                      onRating={(rating) => void handleAnswerRating(activeChat, index, turn, rating)}
                      onReason={(reason) => void toggleAnswerReason(activeChat, index, turn, reason)}
                      onComment={(comment) => setAnswerComments((current) => ({ ...current, [`${activeChat.id}:${index}`]: comment }))}
                      onSubmitComment={() => void submitAnswerComment(activeChat, index, turn)}
                      onClose={() => setAnswerFeedbackOpen(null)}
                    />
                  )}

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
          {/* 回答モードは毎回変えるものではない。名前と説明で1行を占めていたが、
              選択肢そのもの（auto / thinking）で見分けが付くので畳んだ。
              説明は選択肢の中に残してあるので、開けば読める */}
          <div className="response-mode-bar">
            <div className="response-mode-select">
              <SelectMenu
                label="回答モード"
                value={responseMode}
                options={RESPONSE_MODE_OPTIONS}
                onChange={(value) => {
                  const next = value === "deep" ? "deep" : "auto";
                  setResponseMode(next);
                  localStorage.setItem(RESPONSE_MODE_KEY, next);
                }}
              />
            </div>

          </div>
          {attachment && (
            <div className="attachment-row">
            <div className="attachment-chip">
              <img src={attachment.dataUrl} alt="" />
              <span className="attachment-name">{attachment.name}</span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                aria-label={`添付した画像（${attachment.name}）を外す`}
              >
                ×
              </button>
            </div>
            </div>
          )}
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
              onPaste={(event) => {
                const file = imageFromDataTransfer(event.clipboardData);
                if (!file) return; // 文字の貼り付けはそのまま通す
                event.preventDefault();
                void attachImage(file);
              }}
              aria-label="質問"
              placeholder="引き継ぎ資料について質問する（画像は貼り付けもできます）"
              maxLength={500}
              rows={1}
              disabled={streaming}
            />
            <div className="composer-actions">
              <input
                ref={attachmentInput}
                type="file"
                className="visually-hidden"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // 同じ画像をもう一度選べるよう、値は必ず空へ戻す
                  event.target.value = "";
                  void attachImage(file);
                }}
              />
              <button
                type="button"
                className="attach"
                aria-label="画像を添付"
                title="画像を添付"
                disabled={streaming}
                onClick={() => attachmentInput.current?.click()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 6.5 8 12.5a3 3 0 0 0 4.2 4.2l6.3-6.3a5 5 0 0 0-7-7L5 9.7a7 7 0 0 0 9.9 9.9l5.1-5.1" />
                </svg>
              </button>
              <button
                type="submit"
                className="send"
                aria-label="送信"
                title="送信"
                disabled={(!question.trim() && !attachment) || streaming}
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
      {/* ライブリージョンは中身と一緒に現れると読み上げられない。常に置いておき、
          文字だけを差し替える。見えるトースト側は同じ文を二重に読ませないため隠す */}
      <div className="visually-hidden" role="status" aria-live="polite">{toast}</div>
      {toast && (
        <div className="toast" key={toast}>
          <span aria-hidden="true">{toast}</span>
          <button type="button" onClick={hideToast} aria-label="通知を閉じる">×</button>
        </div>
      )}
    </div>
  );
}
