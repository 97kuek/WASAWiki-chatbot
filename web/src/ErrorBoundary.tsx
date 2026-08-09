import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 描画中に例外が出たとき、画面を白いままにしない。
 *
 * Reactは18以降、捕捉されない例外が出るとツリー全体を捨てる。境界が無いと
 * `#root`が空になり、利用者からは「突然真っ白になって何も見えない」という
 * 症状にしか見えない（2026-08-09に本番で報告あり）。原因を推測で塞ぐより、
 * まず「何が起きたか読める状態」にするのが先だと判断した。
 *
 * 表示する内容を最小限にしているのは、境界自身が壊れないようにするためである。
 * ここでアプリの状態やAPIに触ると、元の例外を隠した二次障害になる。
 */

type Props = { children: ReactNode };
type State = { message: string | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 利用者に「コンソールを見せてください」と頼めるよう、原因を残す
    console.error("WASA Chat 画面エラー", error, info.componentStack);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="center crash-page" role="alert">
        <div className="card crash-card">
          <h1>画面の表示に失敗しました</h1>
          <p className="muted">
            再読み込みで直ることがほとんどです。繰り返す場合は、下の内容を添えて
            管理者へ知らせてください。
          </p>
          <pre className="crash-detail">{this.state.message}</pre>
          <button type="button" onClick={() => location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }
}
