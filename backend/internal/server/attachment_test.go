package server

import (
	"encoding/base64"
	"strings"
	"testing"
)

func dataURI(declared string, data []byte) string {
	return "data:" + declared + ";base64," + base64.StdEncoding.EncodeToString(data)
}

var (
	jpeg = append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, 32)...)
	png  = append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, make([]byte, 32)...)
	webp = append(append([]byte("RIFF"), []byte{0, 0, 0, 0}...), append([]byte("WEBP"), make([]byte, 32)...)...)
)

func TestParseAttachmentsAcceptsImages(t *testing.T) {
	for _, c := range []struct {
		name string
		data []byte
		want string
	}{
		{"JPEG", jpeg, "image/jpeg"},
		{"PNG", png, "image/png"},
		{"WebP", webp, "image/webp"},
	} {
		images, err := parseAttachments([]string{dataURI("image/jpeg", c.data)})
		if err != nil {
			t.Fatalf("%s を受け付けませんでした: %v", c.name, err)
		}
		if len(images) != 1 || images[0].MediaType != c.want {
			t.Errorf("%s の判定が違います: %+v", c.name, images)
		}
	}
}

// 画面側の申告を信じてはいけない。中身がPNGならPNGとして扱う。
func TestParseAttachmentsIgnoresDeclaredMediaType(t *testing.T) {
	images, err := parseAttachments([]string{dataURI("image/jpeg", png)})
	if err != nil {
		t.Fatalf("受け付けませんでした: %v", err)
	}
	if images[0].MediaType != "image/png" {
		t.Errorf("申告どおりに扱ってしまいました: %s", images[0].MediaType)
	}
}

// 画像に見せかけた別のファイルを、そのままモデルへ送らない。
func TestParseAttachmentsRejectsNonImage(t *testing.T) {
	for _, c := range []struct {
		name  string
		value string
	}{
		{"PDF", dataURI("image/png", []byte("%PDF-1.7\n..."))},
		{"HTML", dataURI("image/jpeg", []byte("<html><body>"))},
		{"実行ファイル", dataURI("image/png", []byte{0x7F, 'E', 'L', 'F'})},
		{"RIFFだがWebPでない", dataURI("image/webp", append([]byte("RIFF0000WAVE"), make([]byte, 32)...))},
		{"data URIでない", "https://example.org/a.png"},
		{"カンマが無い", "data:image/png;base64"},
		{"base64が壊れている", "data:image/png;base64,@@@@"},
	} {
		if _, err := parseAttachments([]string{c.value}); err == nil {
			t.Errorf("%s を受け付けてしまいました", c.name)
		}
	}
}

func TestParseAttachmentsRejectsTooLarge(t *testing.T) {
	big := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, maxAttachmentSize)...)
	if _, err := parseAttachments([]string{dataURI("image/jpeg", big)}); err == nil {
		t.Error("上限を超えた画像を受け付けてしまいました")
	}
}

// 復号する前に大きさで弾く。巨大なbase64をメモリへ展開してから捨てない。
func TestParseAttachmentsRejectsHugeBeforeDecoding(t *testing.T) {
	huge := "data:image/jpeg;base64," + strings.Repeat("A", maxAttachmentSize*8)
	if _, err := parseAttachments([]string{huge}); err == nil {
		t.Error("巨大なbase64を受け付けてしまいました")
	}
}

func TestParseAttachmentsLimitsCount(t *testing.T) {
	one := dataURI("image/jpeg", jpeg)
	if _, err := parseAttachments([]string{one, one}); err == nil {
		t.Errorf("%d枚を超える添付を受け付けてしまいました", maxAttachments)
	}
}

func TestParseAttachmentsAllowsNone(t *testing.T) {
	images, err := parseAttachments(nil)
	if err != nil || images != nil {
		t.Errorf("添付なしを弾いてしまいました: %v %v", images, err)
	}
}
