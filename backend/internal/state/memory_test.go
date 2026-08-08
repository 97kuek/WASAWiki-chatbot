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

func TestMemoryRestoreDoesNotRollBackUsage(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	if err := store.RestoreUsage(ctx, "利用者", "2026-08-08", 7, 30); err != nil {
		t.Fatal(err)
	}
	if err := store.RestoreUsage(ctx, "利用者", "2026-08-08", 3, 30); err != nil {
		t.Fatal(err)
	}
	if remaining, _ := store.Remaining(ctx, "利用者", "2026-08-08", 30); remaining != 23 {
		t.Fatalf("古い値で回数が巻き戻った: remaining=%d", remaining)
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
