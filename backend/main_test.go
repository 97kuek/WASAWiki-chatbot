package main

import "testing"

func TestGeminiDataUseApproved(t *testing.T) {
	tests := []struct {
		name string
		paid string
		free string
		want bool
	}{
		{name: "未承認", want: false},
		{name: "有料枠", paid: "true", want: true},
		{name: "無料枠の会議承認", free: "true", want: true},
		{name: "true以外は承認にしない", paid: "TRUE", free: "1", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("GEMINI_PAID_TIER", tt.paid)
			t.Setenv("GEMINI_FREE_TIER_APPROVED", tt.free)
			if got := geminiDataUseApproved(); got != tt.want {
				t.Fatalf("承認判定 = %v, want %v", got, tt.want)
			}
		})
	}
}
