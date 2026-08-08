package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

func historyTestServer() *Server {
	return &Server{
		cfg:   Config{SessionSecret: "テスト用の固定鍵", DailyLimit: 30},
		state: state.NewMemory(),
	}
}

func authenticatedRequest(srv *Server, method, target, body, user string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.AddCookie(appCookie(cookieName, srv.sign(user, time.Now().Add(time.Hour).Unix()), 3600))
	return req
}

func TestChatHistoryIsSavedPerUser(t *testing.T) {
	srv := historyTestServer()
	chat := `{"id":"chat-1","title":"試験","createdAt":"2026-08-08T10:00:00Z","updatedAt":"2026-08-08T10:00:00Z","turns":[{"question":"質問","answer":"回答","sources":[],"status":"","streaming":false}]}`
	put := authenticatedRequest(srv, http.MethodPut, "/api/chats/chat-1", chat, "利用者A")
	put.SetPathValue("id", "chat-1")
	putRecorder := httptest.NewRecorder()
	srv.handleSaveChat(putRecorder, put)
	if putRecorder.Code != http.StatusNoContent {
		t.Fatalf("履歴を保存できない: status=%d body=%s", putRecorder.Code, putRecorder.Body.String())
	}

	get := authenticatedRequest(srv, http.MethodGet, "/api/chats", "", "利用者A")
	getRecorder := httptest.NewRecorder()
	srv.handleListChats(getRecorder, get)
	var body struct {
		Chats []state.Chat `json:"chats"`
	}
	if err := json.NewDecoder(getRecorder.Body).Decode(&body); err != nil || len(body.Chats) != 1 {
		t.Fatalf("保存した履歴を取得できない: chats=%d err=%v", len(body.Chats), err)
	}

	other := authenticatedRequest(srv, http.MethodGet, "/api/chats", "", "利用者B")
	otherRecorder := httptest.NewRecorder()
	srv.handleListChats(otherRecorder, other)
	if err := json.NewDecoder(otherRecorder.Body).Decode(&body); err != nil || len(body.Chats) != 0 {
		t.Fatalf("別利用者へ履歴が漏れた: chats=%d err=%v", len(body.Chats), err)
	}
}

func TestDeleteChatHistory(t *testing.T) {
	srv := historyTestServer()
	chat := state.Chat{ID: "chat-1", UpdatedAt: "2026-08-08T10:00:00Z"}
	if err := srv.state.SaveChat(t.Context(), srv.userKey("利用者"), chat, maxChats); err != nil {
		t.Fatal(err)
	}
	req := authenticatedRequest(srv, http.MethodDelete, "/api/chats/chat-1", "", "利用者")
	req.SetPathValue("id", "chat-1")
	recorder := httptest.NewRecorder()
	srv.handleDeleteChat(recorder, req)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("履歴を削除できない: status=%d", recorder.Code)
	}
	chats, _ := srv.state.ListChats(t.Context(), srv.userKey("利用者"), maxChats)
	if len(chats) != 0 {
		t.Fatal("削除後も履歴が残っている")
	}
}
