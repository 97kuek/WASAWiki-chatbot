// Package state は、端末をまたいで共有する利用回数とチャット履歴を管理する。
package state

import "context"

type Source struct {
	Title      string `json:"title" firestore:"title"`
	URL        string `json:"url" firestore:"url"`
	LastEdited string `json:"last_edited" firestore:"last_edited"`
	Origin     string `json:"origin,omitempty" firestore:"origin,omitempty"`
}

type Turn struct {
	Question  string   `json:"question" firestore:"question"`
	Answer    string   `json:"answer" firestore:"answer"`
	Sources   []Source `json:"sources" firestore:"sources"`
	Status    string   `json:"status" firestore:"status"`
	RetryAt   string   `json:"retryAt,omitempty" firestore:"retry_at,omitempty"`
	Error     string   `json:"error,omitempty" firestore:"error,omitempty"`
	ErrorCode string   `json:"errorCode,omitempty" firestore:"error_code,omitempty"`
	Streaming bool     `json:"streaming" firestore:"streaming"`
}

type Chat struct {
	ID        string `json:"id" firestore:"id"`
	Title     string `json:"title" firestore:"title"`
	CreatedAt string `json:"createdAt" firestore:"created_at"`
	UpdatedAt string `json:"updatedAt" firestore:"updated_at"`
	Turns     []Turn `json:"turns" firestore:"turns"`
	Pinned    bool   `json:"pinned,omitempty" firestore:"pinned"`
}

// Storeの利用者キーには、利用者名そのものではなくサーバー側でHMAC化した値を渡す。
type Store interface {
	Remaining(context.Context, string, string, int) (int, error)
	RestoreUsage(context.Context, string, string, int, int) error
	Take(context.Context, string, string, int) (bool, error)
	Refund(context.Context, string, string) error
	ListChats(context.Context, string, int) ([]Chat, error)
	SaveChat(context.Context, string, Chat, int) error
	DeleteChat(context.Context, string, string) error
}
