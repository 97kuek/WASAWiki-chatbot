package server

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

func TestLegacyUsageCookieRestoresSharedUsage(t *testing.T) {
	const user = "利用者"
	shared := state.NewMemory()
	srv := &Server{
		cfg:   Config{SessionSecret: "テスト用の固定鍵", DailyLimit: 30},
		state: shared,
	}
	token := srv.signUsage(user, today(), 8)
	req := httptest.NewRequest("GET", "/api/session", nil)
	req.AddCookie(appCookie(usageCookieName, token, 3600))

	if err := srv.restoreUsage(context.Background(), req, user); err != nil {
		t.Fatalf("旧Cookieを移行できない: %v", err)
	}
	remaining, err := shared.Remaining(context.Background(), srv.userKey(user), today(), 30)
	if err != nil || remaining != 22 {
		t.Fatalf("利用回数が共有状態へ復元されていない: remaining=%d err=%v", remaining, err)
	}
}

func TestUsageCookieIsSignedAndBoundToUser(t *testing.T) {
	srv := &Server{cfg: Config{SessionSecret: "テスト用の固定鍵", DailyLimit: 30}}
	token := srv.signUsage("利用者A", today(), 8)
	day, used, ok := srv.verifyUsage(token, "利用者A")
	if !ok || day != today() || used != 8 {
		t.Fatalf("使用回数Cookieを検証できていない: day=%q used=%d ok=%v", day, used, ok)
	}
	if _, _, ok := srv.verifyUsage(token, "利用者B"); ok {
		t.Fatal("別の利用者の使用回数Cookieを受け入れた")
	}
	if _, _, ok := srv.verifyUsage(token+"x", "利用者A"); ok {
		t.Fatal("改ざんした使用回数Cookieを受け入れた")
	}
}

func TestUserKeyDoesNotExposeUsername(t *testing.T) {
	srv := &Server{cfg: Config{SessionSecret: "テスト用の固定鍵"}}
	first := srv.userKey("利用者A")
	if first != srv.userKey("利用者A") || first == srv.userKey("利用者B") {
		t.Fatal("利用者キーが利用者ごとに安定していない")
	}
	if first == "利用者A" {
		t.Fatal("利用者名をそのまま保存キーにしている")
	}
}

// 返却が必要になる場面の多くは利用者の切断であり、その時点で
// リクエストのcontextはキャンセル済みになっている。メモリ実装は
// contextを見ないので素通りするが、Firestoreはトランザクションを
// 開始できず返却が黙って失敗する。切り離せていることを直接確かめる。
func TestRefundSurvivesCancelledRequestContext(t *testing.T) {
	shared := &contextRecordingStore{Memory: state.NewMemory()}
	srv := &Server{cfg: Config{SessionSecret: "テスト用の固定鍵テスト用の固定鍵", DailyLimit: 30}, state: shared}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	if err := srv.refund(cancelled, "利用者キー", today()); err != nil {
		t.Fatalf("キャンセル済みcontextで返却が失敗した: %v", err)
	}
	if shared.refundErr != nil {
		t.Errorf("返却へ渡したcontextがキャンセル済みだった: %v", shared.refundErr)
	}
}

// 渡されたcontextが生きているかを記録するだけのStore。
type contextRecordingStore struct {
	*state.Memory
	refundErr error
}

func (c *contextRecordingStore) Refund(ctx context.Context, user, day string) error {
	c.refundErr = ctx.Err()
	return c.Memory.Refund(ctx, user, day)
}
