package server

import (
	"strings"
	"testing"

	"github.com/97kuek/wasa-chat/backend/internal/pipeline"
)

func TestValidConversationContext(t *testing.T) {
	valid := pipeline.ConversationTurn{Question: "前の質問", Answer: "前の回答"}
	cases := []struct {
		name    string
		context []pipeline.ConversationTurn
		want    bool
	}{
		{"履歴なし", nil, true},
		{"直近2往復", []pipeline.ConversationTurn{valid, valid}, true},
		{"3往復", []pipeline.ConversationTurn{valid, valid, valid}, false},
		{"質問が空", []pipeline.ConversationTurn{{Question: " ", Answer: "回答"}}, false},
		{"回答が空", []pipeline.ConversationTurn{{Question: "質問", Answer: " "}}, false},
		{"質問が長すぎる", []pipeline.ConversationTurn{{Question: strings.Repeat("問", 501), Answer: "回答"}}, false},
		{"回答が長すぎる", []pipeline.ConversationTurn{{Question: "質問", Answer: strings.Repeat("答", 2_001)}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validConversationContext(tc.context); got != tc.want {
				t.Errorf("validConversationContext() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestResponseModeValidation(t *testing.T) {
	for _, valid := range []string{"", "auto", "fast", "standard", "deep"} {
		if _, ok := pipeline.ParseResponseMode(valid); !ok {
			t.Errorf("有効な回答モードを拒否した: %q", valid)
		}
	}
	if _, ok := pipeline.ParseResponseMode("gemini-3.6-flash"); ok {
		t.Fatal("利用者が生のモデルIDを指定できている")
	}
}
