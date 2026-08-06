# CLAUDE.md

**このリポジトリの作業指示は [AGENTS.md](AGENTS.md) にある。作業前に必ず読むこと。**
設計判断の根拠は [docs/01-設計方針.md](docs/01-設計方針.md)、実測値は [docs/02-測定結果.md](docs/02-測定結果.md)。

以下は、間違えると取り返しがつかない項目だけを再掲する。

---

## ⚠️ 絶対にコミットしないもの

対象は**ログインが必要な非公開Wiki**で、本文に氏名・役職・契約情報を含む。
**リポジトリはpublicである。**

```
.env               Wikiの認証情報、APIキー
dump/              Wiki本文の生データ
data/              生成したインデックス・目次
eval/golden.json   Wiki由来の回答を含む評価データ
```

`.gitignore` 済み。**除外設定を無効化しない。** `git add -A` の前に `git status` で確認すること。

## ⚠️ 学習に使われるAPIにデータを送らない

Gemini APIの無料枠など、送信内容が製品改善に使われる利用枠には送らない。
規約自体が個人情報・機密情報の送信を禁じている。現在の測定はローカルLLM（Ollama）で行う。

## ⚠️ Wikiサーバへの負荷

`dump_wiki.py` のリクエスト間隔1秒を縮めない。さくらインターネットのレンタルサーバである。

---

## よく使うコマンド

```bash
source .venv/bin/activate
python dump_wiki.py             # Wiki取得   → dump/pages.jsonl
python build_index.py           # 整形       → data/index.json
python build_toc.py             # 目次生成   → data/toc.md
python eval/retrieval_eval.py   # 検索精度の測定

OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

Ollamaの `OLLAMA_CONTEXT_LENGTH` を省略しない。既定の4096では目次（1〜1.5万トークン）が
黙って切り捨てられる。

---

## 進め方の原則

- **測ってから足す。** 推測で層を増やさない。段階（Phase）は docs/01 §2 にある
- ドキュメント・コメント・コミットメッセージは**日本語**
- コメントには「なぜそうしたか」を、実測値とともに書く
- 測定したら docs/02 に「数字 / 読み取れたこと / 判断を変えた点」の3点セットで記録する
- 確定済みの設計判断（グラフRAG不採用、BLEU/ROUGE不採用など）は AGENTS.md にある。
  蒸し返さない。異論は根拠に反論する形で出す
