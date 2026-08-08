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

// Assistant は利用者が作り、全員で共有するアシスタント。
//
// チャット履歴と違い、**利用者名を平文で持つ**（Author）。履歴の保存先は
// 利用者名をHMAC化して隠しているが、アシスタントは「誰が作ったか」を
// 画面に出すことが安全装置そのものなので、隠しては意味がない。
// 匿名で共有できないことが、内容の管理を人手に頼らずに済む理由である。
type Assistant struct {
	ID          string `json:"id" firestore:"id"`
	Name        string `json:"name" firestore:"name"`
	Description string `json:"description" firestore:"description"`
	// 口調・語尾・文体・出力形式のための追加指示。事実の扱いの規則は上書きできない
	// （組み立ては internal/assistant を参照）。
	Instruction string `json:"instruction" firestore:"instruction"`
	// 参照範囲の絞り込み。空なら絞らない。**広げる方向の指定は存在しない**
	Team   string `json:"team,omitempty" firestore:"team,omitempty"`
	Origin string `json:"origin,omitempty" firestore:"origin,omitempty"` // "" | "wiki" | "site"

	Author    string `json:"author" firestore:"author"` // Wikiの利用者名。画面に必ず出す
	CreatedAt string `json:"createdAt" firestore:"created_at"`
	UpdatedAt string `json:"updatedAt" firestore:"updated_at"`
}

// Storeの利用者キーには、利用者名そのものではなくサーバー側でHMAC化した値を渡す。
// ただしアシスタントは全員で共有するため、利用者ごとの区別を持たない。
type Store interface {
	Remaining(context.Context, string, string, int) (int, error)
	RestoreUsage(context.Context, string, string, int, int) error
	Take(context.Context, string, string, int) (bool, error)
	Refund(context.Context, string, string) error
	ListChats(context.Context, string, int) ([]Chat, error)
	SaveChat(context.Context, string, Chat, int) error
	DeleteChat(context.Context, string, string) error

	ListAssistants(context.Context) ([]Assistant, error)
	SaveAssistant(context.Context, Assistant) error
	DeleteAssistant(context.Context, string) error
}
