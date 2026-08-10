package llm

import (
	"context"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
)

// Claude は本番用のクライアント。
//
// Request.Cached（目次）を system ブロックに置き、cache_control を付ける。
// これが費用と待ち時間の両方に最も効く（docs/01-設計方針.md §7 の費用方針）。
// 目次は約1万トークンあり、キャッシュが効けば入力費用が約1/10になる。
type Claude struct {
	client anthropic.Client
	model  string
}

// DefaultModel は Claude Opus 5。費用を優先する場合は環境変数 CLAUDE_MODEL で
// claude-sonnet-5 に切り替える（1問あたり約¥9 → 約¥3.5）。
const DefaultModel = "claude-opus-5"

// NewClaude は ANTHROPIC_API_KEY（未設定なら ant のプロファイル）から認証情報を解決する。
func NewClaude(model string) *Claude {
	if model == "" {
		model = DefaultModel
	}
	return &Claude{client: anthropic.NewClient(), model: model}
}

func (c *Claude) Name() string { return c.model }

func (c *Claude) params(req Request) anthropic.MessageNewParams {
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 4096
	}

	prompt := req.Prompt
	if len(req.Schema) > 0 {
		// 構造化出力の指定はSDKのバージョン差が出やすいため、
		// スキーマをプロンプトに埋めて指示する形にしている。
		// APIキーを用意して実挙動を確認できたら output_config に寄せる。
		prompt += "\n\n次のJSONスキーマに厳密に従うJSONだけを出力してください。前置き・説明・コードフェンスは書かないこと。\n" +
			string(req.Schema)
	}

	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(c.model),
		MaxTokens: int64(maxTokens),
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(prompt)),
		},
	}
	if req.Cached != "" {
		// 目次は毎回同一なので、system ブロックに置いてキャッシュ対象にする。
		// 可変部分（質問）は messages 側にあり、キャッシュ境界より後ろになる。
		params.System = []anthropic.TextBlockParam{{
			Text:         req.Cached,
			CacheControl: anthropic.NewCacheControlEphemeralParam(),
		}}
	}
	if req.System != "" {
		// 利用者が作った指示より強い立場で効かせる規則。内容は毎回同じなので
		// キャッシュ境界より後ろに足してもキャッシュは分裂しない
		params.System = append(params.System, anthropic.TextBlockParam{Text: req.System})
	}
	return params
}

func (c *Claude) Complete(ctx context.Context, req Request) (string, error) {
	// 画像は未対応。Anthropic SDKは画像ブロックを持つが、本番はGeminiであり
	// 通す経路が無いまま黙って捨てるほうが危ない
	if len(req.Images) > 0 {
		return "", ErrImagesUnsupported
	}
	msg, err := c.client.Messages.New(ctx, c.params(req))
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for _, block := range msg.Content {
		if text, ok := block.AsAny().(anthropic.TextBlock); ok {
			out.WriteString(text.Text)
		}
	}
	return strings.TrimSpace(out.String()), nil
}

func (c *Claude) Stream(ctx context.Context, req Request, onDelta Delta) (string, error) {
	// 画像は未対応。Anthropic SDKは画像ブロックを持つが、本番はGeminiであり
	// 通す経路が無いまま黙って捨てるほうが危ない
	if len(req.Images) > 0 {
		return "", ErrImagesUnsupported
	}
	stream := c.client.Messages.NewStreaming(ctx, c.params(req))
	var full strings.Builder
	for stream.Next() {
		event := stream.Current()
		if delta, ok := event.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if text, ok := delta.Delta.AsAny().(anthropic.TextDelta); ok {
				full.WriteString(text.Text)
				onDelta(text.Text)
			}
		}
	}
	if err := stream.Err(); err != nil {
		return "", err
	}
	return strings.TrimSpace(full.String()), nil
}
