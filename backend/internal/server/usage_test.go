package server

import (
	"context"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

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
