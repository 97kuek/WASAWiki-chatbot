package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

func feedbackTestServer() *Server {
	return &Server{
		cfg: Config{
			SessionSecret: "フィードバック用の十分に長い固定テスト鍵",
			AdminUsers:    []string{"管理者"},
		},
		state: state.NewMemory(),
	}
}

func TestAnswerFeedbackCanBeSentWithOneTapAndUpdated(t *testing.T) {
	srv := feedbackTestServer()
	first := `{"clientId":"chat-1:0","kind":"answer","rating":"good","question":"質問",` +
		`"answer":"回答","sources":[],"chatId":"chat-1","turnIndex":0,"page":"chat","responseMode":"auto"}`
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback", first, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("1タップ評価を保存できない: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	updated := `{"clientId":"chat-1:0","kind":"answer","rating":"bad","reasons":["missing"],` +
		`"comment":"必要な資料がない","question":"質問","answer":"回答","sources":[],` +
		`"timings":{"pagesMs":1200,"chunksMs":300,"answerMs":2500,"totalMs":4100},` +
		`"chatId":"chat-1","turnIndex":0,"page":"chat","responseMode":"auto"}`
	req = authenticatedRequest(srv, http.MethodPost, "/api/feedback", updated, "利用者")
	recorder = httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	items, err := srv.state.ListFeedback(t.Context(), 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("同じ回答の評価が重複した: count=%d err=%v", len(items), err)
	}
	if items[0].Rating != "bad" || items[0].Comment != "必要な資料がない" ||
		items[0].Timings == nil || items[0].Timings.TotalMS != 4100 {
		t.Fatalf("理由と補足で更新できていない: %+v", items[0])
	}
}

func TestFeedbackRejectsInvalidStageTimings(t *testing.T) {
	srv := feedbackTestServer()
	invalid := `{"clientId":"chat-1:0","kind":"answer","rating":"bad","question":"質問","answer":"回答",` +
		`"timings":{"pagesMs":5000,"totalMs":1000},"chatId":"chat-1","turnIndex":0,"page":"chat"}`
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback", invalid, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("合計より長い段階時間を受け付けた: status=%d", recorder.Code)
	}
}

func TestGeneralFeedbackRequiresAReasonOrComment(t *testing.T) {
	srv := feedbackTestServer()
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback",
		`{"clientId":"report-1","kind":"general","page":"chat"}`, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("空の改善報告を受け付けた: status=%d", recorder.Code)
	}
}

func TestGeneralFeedbackIsSaved(t *testing.T) {
	srv := feedbackTestServer()
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback",
		`{"clientId":"report-1","kind":"general","reasons":["feature"],"comment":"会話を引き継いでほしい","page":"chat"}`, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	items, err := srv.state.ListFeedback(t.Context(), 100)
	if recorder.Code != http.StatusOK || err != nil || len(items) != 1 {
		t.Fatalf("改善報告が保存されない: status=%d body=%s count=%d err=%v", recorder.Code, recorder.Body.String(), len(items), err)
	}
	if items[0].Comment != "会話を引き継いでほしい" || items[0].ReporterKey == "" {
		t.Fatalf("保存した内容が欠けている: %+v", items[0])
	}
}

func TestFeedbackRejectsAReasonForTheWrongRating(t *testing.T) {
	srv := feedbackTestServer()
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback",
		`{"clientId":"chat-1:0","kind":"answer","rating":"good","reasons":["incorrect"],`+
			`"question":"質問","answer":"回答","chatId":"chat-1","turnIndex":0,"page":"chat"}`, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("評価と矛盾する理由を受け付けた: status=%d", recorder.Code)
	}
}
