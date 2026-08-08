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

	"github.com/97kuek/wasa-chat/backend/internal/index"
	"github.com/97kuek/wasa-chat/backend/internal/llm"
	"github.com/97kuek/wasa-chat/backend/internal/pipeline"
	"github.com/97kuek/wasa-chat/backend/internal/wiki"
)

const (
	cookieName      = "wasa_session"
	usageCookieName = "wasa_daily_usage"
	sessionMaxAge   = 30 * 24 * time.Hour
)

type Config struct {
	SessionSecret string // Cookie署名用。未設定なら起動時に生成する
	DailyLimit    int    // 利用者1人あたりの1日の質問数上限
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
	mux.HandleFunc("POST /api/ask", s.requireAuth(s.handleAsk))
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
// Wikiの通常アカウントで本人確認する。共有パスワード1本だと全員が同じ利用者に
// なってしまい、レート制限を個人ごとに分けられないため。
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

// signUsage は日次の使用回数を改ざんできないCookieにする。
// サーバーのメモリだけではCloud Runのコールドスタートで回数が消えるため、
// 個人情報を含まない最小限の状態を利用者のブラウザにも持たせる。
func (s *Server) signUsage(user, day string, used int) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(user))
	body := fmt.Sprintf("%s|%s|%d", encoded, day, used)
	mac := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	fmt.Fprintf(mac, "usage|%s", body)
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) verifyUsage(token, expectedUser string) (string, int, bool) {
	body, signature, ok := strings.Cut(token, ".")
	if !ok {
		return "", 0, false
	}
	parts := strings.Split(body, "|")
	if len(parts) != 3 {
		return "", 0, false
	}
	user, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(user) != expectedUser {
		return "", 0, false
	}
	used, err := strconv.Atoi(parts[2])
	if err != nil || used < 0 || used > s.cfg.DailyLimit {
		return "", 0, false
	}
	expected := strings.TrimPrefix(s.signUsage(string(user), parts[1], used), body+".")
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return "", 0, false
	}
	return parts[1], used, true
}

func (s *Server) restoreUsage(r *http.Request, user string) {
	cookie, err := r.Cookie(usageCookieName)
	if err != nil {
		return
	}
	day, used, ok := s.verifyUsage(cookie.Value, user)
	if ok {
		s.limit.restore(user, day, used)
	}
}

func (s *Server) setUsageCookie(w http.ResponseWriter, user string) {
	day, used := s.limit.usage(user)
	http.SetCookie(w, appCookie(usageCookieName, s.signUsage(user, day, used), int(sessionMaxAge.Seconds())))
}

func appCookie(name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: name, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode,
		// Cloudflare PagesとCloud Runが別サイトでも、対応ブラウザでは
		// Cookieをトップレベルサイト単位に分離してログインを維持できる。
		Partitioned: true,
	}
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

	http.SetCookie(w, appCookie(
		cookieName,
		s.sign(user, time.Now().Add(sessionMaxAge).Unix()),
		int(sessionMaxAge.Seconds()),
	))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": user})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	remaining := 0
	if ok {
		s.restoreUsage(r, user)
		remaining = s.limit.remaining(user)
		s.setUsageCookie(w, user)
	}
	writeJSON(w, http.StatusOK,
		map[string]any{"authenticated": ok, "username": user, "remaining": remaining})
}

func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, appCookie(cookieName, "", -1))
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
	var body struct {
		Question string `json:"question"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "リクエストが不正です"})
		return
	}
	// 質問をURLに載せない。非公開Wikiに関する文面がアクセスログへ残るのを避けるため。
	question := strings.TrimSpace(body.Question)
	if question == "" || len([]rune(question)) > 500 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "質問を入力してください（500文字以内）"})
		return
	}

	// レート制限。本当の費用リスクはインフラではなく
	// API従量課金である（docs/01-設計方針.md §7）。これが実質的な上限装置になる。
	user, _ := s.currentUser(r)
	s.restoreUsage(r, user)
	if !s.limit.take(user) {
		s.setUsageCookie(w, user)
		writeJSON(w, http.StatusTooManyRequests,
			map[string]string{
				"error":    "本日の質問回数の上限に達しました。日本時間の0時以降にもう一度お試しください",
				"code":     "user_daily_limit",
				"retry_at": nextJapanMidnight().Format(time.RFC3339),
			})
		return
	}
	// SSE開始後はCookieヘッダーを書き換えられないため、確保した時点で保存する。
	// Gemini都合で返却した場合は、処理後にフロントが呼ぶ /api/session で訂正される。
	s.setUsageCookie(w, user)

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
		message := "回答の生成に失敗しました"
		code := ""
		retryAt := ""
		if errors.Is(err, llm.ErrDailyQuota) {
			s.limit.refund(user)
			code = "daily_quota"
			message = "Gemini無料枠の本日分を使い切りました。Google側の上限がリセットされてからお試しください"
		} else if errors.Is(err, llm.ErrRateLimited) {
			s.limit.refund(user)
			code = "rate_limit"
			message = "アクセスが集中し、Geminiの短時間の利用上限に達しました。数分後にもう一度お試しください"
		} else if errors.Is(err, llm.ErrUnavailable) {
			// 利用者ではなくGemini側の都合で失敗した質問は、個人の利用回数へ含めない。
			s.limit.refund(user)
			code = "unavailable"
			message = "現在Geminiを利用できません。時間を置いてからもう一度お試しください"
		}
		if at, ok := llm.RetryAt(err); ok {
			retryAt = at.Format(time.RFC3339)
		}
		emit(pipeline.Event{Type: "error", Message: message, Code: code, RetryAt: retryAt})
	}
}

// ---------------------------------------------------------------- 補助

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		// CORSヘッダーだけでは、レスポンスを読めなくするだけでPOST自体は届く。
		// CookieをSameSite=Noneで使うため、本番ではOriginも照合してCSRFを防ぐ。
		if origin := r.Header.Get("Origin"); origin != "" && s.cfg.AllowOrigin != "" && origin != s.cfg.AllowOrigin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "許可されていない送信元です"})
			return
		}
		if s.cfg.AllowOrigin != "" {
			w.Header().Set("Access-Control-Allow-Origin", s.cfg.AllowOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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

// limiter は利用者ごとの1日の質問数を数える。
// メモリを主に使い、署名付きCookieから復元する。Cookieは端末単位で削除できるため
// 厳密な課金制御ではなく、1人による意図しない使い過ぎを防ぐ安全弁である。
type limiter struct {
	mu    sync.Mutex
	limit int
	day   string
	used  map[string]int
}

func newLimiter(limit int) *limiter {
	return &limiter{limit: limit, day: today(), used: map[string]int{}}
}

// 画面の「本日」と一致させるため、Cloud RunのUTCではなく日本時間で日付を切り替える。
var japanTime = time.FixedZone("JST", 9*60*60)

func today() string { return time.Now().In(japanTime).Format("2006-01-02") }

func nextJapanMidnight() time.Time {
	now := time.Now().In(japanTime)
	return time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, japanTime)
}

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

func (l *limiter) usage(key string) (string, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	return l.day, l.used[key]
}

// restore は同じ日のCookieの方が多いときだけ採用する。
// 複数タブや古いレスポンスで、使用回数が巻き戻ることを防ぐため。
func (l *limiter) restore(key, day string, used int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	if day == l.day && used > l.used[key] {
		l.used[key] = min(used, l.limit)
	}
}

func (l *limiter) refund(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover()
	if l.used[key] > 0 {
		l.used[key]--
	}
}
