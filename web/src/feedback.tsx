import type { Feedback, FeedbackNotification, FeedbackReason, StageTimings, Turn } from "./api";

export const FEEDBACK_COMMENT_MAX = 500;
export const FEEDBACK_ANSWER_MAX = 20_000;
export const FEEDBACK_SOURCE_MAX = 8;
const ADMIN_ANSWER_PREVIEW_MAX = 500;
const ADMIN_RECENT_MAX = 12;

export const FEEDBACK_LABELS: Record<FeedbackReason, string> = {
  helpful: "知りたいことが分かった",
  clear: "説明が分かりやすい",
  good_sources: "出典が役立った",
  incorrect: "内容が違う",
  missing: "必要な情報がない",
  unclear: "説明が分かりにくい",
  wrong_sources: "出典が違う",
  outdated: "情報が古い",
  slow: "回答が遅い",
  bug: "表示・動作がおかしい",
  usability: "使いにくい",
  feature: "機能の提案",
  content: "回答・資料について",
  other: "その他",
};

export const GOOD_REASONS: FeedbackReason[] = ["helpful", "clear", "good_sources"];
export const BAD_REASONS: FeedbackReason[] = ["incorrect", "missing", "unclear", "wrong_sources", "outdated", "slow"];
export const GENERAL_REASONS: FeedbackReason[] = ["bug", "usability", "feature", "content", "other"];

export function feedbackNotificationMessage(status: FeedbackNotification, noun = "フィードバック"): string {
  if (status === "sent") return `${noun}をメールで送信しました`;
  if (status === "failed") return `${noun}は保存しましたが、メール通知に失敗しました`;
  return `${noun}を保存しました`;
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}秒`;
}

type ReasonButtonsProps = {
  reasons: FeedbackReason[];
  selected: FeedbackReason[];
  onToggle: (reason: FeedbackReason) => void;
  className: "feedback-choice-list" | "feedback-chips";
};

export function FeedbackReasonButtons({ reasons, selected, onToggle, className }: ReasonButtonsProps) {
  return (
    <div className={className} role="group" aria-label="フィードバックの種類">
      {reasons.map((reason) => (
        <button
          type="button"
          key={reason}
          className={selected.includes(reason) ? "selected" : ""}
          aria-pressed={selected.includes(reason)}
          onClick={() => onToggle(reason)}
        >
          {FEEDBACK_LABELS[reason]}
        </button>
      ))}
    </div>
  );
}

function TimingDetails({ timings }: { timings: StageTimings }) {
  return (
    <p><b>所要時間:</b> ページ {formatDuration(timings.pagesMs)} / 節 {formatDuration(timings.chunksMs)} / 回答 {formatDuration(timings.answerMs)} / 合計 {formatDuration(timings.totalMs)}</p>
  );
}

type FeedbackPopoverProps = {
  reason: FeedbackReason | null;
  comment: string;
  submitting: boolean;
  isAdmin: boolean;
  items: Feedback[];
  loading: boolean;
  onReason: (reason: FeedbackReason) => void;
  onComment: (comment: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onRefresh: () => void;
};

export function FeedbackPopover(props: FeedbackPopoverProps) {
  return (
    <section className="header-popover feedback-popover" id="feedback-popover" aria-label="フィードバック">
      <div className="feedback-popover-head">
        <div><h2>気づいたことを送る</h2><p>匿名で管理者にフィードバックを送れます</p></div>
        <button type="button" className="popover-close" onClick={props.onClose} aria-label="閉じる">×</button>
      </div>
      <form className="feedback-comment-form" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
        <FeedbackReasonButtons
          reasons={GENERAL_REASONS}
          selected={props.reason ? [props.reason] : []}
          onToggle={props.onReason}
          className="feedback-choice-list"
        />
        <label>
          <span>補足</span>
          <textarea value={props.comment} onChange={(event) => props.onComment(event.target.value)} maxLength={FEEDBACK_COMMENT_MAX} rows={3} placeholder="どこで、何が起きたかなど" />
        </label>
        <button type="submit" disabled={!props.reason || props.submitting}>{props.submitting ? "送信中…" : "送信する"}</button>
      </form>
      {props.isAdmin && (
        <section className="feedback-admin">
          <div className="feedback-admin-head">
            <h3>最近の報告</h3>
            <button type="button" onClick={props.onRefresh} disabled={props.loading}>{props.loading ? "読込中" : "更新"}</button>
          </div>
          <div className="feedback-summary">
            <span>良い {props.items.filter((item) => item.rating === "good").length}</span>
            <span>改善 {props.items.filter((item) => item.rating === "bad").length}</span>
            <span>全体 {props.items.filter((item) => item.kind === "general").length}</span>
          </div>
          <div className="feedback-admin-list">
            {props.items.length === 0 ? <p>まだ報告はありません</p> : props.items.slice(0, ADMIN_RECENT_MAX).map((item) => (
              <details key={item.id}>
                <summary>
                  <span>{item.rating === "good" ? "良い" : item.rating === "bad" ? "改善" : "全体"}</span>
                  <strong>{item.reasons?.[0] ? FEEDBACK_LABELS[item.reasons[0]] : item.comment || "理由なし"}</strong>
                </summary>
                {item.question && <p><b>質問:</b> {item.question}</p>}
                {item.comment && <p><b>補足:</b> {item.comment}</p>}
                {item.answer && <p><b>回答:</b> {item.answer.slice(0, ADMIN_ANSWER_PREVIEW_MAX)}{item.answer.length > ADMIN_ANSWER_PREVIEW_MAX ? "…" : ""}</p>}
                {item.timings && <TimingDetails timings={item.timings} />}
                <time dateTime={item.submittedAt}>{new Date(item.submittedAt).toLocaleString("ja-JP")}</time>
              </details>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

type AnswerFeedbackProps = {
  turn: Turn;
  open: boolean;
  comment: string;
  onRating: (rating: "good" | "bad") => void;
  onReason: (reason: FeedbackReason) => void;
  onComment: (comment: string) => void;
  onSubmitComment: () => void;
  onClose: () => void;
};

export function AnswerFeedback(props: AnswerFeedbackProps) {
  const { turn } = props;
  return (
    <section className="answer-feedback" aria-label="回答の評価">
      <div className="answer-feedback-row">
        <span>{turn.feedbackRating ? "評価済み" : "この回答は役に立ちましたか？"}{!turn.feedbackRating && <small>質問・回答も送信</small>}</span>
        <button type="button" className={turn.feedbackRating === "good" ? "selected" : ""} aria-label="役に立った" aria-pressed={turn.feedbackRating === "good"} onClick={() => props.onRating("good")}>👍</button>
        <button type="button" className={turn.feedbackRating === "bad" ? "selected" : ""} aria-label="改善が必要" aria-pressed={turn.feedbackRating === "bad"} onClick={() => props.onRating("bad")}>👎</button>
      </div>
      {props.open && turn.feedbackRating && (
        <div className="answer-feedback-detail">
          <FeedbackReasonButtons reasons={turn.feedbackRating === "good" ? GOOD_REASONS : BAD_REASONS} selected={turn.feedbackReasons ?? []} onToggle={props.onReason} className="feedback-chips" />
          <div className="answer-feedback-comment">
            <textarea value={props.comment} onChange={(event) => props.onComment(event.target.value)} maxLength={FEEDBACK_COMMENT_MAX} rows={2} placeholder="補足があれば入力（任意）" />
            <button type="button" onClick={props.onSubmitComment}>補足を送る</button>
            <button type="button" className="linkish" onClick={props.onClose}>閉じる</button>
          </div>
          <p>評価時は、この質問・回答・出典も改善確認のため保存します。</p>
        </div>
      )}
    </section>
  );
}
