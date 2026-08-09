package feedbackmail

import (
	"strings"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

func TestNewRejectsPartialSettings(t *testing.T) {
	_, err := New(Config{Host: "smtp.example.com", From: "from@example.com", Recipients: []string{"to@example.com"}, Username: "user"})
	if err == nil {
		t.Fatal("パスワードのないSMTP設定を受け付けた")
	}
}

func TestMessageDoesNotExposeReporterKey(t *testing.T) {
	sender, err := New(Config{Host: "smtp.example.com", From: "WASA Chat <from@example.com>", Recipients: []string{"to@example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	message := sender.message(state.Feedback{
		Kind: "answer", Rating: "bad", Reasons: []string{"missing"}, ReporterKey: "秘密の内部キー",
		Question: "尾翼設計は？", Answer: "回答", SubmittedAt: "2026-08-09T00:00:00Z",
	})
	for _, want := range []string{"Subject: =?UTF-8?", "尾翼設計は？", "missing"} {
		if !strings.Contains(message, want) {
			t.Errorf("メール本文に必要な情報がない: %q", want)
		}
	}
	if strings.Contains(message, "秘密の内部キー") || strings.Contains(message, "Reporter") {
		t.Fatal("匿名の内部キーがメールへ漏れている")
	}
}
