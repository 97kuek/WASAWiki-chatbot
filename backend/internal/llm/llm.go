// Package llm は回答生成に使うモデルを抽象化する。
//
// 測定はローカル（Ollama）、本番は Claude を想定しており、
// パイプライン側は具象実装に依存しない。
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// WaitInfo はGeminiへの再送や送信間隔調整で、回答開始が遅れる理由を画面へ伝える。
type WaitInfo struct {
	Reason string
	Until  time.Time
}

type retryError struct {
	kind  error
	until time.Time
}

func (e *retryError) Error() string { return e.kind.Error() }
func (e *retryError) Unwrap() error { return e.kind }

func withRetryAt(kind error, until time.Time) error {
	return &retryError{kind: kind, until: until}
}

// RetryAt は上流が通知した再開時刻、または安全側に見積もった再開時刻を返す。
func RetryAt(err error) (time.Time, bool) {
	var target *retryError
	if !errors.As(err, &target) || target.until.IsZero() {
		return time.Time{}, false
	}
	return target.until, true
}

var (
	// ErrRateLimited はGemini側の短時間のRPM・TPM上限到達を表す。
	ErrRateLimited = errors.New("LLMの利用上限に到達")
	// ErrDailyQuota はGemini無料枠のRPD上限到達を表す。
	ErrDailyQuota = errors.New("LLMの日次利用上限に到達")
	// ErrUnavailable は一時的な通信障害や上流サービス障害を表す。
	ErrUnavailable = errors.New("LLMへ一時的に接続できない")
)

// Request の Cached / Prompt の分割には理由がある。
//
// Cached にはプロンプトの**先頭に置く固定部分**（目次）を入れる。
// 目次を毎回同じ位置・同じ内容で先頭に置くと、
//   - ローカル（llama.cpp）では KV キャッシュが再利用され、
//     プロンプト処理が 80秒 → 0.8秒 になる（M2a で実測）
//   - Claude では prompt caching が効き、入力費用が約 1/10 になる
//
// つまり「目次を先頭に固定する」ことが性能と費用の両方の要になっており、
// それを型で強制するために分けている。連結して1本の文字列にしてはいけない。
type Request struct {
	Cached string // 先頭固定部分（目次など）。キャッシュ対象
	// System は利用者の入力より強い立場で効かせたい指示。
	//
	// 利用者が作ったアシスタントの追加指示を Prompt に載せる以上、
	// 「出典を書くな」「資料に無くても答えろ」を無効化する規則は、
	// **同じユーザーメッセージの後ろに置くだけでは不十分**である。
	// 提供元が system / systemInstruction を持つなら必ずそちらへ回す。
	// 内容は毎回同じなのでキャッシュの分裂も起こさない。
	System    string
	Prompt    string          // 質問ごとに変わる部分
	Schema    json.RawMessage // 構造化出力のJSONスキーマ。nil なら自由形式
	MaxTokens int
	OnWait    func(WaitInfo) // nilなら待機状況を通知しない
}

// Delta はストリーミング中に届く差分。
type Delta func(text string)

type Client interface {
	// Complete は完了まで待って全文を返す。ページ選択など短い構造化出力に使う。
	Complete(ctx context.Context, req Request) (string, error)
	// Stream は差分を onDelta に流しつつ、最終的な全文を返す。回答生成に使う。
	Stream(ctx context.Context, req Request, onDelta Delta) (string, error)
	Name() string
}
