# WASAWiki-chatbot

早稲田大学 鳥人間プロジェクト WASA の引き継ぎ資料Wiki（MediaWiki）に対して、自然言語で質問できるチャットボット。

新入生や代替わりした担当者が「どこに何が書いてあるか分からない」状態を解消することを目的にしている。

> **状態：設計・検証フェーズ**。まだ動くチャットボットはない。現在はデータ基盤と精度評価の準備中。

## ⚠️ このリポジトリにWikiの内容は含まれません

対象のWikiは**ログインが必要な非公開Wiki**である。したがって：

- `dump/` … Wikiから取得した本文（**コミットしない**）
- `data/` … 生成したインデックス（**コミットしない**）
- `.env` … 認証情報（**コミットしない**）

いずれも `.gitignore` で除外している。**このリポジトリはコードと設計ドキュメントのみを公開し、Wikiのデータは各自がローカルで生成する**方針を取っている。デプロイ時もデータはローカルから直接投入し、GitHubを経由させない。

## 構成

```
dump_wiki.py / build_index.py / build_toc.py   Python   Wiki取得 → 整形 → 目次生成
rag/                                           Python   回答パイプライン（測定用の正本）
eval/                                          Python   精度測定
backend/                                       Go       API（認証・SSE・レート制限）
web/                                           React    チャットUI
```

Python側の `rag/pipeline.py` と Go側の `backend/internal/pipeline` は、
**同じ段構成・同じプロンプト**にしてある。Pythonで測った数字がそのまま意味を持つようにするため。

設計の詳細と判断の根拠は [docs/01-設計方針.md](docs/01-設計方針.md)、実測値は [docs/02-測定結果.md](docs/02-測定結果.md) にある。

## セットアップ

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install requests python-dotenv
cp .env.example .env   # Wikiの認証情報を記入する
```

## 1. データを作る

```bash
python dump_wiki.py     # Wiki全体を取得    → dump/pages.jsonl
python build_index.py   # 整形・チャンク化   → data/index.json
python build_toc.py     # 目次を生成        → data/toc.md
```

`dump_wiki.py` はさくらインターネットのレンタルサーバ上のWikiを叩くため、
リクエスト間に1秒の間隔を入れている。全ページの取得には数分かかる。

## 2. 精度を測る

```bash
# ローカルLLM（データを外部に出さないため）
OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama pull qwen3:30b-a3b

python eval/retrieval_eval.py   # M1: BM25による検索ベースライン
python eval/toc_eval.py         # M2a: 目次方式によるページ選択
python eval/answer_eval.py      # M2b: エンドツーエンドの回答品質
```

## 3. 動かす

```bash
# バックエンド
cd backend
SHARED_PASSWORD=... SESSION_SECRET=... DATA_DIR=../data go run .

# フロントエンド（別ターミナル）
cd web && npm install && npm run dev
```

Docker で通しで動かす場合:

```bash
docker compose up --build   # → http://localhost:8080
```

本番モデル（Claude）に切り替えるには `LLM_PROVIDER=claude` と `ANTHROPIC_API_KEY` を設定する。

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `SHARED_PASSWORD` | （必須） | 部内で配る合言葉 |
| `SESSION_SECRET` | 自動生成 | Cookie署名鍵。未設定だと再起動で全員ログアウト |
| `DAILY_LIMIT` | 30 | 1セッションあたりの1日の質問数。API費用の上限装置 |
| `LLM_PROVIDER` | `ollama` | `claude` にすると本番モデルを使う |
| `CLAUDE_MODEL` | `claude-opus-5` | 費用優先なら `claude-sonnet-5` |
| `DATA_DIR` | `data` | index.json と toc.md の置き場所 |
| `SPA_DIR` | (なし) | 指定するとビルド済みSPAも同じサーバーから配る |

## 現在の対象データ規模

| 項目 | 実測値 |
|---|---|
| 本文ページ | 117（標準名前空間） |
| 総文字数 | 約30万字 |
| 添付画像 | 67枚（PNG / JPEG） |

## ライセンス

MIT License（コードのみ。Wikiの内容はWASA鳥人間プロジェクトに帰属する）
