package state

import (
	"encoding/json"
	"strings"
	"testing"
)

// 画面側は turns と sources を配列として扱う。ここが null で届くと
// `.length` の読み出しで例外になり、画面が真っ白になる（2026-08-09に本番で確認）。
// JSONへ書いた結果に null が出ないことを、文字列として直接確かめる。
func TestNormalizeChatWritesEmptyArraysNotNull(t *testing.T) {
	raw, err := json.Marshal(NormalizeChat(Chat{
		ID: "c1", Title: "件名",
		Turns: []Turn{{Question: "問い", Answer: "答え"}}, // Sources は nil のまま
	}))
	if err != nil {
		t.Fatalf("JSONへ書けませんでした: %v", err)
	}
	if strings.Contains(string(raw), "null") {
		t.Errorf("nullが残っています: %s", raw)
	}
	if !strings.Contains(string(raw), `"sources":[]`) {
		t.Errorf("sourcesが空配列になっていません: %s", raw)
	}
}

func TestNormalizeChatFillsMissingTurns(t *testing.T) {
	raw, err := json.Marshal(NormalizeChat(Chat{ID: "c1", Title: "件名"})) // Turns も nil
	if err != nil {
		t.Fatalf("JSONへ書けませんでした: %v", err)
	}
	if !strings.Contains(string(raw), `"turns":[]`) {
		t.Errorf("turnsが空配列になっていません: %s", raw)
	}
}

// 元の値を書き換えないことを確かめる。保存前の正規化で呼び出し側の
// チャットが変わると、追跡しにくい不具合になる。
func TestNormalizeChatKeepsContent(t *testing.T) {
	original := Chat{ID: "c1", Turns: []Turn{{
		Question: "問い", Sources: []Source{{Title: "頁", URL: "https://example.org/"}},
	}}}
	got := NormalizeChat(original)
	if len(got.Turns) != 1 || len(got.Turns[0].Sources) != 1 {
		t.Fatalf("中身が失われました: %+v", got)
	}
	if got.Turns[0].Sources[0].Title != "頁" {
		t.Errorf("出典が変わりました: %+v", got.Turns[0].Sources[0])
	}
}
