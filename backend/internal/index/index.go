// Package index は build_index.py が生成した index.json / toc.md を読み込み、
// ページとチャンクの参照を提供する。
//
// データベースは使わない。114ページ・348チャンク・899KB であり、
// 全件をメモリに載せて総当たりする方が速く、運用も単純になる（docs/01-設計方針.md §7）。
package index

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var aliasSuffix = regexp.MustCompile(`\s*（別名:[^）]*）\s*$`)

// Chunk は検索・回答の単位。breadcrumb は「ページ名 > 見出し > 見出し」。
type Chunk struct {
	ID         string `json:"id"`
	Breadcrumb string `json:"breadcrumb"`
	Text       string `json:"text"`
	Chars      int    `json:"chars"`
}

type Page struct {
	// IDは文字列。Wikiのページは pageid だが、公式サイトのページは "s1" 形式で
	// 数値ではない。出所が2つある以上、数値型には固定できない
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Aliases    []string `json:"aliases"`
	URL        string   `json:"url"`
	LastEdited string   `json:"last_edited"`
	Team       string   `json:"team"`
	Source     string   `json:"source"` // "wiki" | "site"。出典表示で出所を区別する
	Gen        *int     `json:"gen"`
	Chars      int      `json:"chars"`
	IsStub     bool     `json:"is_stub"`
	Chunks     []Chunk  `json:"chunks"`
}

type Index struct {
	TOC    string // 常時コンテキストに載せる目次
	Pages  []Page
	byName map[string]*Page // タイトルと別名の両方から引ける
	byID   map[string]*Chunk
	owner  map[string]*Page // チャンクID → 所属ページ
}

type file struct {
	Pages []Page `json:"pages"`
}

// Load は dir 直下の index.json と toc.md を読み込む。
func Load(dir string) (*Index, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		return nil, fmt.Errorf("index.json の読み込み: %w", err)
	}
	var parsed file
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("index.json の解析: %w", err)
	}

	toc, err := os.ReadFile(filepath.Join(dir, "toc.md"))
	if err != nil {
		return nil, fmt.Errorf("toc.md の読み込み: %w", err)
	}

	ix := &Index{
		TOC:    string(toc),
		Pages:  parsed.Pages,
		byName: make(map[string]*Page),
		byID:   make(map[string]*Chunk),
		owner:  make(map[string]*Page),
	}
	for i := range ix.Pages {
		p := &ix.Pages[i]
		ix.byName[p.Title] = p
		for _, alias := range p.Aliases {
			ix.byName[alias] = p
		}
		for j := range p.Chunks {
			c := &p.Chunks[j]
			ix.byID[c.ID] = c
			ix.owner[c.ID] = p
		}
	}
	return ix, nil
}

func (ix *Index) Chunk(id string) (*Chunk, *Page, bool) {
	c, ok := ix.byID[id]
	if !ok {
		return nil, nil, false
	}
	return c, ix.owner[id], true
}

// Resolve は LLM が返したページ名を実在ページに解決する。解決できなければ false。
//
// M2a の測定で、モデルは班名（「空力」）・節名（「鳥コンまでの流れ」）・
// 命名規則から推測した架空のページ名（「構造設計 41st」）を返してきた。
// ここで落とさないと、存在しないページを根拠として回答してしまう。
func (ix *Index) Resolve(name string) (*Page, bool) {
	name = strings.TrimSpace(name)
	// 目次は「タイトル（別名: X）」と表示するため、モデルが注記ごと
	// コピーしてくることがある（M2a-gemini で2件発生）。剥がしてから照合する
	name = strings.TrimSpace(aliasSuffix.ReplaceAllString(name, ""))
	if name == "" {
		return nil, false
	}
	if p, ok := ix.byName[name]; ok {
		return p, true
	}
	// 部分一致は候補がちょうど1件に定まるときだけ採用する。
	// 「空力」のように多数にマッチする語は班名であり、ページ名ではない。
	var hit *Page
	for title, p := range ix.byName {
		if strings.Contains(title, name) {
			if hit != nil && hit != p {
				return nil, false
			}
			hit = p
		}
	}
	return hit, hit != nil
}

func (ix *Index) Stats() (pages, chunks int) {
	for i := range ix.Pages {
		chunks += len(ix.Pages[i].Chunks)
	}
	return len(ix.Pages), chunks
}
