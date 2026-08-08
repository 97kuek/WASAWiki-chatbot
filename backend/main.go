// WASA Wiki チャットボットのAPIサーバー。
//
//	go run ./backend            # ローカル（Ollama）
//	LLM_PROVIDER=claude go run ./backend
package main

import (
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"

	"github.com/97kuek/WASAWiki-chatbot/backend/internal/index"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/llm"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/pipeline"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/server"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/wiki"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return fallback
}

func main() {
	// リポジトリ直下の .env を読む。測定用のPython側と同じ設定を使えるようにするため。
	// 既に環境変数が設定されていればそちらが優先される
	for _, path := range []string{".env", "../.env"} {
		if err := godotenv.Load(path); err == nil {
			log.Printf("設定を読み込み: %s", path)
			break
		}
	}

	dataDir := env("DATA_DIR", "data")
	ix, err := index.Load(dataDir)
	if err != nil {
		log.Fatalf("インデックスを読み込めません（%s）: %v\n"+
			"先に python build_index.py && python build_toc.py を実行してください", dataDir, err)
	}
	pages, chunks := ix.Stats()
	log.Printf("インデックス読み込み完了: %dページ / %dチャンク / 目次%d字", pages, chunks, len([]rune(ix.TOC)))

	var client llm.Client
	switch env("LLM_PROVIDER", "ollama") {
	case "claude":
		client = llm.NewClaude(os.Getenv("CLAUDE_MODEL"))
	case "gemini":
		// ⚠️ 無料枠は送信内容が学習に使われる場合がある。対象は非公開Wikiの本文
		key := env("GEMINI_API_KEY", os.Getenv("GOOGLE_API_KEY"))
		if key == "" {
			log.Fatal("GEMINI_API_KEY が未設定です")
		}
		client = llm.NewGemini(key, env("GEMINI_MODEL", "gemini-flash-latest"))
	case "compat", "grok", "groq", "openrouter", "mistral":
		client = llm.NewCompat(os.Getenv("LLM_BASE_URL"), os.Getenv("LLM_API_KEY"), os.Getenv("LLM_MODEL"))
	default:
		client = llm.NewOllama(
			env("OLLAMA_ENDPOINT", "http://localhost:11434"),
			env("OLLAMA_MODEL", "qwen3:30b-a3b"),
		)
	}
	log.Printf("モデル: %s", client.Name())

	// 認証はWikiのアカウントに委ねる。共有パスワードを配らずに済み、
	// 利用者名が取れるのでレート制限を個人ごとに分けられる（docs/01-設計方針.md §8-1）
	wikiAPI := env("WIKI_API", "https://wasabirdman.sakura.ne.jp/wbwiki/w/api.php")

	secret := os.Getenv("SESSION_SECRET")
	if secret == "" {
		// 未設定でも起動はする。ただし再起動で全員ログアウトになる点は警告する
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			log.Fatalf("セッション鍵の生成に失敗: %v", err)
		}
		secret = base64.RawStdEncoding.EncodeToString(buf)
		log.Println("警告: SESSION_SECRET が未設定のため一時鍵を生成しました。再起動で全員ログアウトになります")
	}

	srv := server.New(server.Config{
		SessionSecret: secret,
		DailyLimit:    envInt("DAILY_LIMIT", 30),
		AllowOrigin:   os.Getenv("ALLOW_ORIGIN"),
		SPADir:        os.Getenv("SPA_DIR"),
	}, ix, pipeline.New(ix, client), wiki.New(wikiAPI))

	addr := ":" + env("PORT", "8080") // Cloud Run は PORT を渡してくる
	log.Printf("起動: http://localhost%s", addr)

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// WriteTimeout は設定しない。SSEで回答を流し続けるため、
		// 書き込みに期限を設けると長い回答の途中で接続が切れる。
		IdleTimeout: 120 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("サーバーが停止しました: %v", err)
	}
}
