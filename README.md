# WASAWiki-chatbot

> 状態： 設計・検証フェーズ

- 早稲田大学宇宙航空研究会WASA 鳥人間プロジェクトの引き継ぎ資料Wiki（MediaWiki）に対して、自然言語で質問できるチャットボット
- 新入生や代替わりした担当者が「どこに何が書いてあるか分からない」状態を解消することを目的にしている

## 構成

```
dump_wiki.py / build_index.py / build_toc.py   Python   Wiki取得 → 整形 → 目次生成
rag/                                           Python   回答パイプライン（測定用の正本）
eval/                                          Python   精度測定
backend/                                       Go       API（認証・SSE・レート制限）
web/                                           React    履歴・Markdown/TeX対応のチャットUI
```

Python側の `rag/pipeline.py` と Go側の `backend/internal/pipeline` は、
**同じ段構成・同じプロンプト**にしてある。Pythonで測った数字がそのまま意味を持つようにするため。

- 設計の詳細と判断の根拠: [docs/01-設計方針.md](docs/01-設計方針.md)
- 実測値: [docs/02-測定結果.md](docs/02-測定結果.md)
- 画面・履歴・認証の現行仕様: [docs/03-画面・認証仕様.md](docs/03-画面・認証仕様.md)

## セットアップ

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install requests python-dotenv
cp .env.example .env   # Wiki取得に使う通常アカウントの認証情報を記入する
```

## 1. データを作る

```bash
python dump_wiki.py     # Wiki全体を取得    → dump/pages.jsonl
python dump_site.py     # 公式サイト取得     → dump/site.jsonl
python build_index.py   # 整形・チャンク化   → data/index.json
python build_toc.py     # 目次を生成        → data/toc.md
```

`dump_wiki.py` はさくらインターネットのレンタルサーバ上のWikiを叩くため、
リクエスト間に1秒の間隔を入れている。全ページの取得には数分かかる。

`dump_site.py` は一般公開の公式サイト（wasa-birdman.com）を取り込む。
Wikiは「作り方」に詳しい一方、団体の成り立ちや歴代機体といった**対外的な説明**が
薄く、新入生や外部への説明を求められると答えられなかった。こちらも1秒間隔で、
sitemap から519ページを辿る（10分ほどかかる）。`dump/site.jsonl` が無ければ
`build_index.py` はWikiだけで索引を作るので、省略しても動く。

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
SESSION_SECRET=... DATA_DIR=../data go run .   # ログインはWikiのアカウントで行う

# フロントエンド（別ターミナル）
cd web && npm install && npm run dev
```

Docker で通しで動かす場合:

```bash
docker compose up --build   # → http://localhost:8080
```

本番モデル（Claude）に切り替えるには `LLM_PROVIDER=claude` と `ANTHROPIC_API_KEY` を設定する。

### チャット画面

- ログインはWASA Wikiの通常の利用者名・パスワードだけを使う
- 質問は右寄せの吹き出し、回答はMarkdownとTeX数式で表示する
- 入力欄は画面下部に固定し、`Enter` で送信、`Shift + Enter` で改行する
- チャット履歴は現在のタブ内だけに保存し、タブを閉じたときとログアウト時に消去する
- PCは履歴と会話の2カラム、スマートフォンは履歴を上部に表示する

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `WIKI_API` | 本Wikiのapi.php | Wiki取得とログイン時の照合先 |
| `WIKI_USER` | (なし) | Wiki取得と実Wiki認証テストに使う通常アカウントの利用者名 |
| `WIKI_PASS` | (なし) | 上記通常アカウントのパスワード。`.env` だけに置く |
| `SESSION_SECRET` | 自動生成 | Cookie署名鍵。未設定だと再起動で全員ログアウト |
| `DAILY_LIMIT` | 30 | 利用者ひとりあたりの1日の質問数。API費用の上限装置 |
| `LLM_PROVIDER` | `ollama` | `claude` にすると本番モデルを使う |
| `CLAUDE_MODEL` | `claude-opus-5` | 費用優先なら `claude-sonnet-5` |
| `DATA_DIR` | `data` | index.json と toc.md の置き場所 |
| `SPA_DIR` | (なし) | 指定するとビルド済みSPAも同じサーバーから配る |

### 確認

```bash
cd backend && go test ./...
cd web && npm run build
```

## 現在の対象データ規模

| 項目 | 実測値 |
|---|---|
| 本文ページ | 117（標準名前空間） |
| 総文字数 | 約30万字 |
| 添付画像 | 67枚（PNG / JPEG） |

## ライセンス

MIT License（コードのみ。Wikiの内容はWASA鳥人間プロジェクトに帰属する）
