// Package server はHTTP層。認証・レート制限・SSEストリーミングを担う。
package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	"github.com/97kuek/WASAWiki-chatbot/backend/internal/wiki"
)

const (
	cookieName    = "wasa_session"
	sessionMaxAge = 30 * 24 * time.Hour
)

type Config struct {
	SessionSecret string // Cookie署名用。未設定なら起動時に生成する
	DailyLimit    int    // 1セッションあたりの1日の質問数上限
	AllowOrigin   string // 開発時にViteのdev serverから叩くためのCORS設定
	SPADir        string // 指定するとビルド済みSPAも同じサーバーから配る
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
	auth  *wiki.Authenticator
	limit *limiter
}

func New(cfg Config, ix *index.Index, pipe *pipeline.Pipeline, auth *wiki.Authenticator) *Server {
	return &Server{cfg: cfg, ix: ix, pipe: pipe, auth: auth, limit: newLimiter(cfg.DailyLimit)}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
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
// Wikiのアカウントで本人確認する。共有パスワード1本だと全員が同じ利用者に
// なってしまい、チャット履歴を個人ごとに分けられないため。
// パスワードは検証に使って捨て、Cookieには利用者名と有効期限だけを載せる。

func (s *Server) sign(user string, expiry int64) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	fmt.Fprintf(mac, "%s|%d", user, expiry)
	return fmt.Sprintf("%s|%d.%s", base64.RawURLEncoding.EncodeToString([]byte(user)),
		expiry, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}

// verify はCookieを検証し、利用者名を返す。
func (s *Server) verify(token string) (string, bool) {
	body, _, ok := strings.Cut(token, ".")
	if !ok {
		return "", false
	}
	encoded, rawExpiry, ok := strings.Cut(body, "|")
	if !ok {
		return "", false
	}
	user, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", false
	}
	expiry, err := strconv.ParseInt(rawExpiry, 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return "", false
	}
	if !hmac.Equal([]byte(s.sign(string(user), expiry)), []byte(token)) {
		return "", false
	}
	return string(user), true
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "リクエストが不正です"})
		return
	}

	// パスワードはここで使い切る。保存もログ出力もしない
	user, err := s.auth.Login(r.Context(), strings.TrimSpace(body.Username), body.Password)
	if err != nil {
		time.Sleep(300 * time.Millisecond) // 総当たりの速度を落とす
		status, message := http.StatusUnauthorized, err.Error()
		if errors.Is(err, wiki.ErrUnavailable) {
			status = http.StatusBadGateway
			log.Printf("Wikiへの接続に失敗: %v", err)
			message = "Wikiに接続できませんでした。しばらくしてからお試しください"
		}
		writeJSON(w, status, map[string]string{"error": message})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sign(user, time.Now().Add(sessionMaxAge).Unix()),
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode, // フロントを別オリジン(Cloudflare Pages)に置くため
		MaxAge:   int(sessionMaxAge.Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": user})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	remaining := 0
	if ok {
		remaining = s.limit.remaining(user)
	}
	writeJSON(w, http.StatusOK,
		map[string]any{"authenticated": ok, "username": user, "remaining": remaining})
}

func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) currentUser(r *http.Request) (string, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return "", false
	}
	return s.verify(c.Value)
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.currentUser(r); !ok {
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
	user, _ := s.currentUser(r)
	if !s.limit.take(user) {
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
