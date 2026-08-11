package index

import (
	"context"
	"fmt"
	"io"
	"strings"

	"cloud.google.com/go/storage"
)

// ParseGCS は "gs://バケット名/接頭辞" を分解する。接頭辞は省略できる。
func ParseGCS(location string) (bucket, prefix string, ok bool) {
	rest, found := strings.CutPrefix(location, "gs://")
	if !found {
		return "", "", false
	}
	bucket, prefix, _ = strings.Cut(rest, "/")
	if bucket == "" {
		return "", "", false
	}
	if prefix = strings.Trim(prefix, "/"); prefix != "" {
		prefix += "/"
	}
	return bucket, prefix, true
}

// LoadGCS は Cloud Storage 上の index.json と toc.md を読み込む。
//
// 索引をコンテナイメージへ焼き込むと、資料を1文字直すだけでも
// イメージの再ビルドとデプロイが必要になる。置き場所を分けておくと、
// 資料の更新はファイルの差し替えだけで済む（docs/07）。
//
// 起動のたびに取得するので、**古い索引がメモリに残り続けることはない。**
// その代わり、動き続けているインスタンスは差し替えに気づかない。
// すぐ反映したいときはリビジョンを更新して入れ替える。
func LoadGCS(ctx context.Context, location string) (*Index, error) {
	bucket, prefix, ok := ParseGCS(location)
	if !ok {
		return nil, fmt.Errorf("索引の場所が gs://バケット名/… の形ではありません: %q", location)
	}

	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("Cloud Storage へ接続: %w", err)
	}
	defer client.Close()

	read := func(name string) ([]byte, error) {
		reader, err := client.Bucket(bucket).Object(prefix + name).NewReader(ctx)
		if err != nil {
			return nil, fmt.Errorf("gs://%s/%s%s の取得: %w", bucket, prefix, name, err)
		}
		defer reader.Close()
		return io.ReadAll(reader)
	}

	raw, err := read("index.json")
	if err != nil {
		return nil, err
	}
	toc, err := read("toc.md")
	if err != nil {
		return nil, err
	}
	return Build(raw, toc)
}
