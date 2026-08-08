package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

// ---------------------------------------------------------------- Gemini

// Gemini は Google Gemini のクライアント。
//
// ⚠️ 無料枠は送信内容がモデルの学習に使われる場合がある。
// 対象は非公開Wikiの本文であることを承知のうえで選択すること。
type Gemini struct {
	key          string
	model        string
	http         *http.Client
	requestSlot  chan struct{}
	lastRequest  time.Time
	blockedUntil time.Time
	blockedErr   error
	minInterval  time.Duration
	maxRetries   int
}

const geminiBase = "https://generativelanguage.googleapis.com/v1beta"

func NewGemini(key, model string, minInterval time.Duration, maxRetries int) *Gemini {
	if minInterval < 0 {
		minInterval = 0
	}
	if maxRetries < 0 {
		maxRetries = 0
	}
	return &Gemini{
		key: key, model: model, http: &http.Client{}, requestSlot: make(chan struct{}, 1),
		minInterval: minInterval, maxRetries: maxRetries,
	}
}

func (g *Gemini) acquire(ctx context.Context, onWait func(WaitInfo)) error {
	select {
	case g.requestSlot <- struct{}{}:
		return nil
	default:
		if onWait != nil {
			onWait(WaitInfo{Reason: "queue"})
		}
	}
	select {
	case g.requestSlot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *Gemini) release() { <-g.requestSlot }

func (g *Gemini) Name() string { return "gemini/" + g.model }

// ListModels は generateContent が使えるモデル名を返す。
// モデル名は変わりやすいため、固定せず問い合わせて確かめられるようにしている。
func (g *Gemini) ListModels(ctx context.Context) ([]string, error) {
	url := fmt.Sprintf("%s/models?pageSize=200", geminiBase)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-goog-api-key", g.key)
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

var retryDelayPattern = regexp.MustCompile(`"retryDelay"\s*:\s*"([^"]+)"`)

func retryDelay(resp *http.Response, detail []byte, fallback time.Duration) time.Duration {
	if raw := resp.Header.Get("Retry-After"); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second
		}
		if at, err := http.ParseTime(raw); err == nil {
			if wait := time.Until(at); wait > 0 {
				return wait
			}
		}
	}
	if match := retryDelayPattern.FindSubmatch(detail); len(match) == 2 {
		if wait, err := time.ParseDuration(string(match[1])); err == nil && wait >= 0 {
			return wait
		}
	}
	return fallback
}

func clampDuration(value, minimum, maximum time.Duration) time.Duration {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func isDailyQuota(detail []byte) bool {
	lower := strings.ToLower(string(detail))
	return strings.Contains(lower, "perday") ||
		strings.Contains(lower, "per_day") ||
		strings.Contains(lower, "requests per day") ||
		strings.Contains(lower, "rpd")
}

func untilPacificMidnight(now time.Time) time.Duration {
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		return 24 * time.Hour
	}
	local := now.In(location)
	next := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, location)
	return next.Sub(local)
}

// waitRequest は全利用者のGemini呼び出しを同じ間隔に整える。
// 無料枠はプロジェクト単位なので、利用者ごとの待機だけでは同時送信を防げない。
func (g *Gemini) waitRequest(ctx context.Context, retryWait time.Duration, onWait func(WaitInfo)) error {
	wait := retryWait
	reason := "retry"
	if !g.lastRequest.IsZero() {
		if intervalWait := g.minInterval - time.Since(g.lastRequest); intervalWait > wait {
			wait = intervalWait
			reason = "pace"
		}
	}
	if wait > 0 {
		if onWait != nil {
			onWait(WaitInfo{Reason: reason, Until: time.Now().Add(wait)})
		}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	g.lastRequest = time.Now()
	return nil
}

func (g *Gemini) do(ctx context.Context, method string, body map[string]any, onWait func(WaitInfo)) (*http.Response, error) {
	if time.Now().Before(g.blockedUntil) {
		blockedErr := g.blockedErr
		if blockedErr == nil {
			blockedErr = ErrRateLimited
		}
		return nil, fmt.Errorf("%w: Geminiの再試行待機中", withRetryAt(blockedErr, g.blockedUntil))
	}
	g.blockedUntil = time.Time{}
	g.blockedErr = nil
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	// APIキーはクエリ文字列ではなくヘッダで渡す。
	// クエリに載せると、通信エラー時の *url.Error にURLごと鍵が入り、
	// サーバーログ（log.Printf("%v", err)）にそのまま残ってしまう
	url := fmt.Sprintf("%s/models/%s:%s", geminiBase, g.model, method)
	if method == "streamGenerateContent" {
		url += "?alt=sse"
	}

	var wait time.Duration
	for attempt := 0; ; attempt++ {
		if err := g.waitRequest(ctx, wait, onWait); err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-goog-api-key", g.key)
		resp, err := g.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt < g.maxRetries {
				wait = time.Duration(1<<attempt) * time.Second
				continue
			}
			return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		if resp.StatusCode == http.StatusOK {
			g.blockedUntil = time.Time{}
			g.blockedErr = nil
			return resp, nil
		}

		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
			if resp.StatusCode == http.StatusTooManyRequests && isDailyQuota(detail) {
				// 日次上限は短時間待っても回復しないため、再試行せず太平洋時間0時まで止める。
				g.blockedUntil = time.Now().Add(untilPacificMidnight(time.Now()))
				g.blockedErr = ErrDailyQuota
				return nil, fmt.Errorf("%w: gemini が %s を返した", withRetryAt(ErrDailyQuota, g.blockedUntil), resp.Status)
			}
			if attempt < g.maxRetries {
				wait = clampDuration(
					retryDelay(resp, detail, time.Duration(1<<attempt)*time.Second),
					0,
					60*time.Second,
				)
				continue
			}
			if resp.StatusCode == http.StatusTooManyRequests {
				// 短時間の上限は1〜15分だけ回路を開き、全利用者からの無駄な再送を止める。
				cooldown := clampDuration(retryDelay(resp, detail, time.Minute), time.Minute, 15*time.Minute)
				g.blockedUntil = time.Now().Add(cooldown)
				g.blockedErr = ErrRateLimited
				return nil, fmt.Errorf("%w: gemini が %s を返した", withRetryAt(ErrRateLimited, g.blockedUntil), resp.Status)
			}
			return nil, fmt.Errorf("%w: gemini が %s を返した", ErrUnavailable, resp.Status)
		}
		return nil, fmt.Errorf("gemini が %s を返した", resp.Status)
	}
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
	if err := g.acquire(ctx, req.OnWait); err != nil {
		return "", err
	}
	defer g.release()
	resp, err := g.do(ctx, "generateContent", g.payload(req), req.OnWait)
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
	if err := g.acquire(ctx, req.OnWait); err != nil {
		return "", err
	}
	defer g.release()
	resp, err := g.do(ctx, "streamGenerateContent", g.payload(req), req.OnWait)
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
	if err := scanner.Err(); err != nil {
		return strings.TrimSpace(full.String()), fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return strings.TrimSpace(full.String()), nil
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
