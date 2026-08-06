package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ---------------------------------------------------------------- Gemini

// Gemini は Google Gemini のクライアント。
//
// ⚠️ 無料枠は送信内容がモデルの学習に使われる場合がある。
// 対象は非公開Wikiの本文であることを承知のうえで選択すること。
type Gemini struct {
	key   string
	model string
	http  *http.Client
}

const geminiBase = "https://generativelanguage.googleapis.com/v1beta"

func NewGemini(key, model string) *Gemini {
	return &Gemini{key: key, model: model, http: &http.Client{}}
}

func (g *Gemini) Name() string { return "gemini/" + g.model }

// ListModels は generateContent が使えるモデル名を返す。
// モデル名は変わりやすいため、固定せず問い合わせて確かめられるようにしている。
func (g *Gemini) ListModels(ctx context.Context) ([]string, error) {
	url := fmt.Sprintf("%s/models?key=%s&pageSize=200", geminiBase, g.key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out struct {
		Models []struct {
			Name    string   `json:"name"`
			Methods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	var names []string
	for _, m := range out.Models {
		for _, method := range m.Methods {
			if method == "generateContent" {
				names = append(names, strings.TrimPrefix(m.Name, "models/"))
				break
			}
		}
	}
	return names, nil
}

// geminiSchema は JSON Schema を Gemini の responseSchema へ変換する。
// 型名が大文字である点と、maxItems などの制約が通らない点が主な差分。
func geminiSchema(raw json.RawMessage) any {
	var schema map[string]any
	if json.Unmarshal(raw, &schema) != nil {
		return nil
	}
	return convertSchema(schema)
}

func convertSchema(schema map[string]any) map[string]any {
	types := map[string]string{
		"object": "OBJECT", "array": "ARRAY", "string": "STRING",
		"boolean": "BOOLEAN", "integer": "INTEGER", "number": "NUMBER",
	}
	out := map[string]any{}
	if t, ok := schema["type"].(string); ok {
		if mapped, ok := types[t]; ok {
			out["type"] = mapped
		}
	}
	if props, ok := schema["properties"].(map[string]any); ok {
		converted := map[string]any{}
		for k, v := range props {
			if child, ok := v.(map[string]any); ok {
				converted[k] = convertSchema(child)
			}
		}
		out["properties"] = converted
	}
	if items, ok := schema["items"].(map[string]any); ok {
		out["items"] = convertSchema(items)
	}
	if required, ok := schema["required"]; ok {
		out["required"] = required
	}
	return out
}

func (g *Gemini) payload(req Request) map[string]any {
	config := map[string]any{"temperature": 0, "maxOutputTokens": req.MaxTokens}
	if len(req.Schema) > 0 {
		config["responseMimeType"] = "application/json"
		config["responseSchema"] = geminiSchema(req.Schema)
	}
	// Cached を先頭に置く。Gemini でも同一プレフィックスは暗黙キャッシュの対象になる
	return map[string]any{
		"contents":         []any{map[string]any{"parts": []any{map[string]any{"text": req.Cached + req.Prompt}}}},
		"generationConfig": config,
	}
}

func (g *Gemini) do(ctx context.Context, method string, body map[string]any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("%s/models/%s:%s?key=%s", geminiBase, g.model, method, g.key)
	if method == "streamGenerateContent" {
		url += "&alt=sse"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		resp.Body.Close()
		return nil, fmt.Errorf("gemini が %s を返した: %s", resp.Status, detail)
	}
	return resp, nil
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
}

func (r geminiResponse) text() string {
	var out strings.Builder
	for _, c := range r.Candidates {
		for _, p := range c.Content.Parts {
			out.WriteString(p.Text)
		}
	}
	return out.String()
}

func (g *Gemini) Complete(ctx context.Context, req Request) (string, error) {
	resp, err := g.do(ctx, "generateContent", g.payload(req))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var parsed geminiResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	return strings.TrimSpace(parsed.text()), nil
}

func (g *Gemini) Stream(ctx context.Context, req Request, onDelta Delta) (string, error) {
	resp, err := g.do(ctx, "streamGenerateContent", g.payload(req))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var full strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimPrefix(scanner.Text(), "data: ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		var parsed geminiResponse
		if json.Unmarshal([]byte(line), &parsed) != nil {
			continue
		}
		if text := parsed.text(); text != "" {
			full.WriteString(text)
			onDelta(text)
		}
	}
	return strings.TrimSpace(full.String()), scanner.Err()
}

// ---------------------------------------------------------------- OpenAI互換

// Compat は OpenAI互換API。Grok(xAI) / Groq / Mistral / OpenRouter などが同じ形式。
type Compat struct {
	base  string
	key   string
	model string
	http  *http.Client
}

func NewCompat(base, key, model string) *Compat {
	return &Compat{base: strings.TrimRight(base, "/"), key: key, model: model, http: &http.Client{}}
}

func (c *Compat) Name() string { return "compat/" + c.model }

func (c *Compat) payload(req Request, stream bool) map[string]any {
	prompt := req.Cached + req.Prompt
	body := map[string]any{
		"model":       c.model,
		"messages":    []any{map[string]any{"role": "user", "content": prompt}},
		"temperature": 0,
		"max_tokens":  req.MaxTokens,
		"stream":      stream,
	}
	if len(req.Schema) > 0 {
		// json_schema モードは提供元によって対応が割れる。
		// 広く通る json_object と、プロンプトでのスキーマ指示を併用する
		body["messages"] = []any{map[string]any{"role": "user", "content": prompt +
			"\n\n次のJSONスキーマに厳密に従うJSONだけを出力してください。前置き・説明・コードフェンスは書かないこと。\n" +
			string(req.Schema)}}
		body["response_format"] = map[string]any{"type": "json_object"}
	}
	return body
}

func (c *Compat) do(ctx context.Context, body map[string]any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		resp.Body.Close()
		return nil, fmt.Errorf("%s が %s を返した: %s", c.base, resp.Status, detail)
	}
	return resp, nil
}

func (c *Compat) Complete(ctx context.Context, req Request) (string, error) {
	resp, err := c.do(ctx, c.payload(req, false))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func (c *Compat) Stream(ctx context.Context, req Request, onDelta Delta) (string, error) {
	resp, err := c.do(ctx, c.payload(req, true))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var full strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimPrefix(scanner.Text(), "data: ")
		if strings.TrimSpace(line) == "" || line == "[DONE]" {
			continue
		}
		var frame struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(line), &frame) != nil || len(frame.Choices) == 0 {
			continue
		}
		if text := frame.Choices[0].Delta.Content; text != "" {
			full.WriteString(text)
			onDelta(text)
		}
	}
	return strings.TrimSpace(full.String()), scanner.Err()
}
