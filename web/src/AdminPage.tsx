import { useEffect, useMemo, useRef, useState } from "react";
import {
  adminOverview,
  checkSources,
  setCoAdmin,
  type AdminOverview,
  type AdminAlert,
  type AdminUserUsage,
  type SourceCheckResult,
} from "./api";

type Props = {
  username: string;
  onBack: () => void;
  onLogout: () => void;
};

type SortKey = "username" | "today" | "sevenDays" | "thirtyDays" | "lastUsed";
type AdminTab = "overview" | "sources" | "users" | "quota" | "logs";

const TOAST_DURATION_MS = 3000;
const WIKI_URL = import.meta.env.VITE_WIKI_URL ?? "https://wasabirdman.sakura.ne.jp/wbwiki/";
const SUPPORT_URL = "/support.html";
const tabs: { id: AdminTab; label: string; description: string }[] = [
  { id: "overview", label: "概要", description: "今日の利用状況とシステムの状態を確認します。" },
  { id: "sources", label: "資料更新", description: "Wiki・公式サイトの変更と、取り込み直しの手順を確認します。" },
  { id: "users", label: "利用者・権限", description: "利用回数の確認と、共同管理者の追加・解除を行います。" },
  { id: "quota", label: "API利用状況", description: "Gemini無料枠の利用量とリセット時刻を確認します。" },
  { id: "logs", label: "監査ログ", description: "質問本文を含まない利用記録と管理者操作を確認します。" },
];

const number = new Intl.NumberFormat("ja-JP");
const dateTime = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(1)}秒`;
}

const outcomeLabels: Record<string, string> = {
  success: "成功",
  daily_quota: "日次上限",
  rate_limit: "短時間制限",
  unavailable: "API障害",
  images_unsupported: "画像非対応",
  cancelled: "中止",
  failed: "失敗",
  user_daily_limit: "個人上限",
};

const auditLabels: Record<string, string> = {
  "admin.login": "管理者としてログイン",
  "admin.overview.view": "管理画面を閲覧",
  "admin.role.grant": "共同管理者に追加",
  "admin.role.revoke": "共同管理者を解除",
  "assistant.delete": "管理者権限でアシスタントを削除",
  "source.check": "資料の更新を確認",
};

function quotaStateLabel(state: AdminOverview["quota"]["state"]): string {
  if (state === "daily_quota") return "本日分を使い切りました";
  if (state === "rate_limited") return "短時間の利用制限中";
  return "利用可能";
}

function sourceLabel(source: string): string {
  return source === "wiki" ? "Wiki" : "公式サイト";
}

function changeCount(result: SourceCheckResult): number {
  return result.deltas.reduce(
    (total, delta) => total + delta.added.length + delta.updated.length + delta.removed.length,
    0,
  );
}

function sortValue(user: AdminUserUsage, key: SortKey): string | number {
  if (key === "lastUsed") return user.lastUsed ? new Date(user.lastUsed).getTime() : 0;
  return user[key];
}

function inPeriod(value: string, period: string): boolean {
  if (period === "all") return true;
  const occurred = new Date(value).getTime();
  if (Number.isNaN(occurred)) return false;
  const days = Number(period);
  return occurred >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function sameVersion(frontend: string, backend: string): boolean {
  if (!frontend || !backend || frontend === "local" || backend === "local") return true;
  return frontend.startsWith(backend) || backend.startsWith(frontend);
}

function progressLabel(stage: AdminOverview["updateProgress"]["stage"]): string {
  switch (stage) {
    case "unavailable": return "更新確認を利用できません";
    case "not_checked": return "更新確認待ち";
    case "changes_detected": return "再構築・差分確認待ち";
    case "verify_needed": return "反映後の再確認待ち";
    default: return "最新です";
  }
}

export function AdminPage({ username, onBack, onLogout }: Props) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [roleBusy, setRoleBusy] = useState("");
  const [checkingSources, setCheckingSources] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("thirtyDays");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [usageLogSearch, setUsageLogSearch] = useState("");
  const [usageLogPeriod, setUsageLogPeriod] = useState("7");
  const [usageLogOutcome, setUsageLogOutcome] = useState("all");
  const [auditLogSearch, setAuditLogSearch] = useState("");
  const [auditLogPeriod, setAuditLogPeriod] = useState("30");
  const [auditLogAction, setAuditLogAction] = useState("all");
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  const toastMessage = useRef("");
  const headerMenus = useRef<HTMLDivElement>(null);
  const profileTrigger = useRef<HTMLButtonElement>(null);

  function hideToast() {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastMessage.current = "";
    setToast("");
  }

  // チャット画面と同じく、同一文言の再通知で表示時間を延ばさない。
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

  async function refresh() {
    setLoading(true);
    try {
      setData(await adminOverview());
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "管理情報を読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    function close(event: MouseEvent) {
      if (!headerMenus.current?.contains(event.target as Node)) setProfileOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setProfileOpen(false);
      profileTrigger.current?.focus();
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [profileOpen]);

  const users = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ja");
    const filtered = data?.users.filter((user) =>
      !query || user.username.toLocaleLowerCase("ja").includes(query)) ?? [];
    return [...filtered].sort((left, right) => {
      const a = sortValue(left, sortKey);
      const b = sortValue(right, sortKey);
      const order = typeof a === "string" && typeof b === "string"
        ? a.localeCompare(b, "ja")
        : Number(a) - Number(b);
      return sortDirection === "asc" ? order : -order;
    });
  }, [data?.users, search, sortDirection, sortKey]);

  const usageEvents = useMemo(() => {
    const query = usageLogSearch.trim().toLocaleLowerCase("ja");
    return data?.usageEvents.filter((event) => {
      const matchesText = !query || [event.username, event.assistantId, event.responseMode, event.resolvedMode]
        .some((value) => value?.toLocaleLowerCase("ja").includes(query));
      return matchesText && inPeriod(event.occurredAt, usageLogPeriod) &&
        (usageLogOutcome === "all" || event.outcome === usageLogOutcome);
    }) ?? [];
  }, [data?.usageEvents, usageLogOutcome, usageLogPeriod, usageLogSearch]);

  const adminAudits = useMemo(() => {
    const query = auditLogSearch.trim().toLocaleLowerCase("ja");
    return data?.adminAudits.filter((audit) => {
      const matchesText = !query || [audit.actor, audit.target, auditLabels[audit.action], audit.action]
        .some((value) => value?.toLocaleLowerCase("ja").includes(query));
      return matchesText && inPeriod(audit.occurredAt, auditLogPeriod) &&
        (auditLogAction === "all" || audit.action === auditLogAction);
    }) ?? [];
  }, [auditLogAction, auditLogPeriod, auditLogSearch, data?.adminAudits]);

  const usageOutcomes = useMemo(() => [...new Set(data?.usageEvents.map((event) => event.outcome) ?? [])], [data?.usageEvents]);
  const auditActions = useMemo(() => [...new Set(data?.adminAudits.map((audit) => audit.action) ?? [])], [data?.adminAudits]);

  function changeSort(next: SortKey) {
    if (next === sortKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
    } else {
      setSortKey(next);
      setSortDirection(next === "username" ? "asc" : "desc");
    }
  }

  function sortMark(key: SortKey): string {
    if (key !== sortKey) return "";
    return sortDirection === "asc" ? " ↑" : " ↓";
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | "none" {
    if (key !== sortKey) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  }

  function changeSortSelect(value: string) {
    const [key, direction] = value.split(":") as [SortKey, "asc" | "desc"];
    setSortKey(key);
    setSortDirection(direction);
  }

  async function changeRole(target: AdminUserUsage, enabled: boolean) {
    const action = enabled ? "共同管理者にします" : "共同管理者権限を解除します";
    if (!window.confirm(`${target.username}さんを${action}。よろしいですか？`)) return;
    setRoleBusy(target.username);
    try {
      await setCoAdmin(target.username, enabled);
      await refresh();
      showToast(enabled ? `${target.username}さんを共同管理者にしました` : `${target.username}さんの共同管理者権限を解除しました`);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "管理者権限を変更できませんでした");
    } finally {
      setRoleBusy("");
    }
  }

  async function runSourceCheck() {
    setCheckingSources(true);
    try {
      const result = await checkSources();
      await refresh();
      showToast(result.changed ? `${changeCount(result)}件の資料変更を検出しました` : "Wikiと公式サイトに変更はありませんでした");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "更新を確認できませんでした");
    } finally {
      setCheckingSources(false);
    }
  }

  async function copyPublishSteps() {
    try {
      await navigator.clipboard.writeText("python rebuild.py\nsh tools/publish-index.sh");
      showToast("再構築と本番反映のコマンドをコピーしました");
    } catch {
      showToast("コピーできませんでした。コマンドを選択してコピーしてください");
    }
  }

  const isOwner = data?.currentAdmin.role === "owner";
  const lastCheck = data?.sourceCheck.last;
  const currentTab = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const versionMismatch = Boolean(data && !sameVersion(__WASA_BUILD_VERSION__, data.system.codeVersion));
  const alerts = useMemo<AdminAlert[]>(() => {
    if (!data) return [];
    if (!versionMismatch) return data.alerts;
    return [{
      id: "version-mismatch", severity: "danger", title: "画面とAPIのバージョンが一致していません",
      detail: `画面 ${__WASA_BUILD_VERSION__} / API ${data.system.codeVersion}。Cloud Runの再デプロイを確認してください。`, tab: "overview",
    }, ...data.alerts];
  }, [data, versionMismatch]);

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-brand">
          <button type="button" className="sidebar-toggle admin-back" onClick={onBack} aria-label="チャットへ戻る" title="チャットへ戻る">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          </button>
          <img src="/assets/wasa-chat-logo-photo-trimmed.png" alt="WASA Chat" className="admin-logo" />
          <span className="admin-mode-label">管理</span>
        </div>
        <div className="header-actions" ref={headerMenus}>
          <button type="button" className="header-icon admin-refresh" onClick={() => void refresh()} disabled={loading} aria-label="管理情報を再読み込み" title="再読み込み">
            {loading ? <span className="admin-spinner" aria-hidden="true" /> : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 0-14.9-4M4 4v4h4M4 12a8 8 0 0 0 14.9 4M20 20v-4h-4" /></svg>
            )}
          </button>
          <div className="header-menu-wrap">
            <button
              ref={profileTrigger}
              type="button"
              className="profile-avatar"
              aria-label={`利用者メニュー: ${username}`}
              aria-expanded={profileOpen}
              aria-controls="admin-profile-popover"
              onClick={() => setProfileOpen((open) => !open)}
            >
              {Array.from(username)[0] ?? "W"}
            </button>
            {profileOpen && (
              <section className="header-popover profile-popover" id="admin-profile-popover" aria-label="利用者メニュー">
                <div className="profile-summary"><span>管理者としてログイン中</span><strong>{username}</strong></div>
                <button type="button" onClick={onBack}>チャットへ戻る</button>
                <a href={WIKI_URL} target="_blank" rel="noreferrer noopener">WASA Wikiを開く</a>
                <a href={SUPPORT_URL} target="_blank" rel="noreferrer noopener">ヘルプとポリシー</a>
                <button type="button" onClick={onLogout}>ログアウト</button>
              </section>
            )}
          </div>
        </div>
      </header>

      {!data && loading && <p className="admin-loading" role="status">管理情報を読み込んでいます…</p>}

      {data && (
        <main className="admin-main">
          <div className="admin-tabs" role="tablist" aria-label="管理メニュー">
            {tabs.map((tab) => (
              <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>

          <header className="admin-page-title">
            <h2>{currentTab.label}</h2>
            <p>{currentTab.description}</p>
          </header>

          {activeTab === "overview" && (
            <>
              <section aria-labelledby="admin-alerts-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-alerts-title">要対応</h3><p>確認や作業が必要な項目を優先順に表示します。</p></div>
                  <span className={`admin-pill ${alerts.length > 0 ? "has-alert" : ""}`}>{alerts.length}件</span>
                </div>
                {alerts.length === 0 ? (
                  <div className="admin-all-clear"><span aria-hidden="true">✓</span><div><strong>現在、対応が必要な項目はありません</strong><small>資料、API、実行状態に既知の問題はありません。</small></div></div>
                ) : (
                  <div className="admin-alert-list">
                    {alerts.map((alert) => (
                      <button key={alert.id} type="button" className={`admin-alert severity-${alert.severity}`} onClick={() => setActiveTab(alert.tab)}>
                        <span className="admin-alert-mark" aria-hidden="true">{alert.severity === "danger" ? "!" : alert.severity === "warning" ? "!" : "i"}</span>
                        <span><strong>{alert.title}</strong><small>{alert.detail}</small></span>
                        <span aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section aria-labelledby="admin-summary-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-summary-title">今日の状態</h3><p>最終取得: {formatDateTime(data.generatedAt)}</p></div>
                </div>
                <div className="admin-stat-grid">
                  <article className="admin-stat"><span>質問</span><strong>{number.format(data.summary.todayQuestions)}</strong><small>日本時間の今日</small></article>
                  <article className="admin-stat"><span>利用者</span><strong>{number.format(data.summary.activeUsersToday)}</strong><small>登録 {number.format(data.summary.knownUsers)}人</small></article>
                  <article className={`admin-stat quota-${data.quota.state}`}><span>Gemini</span><strong>{quotaStateLabel(data.quota.state)}</strong><small>{data.quota.retryAt ? `${formatDateTime(data.quota.retryAt)}まで` : `リセット ${formatDateTime(data.quota.resetAt)}`}</small></article>
                </div>
              </section>
              <section aria-labelledby="admin-version-title">
                <div className="admin-section-head"><div><h3 id="admin-version-title">本番バージョン</h3><p>画面・API・索引が意図した版へ切り替わったか確認します。</p></div><span className={`admin-pill ${versionMismatch ? "has-alert" : ""}`}>{versionMismatch ? "不一致" : "一致"}</span></div>
                <div className="admin-version-grid">
                  <article><span>画面</span><strong>{__WASA_BUILD_VERSION__}</strong><small>Cloudflare Pages</small></article>
                  <article><span>API</span><strong>{data.system.codeVersion || "不明"}</strong><small>{data.system.revision || "リビジョン不明"}</small></article>
                  <article><span>索引</span><strong>{data.system.indexVersion || "不明"}</strong><small>{data.system.indexPublishedAt ? `${formatDateTime(data.system.indexPublishedAt)}公開` : "公開日時不明"}</small></article>
                </div>
              </section>
              <details className="admin-system">
                <summary>障害調査用の実行情報</summary>
                <dl><div><dt>LLM</dt><dd>{data.system.llm || "未設定"}</dd></div><div><dt>保存先</dt><dd>{data.system.store || "不明"}</dd></div><div><dt>索引読込元</dt><dd>{data.system.indexSource || "不明"}</dd></div><div><dt>API起動</dt><dd>{formatDateTime(data.system.startedAt)}</dd></div></dl>
              </details>
            </>
          )}

          {activeTab === "sources" && (
            <>
              <section aria-labelledby="admin-progress-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-progress-title">更新作業の進捗</h3><p>公開元の確認から、本番索引の反映確認までを追跡します。</p></div>
                  <span className={`admin-pill progress-${data.updateProgress.stage}`}>{progressLabel(data.updateProgress.stage)}</span>
                </div>
                <div className="admin-progress" data-stage={data.updateProgress.stage}>
                  <article className={data.updateProgress.checkedAt ? "complete" : "active"}><span>1</span><div><strong>公開元を確認</strong><small>{data.updateProgress.checkedAt ? formatDateTime(data.updateProgress.checkedAt) : "未確認"}</small></div></article>
                  <i aria-hidden="true" />
                  <article className={data.updateProgress.stage === "changes_detected" ? "active" : data.updateProgress.stage === "verify_needed" || data.updateProgress.stage === "current" ? "complete" : ""}><span>2</span><div><strong>再構築・差分確認</strong><small>{data.updateProgress.stage === "changes_detected" ? "手元で作業してください" : data.updateProgress.stage === "current" ? "変更なし" : data.updateProgress.stage === "verify_needed" ? "本番反映から確認" : "変更検出後に実施"}</small></div></article>
                  <i aria-hidden="true" />
                  <article className={data.updateProgress.stage === "verify_needed" || data.updateProgress.stage === "current" ? "complete" : ""}><span>3</span><div><strong>本番へ反映</strong><small>{data.updateProgress.publishedAt ? formatDateTime(data.updateProgress.publishedAt) : "公開記録なし"}</small></div></article>
                  <i aria-hidden="true" />
                  <article className={data.updateProgress.stage === "current" ? "complete" : data.updateProgress.stage === "verify_needed" ? "active" : ""}><span>4</span><div><strong>反映後を再確認</strong><small>{data.updateProgress.stage === "current" ? "変更なしを確認済み" : data.updateProgress.stage === "verify_needed" ? "更新確認を実行してください" : "本番反映後に実施"}</small></div></article>
                </div>
                <p className="admin-progress-note">再構築と差分確認は保守者の手元で行うため、管理画面では本番公開日時をもとに完了を判定します。</p>
              </section>
              <section aria-labelledby="admin-source-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-source-title">更新確認</h3><p>現在の索引と公開元の改訂番号・更新日だけを比較します。</p></div>
                  <button type="button" className="admin-primary" onClick={() => void runSourceCheck()} disabled={checkingSources || !data.sourceCheck.available}>
                    {checkingSources ? "確認中…" : "更新を確認"}
                  </button>
                </div>
                <div className="admin-source-card">
                  {!data.sourceCheck.available ? (
                    <p className="admin-empty">更新確認用Wikiアカウントの設定後に利用できます。</p>
                  ) : !lastCheck ? (
                    <p className="admin-empty">まだ確認していません。</p>
                  ) : (
                    <>
                      <div className={`admin-source-result ${lastCheck.changed ? "has-change" : "no-change"}`}>
                        <strong>{lastCheck.changed ? `${changeCount(lastCheck)}件の変更があります` : "変更はありません"}</strong>
                        <span>{formatDateTime(lastCheck.checkedAt)}・{lastCheck.checkedBy}</span>
                      </div>
                      <div className="admin-source-deltas">
                        {lastCheck.deltas.map((delta) => {
                          const items = [
                            ...delta.added.map((name) => `追加: ${name}`),
                            ...delta.updated.map((name) => `更新: ${name}`),
                            ...delta.removed.map((name) => `削除: ${name}`),
                          ];
                          return (
                            <details key={delta.source} open={items.length > 0}>
                              <summary>{sourceLabel(delta.source)}　追加 {delta.added.length}・更新 {delta.updated.length}・削除 {delta.removed.length}</summary>
                              {items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>変更なし</p>}
                            </details>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </section>

              <section aria-labelledby="admin-publish-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-publish-title">再構築と本番反映</h3><p>変更を回答へ取り込む作業です。</p></div>
                  <span className="admin-pill">現在は手元で実行</span>
                </div>
                <div className="admin-publish-guide">
                  <p><strong>この管理画面からは、まだ実行できません。</strong> 現在のAPIコンテナにはPythonがなく、実行権限も索引の読み取りに絞っています。誤編集を確認せず公開する事故を避けるため、自動反映もしません。</p>
                  <ol>
                    <li><span>1</span><div><strong>索引を再構築する</strong><code>python rebuild.py</code><small>Wiki・公式サイトを取得し直し、索引生成と検索検査を行います。</small></div></li>
                    <li><span>2</span><div><strong>差分を人が確認する</strong><small>意図しない削除や誤編集が混ざっていないことを確認します。</small></div></li>
                    <li><span>3</span><div><strong>本番へ反映する</strong><code>sh tools/publish-index.sh</code><small>Cloud Storageを差し替え、新しいCloud Runリビジョンへ切り替えます。</small></div></li>
                  </ol>
                  <div className="admin-publish-actions">
                    <button type="button" className="admin-secondary" onClick={() => void copyPublishSteps()}>2つのコマンドをコピー</button>
                  </div>
                  <details>
                    <summary>将来、管理画面から実行するには</summary>
                    <p>チャットAPIへ強い権限を足すのではなく、専用Cloud Run Jobで再構築して一旦ステージングへ保存し、結果を管理画面で確認したあとに別操作で公開する構成が必要です。ジョブの実行サービスアカウントだけにWiki読取・GCS書込権限を与えます。</p>
                  </details>
                </div>
              </section>
            </>
          )}

          {activeTab === "users" && (
            <>
              <section aria-labelledby="admin-roles-title">
                <div className="admin-section-head">
                  <div><h3 id="admin-roles-title">管理者</h3><p>主管理者は設定に残る復旧担当です。共同管理者の追加・解除は利用者一覧から行います。</p></div>
                  <span className="admin-pill">{data.admins.length}人</span>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead><tr><th>Wiki利用者名</th><th>権限</th><th>付与者</th><th>付与日時</th></tr></thead>
                    <tbody>{data.admins.map((admin) => (
                      <tr key={admin.username}><th>{admin.username}</th><td><span className="admin-role-badge">{admin.role === "owner" ? "主管理者" : "共同管理者"}</span></td><td>{admin.grantedBy || "—"}</td><td>{formatDateTime(admin.grantedAt)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="admin-users-title">
                <div className="admin-section-head admin-user-head">
                  <div><h3 id="admin-users-title">利用者一覧</h3><p>WASA Chatへログインした全利用者です。一覧にいない人は、一度ログインすると追加されます。</p></div>
                  <div className="admin-user-tools">
                    <label><span className="sr-only">利用者名を検索</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名前で検索" /></label>
                    <label><span className="sr-only">利用者の並び順</span><select value={`${sortKey}:${sortDirection}`} onChange={(event) => changeSortSelect(event.target.value)}>
                      <option value="thirtyDays:desc">30日利用が多い順</option><option value="sevenDays:desc">7日利用が多い順</option><option value="today:desc">今日の利用が多い順</option><option value="lastUsed:desc">最近利用した順</option><option value="username:asc">名前順</option>
                    </select></label>
                    <span className="admin-pill">{users.length} / {data.users.length}人</span>
                  </div>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead><tr>
                      <th aria-sort={ariaSort("username")}><button type="button" onClick={() => changeSort("username")}>Wiki利用者名{sortMark("username")}</button></th>
                      <th aria-sort={ariaSort("today")}><button type="button" onClick={() => changeSort("today")}>今日{sortMark("today")}</button></th>
                      <th aria-sort={ariaSort("sevenDays")}><button type="button" onClick={() => changeSort("sevenDays")}>7日{sortMark("sevenDays")}</button></th>
                      <th aria-sort={ariaSort("thirtyDays")}><button type="button" onClick={() => changeSort("thirtyDays")}>30日{sortMark("thirtyDays")}</button></th>
                      <th aria-sort={ariaSort("lastUsed")}><button type="button" onClick={() => changeSort("lastUsed")}>最終利用{sortMark("lastUsed")}</button></th>
                      <th>管理権限</th>
                    </tr></thead>
                    <tbody>{users.length === 0 ? (
                      <tr><td colSpan={6} className="admin-empty">該当する利用者はいません</td></tr>
                    ) : users.map((user) => (
                      <tr key={user.username}>
                        <th>{user.username}</th><td>{user.today}{user.limitReached && <span className="admin-warning">上限</span>}</td><td>{user.sevenDays}</td><td>{user.thirtyDays}</td><td>{formatDateTime(user.lastUsed)}</td>
                        <td>{user.role === "owner" ? <span className="admin-role-badge">主管理者</span> : user.role === "co_admin" ? (
                          <div className="admin-role-action"><span className="admin-role-badge">共同管理者</span>{isOwner && <button type="button" disabled={roleBusy === user.username} onClick={() => void changeRole(user, false)}>解除</button>}</div>
                        ) : isOwner ? <button type="button" className="admin-link-button" disabled={roleBusy === user.username} onClick={() => void changeRole(user, true)}>共同管理者にする</button> : "—"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {!isOwner && <p className="admin-footnote">共同管理者の追加・解除は主管理者だけが行えます。</p>}
              </section>
            </>
          )}

          {activeTab === "quota" && (
            <section aria-labelledby="admin-quota-title">
              <div className="admin-section-head"><div><h3 id="admin-quota-title">Gemini無料枠</h3><p>再試行を含む送信試行回数です。ほかのAPIキーからの利用は含みません。</p></div><span className="admin-pill">太平洋時間 {data.quota.day}</span></div>
              <div className="admin-quota-list">
                {data.quota.models.length === 0 && <p className="admin-empty">現在はGeminiを使用していません</p>}
                {data.quota.models.map((model) => {
                  const ratio = model.limit > 0 ? Math.min(model.requests / model.limit, 1) : 0;
                  return (
                    <article key={model.model} className="admin-quota-card">
                      <div><strong>{model.model}</strong><span>推定残り {number.format(model.remaining)}回</span></div>
                      <div className="admin-meter" role="meter" aria-label={`${model.model}の利用率`} aria-valuemin={0} aria-valuemax={model.limit} aria-valuenow={model.requests}><span style={{ width: `${ratio * 100}%` }} /></div>
                      <small>{number.format(model.requests)} / {number.format(model.limit)}リクエスト・通常約{number.format(Math.floor(model.remaining / 3))}質問分</small>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {activeTab === "logs" && (
            <>
              <section aria-labelledby="admin-events-title">
                <div className="admin-section-head admin-log-head"><div><h3 id="admin-events-title">利用ログ</h3><p>質問本文を含まない直近100件です。90日で削除します。</p></div><span className="admin-pill">{usageEvents.length} / {data.usageEvents.length}件</span></div>
                <div className="admin-log-tools" aria-label="利用ログの絞り込み">
                  <label><span>検索</span><input type="search" value={usageLogSearch} onChange={(event) => setUsageLogSearch(event.target.value)} placeholder="利用者・アシスタント" /></label>
                  <label><span>期間</span><select value={usageLogPeriod} onChange={(event) => setUsageLogPeriod(event.target.value)}><option value="1">24時間</option><option value="7">7日</option><option value="30">30日</option><option value="all">すべて</option></select></label>
                  <label><span>結果</span><select value={usageLogOutcome} onChange={(event) => setUsageLogOutcome(event.target.value)}><option value="all">すべて</option>{usageOutcomes.map((outcome) => <option key={outcome} value={outcome}>{outcomeLabels[outcome] ?? outcome}</option>)}</select></label>
                  <button type="button" onClick={() => { setUsageLogSearch(""); setUsageLogPeriod("7"); setUsageLogOutcome("all"); }}>絞り込みを解除</button>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-table admin-log-table">
                    <thead><tr><th>日時</th><th>利用者</th><th>結果</th><th>利用</th><th>モード</th><th>所要時間</th></tr></thead>
                    <tbody>{usageEvents.length === 0 ? <tr><td colSpan={6} className="admin-empty">条件に一致する記録はありません</td></tr> : usageEvents.map((event) => (
                      <tr key={event.id}><td>{formatDateTime(event.occurredAt)}</td><th>{event.username}</th><td>{outcomeLabels[event.outcome] ?? event.outcome}</td><td>{event.assistantId || "汎用"}{event.hasAttachment ? "・画像" : ""}</td><td>{event.resolvedMode || event.responseMode || "—"}</td><td>{duration(event.durationMs)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
              <section aria-labelledby="admin-audits-title">
                <div className="admin-section-head admin-log-head"><div><h3 id="admin-audits-title">管理者操作ログ</h3><p>管理者として行った操作を1年間保持します。</p></div><span className="admin-pill">{adminAudits.length} / {data.adminAudits.length}件</span></div>
                <div className="admin-log-tools" aria-label="管理者操作ログの絞り込み">
                  <label><span>検索</span><input type="search" value={auditLogSearch} onChange={(event) => setAuditLogSearch(event.target.value)} placeholder="管理者・対象" /></label>
                  <label><span>期間</span><select value={auditLogPeriod} onChange={(event) => setAuditLogPeriod(event.target.value)}><option value="1">24時間</option><option value="7">7日</option><option value="30">30日</option><option value="all">すべて</option></select></label>
                  <label><span>操作</span><select value={auditLogAction} onChange={(event) => setAuditLogAction(event.target.value)}><option value="all">すべて</option>{auditActions.map((action) => <option key={action} value={action}>{auditLabels[action] ?? action}</option>)}</select></label>
                  <button type="button" onClick={() => { setAuditLogSearch(""); setAuditLogPeriod("30"); setAuditLogAction("all"); }}>絞り込みを解除</button>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-table admin-log-table">
                    <thead><tr><th>日時</th><th>管理者</th><th>操作</th><th>対象</th></tr></thead>
                    <tbody>{adminAudits.length === 0 ? <tr><td colSpan={4} className="admin-empty">条件に一致する記録はありません</td></tr> : adminAudits.map((audit) => (
                      <tr key={audit.id}><td>{formatDateTime(audit.occurredAt)}</td><th>{audit.actor}</th><td>{auditLabels[audit.action] ?? audit.action}</td><td>{audit.target || "—"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </main>
      )}

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
