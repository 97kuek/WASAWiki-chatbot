// export-feedback はFirestoreに保存された利用者フィードバックを、
// 開発者が手元で調査できるJSONLまたはCSVへ書き出す。
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

var csvHeader = []string{
	"feedback_id", "submitted_at", "kind", "rating", "reasons", "comment",
	"question", "answer", "sources_json", "assistant_id", "assistant_name",
	"response_mode", "resolved_mode", "pages_ms", "chunks_ms", "answer_ms", "total_ms",
	"chat_id", "turn_index", "page",
	"review_status", "problem_layer", "verified", "action", "regression_id", "review_note",
}

func compactJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func integer(value int64) string {
	if value == 0 {
		return ""
	}
	return fmt.Sprintf("%d", value)
}

func spreadsheetSafe(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed == "" {
		return value
	}
	// CSVを表計算ソフトで開いたとき、利用者入力を数式として実行させない。
	// encoding/csvの引用符だけではCSVインジェクションを防げない。
	if strings.ContainsRune("=+-@", []rune(trimmed)[0]) {
		return "'" + value
	}
	return value
}

func csvRow(item state.Feedback) ([]string, error) {
	reasons, err := compactJSON(item.Reasons)
	if err != nil {
		return nil, err
	}
	sources, err := compactJSON(item.Sources)
	if err != nil {
		return nil, err
	}
	var pages, chunks, answer, total string
	if item.Timings != nil {
		pages = integer(item.Timings.PagesMS)
		chunks = integer(item.Timings.ChunksMS)
		answer = integer(item.Timings.AnswerMS)
		total = integer(item.Timings.TotalMS)
	}
	return []string{
		item.ID, item.SubmittedAt, item.Kind, item.Rating, reasons, spreadsheetSafe(item.Comment),
		spreadsheetSafe(item.Question), spreadsheetSafe(item.Answer), sources, item.AssistantID, spreadsheetSafe(item.AssistantName),
		item.ResponseMode, item.ResolvedMode, pages, chunks, answer, total,
		item.ChatID, fmt.Sprintf("%d", item.TurnIndex), item.Page,
		"", "", "", "", "", "",
	}, nil
}

func writeJSONL(w io.Writer, items []state.Feedback) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	for _, item := range items {
		if err := encoder.Encode(item); err != nil {
			return err
		}
	}
	return nil
}

func writeCSV(w io.Writer, items []state.Feedback) error {
	writer := csv.NewWriter(w)
	if err := writer.Write(csvHeader); err != nil {
		return err
	}
	for _, item := range items {
		row, err := csvRow(item)
		if err != nil {
			return err
		}
		if err := writer.Write(row); err != nil {
			return err
		}
	}
	writer.Flush()
	return writer.Error()
}

func defaultOutput(format string) string {
	return fmt.Sprintf("/private/tmp/wasa-feedback-%s.%s", time.Now().Format("20060102-150405"), format)
}

func run() error {
	project := flag.String("project", os.Getenv("FIRESTORE_PROJECT_ID"), "FirestoreのGoogle CloudプロジェクトID")
	format := flag.String("format", "jsonl", "出力形式（jsonl または csv）")
	output := flag.String("output", "", "出力先（未指定なら/private/tmp）")
	flag.Parse()

	*format = strings.ToLower(strings.TrimSpace(*format))
	if *project == "" {
		return errors.New("-project または FIRESTORE_PROJECT_ID を指定してください")
	}
	if *format != "jsonl" && *format != "csv" {
		return errors.New("-format は jsonl または csv を指定してください")
	}
	if *output == "" {
		*output = defaultOutput(*format)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	store, err := state.NewFirestore(ctx, *project)
	if err != nil {
		return fmt.Errorf("Firestoreへ接続: %w", err)
	}
	defer store.Close()

	items, err := store.ListFeedback(ctx, 0)
	if err != nil {
		return fmt.Errorf("フィードバックを取得: %w", err)
	}
	// 質問・回答には非公開Wikiの内容が含まれうる。既存ファイルを黙って
	// 上書きせず、所有者だけが読める権限で新規作成する。
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("出力ファイルを作成: %w", err)
	}
	var writeErr error
	if *format == "csv" {
		writeErr = writeCSV(file, items)
	} else {
		writeErr = writeJSONL(file, items)
	}
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("書き出し: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("出力ファイルを閉じる: %w", closeErr)
	}
	fmt.Printf("%d件を書き出しました: %s\n", len(items), *output)
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
