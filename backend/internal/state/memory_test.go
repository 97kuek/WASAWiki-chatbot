package state

import (
	"context"
	"fmt"
	"testing"
)

func TestMemoryUsageIsSharedByUserAndDay(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	for range 3 {
		taken, err := store.Take(ctx, "利用者", "2026-08-08", 3)
		if err != nil || !taken {
			t.Fatalf("質問回数を確保できない: taken=%v err=%v", taken, err)
		}
	}
	if taken, err := store.Take(ctx, "利用者", "2026-08-08", 3); err != nil || taken {
		t.Fatalf("上限を超えて確保した: taken=%v err=%v", taken, err)
	}
	if err := store.Refund(ctx, "利用者", "2026-08-08"); err != nil {
		t.Fatal(err)
	}
	if remaining, _ := store.Remaining(ctx, "利用者", "2026-08-08", 3); remaining != 1 {
		t.Fatalf("返却が反映されていない: remaining=%d", remaining)
	}
	if remaining, _ := store.Remaining(ctx, "利用者", "2026-08-09", 3); remaining != 3 {
		t.Fatalf("日付をまたいで回数が混ざった: remaining=%d", remaining)
	}
}

func TestMemoryKeepsNewestThirtyChats(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	for i := range 31 {
		chat := Chat{
			ID: fmt.Sprintf("chat-%02d", i), UpdatedAt: fmt.Sprintf("2026-08-08T00:%02d:00Z", i),
		}
		if err := store.SaveChat(ctx, "利用者", chat, 30); err != nil {
			t.Fatal(err)
		}
	}
	chats, err := store.ListChats(ctx, "利用者", 30)
	if err != nil || len(chats) != 30 {
		t.Fatalf("30件に整理されていない: len=%d err=%v", len(chats), err)
	}
	if chats[0].ID != "chat-30" || chats[len(chats)-1].ID != "chat-01" {
		t.Fatalf("新しい30件が残っていない: first=%s last=%s", chats[0].ID, chats[len(chats)-1].ID)
	}
}

// プライバシーポリシーに「1年で削除する」と書いた以上、期限の判定が
// 実際に効いていることを固定しておく。境界（ちょうど期限の値）は消さない。
func TestMemoryPurgesFeedbackOlderThanCutoff(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	items := map[string]string{
		"古い":  "2025-08-08T23:59:59Z",
		"境界":  "2025-08-09T00:00:00Z",
		"新しい": "2026-08-09T00:00:00Z",
	}
	for id, at := range items {
		if err := store.SaveFeedback(ctx, Feedback{ID: id, Kind: "general", SubmittedAt: at}); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := store.PurgeFeedback(ctx, "2025-08-09T00:00:00Z")
	if err != nil || removed != 1 {
		t.Fatalf("期限より古い1件だけを消していない: removed=%d err=%v", removed, err)
	}

	list, err := store.ListFeedback(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("残る件数が違う: %d", len(list))
	}
	for _, item := range list {
		if item.ID == "古い" {
			t.Fatal("期限を過ぎた報告が残っている")
		}
	}
}
