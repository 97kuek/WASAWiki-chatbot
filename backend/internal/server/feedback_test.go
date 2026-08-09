package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

type feedbackNotifierStub struct {
	item state.Feedback
	err  error
}

func (n *feedbackNotifierStub) Notify(_ context.Context, item state.Feedback) error {
	n.item = item
	return n.err
}

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

func TestGeneralFeedbackIsSavedAndEmailed(t *testing.T) {
	notifier := &feedbackNotifierStub{}
	srv := feedbackTestServer()
	srv.cfg.FeedbackNotifier = notifier
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback",
		`{"clientId":"report-1","kind":"general","reasons":["feature"],"comment":"会話を引き継いでほしい","page":"chat"}`, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"notification":"sent"`) {
		t.Fatalf("保存と通知が完了しない: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if notifier.item.Comment != "会話を引き継いでほしい" || notifier.item.ReporterKey == "" {
		t.Fatalf("保存した内容が通知へ渡っていない: %+v", notifier.item)
	}
}

func TestMailFailureDoesNotDiscardFeedback(t *testing.T) {
	notifier := &feedbackNotifierStub{err: errors.New("一時的なSMTP障害")}
	srv := feedbackTestServer()
	srv.cfg.FeedbackNotifier = notifier
	req := authenticatedRequest(srv, http.MethodPost, "/api/feedback",
		`{"clientId":"report-2","kind":"general","reasons":["bug"],"page":"chat"}`, "利用者")
	recorder := httptest.NewRecorder()
	srv.handleSaveFeedback(recorder, req)
	items, err := srv.state.ListFeedback(t.Context(), 100)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"notification":"failed"`) || err != nil || len(items) != 1 {
		t.Fatalf("メール障害時に保存されない: status=%d body=%s count=%d err=%v", recorder.Code, recorder.Body.String(), len(items), err)
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

func TestOnlyAdminCanListFeedbackAndReporterIsHidden(t *testing.T) {
	srv := feedbackTestServer()
	if err := srv.state.SaveFeedback(t.Context(), state.Feedback{
		ID: "feedback-1", ReporterKey: "秘密の利用者キー", Kind: "general",
		Reasons: []string{"feature"}, SubmittedAt: "2026-08-09T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	denied := authenticatedRequest(srv, http.MethodGet, "/api/feedback", "", "利用者")
	deniedRecorder := httptest.NewRecorder()
	srv.handleListFeedback(deniedRecorder, denied)
	if deniedRecorder.Code != http.StatusForbidden {
		t.Fatalf("一般利用者が一覧を取得できた: status=%d", deniedRecorder.Code)
	}

	allowed := authenticatedRequest(srv, http.MethodGet, "/api/feedback", "", "管理者")
	allowedRecorder := httptest.NewRecorder()
	srv.handleListFeedback(allowedRecorder, allowed)
	if allowedRecorder.Code != http.StatusOK {
		t.Fatalf("管理者が一覧を取得できない: status=%d", allowedRecorder.Code)
	}
	if strings.Contains(allowedRecorder.Body.String(), "秘密の利用者キー") ||
		strings.Contains(allowedRecorder.Body.String(), "reporter") {
		t.Fatalf("利用者キーが一覧へ漏れた: %s", allowedRecorder.Body.String())
	}
	var body struct {
		Feedback []state.Feedback `json:"feedback"`
	}
	if err := json.NewDecoder(allowedRecorder.Body).Decode(&body); err != nil || len(body.Feedback) != 1 {
		t.Fatalf("一覧の形式が不正: count=%d err=%v", len(body.Feedback), err)
	}
}

func TestFeedbackSessionTellsTheFrontendWhetherUserIsAdmin(t *testing.T) {
	srv := feedbackTestServer()
	for _, test := range []struct {
		user string
		want bool
	}{{"管理者", true}, {"利用者", false}} {
		req := authenticatedRequest(srv, http.MethodGet, "/api/session", "", test.user)
		recorder := httptest.NewRecorder()
		srv.handleSession(recorder, req)
		var body struct {
			Admin bool `json:"admin"`
		}
		if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil || body.Admin != test.want {
			t.Errorf("管理者表示が不正: user=%s admin=%v want=%v err=%v", test.user, body.Admin, test.want, err)
		}
	}
}
