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
	"time"

	assistantpkg "github.com/97kuek/wasa-chat/backend/internal/assistant"
	"github.com/97kuek/wasa-chat/backend/internal/index"
	"github.com/97kuek/wasa-chat/backend/internal/llm"
	"github.com/97kuek/wasa-chat/backend/internal/state"
)

const (
	// 空力設計は代違いで4ページあり、3では構造的に全部入らない
	maxPages = 4
	// 選択ページの本文をそのまま渡す上限。超えたらチャンク単位に絞る。
	// M2a では3ページの合計が最大48,100字になった（36,261字の「駆動・フレーム班」が原因）。
	directContextLimit = 12000
	maxChunks          = 8
)

// Cloud Run のコンテナはUTCで動く。利用者は日本の学生なので、
// 「今日」は日本時間で伝えないと日付が1日ずれる
var jst = time.FixedZone("JST", 9*60*60)

// Event はSSEで画面に流す進捗。
// 「無言で待たされる5秒」と「検索中→3ページ読んでいます→回答中と流れる5秒」では
// 体感がまったく違う。進捗表示は実装が地味な割にUXへの効果が大きい。
type Event struct {
	Type    string   `json:"type"` // status | pages | delta | done | error
	Message string   `json:"message,omitempty"`
	Code    string   `json:"code,omitempty"`
	RetryAt string   `json:"retry_at,omitempty"`
	Pages   []Source `json:"pages,omitempty"`
	Text    string   `json:"text,omitempty"`
}

type Source struct {
	Title      string `json:"title"`
	URL        string `json:"url"`
	LastEdited string `json:"last_edited"`
	// "wiki"（部内限定の引き継ぎ資料）か "site"（一般公開の公式サイト）か。
	// 画面で見分けられないと、部外に出せる情報かどうかが判断できない
	Origin string `json:"origin"`
}

type Pipeline struct {
	ix  *index.Index
	llm llm.Client
}

func New(ix *index.Index, client llm.Client) *Pipeline {
	return &Pipeline{ix: ix, llm: client}
}

const selectPrompt = `---
上は資料の目次です。引き継ぎWiki（部内限定）と公式サイト（一般公開）の2つが載っています。
次の質問に答えるために読むべきページを、目次のタイトルから最大4件選んでください。

厳守すること:
- **目次に実在するページタイトルを、一字一句そのまま**書き写すこと
- 班の名前（空力、構造など）や節の名前をページタイトルとして書かないこと
- 目次に無いページ名を推測して作らないこと
- 関連が薄いものを埋め合わせで入れないこと
- **質問に出てくる語がそのままタイトルに含まれるページがあれば、必ず候補に入れること**
- **同じテーマで代（世代）違いのページが複数ある場合は、最新の代を必ず含めること**
  （例: 空力設計(38th) / (40th) / (41st) があるなら 41st は外さない）。
  引き継ぎ資料では最新代が最も重要であり、古い代だけを挙げるのは誤り
- サークルの成り立ち・歴代機体・対外的な説明を問われたら**公式サイト側も候補に入れる**。
  逆に作業手順や設計の詳細は引き継ぎWiki側にある

目次を見る限りどちらの資料にも答えが無いと判断できる場合は answerable を false にし、
titles には最も近そうなページだけを挙げてください。

質問: `

var selectSchema = json.RawMessage(`{"type":"object","properties":{"titles":{"type":"array","items":{"type":"string"},"maxItems":4},"answerable":{"type":"boolean"}},"required":["titles","answerable"]}`)

var chunkSchema = json.RawMessage(`{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string"},"maxItems":8}},"required":["ids"]}`)

const answerPrompt = `あなたは早稲田大学の鳥人間サークル WASA の資料に詳しいアシスタントです。
資料は部内の引き継ぎWikiと一般公開の公式サイトの2つからなります。
以下の資料を根拠に、質問に答えてください。

**今日は %s（日本時間）です。** 「今年」「現在」「最新」「何年前」はこの日付を基準に判断すること。

**答えられることは答える。**
- 資料を読めば分かることは、質問と同じ言葉で書かれていなくても答えてよい
- 要約・比較・時系列の整理・複数箇所の突き合わせは「推測」ではない。積極的に行う
- 「記載がありません」と答えてよいのは、**資料を読んでも該当する情報が本当に無いとき**だけ

**分からないことは、分からないと言う。**
- 資料に無い事実を創作しない
- 一部しか分からない場合は、**分かることを先に述べてから**、何が欠けているかを述べる
- 質問の前提が資料と食い違う場合は、まず前提の誤りを指摘する

**資料には2つの出所がある。**
- **引き継ぎWiki**（部内限定）… 作業手順・設計の詳細・反省点。中身が濃いのはこちら
- **公式サイト**（一般公開）… 団体紹介・歴代機体・活動報告。対外的な説明はこちら
- 両方に書いてあって食い違う場合は、**引き継ぎWikiを優先**し、食い違い自体も述べる

**情報の古さは「最終更新」で判断しない。**
- **最終更新はページが編集された日**であって、そこに書かれている内容の年代ではない。
  誤字直しやリンク追加でも更新日は今日になる。実測では17%%の節で、本文が扱う年代が
  最終更新より2年以上古かった（最終更新2026年・本文は2024年までしか書いていない、など）
- 各資料には「本文の年代」を添えてある。これは**本文中に出てくる西暦と代から機械的に
  拾ったもの**で、内容がいつの話かの手がかりになる。**古さに言及するときはこちらを根拠にする**
- 「本文の年代」が資料に無い（拾えなかった）ときは、**古さについて断定しない**。
  最終更新日を代わりに使ってはいけない
- 本文の年代が今日から2年以上前なら、その旨を一言添える。**何年前かは今日の日付から計算する**
- 代（世代）と西暦の対応は冒頭の基本情報にある。代が分かれば年も分かる

**書き方**
- 必ず日本語で書く。思考の過程は書かず、結論から書く
- 回答の最後に出典を必ず挙げる。形式は
  ` + "`- [ページ名](URL)（Wiki / 公式サイト、本文の年代: YYYY年）`" + ` の**Markdownリンク**。
  URLは各資料に添えてあるものを使い、書き換えたり推測で作ったりしない
- 本文中にURL（Googleドライブ・ドキュメント・写真など）が書かれていて、
  それが回答に関係するなら**URLをそのまま本文に載せる**。画面側でリンクになる

なお、冒頭には**人が保守している基本情報**と、**どんなページが存在するかの目次**が
出所ごとに載っている。基本情報は資料本文より優先される確定事実として扱うこと。
「どの分野の情報が薄いか」「そのページは存在するか」といった問いには、目次を根拠に答えてよい。

# 資料

%s
%s
# 質問

%s
`

// inScope はアシスタントの参照範囲にページが入るかを返す。
//
// **判定をモデルに任せない。** プロンプトで「公式サイトだけ見て」と頼む方式は、
// 書き忘れや無視で部内資料が混ざる。ここで落とせば構造的に混ざらない。
// 絞り込みは狭める方向しか無いので、範囲外を弾くだけで足りる。
func inScope(pg *index.Page, a *state.Assistant) bool {
	if a == nil {
		return true
	}
	origin := pg.Source
	if origin == "" {
		origin = "wiki" // 旧い index.json には source が無い
	}
	if a.Origin != "" && a.Origin != origin {
		return false
	}
	if a.Team != "" && pg.Team != a.Team {
		return false
	}
	return true
}

// Run は質問に答え、進行状況を emit に流す。assistant は未選択なら nil。
func (p *Pipeline) Run(ctx context.Context, question string, assistant *state.Assistant, emit func(Event)) error {
	emit(Event{Type: "status", Message: "目次から関連ページを探しています"})
	onWait := func(info llm.WaitInfo) {
		message := "Geminiへの送信間隔を調整しています"
		if info.Reason == "retry" {
			message = "Geminiの一時的な利用制限を待っています"
		} else if info.Reason == "queue" {
			message = "ほかの質問を処理しています。順番に回答します"
		}
		retryAt := ""
		if !info.Until.IsZero() {
			retryAt = info.Until.Format(time.RFC3339)
		}
		emit(Event{Type: "status", Message: message, RetryAt: retryAt})
	}

	pages, err := p.selectPages(ctx, question, assistant, onWait)
	if err != nil {
		return fmt.Errorf("ページ選択: %w", err)
	}
	if len(pages) == 0 {
		// M2b で、モデルが空文字列のタイトルを3件返して照合で全滅し、
		// 文脈ゼロになった事例があった。字面一致で拾い直す保険。
		pages = p.fallbackPages(question, assistant)
	}
	if len(pages) == 0 {
		message := "Wikiの目次から関連するページを特定できませんでした。"
		if scope := assistantpkg.ScopeLabel(assistant); scope != "" {
			// 範囲外で落ちたのか、そもそも資料が無いのかが分からないと
			// 「壊れている」と受け取られる。絞り込み中であることを伝える
			message = fmt.Sprintf("このアシスタントの参照範囲（%s）に、該当する資料が見つかりませんでした。", scope)
		}
		emit(Event{Type: "delta", Text: message})
		emit(Event{Type: "done"})
		return nil
	}

	sources := make([]Source, 0, len(pages))
	for _, pg := range pages {
		origin := pg.Source
		if origin == "" {
			origin = "wiki" // 旧い index.json には source が無い
		}
		sources = append(sources, Source{
			Title: pg.Title, URL: pg.URL, LastEdited: pg.LastEdited, Origin: origin,
		})
	}
	emit(Event{Type: "pages", Pages: sources})

	chunks, err := p.selectChunks(ctx, question, pages, onWait)
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
		origin := "Wiki"
		if pg.Source == "site" {
			origin = "公式サイト"
		}
		// 年代は拾えないことがある（実測で38%）。空欄を出すとモデルが
		// 「不明」を「古い」と読み替えるので、その場合は項目ごと省く
		era := ""
		if label := c.Era.Label(); label != "" {
			era = " / 本文の年代: " + label
		}
		blocks = append(blocks, fmt.Sprintf("## %s\n（出所: %s / ページ: %s / URL: %s / 最終更新: %s%s）\n\n%s",
			c.Breadcrumb, origin, pg.Title, pg.URL, pg.LastEdited, era, c.Text))
	}

	emit(Event{Type: "status", Message: "回答を作成しています"})
	_, err = p.llm.Stream(ctx, llm.Request{
		// 目次を先頭に置く。全体を見渡す問い（「最も情報が薄い分野は？」）は
		// 選択ページの本文だけでは構造的に答えられない。キャッシュも効く
		Cached: p.ix.TOC,
		// 今日の日付を渡すのは、モデルが「2年前」を勝手に見積もっていたため。
		// 基準日が無いと、最終更新2026-04の資料を「2年前」と述べる誤りが起きる
		// アシスタントの指示は**資料の後・質問の前**に置く。
		// 直後に変更不能の規則（assistant.PromptSection の guard）が続くので、
		// 「出典を書くな」のような指示が書かれていても最後に規則が勝つ。
		Prompt: fmt.Sprintf(answerPrompt,
			time.Now().In(jst).Format("2006年1月2日"),
			strings.Join(blocks, "\n\n---\n\n"),
			assistantpkg.PromptSection(assistant),
			question),
		MaxTokens: 1500,
		OnWait:    onWait,
	}, func(text string) {
		emit(Event{Type: "delta", Text: text})
	})
	if err != nil {
		return fmt.Errorf("回答生成: %w", err)
	}
	emit(Event{Type: "done"})
	return nil
}

func (p *Pipeline) selectPages(ctx context.Context, question string, a *state.Assistant, onWait func(llm.WaitInfo)) ([]*index.Page, error) {
	// 絞り込み中でも**目次そのものは削らない**。目次を差し替えるとアシスタントごとに
	// プロンプトキャッシュが分裂し、使う人の少ないアシスタントほど単価が上がる
	// （llm.Request のコメント参照）。候補を減らす指示だけを足し、
	// 実際の除外は下の inScope で決定的に行う。
	scopeHint := ""
	if scope := assistantpkg.ScopeLabel(a); scope != "" {
		scopeHint = fmt.Sprintf(
			"\n**このアシスタントは「%s」しか参照できません。範囲外のページを選んでも捨てられます。**\n", scope)
	}
	raw, err := p.llm.Complete(ctx, llm.Request{
		Cached:    p.ix.TOC, // 目次は必ず先頭固定。キャッシュが効く条件
		Prompt:    selectPrompt + question + scopeHint,
		Schema:    selectSchema,
		MaxTokens: 300,
		OnWait:    onWait,
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
		if !ok || seen[pg.Title] || !inScope(pg, a) {
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
func (p *Pipeline) fallbackPages(question string, a *state.Assistant) []*index.Page {
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
		// 保険の経路でも範囲外は出さない。ここを抜かすと、絞り込みが
		// 「たいていは効く」だけの頼れない機能になる
		if len(pg.Chunks) == 0 || !inScope(pg, a) {
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

func (p *Pipeline) selectChunks(ctx context.Context, question string, pages []*index.Page, onWait func(llm.WaitInfo)) ([]string, error) {
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
		OnWait:    onWait,
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
