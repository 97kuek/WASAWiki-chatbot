package wiki

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/joho/godotenv"
)

func TestLoginUsesClientLogin(t *testing.T) {
	t.Helper()
	var loginAction string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("フォームを読めない: %v", err)
		}
		switch r.Form.Get("action") {
		case "query":
			_, _ = w.Write([]byte(`{"query":{"tokens":{"logintoken":"token+\\"}}}`))
		case "clientlogin":
			loginAction = r.Form.Get("action")
			if r.Form.Get("username") != "WASA利用者" || r.Form.Get("password") != "wiki-password" {
				t.Fatal("利用者名またはパスワードがWikiへ正しく中継されていない")
			}
			_, _ = w.Write([]byte(`{"clientlogin":{"status":"PASS","username":"WASA利用者"}}`))
		default:
			t.Fatalf("想定外の認証経路: %s", r.Form.Get("action"))
		}
	}))
	defer server.Close()

	user, err := New(server.URL).Login(context.Background(), "WASA利用者", "wiki-password")
	if err != nil {
		t.Fatalf("ログインに失敗した: %v", err)
	}
	if user != "WASA利用者" || loginAction != "clientlogin" {
		t.Fatalf("通常のWiki認証に統一されていない: user=%q action=%q", user, loginAction)
	}
}

func TestLoginRejectsBadCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("フォームを読めない: %v", err)
		}
		if r.Form.Get("action") == "query" {
			_, _ = w.Write([]byte(`{"query":{"tokens":{"logintoken":"token"}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"clientlogin":{"status":"FAIL"}}`))
	}))
	defer server.Close()

	if _, err := New(server.URL).Login(context.Background(), "利用者", "wrong"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("誤ったパスワードが弾かれていない: err=%v", err)
	}
}

// 実際のWikiに繋いで確認する。通常テストで非公開Wikiへ接続しないよう明示フラグを必須にする。
//
//	cd backend && LIVE_WIKI_TEST=1 go test ./internal/wiki -run '^TestLoginSuccess$'
func liveAuth(t *testing.T) *Authenticator {
	t.Helper()
	if os.Getenv("LIVE_WIKI_TEST") != "1" {
		t.Skip("LIVE_WIKI_TEST=1 が未指定のため実Wiki認証をスキップ")
	}
	if os.Getenv("WIKI_API") == "" {
		if err := godotenv.Load("../../../.env"); err != nil {
			t.Fatalf("リポジトリ直下の.envを読み込めない: %v", err)
		}
	}
	api := os.Getenv("WIKI_API")
	if api == "" || os.Getenv("WIKI_USER") == "" {
		t.Fatal("WIKI_API / WIKI_USER が未設定")
	}
	return New(api)
}

func TestLoginSuccess(t *testing.T) {
	a := liveAuth(t)
	user, err := a.Login(context.Background(),
		os.Getenv("WIKI_USER"), os.Getenv("WIKI_PASS"))
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
		os.Getenv("WIKI_USER"), "definitely-not-the-password"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("誤ったパスワードが弾かれていない: err=%v", err)
	}
}
