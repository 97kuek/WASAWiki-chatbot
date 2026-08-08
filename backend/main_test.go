package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	appstate "github.com/97kuek/wasa-chat/backend/internal/state"
)

func TestGeminiDataUseApproved(t *testing.T) {
	tests := []struct {
		name string
		paid string
		free string
		want bool
	}{
		{name: "未承認", want: false},
		{name: "有料枠", paid: "true", want: true},
		{name: "無料枠の会議承認", free: "true", want: true},
		{name: "true以外は承認にしない", paid: "TRUE", free: "1", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("GEMINI_PAID_TIER", tt.paid)
			t.Setenv("GEMINI_FREE_TIER_APPROVED", tt.free)
			if got := geminiDataUseApproved(); got != tt.want {
				t.Fatalf("承認判定 = %v, want %v", got, tt.want)
			}
		})
	}
}

// ADMIN_USERS の書き忘れでアプリ全体が起動しなくなってはいけない。
// 初期アシスタントは作成者を決められないので見送るが、それだけで済ませる。
func TestSeedAssistantsWithoutAdminDoesNotFail(t *testing.T) {
	dir := t.TempDir()
	seed := `{"id":"x","name":"テスト","instruction":"語尾を〜だよにする","author_from_admin":true}`
	if err := os.WriteFile(filepath.Join(dir, "x.json"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	store := appstate.NewMemory()

	if err := seedAssistants(context.Background(), store, dir, nil); err != nil {
		t.Fatalf("ADMIN_USERS 未設定で起動が止まる: %v", err)
	}
	list, _ := store.ListAssistants(context.Background())
	if len(list) != 0 {
		t.Errorf("作成者が決まらないのに登録された: %+v", list)
	}

	// 管理者を設定すれば登録され、その人が作成者になる
	if err := seedAssistants(context.Background(), store, dir, []string{"42 Wasa Taro"}); err != nil {
		t.Fatalf("登録に失敗: %v", err)
	}
	list, _ = store.ListAssistants(context.Background())
	if len(list) != 1 || list[0].Author != "42 Wasa Taro" {
		t.Fatalf("作成者が管理者になっていない: %+v", list)
	}
}

// シードのディレクトリが無いのは異常ではない（同梱しない構成もありうる）。
func TestSeedAssistantsWithoutDirectory(t *testing.T) {
	if err := seedAssistants(context.Background(), appstate.NewMemory(), "存在しない場所", nil); err != nil {
		t.Errorf("ディレクトリ不在で失敗した: %v", err)
	}
}
