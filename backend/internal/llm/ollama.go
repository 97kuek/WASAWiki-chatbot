package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// Ollama はローカル測定用のクライアント。
// 非公開Wikiのデータを外部に出さずに精度を測るために使う。
type Ollama struct {
	Endpoint string
	Model    string
	NumCtx   int
	HTTP     *http.Client
}

func NewOllama(endpoint, model string) *Ollama {
	return &Ollama{
		Endpoint: strings.TrimRight(endpoint, "/"),
		Model:    model,
		NumCtx:   32768, // 目次だけで約1万トークン。既定の4096では黙って切り捨てられる
		HTTP:     &http.Client{},
	}
}

func (o *Ollama) Name() string { return "ollama/" + o.Model }

// think=false を指定しても qwen3 は思考を本文に混ぜてくることがあるため後処理で落とす。
// Claude では thinking が構造として分離されるので、この処理は Ollama 側にのみ置く。
var (
	thinkBlock = regexp.MustCompile(`(?is)<think>.*?</think>`)
	thinkTail  = regexp.MustCompile(`(?is)^.*?</think>\s*`)
)

func stripThinking(s string) string {
	s = thinkBlock.ReplaceAllString(s, "")
	if strings.Contains(strings.ToLower(s), "</think>") {
		s = thinkTail.ReplaceAllString(s, "")
	}
	return strings.TrimSpace(s)
}

func (o *Ollama) body(req Request, stream bool) ([]byte, error) {
	// 手元の既定モデル（qwen3:30b-a3b）は画像を読めない。黙って捨てると
	// **画像を見て答えたつもりの嘘**が返るので、必ず失敗させる
	if len(req.Images) > 0 {
		return nil, ErrImagesUnsupported
	}
	payload := map[string]any{
		"model": o.Model,
		// Cached を必ず先頭に置く。llama.cpp のプレフィックスキャッシュが効く条件。
		"prompt": req.Cached + req.Prompt,
		"stream": stream,
		"think":  false,
		// /api/generate の system はテンプレートのシステム役へ入る。
		// 測定用のローカル実行でも、本番と同じ強さの区別を保つ
		"system": req.System,
		"options": map[string]any{
			"num_ctx":     o.NumCtx,
			"temperature": 0,
			"num_predict": req.MaxTokens,
		},
	}
	if len(req.Schema) > 0 {
		payload["format"] = json.RawMessage(req.Schema)
	}
	return json.Marshal(payload)
}

func (o *Ollama) post(ctx context.Context, body []byte) (*http.Response, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, o.Endpoint+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	resp, err := o.HTTP.Do(r)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("ollama が %s を返した", resp.Status)
	}
	return resp, nil
}

func (o *Ollama) Complete(ctx context.Context, req Request) (string, error) {
	body, err := o.body(req, false)
	if err != nil {
		return "", err
	}
	resp, err := o.post(ctx, body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var out struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return stripThinking(out.Response), nil
}

func (o *Ollama) Stream(ctx context.Context, req Request, onDelta Delta) (string, error) {
	body, err := o.body(req, true)
	if err != nil {
		return "", err
	}
	resp, err := o.post(ctx, body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var full strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var frame struct {
			Response string `json:"response"`
			Done     bool   `json:"done"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			continue
		}
		if frame.Response != "" {
			full.WriteString(frame.Response)
			// 思考タグが閉じるまでは表に出さない
			if !strings.Contains(strings.ToLower(full.String()), "<think>") ||
				strings.Contains(strings.ToLower(full.String()), "</think>") {
				onDelta(frame.Response)
			}
		}
		if frame.Done {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return stripThinking(full.String()), nil
}
