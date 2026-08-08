package index

import (
	"encoding/json"
	"testing"
)

func unmarshalChunk(raw string, c *Chunk) error { return json.Unmarshal([]byte(raw), c) }

// Label の出力は rag/pipeline.py の era_label と一字一句同じでなければならない。
// プロンプトを片方だけ変えると、Python側で測った数字が本番の説明にならなくなる。
func TestEraLabel(t *testing.T) {
	cases := []struct {
		name string
		era  Era
		want string
	}{
		// 拾えなかったときは空。空欄を出すとモデルが「不明」を「古い」と読み替える
		{"手がかり無し", Era{}, ""},
		{"単一の年", Era{Years: []int{2024}}, "2024年"},
		{"複数年", Era{Years: []int{2021, 2023, 2024}}, "2021〜2024年（最新2024年）"},
		// 公式サイトの歴史ページは17年幅になる。範囲を出しても最新年が読み取れること
		{"長い範囲", Era{Years: []int{1985, 2002}}, "1985〜2002年（最新2002年）"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.era.Label(); got != c.want {
				t.Errorf("Label() = %q, want %q", got, c.want)
			}
		})
	}
}

// index.json に era が無い（このフィールドを足す前に生成した）場合でも
// 読み込みが壊れないこと。デプロイ済みのデータで起動できなくなると困る
func TestEraAbsentInOldIndex(t *testing.T) {
	var c Chunk
	if err := unmarshalChunk(`{"id":"p1-c0","breadcrumb":"A","text":"x","chars":1}`, &c); err != nil {
		t.Fatalf("旧形式の読み込みに失敗: %v", err)
	}
	if c.Era.Label() != "" {
		t.Errorf("era 無しなのに %q が出た", c.Era.Label())
	}
}
