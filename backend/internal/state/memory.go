package state

import (
	"context"
	"sort"
	"sync"
)

// Memoryはローカル開発と単体テスト用。Cloud RunではFirestoreを必須にする。
type Memory struct {
	mu    sync.Mutex
	usage map[string]int
	chats map[string]map[string]Chat
}

func NewMemory() *Memory {
	return &Memory{usage: map[string]int{}, chats: map[string]map[string]Chat{}}
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
