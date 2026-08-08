// WASA ChatのAPIサーバー。
//
//	go run ./backend            # ローカル（Ollama）
//	LLM_PROVIDER=claude go run ./backend
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"

	"github.com/97kuek/wasa-chat/backend/internal/index"
	"github.com/97kuek/wasa-chat/backend/internal/llm"
	"github.com/97kuek/wasa-chat/backend/internal/pipeline"
	"github.com/97kuek/wasa-chat/backend/internal/server"
	appstate "github.com/97kuek/wasa-chat/backend/internal/state"
	"github.com/97kuek/wasa-chat/backend/internal/wiki"
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

func envNonNegativeInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v >= 0 {
		return v
	}
	return fallback
}

func envSeconds(key string, fallback float64) time.Duration {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil && v >= 0 {
		return time.Duration(v * float64(time.Second))
	}
	return time.Duration(fallback * float64(time.Second))
}

func geminiDataUseApproved() bool {
	return os.Getenv("GEMINI_PAID_TIER") == "true" ||
		os.Getenv("GEMINI_FREE_TIER_APPROVED") == "true"
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
	provider := env("LLM_PROVIDER", "ollama")
	switch provider {
	case "claude":
		client = llm.NewClaude(os.Getenv("CLAUDE_MODEL"))
	case "gemini":
		// 無料枠への非公開Wiki送信はデータ取扱いの判断を伴う。2026-08-08の
		// WASA会議で代表・PMが許可したため、有料枠とは別の明示フラグで起動を認める。
		if os.Getenv("K_SERVICE") != "" && !geminiDataUseApproved() {
			log.Fatal("Cloud RunでGeminiを使うには、GEMINI_PAID_TIER=true または GEMINI_FREE_TIER_APPROVED=true を設定してください")
		}
		key := env("GEMINI_API_KEY", os.Getenv("GOOGLE_API_KEY"))
		if key == "" {
			log.Fatal("GEMINI_API_KEY が未設定です")
		}
		client = llm.NewGemini(
			key,
			env("GEMINI_MODEL", "gemini-flash-latest"),
			envSeconds("GEMINI_MIN_INTERVAL", 4),
			envNonNegativeInt("GEMINI_MAX_RETRIES", 2),
		)
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
		if os.Getenv("K_SERVICE") != "" {
			log.Fatal("Cloud RunではSESSION_SECRETの固定値が必須です")
		}
		// 未設定でも起動はする。ただし再起動で全員ログアウトになる点は警告する
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			log.Fatalf("セッション鍵の生成に失敗: %v", err)
		}
		secret = base64.RawStdEncoding.EncodeToString(buf)
		log.Println("警告: SESSION_SECRET が未設定のため一時鍵を生成しました。再起動で全員ログアウトし、当日の質問回数も復元できません")
	} else if len(secret) < 32 {
		log.Fatal("SESSION_SECRETは32文字以上で設定してください")
	}
	allowOrigin := os.Getenv("ALLOW_ORIGIN")
	if os.Getenv("K_SERVICE") != "" && allowOrigin == "" {
		log.Fatal("Cloud RunではCloudflare PagesのURLをALLOW_ORIGINに設定してください")
	}

	sharedState := appstate.Store(appstate.NewMemory())
	if projectID := os.Getenv("FIRESTORE_PROJECT_ID"); projectID != "" {
		firestoreState, err := appstate.NewFirestore(context.Background(), projectID)
		if err != nil {
			log.Fatalf("Firestoreへ接続できません: %v", err)
		}
		defer firestoreState.Close()
		sharedState = firestoreState
		log.Printf("共有状態: Firestore（project=%s）", projectID)
	} else if os.Getenv("K_SERVICE") != "" {
		log.Fatal("Cloud RunではFIRESTORE_PROJECT_IDが必須です")
	} else {
		log.Println("共有状態: メモリ（ローカル開発用。再起動で履歴と利用回数が消えます）")
	}

	srv := server.New(server.Config{
		SessionSecret: secret,
		DailyLimit:    envInt("DAILY_LIMIT", 30),
		AllowOrigin:   allowOrigin,
		SPADir:        os.Getenv("SPA_DIR"),
	}, ix, pipeline.New(ix, client), wiki.New(wikiAPI), sharedState)

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
