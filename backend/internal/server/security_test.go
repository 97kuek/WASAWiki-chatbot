package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSRejectsUnexpectedOrigin(t *testing.T) {
	srv := &Server{cfg: Config{AllowOrigin: "https://chat.example.test"}}
	handler := srv.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.Header.Set("Origin", "https://attacker.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("許可外Originを拒否していない: status=%d", recorder.Code)
	}
}

func TestCORSAllowsConfiguredOrigin(t *testing.T) {
	const origin = "https://chat.example.test"
	srv := &Server{cfg: Config{AllowOrigin: origin}}
	handler := srv.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.Header.Set("Origin", origin)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("許可Originを拒否した: status=%d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("CORSヘッダーが不正: %q", got)
	}
}

func TestAppCookieUsesCrossSiteSecurityAttributes(t *testing.T) {
	cookie := appCookie("test", "value", 60)
	if !cookie.HttpOnly || !cookie.Secure || !cookie.Partitioned || cookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("Cookieのセキュリティ属性が不足: %+v", cookie)
	}
}
