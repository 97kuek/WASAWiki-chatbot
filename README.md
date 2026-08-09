# WASA Chat

> 状態： 初期Webアプリ実装済み・精度検証／本番準備フェーズ

- 早稲田大学宇宙航空研究会WASA 鳥人間プロジェクトの引き継ぎ資料Wiki（MediaWiki）に対して、自然言語で質問できるチャットボット
- 新入生や代替わりした担当者が「どこに何が書いてあるか分からない」状態を解消することを目的にしている

## 構成

```
check_updates.py / rebuild.py                  Python   更新確認 → 取得 → 索引生成 → 検査
rag/                                           Python   回答パイプライン（測定用の正本）
eval/                                          Python   精度測定
backend/                                       Go       API（認証・SSE・レート制限）
web/                                           React    履歴・Markdown/TeX対応のチャットUI
```

Python側の `rag/pipeline.py` とGo側の `backend/internal/pipeline`は、検索・回答の
**共通段構成とコアプロンプト**を揃える。Go側には認証、共有アシスタントのsystem規則、
参照範囲の決定的な除外、SSEが追加されるため、実装全体が同一という意味ではない。

- 引き継ぎの入口と文書の正本: [docs/00-引き継ぎガイド.md](docs/00-引き継ぎガイド.md)
- 設計の詳細と判断の根拠: [docs/01-設計方針.md](docs/01-設計方針.md)
- 実測値: [docs/02-測定結果.md](docs/02-測定結果.md)
- 画面・履歴・アシスタントの現行仕様: [docs/03-画面仕様.md](docs/03-画面仕様.md)
- 本番へのデプロイと更新手順: [docs/04-デプロイ手順.md](docs/04-デプロイ手順.md)
- システムプロンプト: [docs/05-システムプロンプト.md](docs/05-システムプロンプト.md)
- コードで保証する規則: [docs/06-決定的ルール.md](docs/06-決定的ルール.md)
- 認証とデータ保護: [docs/07-認証・データ保護.md](docs/07-認証・データ保護.md)
- 評価制度と利用者フィードバック: [docs/08-評価・フィードバック.md](docs/08-評価・フィードバック.md)
- 今後の作業: [TODO.md](TODO.md)

## セットアップ

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install requests python-dotenv
cp .env.example .env   # Wiki取得に使う通常アカウントの認証情報を記入する
```

## 1. データを作る

```bash
python check_updates.py # 取得後に公開元が変わったか確認する
python rebuild.py       # 取得、索引作成、検索検査をまとめて実行する
```

- `dump_wiki.py` はさくらインターネットのレンタルサーバ上のWikiを叩くため、リクエスト間に1秒の間隔を入れている。全ページの取得には数分かかる。
- `dump_site.py` は一般公開の公式サイト（wasa-birdman.com）を取り込む。
- Wikiは「作り方」に詳しい一方、団体の成り立ちや歴代機体といった**対外的な説明**が薄く、新入生や外部への説明を求められると答えられなかった。こちらも1秒間隔で、sitemap から519ページを辿る（10分ほどかかる）。`dump/site.jsonl` が無ければ`build_index.py` はWikiだけで索引を作るので、省略しても動く。

## 2. 精度を測る

```bash
# ローカルLLM（データを外部に出さないため）
OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama pull qwen3:30b-a3b

python eval/retrieval_eval.py   # M1: BM25による検索ベースライン
python eval/toc_eval.py         # M2a: 目次方式によるページ選択
python eval/answer_eval.py      # M2b: エンドツーエンドの回答品質
# 実際に誤答した設問だけを低コストで再測定
python eval/answer_eval.py --ids q32,q33 --output eval/answers-tr797.json
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

- Geminiに切り替えるには `LLM_PROVIDER=gemini` と `GEMINI_API_KEY` を設定する。

### チャット画面

- ログインはWASA Wikiの通常の利用者名・パスワードだけを使う
- 質問は右寄せの吹き出し、回答はMarkdownとTeX数式で表示する
- 入力欄は画面下部に固定し、`Enter` で送信、`Shift + Enter` で改行する
- チャット履歴はWiki利用者ごとにFirestoreへ最大30件保存し、別端末でのログイン時にも同期する
- アシスタントを切り替えると、参照範囲と口調を混ぜないため新しいチャットを開く
- PCは履歴と会話の2カラムで、履歴欄は折りたためる。狭い画面では重ねて開く
- 履歴は今日、昨日、過去7日間、年月で分け、各履歴からピン留め、タイトル変更、共有、削除ができる
- ベルからリポジトリ管理のお知らせ、利用者アイコンからWikiとログアウトを開く
- 各回答は👍／👎を1タップで送れ、理由と補足は任意にする
- 右上の「改善を送る」では分類を選び、送信ボタンで画面・使い勝手・機能提案を報告する
- フィードバックはFirestoreへ保存し、設定済みなら管理者へメールでも通知する

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `WIKI_API` | 本Wikiのapi.php | Wiki取得とログイン時の照合先 |
| `WIKI_USER` | (なし) | Wiki取得と実Wiki認証テストに使う通常アカウントの利用者名 |
| `WIKI_PASS` | (なし) | 上記通常アカウントのパスワード。`.env` だけに置く |
| `SESSION_SECRET` | 自動生成 | Cookie署名とFirestore上の利用者識別に使う固定鍵。本番では固定値が必須。変更するとログアウトし、既存履歴を参照できなくなる |
| `DAILY_LIMIT` | 30 | 利用者ひとりあたり・日本時間1日の質問数。API費用の安全弁 |
| `FIRESTORE_PROJECT_ID` | (なし) | 利用回数、最大30件の履歴、共有アシスタント、フィードバックを保存するGoogle Cloudプロジェクト。本番では必須 |
| `ALLOW_ORIGIN` | (なし) | 本番のCloudflare Pages URL。複数はカンマ区切り。Cloud Runでは必須で、許可外OriginのPOSTを拒否する |
| `FEEDBACK_EMAIL_TO` | (なし) | フィードバック通知を受け取る管理者のメールアドレス。複数はカンマ区切り |
| `SMTP_HOST` / `SMTP_PORT` | (なし) / `587` | メール送信サービスの接続先 |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | (なし) | メール送信サービスの認証情報。パスワードはSecret Managerへ置く |
| `SMTP_FROM` | `SMTP_USERNAME` | 通知メールの送信元 |
| `LLM_PROVIDER` | `ollama` | 本番でGeminiを使う場合は `gemini` |
| `GEMINI_API_KEY` | (なし) | WASAで共有するGeminiプロジェクトのAPIキー。サーバーの`.env`だけに置く |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Geminiの固定モデルID。`latest`別名は本番で使わない |
| `GEMINI_FAST_MODEL` | `GEMINI_MODEL` | 自動判定の高速段階用。比較測定で改善を確認するまでは未設定 |
| `GEMINI_STANDARD_MODEL` | `GEMINI_MODEL` | 自動判定の標準段階で行うページ・節選択用 |
| `GEMINI_DEEP_MODEL` | `GEMINI_MODEL` | じっくりモード用 |
| `GEMINI_PAID_TIER` | `false` | Gemini有料枠を確認した場合だけ`true`にする |
| `GEMINI_FREE_TIER_APPROVED` | `false` | 非公開WikiをGemini無料枠へ送る組織承認。2026-08-08のWASA会議で代表・PMが承認 |
| `GEMINI_MIN_INTERVAL` | 4 | Goバックエンド全体でGeminiリクエスト間に空ける秒数 |
| `GEMINI_MAX_RETRIES` | 2 | 短時間の429、503、通信失敗時の追加試行回数。日次上限は再試行しない |
| `VITE_WIKI_URL` | 本Wiki | プロフィールメニューから開くWiki |
| `CLAUDE_MODEL` | `claude-opus-5` | 費用優先なら `claude-sonnet-5` |
| `DATA_DIR` | `data` | index.json と toc.md の置き場所 |
| `SPA_DIR` | (なし) | 指定するとビルド済みSPAも同じサーバーから配る |

### 確認

```bash
cd backend && go test ./...
cd web && npm run build
```

## 現在の索引規模

| 項目 | 実測値 |
|---|---|
| Wiki実記事 | 114ページ |
| 公式サイト | 500ページ |
| 索引全体 | 614ページ / 911チャンク / 646,856字 |
| Wiki添付画像 | 67枚（本文参照57箇所） |

## ライセンス

- コードは [MIT License](LICENSE) で公開する
- Wikiの内容と取得データはWASA鳥人間プロジェクトに帰属し、MIT Licenseの対象に含めない
