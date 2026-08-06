// Package pipeline は「目次 → ページ選択 → チャンク絞り込み → 回答生成」を実装する。
//
// rag/pipeline.py（測定用）と同じ段構成・同じプロンプトである。
// Python 側で測った数字（docs/02-測定結果.md M2a: Page Recall@3 = 93.1%）が
// そのまま意味を持つよう、意図的に一致させている。片方だけ変えないこと。
package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/97kuek/WASAWiki-chatbot/backend/internal/index"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/llm"
)

const (
	maxPages = 3
	// 選択ページの本文をそのまま渡す上限。超えたらチャンク単位に絞る。
	// M2a では3ページの合計が最大48,100字になった（36,261字の「駆動・フレーム班」が原因）。
	directContextLimit = 12000
	maxChunks          = 8
)

// Event はSSEで画面に流す進捗。
// 「無言で待たされる5秒」と「検索中→3ページ読んでいます→回答中と流れる5秒」では
// 体感がまったく違う。進捗表示は実装が地味な割にUXへの効果が大きい。
type Event struct {
	Type    string   `json:"type"` // status | pages | delta | done | error
	Message string   `json:"message,omitempty"`
	Pages   []Source `json:"pages,omitempty"`
	Text    string   `json:"text,omitempty"`
}

type Source struct {
	Title      string `json:"title"`
	URL        string `json:"url"`
	LastEdited string `json:"last_edited"`
}

type Pipeline struct {
	ix  *index.Index
	llm llm.Client
}

func New(ix *index.Index, client llm.Client) *Pipeline {
	return &Pipeline{ix: ix, llm: client}
}

const selectPrompt = `---
上はWikiの目次です。次の質問に答えるために読むべきページを、目次のタイトルから
最大3件選んでください。

厳守すること:
- **目次に実在するページタイトルを、一字一句そのまま**書き写すこと
- 班の名前（空力、構造など）や節の名前をページタイトルとして書かないこと
- 目次に無いページ名を推測して作らないこと
- 関連が薄いものを埋め合わせで入れないこと

目次を見る限りWikiに答えが無いと判断できる場合は answerable を false にし、
titles には最も近そうなページだけを挙げてください。

質問: `

var selectSchema = json.RawMessage(`{"type":"object","properties":{"titles":{"type":"array","items":{"type":"string"},"maxItems":3},"answerable":{"type":"boolean"}},"required":["titles","answerable"]}`)

var chunkSchema = json.RawMessage(`{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string"},"maxItems":8}},"required":["ids"]}`)

const answerPrompt = `あなたは早稲田大学の鳥人間サークル WASA の引き継ぎ資料Wikiに詳しいアシスタントです。
以下の資料**だけ**を根拠に、質問に答えてください。

厳守すること:
- **必ず日本語で答える**
- 思考の過程は書かず、結論から書く
- 資料に書かれていないことは、推測で補わず「Wikiには記載がありません」と明示する
- 資料の一部しか答えられない場合は、**何が書かれていて何が書かれていないか**を分けて述べる
- 質問の前提が資料と食い違う場合は、まず前提の誤りを指摘する
- 回答の最後に、参照した資料を「出典: ページ名（最終更新: YYYY-MM）」の形で必ず挙げる
- 参照元が2年以上前の場合は、情報が古い可能性があることを添える

# 資料

%s

# 質問

%s
`

// Run は質問に答え、進行状況を emit に流す。
func (p *Pipeline) Run(ctx context.Context, question string, emit func(Event)) error {
	emit(Event{Type: "status", Message: "目次から関連ページを探しています"})

	pages, err := p.selectPages(ctx, question)
	if err != nil {
		return fmt.Errorf("ページ選択: %w", err)
	}
	if len(pages) == 0 {
		// M2b で、モデルが空文字列のタイトルを3件返して照合で全滅し、
		// 文脈ゼロになった事例があった。字面一致で拾い直す保険。
		pages = p.fallbackPages(question)
	}
	if len(pages) == 0 {
		emit(Event{Type: "delta", Text: "Wikiの目次から関連するページを特定できませんでした。"})
		emit(Event{Type: "done"})
		return nil
	}

	sources := make([]Source, 0, len(pages))
	for _, pg := range pages {
		sources = append(sources, Source{Title: pg.Title, URL: pg.URL, LastEdited: pg.LastEdited})
	}
	emit(Event{Type: "pages", Pages: sources})

	chunks, err := p.selectChunks(ctx, question, pages)
	if err != nil {
		return fmt.Errorf("節の絞り込み: %w", err)
	}
	emit(Event{Type: "status", Message: fmt.Sprintf("%d件の資料を読んでいます", len(chunks))})

	var blocks []string
	for _, id := range chunks {
		c, pg, ok := p.ix.Chunk(id)
		if !ok {
			continue
		}
		blocks = append(blocks, fmt.Sprintf("## %s\n（ページ: %s / 最終更新: %s）\n\n%s",
			c.Breadcrumb, pg.Title, pg.LastEdited, c.Text))
	}

	emit(Event{Type: "status", Message: "回答を作成しています"})
	_, err = p.llm.Stream(ctx, llm.Request{
		Prompt:    fmt.Sprintf(answerPrompt, strings.Join(blocks, "\n\n---\n\n"), question),
		MaxTokens: 1500,
	}, func(text string) {
		emit(Event{Type: "delta", Text: text})
	})
	if err != nil {
		return fmt.Errorf("回答生成: %w", err)
	}
	emit(Event{Type: "done"})
	return nil
}

func (p *Pipeline) selectPages(ctx context.Context, question string) ([]*index.Page, error) {
	raw, err := p.llm.Complete(ctx, llm.Request{
		Cached:    p.ix.TOC, // 目次は必ず先頭固定。キャッシュが効く条件
		Prompt:    selectPrompt + question,
		Schema:    selectSchema,
		MaxTokens: 300,
	})
	if err != nil {
		return nil, err
	}

	var out struct {
		Titles []string `json:"titles"`
	}
	if err := json.Unmarshal([]byte(extractJSON(raw)), &out); err != nil {
		return nil, fmt.Errorf("選択結果の解析に失敗: %w", err)
	}

	var pages []*index.Page
	seen := map[string]bool{}
	for _, title := range out.Titles {
		// 実在しないページ名は落とす。M2a でモデルは班名・節名・
		// 推測で作った名前を返してきた（index.Resolve のコメント参照）。
		pg, ok := p.ix.Resolve(title)
		if !ok || seen[pg.Title] {
			continue
		}
		seen[pg.Title] = true
		pages = append(pages, pg)
		if len(pages) == maxPages {
			break
		}
	}
	return pages, nil
}

// fallbackPages は LLM がページを1件も返せなかったときの保険。
// 目次に対する素朴な字面一致。精度は高くないが「何も答えられない」よりはよい。
func (p *Pipeline) fallbackPages(question string) []*index.Page {
	grams := map[string]bool{}
	runes := []rune(question)
	for i := 0; i+1 < len(runes); i++ {
		grams[string(runes[i:i+2])] = true
	}

	type scored struct {
		page  *index.Page
		score int
	}
	var ranked []scored
	for i := range p.ix.Pages {
		pg := &p.ix.Pages[i]
		if len(pg.Chunks) == 0 {
			continue
		}
		hay := pg.Title
		for _, c := range pg.Chunks {
			hay += " " + c.Breadcrumb
		}
		score := 0
		for g := range grams {
			if strings.Contains(hay, g) {
				score++
			}
		}
		if score > 0 {
			ranked = append(ranked, scored{pg, score})
		}
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })

	var out []*index.Page
	for i := 0; i < len(ranked) && i < maxPages; i++ {
		out = append(out, ranked[i].page)
	}
	return out
}

func (p *Pipeline) selectChunks(ctx context.Context, question string, pages []*index.Page) ([]string, error) {
	var ids []string
	total := 0
	for _, pg := range pages {
		for _, c := range pg.Chunks {
			ids = append(ids, c.ID)
			total += c.Chars
		}
	}
	if len(ids) == 0 || total <= directContextLimit {
		return ids, nil
	}

	// 本文は見せず、パンくずの一覧だけで選ばせる。
	// パンくずは「ページ名 > 見出し > 見出し」で節の内容を要約しているため、これで足りる。
	var catalog strings.Builder
	for _, id := range ids {
		if c, _, ok := p.ix.Chunk(id); ok {
			fmt.Fprintf(&catalog, "%s\t%s（%d字）\n", c.ID, c.Breadcrumb, c.Chars)
		}
	}
	raw, err := p.llm.Complete(ctx, llm.Request{
		Prompt: fmt.Sprintf(
			"以下はWikiの節の一覧です。各行は「ID\tページ名 > 見出し > 見出し（文字数）」です。\n\n%s\n---\n"+
				"質問「%s」に答えるために必要な節を、最大%d件選び、IDだけをJSONで返してください。",
			catalog.String(), question, maxChunks),
		Schema:    chunkSchema,
		MaxTokens: 400,
	})
	if err != nil {
		return truncate(ids, maxChunks), nil // 絞れなければ先頭から詰める
	}

	var out struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal([]byte(extractJSON(raw)), &out); err != nil {
		return truncate(ids, maxChunks), nil
	}
	var picked []string
	for _, id := range out.IDs {
		if _, _, ok := p.ix.Chunk(id); ok {
			picked = append(picked, id)
		}
	}
	if len(picked) == 0 {
		return truncate(ids, maxChunks), nil
	}
	return picked, nil
}

func truncate(ids []string, n int) []string {
	if len(ids) <= n {
		return ids
	}
	return ids[:n]
}

// extractJSON はコードフェンスや前置きが付いた出力からJSON本体を取り出す。
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j > i {
			return s[i : j+1]
		}
	}
	return s
}
