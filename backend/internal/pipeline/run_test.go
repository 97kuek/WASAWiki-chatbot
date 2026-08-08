package pipeline

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/index"
	"github.com/97kuek/wasa-chat/backend/internal/llm"
	"github.com/97kuek/wasa-chat/backend/internal/state"
)

// stubLLM はページ選択に固定の答えを返し、回答生成のプロンプトを記録する。
// 本物のモデルを呼ばずに「何を渡しているか」だけを検証したい。
type stubLLM struct {
	titles     []string
	lastAnswer string
}

func (s *stubLLM) Complete(_ context.Context, req llm.Request) (string, error) {
	if strings.Contains(req.Prompt, "節の一覧") {
		return `{"ids":[]}`, nil // 節の絞り込みは使わせない（総量が小さいので呼ばれない）
	}
	out, _ := json.Marshal(map[string]any{"titles": s.titles, "answerable": true})
	return string(out), nil
}

func (s *stubLLM) Stream(_ context.Context, req llm.Request, onDelta llm.Delta) (string, error) {
	s.lastAnswer = req.Prompt
	onDelta("（ダミー回答）")
	return "（ダミー回答）", nil
}

func (s *stubLLM) Name() string { return "stub" }

// テスト用の小さな索引を書き出して読み込む。
func testIndex(t *testing.T) *index.Index {
	t.Helper()
	dir := t.TempDir()
	payload := map[string]any{"pages": []map[string]any{
		{
			"id": "1", "source": "wiki", "title": "電装班", "url": "https://wiki.example/dens",
			"last_edited": "2026-04-01", "team": "電装", "chars": 100,
			"chunks": []map[string]any{
				{"id": "p1-c0", "breadcrumb": "電装班", "text": "計測系統のはなし", "chars": 8,
					"era": map[string]any{"years": []int{2024}, "gens": []int{40}}},
			},
		},
		{
			"id": "s1", "source": "site", "title": "WASAについて知る", "url": "https://wasa-birdman.com/about",
			"last_edited": "2026-04-01", "team": "", "chars": 100,
			"chunks": []map[string]any{
				{"id": "ps1-c0", "breadcrumb": "WASAについて知る", "text": "WASAは1965年に設立された。", "chars": 14,
					"era": map[string]any{"years": []int{1965}, "gens": []int{}}},
			},
		},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "toc.md"), []byte("# 目次\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ix, err := index.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return ix
}

func run(t *testing.T, assistant *state.Assistant) (*stubLLM, []Source, string) {
	t.Helper()
	// モデルは毎回「両方のページを使いたい」と答える。絞り込みが効いていなければ
	// 両方が文脈に入るので、範囲外が確実に落ちているかを見分けられる
	client := &stubLLM{titles: []string{"電装班", "WASAについて知る"}}
	pipe := New(testIndex(t), client)

	var sources []Source
	var answer strings.Builder
	err := pipe.Run(context.Background(), "WASAについて教えて", assistant, func(e Event) {
		switch e.Type {
		case "pages":
			sources = e.Pages
		case "delta":
			answer.WriteString(e.Text)
		}
	})
	if err != nil {
		t.Fatalf("Run が失敗: %v", err)
	}
	return client, sources, answer.String()
}

// 「公式サイトのみ」は部外に出せる情報だけに限る用途で使う。
// ここが破れると、部内資料が対外向けの回答に混ざる。
func TestRunScopeExcludesOtherOrigin(t *testing.T) {
	client, sources, _ := run(t, &state.Assistant{
		Name: "対外説明", Instruction: "ですます調で書く", Origin: "site",
	})

	if len(sources) != 1 || sources[0].Origin != "site" {
		t.Fatalf("出典に範囲外が残った: %+v", sources)
	}
	// 出典パネルだけでなく、モデルに渡す本文からも消えていること
	if strings.Contains(client.lastAnswer, "計測系統のはなし") {
		t.Error("範囲外のWiki本文がプロンプトへ入った")
	}
	if !strings.Contains(client.lastAnswer, "WASAは1965年に設立された。") {
		t.Error("範囲内の本文がプロンプトへ入っていない")
	}
}

func TestRunScopeByTeam(t *testing.T) {
	_, sources, _ := run(t, &state.Assistant{Name: "電装班", Instruction: "簡潔に", Team: "電装"})
	if len(sources) != 1 || sources[0].Title != "電装班" {
		t.Fatalf("班の絞り込みが効いていない: %+v", sources)
	}
}

func TestRunWithoutAssistantKeepsEverything(t *testing.T) {
	_, sources, _ := run(t, nil)
	if len(sources) != 2 {
		t.Fatalf("未選択なのに資料が減った: %+v", sources)
	}
}

// 絞り込みで全滅したときに、無言で「見つかりません」と言うと壊れて見える。
func TestRunReportsEmptyScope(t *testing.T) {
	_, sources, answer := run(t, &state.Assistant{
		Name: "パイロット班", Instruction: "簡潔に", Team: "パイロット",
	})
	if len(sources) != 0 {
		t.Fatalf("範囲外が残った: %+v", sources)
	}
	if !strings.Contains(answer, "参照範囲") {
		t.Errorf("絞り込みが原因だと分かる文面になっていない: %q", answer)
	}
}

// 目次はアシスタントによらず同じでなければならない。差し替えるとプロンプト
// キャッシュがアシスタントごとに分裂し、使う人の少ないものほど単価が上がる。
func TestRunKeepsTOCCacheable(t *testing.T) {
	ix := testIndex(t)
	var cached []string
	pipe := New(ix, &cacheProbe{inner: &stubLLM{titles: []string{"電装班"}}, seen: &cached})
	for _, a := range []*state.Assistant{nil, {Name: "電装", Instruction: "簡潔に", Team: "電装"}} {
		if err := pipe.Run(context.Background(), "質問", a, func(Event) {}); err != nil {
			t.Fatalf("Run が失敗: %v", err)
		}
	}
	for _, got := range cached {
		if got != ix.TOC {
			t.Fatal("アシスタントによって目次が変わっている（キャッシュが分裂する）")
		}
	}
}

type cacheProbe struct {
	inner *stubLLM
	seen  *[]string
}

func (c *cacheProbe) Complete(ctx context.Context, req llm.Request) (string, error) {
	if req.Cached != "" {
		*c.seen = append(*c.seen, req.Cached)
	}
	return c.inner.Complete(ctx, req)
}

func (c *cacheProbe) Stream(ctx context.Context, req llm.Request, onDelta llm.Delta) (string, error) {
	if req.Cached != "" {
		*c.seen = append(*c.seen, req.Cached)
	}
	return c.inner.Stream(ctx, req, onDelta)
}

func (c *cacheProbe) Name() string { return "probe" }
