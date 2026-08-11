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

func (f *Firestore) SaveFeedback(ctx context.Context, feedback Feedback) error {
	_, err := f.client.Collection("feedback").Doc(feedback.ID).Set(ctx, feedback)
	return err
}

// 保存期間を過ぎた報告を消す。1回で消す件数に上限を置き、溜まっていた場合でも
// 利用者のリクエストを長く待たせない。残りは次回の送信時に消える。
const maxFeedbackPurge = 100

func (f *Firestore) PurgeFeedback(ctx context.Context, before string) (int, error) {
	snapshots, err := f.client.Collection("feedback").
		Where("submitted_at", "<", before).
		Limit(maxFeedbackPurge).
		Documents(ctx).
		GetAll()
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, snapshot := range snapshots {
		if _, err := snapshot.Ref.Delete(ctx); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (f *Firestore) ListFeedback(ctx context.Context, limit int) ([]Feedback, error) {
	query := f.client.Collection("feedback").OrderBy("submitted_at", firestore.Desc)
	if limit > 0 {
		query = query.Limit(limit)
	}
	snapshots, err := query.Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	list := make([]Feedback, 0, len(snapshots))
	for _, snapshot := range snapshots {
		var item Feedback
		if err := snapshot.DataTo(&item); err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	return list, nil
}

// アシスタントは全員で共有するため users/ の下ではなくトップレベルに置く。
func (f *Firestore) assistantCollection() *firestore.CollectionRef {
	return f.client.Collection("assistants")
}

func (f *Firestore) ListAssistants(ctx context.Context) ([]Assistant, error) {
	snapshots, err := f.assistantCollection().
		OrderBy("created_at", firestore.Asc).
		Documents(ctx).
		GetAll()
	if err != nil {
		return nil, err
	}
	list := make([]Assistant, 0, len(snapshots))
	for _, snapshot := range snapshots {
		var assistant Assistant
		if err := snapshot.DataTo(&assistant); err != nil {
			return nil, err
		}
		list = append(list, assistant)
	}
	return list, nil
}

// SaveAssistant は無条件に書き込む。初期アシスタントの投入にだけ使う
// （Apply が事前に一覧で存在を確認しており、競合する呼び出し元がない）。
func (f *Firestore) SaveAssistant(ctx context.Context, assistant Assistant) error {
	_, err := f.assistantCollection().Doc(assistant.ID).Set(ctx, assistant)
	return err
}

// CreateAssistant は Create を使う。存在すればFirestoreがAlreadyExistsで弾くため、
// 同時作成でも後勝ちの上書きが起きない（Setだと両方通ってしまう）。
func (f *Firestore) CreateAssistant(ctx context.Context, assistant Assistant) error {
	_, err := f.assistantCollection().Doc(assistant.ID).Create(ctx, assistant)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAssistantExists
	}
	return err
}

func (f *Firestore) UpdateAssistant(ctx context.Context, assistant Assistant) error {
	_, err := f.assistantCollection().Doc(assistant.ID).Set(ctx, assistant)
	return err
}

func (f *Firestore) DeleteAssistant(ctx context.Context, id string) error {
	_, err := f.assistantCollection().Doc(id).Delete(ctx)
	return err
}

var _ Store = (*Firestore)(nil)
var _ Store = (*Memory)(nil)
