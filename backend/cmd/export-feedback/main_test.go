package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"strings"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

func feedbackFixture() state.Feedback {
	return state.Feedback{
		ID: "feedback-1", ReporterKey: "外へ出してはいけないキー",
		Kind: "answer", Rating: "bad", Reasons: []string{"missing"},
		Question: "尾翼設計は？", Answer: "資料が見つかりませんでした。",
		Sources: []state.Source{{Title: "尾翼設計", URL: "https://example.com/wiki"}},
		Timings: &state.StageTimings{PagesMS: 1200, ChunksMS: 300, AnswerMS: 2500, TotalMS: 4100},
		ChatID:  "chat-1", TurnIndex: 2, Page: "chat", SubmittedAt: "2026-08-10T00:00:00Z",
	}
}

func TestJSONLDoesNotExposeReporterKey(t *testing.T) {
	var output bytes.Buffer
	if err := writeJSONL(&output, []state.Feedback{feedbackFixture()}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "外へ出してはいけないキー") || strings.Contains(output.String(), "reporter") {
		t.Fatalf("内部の利用者キーがJSONLへ漏れた: %s", output.String())
	}
	var item state.Feedback
	if err := json.Unmarshal(output.Bytes(), &item); err != nil || item.ID != "feedback-1" {
		t.Fatalf("JSONLを読み戻せない: item=%+v err=%v", item, err)
	}
}

func TestCSVIncludesRawDataAndBlankReviewColumns(t *testing.T) {
	var output bytes.Buffer
	if err := writeCSV(&output, []state.Feedback{feedbackFixture()}); err != nil {
		t.Fatal(err)
	}
	records, err := csv.NewReader(&output).ReadAll()
	if err != nil || len(records) != 2 {
		t.Fatalf("CSVを読み戻せない: rows=%d err=%v", len(records), err)
	}
	columns := map[string]int{}
	for index, name := range records[0] {
		columns[name] = index
	}
	for _, name := range []string{"feedback_id", "sources_json", "review_status", "problem_layer", "regression_id"} {
		if _, ok := columns[name]; !ok {
			t.Errorf("CSV列がない: %s", name)
		}
	}
	row := records[1]
	if row[columns["feedback_id"]] != "feedback-1" || row[columns["review_status"]] != "" ||
		!strings.Contains(row[columns["sources_json"]], "尾翼設計") {
		t.Fatalf("CSVの内容が不正: %v", row)
	}
	if strings.Contains(output.String(), "外へ出してはいけないキー") {
		t.Fatal("内部の利用者キーがCSVへ漏れた")
	}
}

func TestCSVDoesNotExecuteUserTextAsSpreadsheetFormula(t *testing.T) {
	item := feedbackFixture()
	item.Comment = `=HYPERLINK("https://example.com","開く")`
	row, err := csvRow(item)
	if err != nil {
		t.Fatal(err)
	}
	columns := map[string]int{}
	for index, name := range csvHeader {
		columns[name] = index
	}
	if !strings.HasPrefix(row[columns["comment"]], "'=") {
		t.Fatalf("表計算ソフトの数式として解釈されうる: %q", row[columns["comment"]])
	}
}
