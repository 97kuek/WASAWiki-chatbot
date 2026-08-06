import { useEffect, useRef, useState } from "react";
import { ask, login, session, type Source } from "./api";

type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  status: string;
  error?: string;
  streaming: boolean;
};

const EXAMPLES = [
  "作業場の家賃は月いくらですか？",
  "荷重試験の申請方法を教えてください",
  "40thと41stの空力設計は何が違いますか？",
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
          <div className="card intro">
            <p>引き継ぎ資料Wikiの内容について質問できます。</p>
            <p className="muted">
              回答は必ず出典ページを示します。Wikiに書かれていないことは「記載がありません」と答えます。
            </p>
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="chip" onClick={() => handleAsk(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <article key={i} className="turn">
            <div className="question">{turn.question}</div>

            {turn.sources.length > 0 && (
              <div className="sources">
                {turn.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="chip">
                    {s.title}
                    <span className="muted"> · {s.last_edited.slice(0, 7)}</span>
                  </a>
                ))}
              </div>
            )}

            {/* 進捗表示。無言で待たされる数秒と、何をしているか見える数秒では体感が違う */}
            {turn.status && (
              <div className="status">
                <span className="dot" />
                {turn.status}
              </div>
            )}

            {turn.answer && (
              <div className="answer">
                {turn.answer}
                {turn.streaming && <span className="caret" />}
              </div>
            )}
            {turn.error && <div className="error">{turn.error}</div>}
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
        <button type="submit" disabled={!question.trim() || turns.some((t) => t.streaming)}>
          送信
        </button>
      </form>
    </div>
  );
}
