package wiki

import (
	"context"
	"errors"
	"os"
	"testing"
)

// 実際のWikiに繋いで確認する。認証情報が無い環境ではスキップする。
//
//	cd backend && set -a && . ../.env && set +a && go test ./internal/wiki -v
func liveAuth(t *testing.T) *Authenticator {
	t.Helper()
	api := os.Getenv("WIKI_API")
	if api == "" || os.Getenv("WIKI_BOT_USER") == "" {
		t.Skip("WIKI_API / WIKI_BOT_USER が未設定のためスキップ")
	}
	return New(api)
}

func TestLoginSuccess(t *testing.T) {
	a := liveAuth(t)
	user, err := a.Login(context.Background(),
		os.Getenv("WIKI_BOT_USER"), os.Getenv("WIKI_BOT_PASS"))
	if err != nil {
		t.Fatalf("ログインに失敗した: %v", err)
	}
	if user == "" {
		t.Fatal("利用者名が空。Cookieに載せる識別子が取れていない")
	}
	t.Logf("利用者名: %s", user)
}

func TestLoginWrongPassword(t *testing.T) {
	a := liveAuth(t)
	if _, err := a.Login(context.Background(),
		os.Getenv("WIKI_BOT_USER"), "definitely-not-the-password"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("誤ったパスワードが弾かれていない: err=%v", err)
	}
}
