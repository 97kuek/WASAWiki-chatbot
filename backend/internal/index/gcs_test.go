package index

import "testing"

func TestParseGCS(t *testing.T) {
	cases := []struct {
		location string
		bucket   string
		prefix   string
		ok       bool
	}{
		{"gs://wasa-chat-index", "wasa-chat-index", "", true},
		{"gs://wasa-chat-index/", "wasa-chat-index", "", true},
		{"gs://wasa-chat-index/prod", "wasa-chat-index", "prod/", true},
		{"gs://wasa-chat-index/prod/", "wasa-chat-index", "prod/", true},
		// 接頭辞を書いても、実際に読むのは index.json と toc.md の2つだけ
		{"gs://bucket/a/b", "bucket", "a/b/", true},
		{"", "", "", false},
		{"gs://", "", "", false},
		{"data", "", "", false},
		{"https://storage.googleapis.com/bucket", "", "", false},
	}
	for _, c := range cases {
		bucket, prefix, ok := ParseGCS(c.location)
		if ok != c.ok || bucket != c.bucket || prefix != c.prefix {
			t.Errorf("ParseGCS(%q) = (%q, %q, %v), 期待は (%q, %q, %v)",
				c.location, bucket, prefix, ok, c.bucket, c.prefix, c.ok)
		}
	}
}

// 空の索引で起動すると、全部の質問に「資料が見つかりません」と答え続ける。
// 壊れていることが分からないので、読み込みの時点で止める。
func TestBuildRejectsEmptyIndex(t *testing.T) {
	if _, err := Build([]byte(`{"pages":[]}`), []byte("# 目次")); err == nil {
		t.Error("ページが0件の index.json を受け入れてしまいました")
	}
	if _, err := Build([]byte(`{}`), []byte("# 目次")); err == nil {
		t.Error("pages が無い index.json を受け入れてしまいました")
	}
}
