package state

import (
	"context"
	"sort"
	"sync"
)

// Memoryはローカル開発と単体テスト用。Cloud RunではFirestoreを必須にする。
type Memory struct {
	mu         sync.Mutex
	usage      map[string]int
	chats      map[string]map[string]Chat
	feedback   map[string]Feedback
	assistants map[string]Assistant
}

func NewMemory() *Memory {
	return &Memory{
		usage:      map[string]int{},
		chats:      map[string]map[string]Chat{},
		feedback:   map[string]Feedback{},
		assistants: map[string]Assistant{},
	}
}

func usageKey(user, day string) string { return user + "\x00" + day }

func (m *Memory) Remaining(_ context.Context, user, day string, limit int) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return max(limit-m.usage[usageKey(user, day)], 0), nil
}

func (m *Memory) RestoreUsage(_ context.Context, user, day string, used, limit int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := usageKey(user, day)
	if used > m.usage[key] {
		m.usage[key] = min(used, limit)
	}
	return nil
}

func (m *Memory) Take(_ context.Context, user, day string, limit int) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := usageKey(user, day)
	if m.usage[key] >= limit {
		return false, nil
	}
	m.usage[key]++
	return true, nil
}

func (m *Memory) Refund(_ context.Context, user, day string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := usageKey(user, day)
	if m.usage[key] > 0 {
		m.usage[key]--
	}
	return nil
}

func (m *Memory) ListChats(_ context.Context, user string, limit int) ([]Chat, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var chats []Chat
	for _, chat := range m.chats[user] {
		chats = append(chats, chat)
	}
	sort.Slice(chats, func(i, j int) bool { return chats[i].UpdatedAt > chats[j].UpdatedAt })
	if len(chats) > limit {
		chats = chats[:limit]
	}
	return chats, nil
}

func (m *Memory) SaveChat(_ context.Context, user string, chat Chat, limit int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chats[user] == nil {
		m.chats[user] = map[string]Chat{}
	}
	m.chats[user][chat.ID] = chat
	if len(m.chats[user]) <= limit {
		return nil
	}
	var chats []Chat
	for _, item := range m.chats[user] {
		chats = append(chats, item)
	}
	sort.Slice(chats, func(i, j int) bool { return chats[i].UpdatedAt > chats[j].UpdatedAt })
	for _, item := range chats[limit:] {
		delete(m.chats[user], item.ID)
	}
	return nil
}

func (m *Memory) DeleteChat(_ context.Context, user, chatID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.chats[user], chatID)
	return nil
}

func (m *Memory) SaveFeedback(_ context.Context, feedback Feedback) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.feedback[feedback.ID] = feedback
	return nil
}

func (m *Memory) ListFeedback(_ context.Context, limit int) ([]Feedback, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := make([]Feedback, 0, len(m.feedback))
	for _, item := range m.feedback {
		list = append(list, item)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].SubmittedAt > list[j].SubmittedAt })
	if len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

func (m *Memory) ListAssistants(_ context.Context) ([]Assistant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := make([]Assistant, 0, len(m.assistants))
	for _, item := range m.assistants {
		list = append(list, item)
	}
	// 作成順に並べる。人気順や利用回数での並べ替えは、数が増えて
	// 探しづらくなってから足す（いまは10件程度を想定している）
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt < list[j].CreatedAt })
	return list, nil
}

// SaveAssistant は無条件に書き込む。シード投入と下準備のためだけに使う。
func (m *Memory) SaveAssistant(_ context.Context, assistant Assistant) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.assistants[assistant.ID] = assistant
	return nil
}

func (m *Memory) CreateAssistant(_ context.Context, assistant Assistant) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	// 検査と書き込みを同じロックの中で行う。分けると同時作成で両方通る
	if _, exists := m.assistants[assistant.ID]; exists {
		return ErrAssistantExists
	}
	m.assistants[assistant.ID] = assistant
	return nil
}

func (m *Memory) UpdateAssistant(_ context.Context, assistant Assistant) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.assistants[assistant.ID] = assistant
	return nil
}

func (m *Memory) DeleteAssistant(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.assistants, id)
	return nil
}
