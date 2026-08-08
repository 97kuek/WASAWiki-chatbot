import { useEffect, useRef, useState } from "react";
import { ask, login, session, type Source } from "./api";
import { Markdown } from "./markdown";

type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  status: string;
  error?: string;
  streaming: boolean;
};

/**
 * 回答末尾の「出典: ページ名（最終更新: YYYY-MM）」を落とす。
 *
 * 同じ情報を pages イベントで構造化データとして受け取っており、
 * そちらはリンクにできる。本文の平文と二重に出す意味がない。
 * 鮮度の注記（※〜）は情報として残す。
 */
function stripCitation(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*(\*\*)?出典[:：]/.test(l));
  if (start === -1) return text.trim();
  // 出典は末尾に書かせているので、それ以降はまとめて出典ブロックとみなす。
  // 複数ページを箇条書きで並べることがあり、行単位の除去では取り切れない。
  // ただし鮮度の注記（※〜）は本文として意味があるので残す
  const notes = lines.slice(start).filter((l) => /^\s*[※注]/.test(l));
  return [...lines.slice(0, start), ...notes].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 質問候補。新入生や代替わり直後の人は「何を聞けばいいか」が分からないので、
 * 入口を用意しておく。title は一覧で拾える短さ、body が実際に送る質問文。
 */
const SUGGESTIONS: { title: string; body: string }[] = [
  { title: "空力設計の手順", body: "空力設計の設計手順について、詳しく分かりやすく説明してください" },
  { title: "荷重試験の申請", body: "荷重試験の申請方法を教えてください。申請先のメールアドレスも知りたいです" },
  { title: "作業場のこと", body: "作業場の家賃・ルール・移転の経緯を教えてください" },
  { title: "鳥コンまでの流れ", body: "鳥人間コンテストまでにやっておくべきことを教えてください" },
  { title: "代ごとの違い", body: "空力設計は38代から41代にかけて何が変化しましたか？" },
  { title: "テストフライト", body: "テストフライトの申請方法と、TF前日までにやるべきことを教えてください" },
];

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    session().then((s) => {
      setAuthed(s.authenticated);
      setRemaining(s.remaining);
    });
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    if (await login(password)) {
      const s = await session();
      setAuthed(true);
      setRemaining(s.remaining);
    } else {
      setLoginError("パスワードが違います");
    }
  }

  async function handleAsk(text: string) {
    const q = text.trim();
    if (!q || turns.some((t) => t.streaming)) return;
    setQuestion("");

    // 楽観的UI: 送信した瞬間に自分の質問を表示する
    const index = turns.length;
    setTurns((prev) => [
      ...prev,
      { question: q, answer: "", sources: [], status: "送信中", streaming: true },
    ]);

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === index ? fn(t) : t)));

    await ask(q, (event) => {
      switch (event.type) {
        case "status":
          patch((t) => ({ ...t, status: event.message }));
          break;
        case "pages":
          patch((t) => ({ ...t, sources: event.pages }));
          break;
        case "delta":
          patch((t) => ({ ...t, answer: t.answer + event.text, status: "" }));
          break;
        case "error":
          patch((t) => ({ ...t, error: event.message, streaming: false, status: "" }));
          break;
        case "done":
          patch((t) => ({ ...t, streaming: false, status: "" }));
          break;
      }
    });
    patch((t) => ({ ...t, streaming: false }));
    setRemaining((n) => Math.max(0, n - 1));
  }

  if (authed === null) return <div className="center muted">読み込み中…</div>;

  if (!authed) {
    return (
      <div className="center">
        <form className="card gate" onSubmit={handleLogin}>
          <h1>WASA Wiki チャット</h1>
          <p className="muted">部内で配布されている合言葉を入力してください。</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="合言葉"
            autoFocus
          />
          {loginError && <p className="error">{loginError}</p>}
          <button type="submit">入る</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>WASA Wiki チャット</h1>
        <span className="muted">本日あと{remaining}回</span>
      </header>

      <main>
        {turns.length === 0 && (
          <div className="intro">
            <h2>WASA Wiki チャット</h2>
            <p className="muted">
              引き継ぎ資料Wikiの内容に答えます。回答には必ず出典ページを示し、
              Wikiに書かれていないことは「記載がありません」と答えます。
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="suggestion" onClick={() => handleAsk(s.body)}>
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-body">{s.body}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <article key={i} className="turn">
            <div className="question">{turn.question}</div>

            {/* 進捗表示。無言で待たされる数秒と、何をしているか見える数秒では体感が違う */}
            {turn.status && (
              <div className="status">
                <span className="dot" />
                {turn.status}
              </div>
            )}

            {turn.answer && (
              <div>
                <Markdown text={stripCitation(turn.answer)} />
                {turn.streaming && <span className="caret" />}
              </div>
            )}
            {turn.error && <div className="error">{turn.error}</div>}

            {turn.sources.length > 0 && (
              <section className="sources">
                <h2>{turn.streaming ? "参照中の資料" : "出典"}</h2>
                <ul>
                  {turn.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener">
                        <span className="source-title">{s.title}</span>
                        <span className="source-meta">最終更新 {s.last_edited}</span>
                        <span className="source-arrow" aria-hidden="true">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        ))}
        <div ref={bottom} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          handleAsk(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="引き継ぎ資料について質問する"
          maxLength={500}
          disabled={turns.some((t) => t.streaming)}
        />
        <button
          type="submit"
          className="send"
          aria-label="送信"
          title="送信"
          disabled={!question.trim() || turns.some((t) => t.streaming)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M12 19V5M12 5l-6 6M12 5l6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>

      <p className="disclaimer">
        生成AIの回答には誤りが含まれることがあります。重要な判断の前に出典ページをご確認ください。
      </p>
    </div>
  );
}
