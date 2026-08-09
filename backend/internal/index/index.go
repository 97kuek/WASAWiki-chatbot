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

// Era は本文が「いつの話か」の手がかり。build_index.py の extract_era が入れる。
//
// ページの LastEdited は編集した日であって、書かれている内容の新しさではない。
// 実測では911チャンク中155件（17%）で、本文が扱う年代が最終更新より2年以上古かった。
// 「鳥コン > 鳥コンまでの流れ」は最終更新2026年だが本文は2024年までしか書いていない。
type Era struct {
	Years []int `json:"years"` // 本文中の西暦（代から換算したものを含む）
	Gens  []int `json:"gens"`  // 本文中の代
}

// Label はプロンプトに載せる短い表記を返す。手がかりが無ければ空文字。
func (e Era) Label() string {
	if len(e.Years) == 0 {
		return ""
	}
	lo, hi := e.Years[0], e.Years[len(e.Years)-1]
	if lo == hi {
		return fmt.Sprintf("%d年", hi)
	}
	return fmt.Sprintf("%d〜%d年（最新%d年）", lo, hi, hi)
}

// Chunk は検索・回答の単位。breadcrumb は「ページ名 > 見出し > 見出し」。
type Chunk struct {
	ID         string `json:"id"`
	Breadcrumb string `json:"breadcrumb"`
	Text       string `json:"text"`
	Chars      int    `json:"chars"`
	Era        Era    `json:"era"`
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
	Source     string   `json:"source"` // "wiki" | "site" | "fee"。出典表示で出所を区別する
	Gen        *int     `json:"gen"`
	Chars      int      `json:"chars"`
	IsStub     bool     `json:"is_stub"`
	Chunks     []Chunk  `json:"chunks"`
}

type Index struct {
	TOC string // 常時コンテキストに載せる目次
	// SiteTOC は公式サイト（一般公開）の部分だけを抜いた目次。
	//
	// 「公式サイトのみ」のアシスタントに TOC をそのまま渡すと、選択ページと
	// 出典は公式サイトだけなのに、**回答本文は引き継ぎWikiのページ名や
	// リード文を目次から拾えてしまう**（回答プロンプトが目次を根拠にしてよいと
	// 明記しているため）。部外に出せる情報だけ、という表示と食い違うので、
	// 出所を絞ったときは目次も差し替える。
	//
	// キャッシュは「全体」と「公式サイトのみ」の2種類までしか分裂しない。
	// 班の絞り込みで目次を変えないのは、班は機密の境界ではなく関連度の
	// 絞り込みでしかなく、分裂させるとキャッシュが班の数だけ増えるため。
	SiteTOC string
	Pages   []Page
	byName  map[string]*Page // タイトルと別名の両方から引ける
	byID    map[string]*Chunk
	owner   map[string]*Page // チャンクID → 所属ページ
}

type file struct {
	Pages []Page `json:"pages"`
}

// 目次の出所ごとの見出し。build_toc.py が出力する文言と一致させること。
const (
	wikiHeading = "\n## 引き継ぎWiki（部内限定）"
	siteHeading = "\n## 公式サイト（一般公開"
)

// siteOnlyTOC は目次から引き継ぎWikiの部分を落とす。
//
// 先頭の事実カード（人が書いた団体の基本情報）と公式サイトの節だけを残す。
// **見出しが見つからないときは空を返す。** 全体を返すと部内資料が
// 「公式サイトのみ」の回答へ混ざるので、目次なしで動く方を選ぶ
// （精度は落ちるが、混ざるよりよい）。
func siteOnlyTOC(toc string) string {
	wikiAt := strings.Index(toc, wikiHeading)
	siteAt := strings.Index(toc, siteHeading)
	if wikiAt < 0 || siteAt < 0 || siteAt < wikiAt {
		return ""
	}
	return toc[:wikiAt] + "\n" + toc[siteAt:]
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
		TOC:     string(toc),
		SiteTOC: siteOnlyTOC(string(toc)),
		Pages:   parsed.Pages,
		byName:  make(map[string]*Page),
		byID:    make(map[string]*Chunk),
		owner:   make(map[string]*Page),
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
