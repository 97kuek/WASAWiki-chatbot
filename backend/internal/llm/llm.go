// Package llm は回答生成に使うモデルを抽象化する。
//
// 測定はローカル（Ollama）、本番は Claude を想定しており、
// パイプライン側は具象実装に依存しない。
package llm

import (
	"context"
	"encoding/json"
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
	Cached    string          // 先頭固定部分（目次など）。キャッシュ対象
	Prompt    string          // 質問ごとに変わる部分
	Schema    json.RawMessage // 構造化出力のJSONスキーマ。nil なら自由形式
	MaxTokens int
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
