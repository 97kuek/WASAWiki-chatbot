// Package server はHTTP層。認証・レート制限・SSEストリーミングを担う。
package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/97kuek/WASAWiki-chatbot/backend/internal/index"
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/pipeline"
)

const (
	cookieName    = "wasa_session"
	sessionMaxAge = 30 * 24 * time.Hour
)

type Config struct {
	SharedPassword string // 部内で配る共有パスワード
	SessionSecret  string // Cookie署名用。未設定なら起動時に生成する
	DailyLimit     int    // 1セッションあたりの1日の質問数上限
	AllowOrigin    string // 開発時にViteのdev serverから叩くためのCORS設定
	SPADir         string // 指定するとビルド済みSPAも同じサーバーから配る
}

// spaHandler は静的ファイルを返し、見つからないパスは index.html に落とす
// （クライアント側ルーティングのため）。
func spaHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(filepath.Join(dir, filepath.Clean(r.URL.Path))); err != nil {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}

type Server struct {
	cfg   Config
	ix    *index.Index
	pipe  *pipeline.Pipeline
	limit *limiter
}

func New(cfg Config, ix *index.Index, pipe *pipeline.Pipeline) *Server {
	return &Server{cfg: cfg, ix: ix, pipe: pipe, limit: newLimiter(cfg.DailyLimit)}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("GET /api/session", s.handleSession)
	mux.HandleFunc("GET /api/ask", s.requireAuth(s.handleAsk))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		pages, chunks := s.ix.Stats()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pages": pages, "chunks": chunks})
	})

	// SPAを同梱して配る場合（SPA_DIR 指定時）。フロントを Cloudflare Pages に
	// 置くなら不要だが、Docker一つで動かしたいときにこちらが使える。
	if s.cfg.SPADir != "" {
		mux.Handle("GET /", spaHandler(s.cfg.SPADir))
	}
	return s.withCORS(mux)
}

// ---------------------------------------------------------------- 認証
//
// 共有パスワード1本 + 署名付きCookie。
// URLを知っている人だけがアクセスできる方式は認証ではない、というのが採用理由。
// 失効・監査ができない弱さは docs/01-設計方針.md §8-1 にトレードオフとして記録済み。

func (s *Server) sign(expiry int64) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	fmt.Fprintf(mac, "%d", expiry)
	return fmt.Sprintf("%d.%s", expiry, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}

func (s *Server) verify(token string) bool {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}
	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return false
	}
	return hmac.Equal([]byte(s.sign(expiry)), []byte(token))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "リクエストが不正です"})
		return
	}
	// タイミング攻撃を避けるため定数時間で比較する
	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(s.cfg.SharedPassword)) != 1 {
		time.Sleep(300 * time.Millisecond) // 総当たりの速度を落とす
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "パスワードが違います"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sign(time.Now().Add(sessionMaxAge).Unix()),
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode, // フロントを別オリジン(Cloudflare Pages)に置くため
		MaxAge:   int(sessionMaxAge.Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(cookieName)
	ok := err == nil && s.verify(c.Value)
	remaining := 0
	if ok {
		remaining = s.limit.remaining(c.Value)
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": ok, "remaining": remaining})
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || !s.verify(c.Value) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "ログインしてください"})
			return
		}
		next(w, r)
	}
}

// ---------------------------------------------------------------- 質問

func (s *Server) handleAsk(w http.ResponseWriter, r *http.Request) {
	question := strings.TrimSpace(r.URL.Query().Get("q"))
	if question == "" || len([]rune(question)) > 500 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "質問を入力してください（500文字以内）"})
		return
	}

	// レート制限。共有パスワードが漏れた場合、本当の費用リスクはインフラではなく
	// API従量課金である（docs/01-設計方針.md §7）。これが実質的な上限装置になる。
	c, _ := r.Cookie(cookieName)
	if !s.limit.take(c.Value) {
		writeJSON(w, http.StatusTooManyRequests,
			map[string]string{"error": "本日の質問回数の上限に達しました"})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "ストリーミング未対応"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var mu sync.Mutex
	emit := func(e pipeline.Event) {
		mu.Lock()
		defer mu.Unlock()
		payload, err := json.Marshal(e)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}

	if err := s.pipe.Run(r.Context(), question, emit); err != nil {
		log.Printf("質問の処理に失敗: %v", err)
		emit(pipeline.Event{Type: "error", Message: "回答の生成に失敗しました"})
	}
}

// ---------------------------------------------------------------- 補助

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AllowOrigin != "" {
			w.Header().Set("Access-Control-Allow-Origin", s.cfg.AllowOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// limiter はセッションごとの1日の質問数を数える。
//
// メモリ上に持つため、Cloud Run が min-instances=0 でコールドスタートすると
// カウンタは失われる。上限を厳密に守る仕組みではなく、暴走を止める安全弁である。
// 厳密さが必要になったら外部ストアに移すこと。
type limiter struct {
	mu    sync.Mutex
	limit int
	day   string
	used  map[string]int
}

func newLimiter(limit int) *limiter {
	return &limiter{limit: limit, day: today(), used: map[string]int{}}
}

func today() string { return time.Now().UTC().Format("2006-01-02") }

func (l *limiter) rollover() {
	if d := today(); d != l.day {
		l.day, l.used = d, map[string]int{}
	}
}

func (l *limiter) take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	if l.used[key] >= l.limit {
		return false
	}
	l.used[key]++
	return true
}

func (l *limiter) remaining(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	if r := l.limit - l.used[key]; r > 0 {
		return r
	}
	return 0
}
