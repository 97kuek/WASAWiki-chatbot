package state

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Firestore struct {
	client *firestore.Client
}

func NewFirestore(ctx context.Context, projectID string) (*Firestore, error) {
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return &Firestore{client: client}, nil
}

func (f *Firestore) Close() error { return f.client.Close() }

func (f *Firestore) usageDoc(user, day string) *firestore.DocumentRef {
	return f.client.Collection("users").Doc(user).Collection("usage").Doc(day)
}

func usedFromSnapshot(snapshot *firestore.DocumentSnapshot) int {
	value, err := snapshot.DataAt("used")
	if err != nil {
		return 0
	}
	switch used := value.(type) {
	case int64:
		return int(used)
	case int:
		return used
	default:
		return 0
	}
}

func (f *Firestore) Remaining(ctx context.Context, user, day string, limit int) (int, error) {
	snapshot, err := f.usageDoc(user, day).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return limit, nil
	}
	if err != nil {
		return 0, err
	}
	return max(limit-usedFromSnapshot(snapshot), 0), nil
}

func (f *Firestore) RestoreUsage(ctx context.Context, user, day string, used, limit int) error {
	ref := f.usageDoc(user, day)
	return f.client.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		current := 0
		snapshot, err := tx.Get(ref)
		if err == nil {
			current = usedFromSnapshot(snapshot)
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		if used <= current {
			return nil
		}
		return tx.Set(ref, map[string]any{
			"used":       min(used, limit),
			"updated_at": time.Now().UTC(),
		})
	})
}

func (f *Firestore) Take(ctx context.Context, user, day string, limit int) (bool, error) {
	ref := f.usageDoc(user, day)
	taken := false
	err := f.client.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		taken = false
		used := 0
		snapshot, err := tx.Get(ref)
		if err == nil {
			used = usedFromSnapshot(snapshot)
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		if used >= limit {
			return nil
		}
		taken = true
		return tx.Set(ref, map[string]any{
			"used":       used + 1,
			"updated_at": time.Now().UTC(),
		})
	})
	return taken, err
}

func (f *Firestore) Refund(ctx context.Context, user, day string) error {
	ref := f.usageDoc(user, day)
	return f.client.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snapshot, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return nil
		}
		if err != nil {
			return err
		}
		used := usedFromSnapshot(snapshot)
		if used == 0 {
			return nil
		}
		return tx.Set(ref, map[string]any{
			"used":       used - 1,
			"updated_at": time.Now().UTC(),
		})
	})
}

func (f *Firestore) chatCollection(user string) *firestore.CollectionRef {
	return f.client.Collection("users").Doc(user).Collection("chats")
}

func (f *Firestore) ListChats(ctx context.Context, user string, limit int) ([]Chat, error) {
	snapshots, err := f.chatCollection(user).
		OrderBy("updated_at", firestore.Desc).
		Limit(limit).
		Documents(ctx).
		GetAll()
	if err != nil {
		return nil, err
	}
	chats := make([]Chat, 0, len(snapshots))
	for _, snapshot := range snapshots {
		var chat Chat
		if err := snapshot.DataTo(&chat); err != nil {
			return nil, err
		}
		chats = append(chats, chat)
	}
	return chats, nil
}

func (f *Firestore) SaveChat(ctx context.Context, user string, chat Chat, limit int) error {
	collection := f.chatCollection(user)
	if _, err := collection.Doc(chat.ID).Set(ctx, chat); err != nil {
		return err
	}
	snapshots, err := collection.
		OrderBy("updated_at", firestore.Desc).
		Documents(ctx).
		GetAll()
	if err != nil {
		return err
	}
	if len(snapshots) <= limit {
		return nil
	}
	batch := f.client.Batch()
	for _, snapshot := range snapshots[limit:] {
		batch.Delete(snapshot.Ref)
	}
	_, err = batch.Commit(ctx)
	return err
}

func (f *Firestore) DeleteChat(ctx context.Context, user, chatID string) error {
	_, err := f.chatCollection(user).Doc(chatID).Delete(ctx)
	return err
}

var _ Store = (*Firestore)(nil)
var _ Store = (*Memory)(nil)
