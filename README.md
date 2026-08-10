# WASA Chat

> 精度検証・本番運用確認フェーズ

WASAの内部情報を参照して、
自然言語で質問できるチャットボットです。

![チャット画面](docs/images/chat-view.png)

現在は、以下の情報に対応しています。

- WASA wiki
- WASAのホームページ
- FEEのホームページ

LLMがこれらの情報を参照し、WASAに特化した回答をしてくれます。

また、**アシスタント機能**も搭載しており、個別にプロンプトで最適化した回答をしてくれます。

## 制作動機

WASAには毎年、代が替わるたびに引き継ぎ資料が積み上がっていきます。
資料自体はきちんと書かれているのですが、量が多いため
**「知りたいことがどこに書いてあるか分からない」**という状態になりがちです。

新入生や、担当を引き継いだばかりの人が、資料の場所を知らなくても
普通の言葉で聞けば答えが返ってくる状態にすることを目的にしています。

## できること

- **出典が必ず付きます。** どのページを見て答えたのかが分かるので、原典を確認できます
- **Wikiと公式サイトを区別します。** 部外に出せる情報かどうかが一目で分かります
- **画像を添えて質問できます。** 写真やスクリーンショットを見せて聞けます
- **アシスタントを切り替えられます。** 班ごとの参照範囲や、対外説明用の口調を選べます
- **履歴は端末をまたいで同期します。** PCで聞いたことをスマホで見返せます

## 構成

リポジトリは、役割ごとに分かれています。

Pythonが資料の取り込みと精度測定、Goが実際のAPI、Reactが画面という分担です。

```
check_updates.py / rebuild.py   Python   更新確認 → 取得 → 索引生成 → 検査
rag/                            Python   回答パイプライン（測定用の正本）
eval/                           Python   精度測定
backend/                        Go       API（認証・SSE・レート制限）
web/                            React    履歴・Markdown/TeX対応のチャットUI
tools/                          Shell    更新確認の定期実行、索引の差し替え
```

ここで1つ注意があります。Python側の`rag/pipeline.py`とGo側の`backend/internal/pipeline`は、
検索・回答の**共通段構成とコアプロンプト**を揃えています。

ただし**同じ実装という意味ではありません。** Go側には認証、共有アシスタントのsystem規則、
参照範囲の決定的な除外、SSEが追加されています。Python側は、
プロンプト改善を再現可能に比較するための測定用だと考えてください。

## ドキュメント

**引き継ぎで最初に読むのは[docs/00-引き継ぎガイド.md](docs/00-引き継ぎガイド.md)です。**
このREADMEは全体像と動かし方をまとめたもので、詳しい話はそちらから辿れます。

| 知りたいこと | 文書 |
|---|---|
| 引き継ぎの入口 | [docs/00-引き継ぎガイド.md](docs/00-引き継ぎガイド.md) |
| 直すときの進め方 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| なぜこの設計にしたか | [docs/01-設計方針.md](docs/01-設計方針.md) |
| 実測値 | [docs/02-測定結果.md](docs/02-測定結果.md) |
| 画面の現行仕様 | [docs/03-フロントエンド.md](docs/03-フロントエンド.md) |
| デプロイと更新 | [docs/04-デプロイ手順.md](docs/04-デプロイ手順.md) |
| システムプロンプト | [docs/05-プロンプトエンジニアリング.md](docs/05-プロンプトエンジニアリング.md) |
| コードで保証する規則 | [docs/06-ルールベース.md](docs/06-ルールベース.md) |
| 認証とデータ保護 | [docs/07-バックエンド.md](docs/07-バックエンド.md) |
| 評価とフィードバック | [docs/08-評価・フィードバック.md](docs/08-評価・フィードバック.md) |
| 今後の作業 | [TODO.md](TODO.md) |

## セットアップ

まず開発環境を用意します。外部依存は`requests`と`python-dotenv`の2つだけです。

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install requests python-dotenv
cp .env.example .env   # Wiki取得に使う通常アカウントの認証情報を記入する
```

## 1. データを作る

WikiとサイトのデータをWASA Chatが検索できる形へ取り込みます。

```bash
python check_updates.py # 取得後に公開元が変わったか確認する
python rebuild.py       # 取得、索引作成、検索検査をまとめて実行する
```

取り込みには10分ほどかかります。急いでいるときに戸惑わないよう、理由を書いておきます。

⚠️ **取得スクリプトの1秒間隔を縮めないでください。** 相手はさくらインターネットの
レンタルサーバです。数分かかるのは意図的なものです。

公式サイトも取り込んでいるのは、Wikiが「作り方」には詳しい一方で、
団体の成り立ちや歴代機体といった**対外的な説明**が薄いためです。
新入生や外部への説明を求められたときに答えられませんでした。

なお、更新確認は週1回の自動実行にできます。**変更があったときだけ通知が出ます。**

```bash
sh tools/install-check-updates.sh   # 保守者のMacで1回だけ実行する
```

## 2. 精度を測る

作った索引でどれくらい正しく答えられるかを測ります。

測定にローカルLLMを使っているのは、非公開Wikiのデータを外部へ出さないためです。

```bash
OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama pull qwen3:30b-a3b

python eval/retrieval_eval.py   # M1: BM25による検索ベースライン
python eval/toc_eval.py         # M2a: 目次方式によるページ選択
python eval/answer_eval.py      # M2b: エンドツーエンドの回答品質

# 実際に誤答した設問だけを低コストで再測定
python eval/toc_eval.py --ids q10,q21
python eval/answer_eval.py --ids q32,q33 --output eval/answers-tr797.json
```

⚠️ **`OLLAMA_CONTEXT_LENGTH`を省略しないでください。** 既定の4096では、
目次（1〜1.5万トークン）が黙って切り捨てられます。

## 3. 動かす

手元で実際に動かしてみます。バックエンドとフロントエンドを、別々のターミナルで起動します。

```bash
# バックエンド
cd backend
SESSION_SECRET=... DATA_DIR=../data go run .   # ログインはWikiのアカウントで行う

# フロントエンド（別ターミナル）
cd web && npm install && npm run dev
```

2つ立ち上げるのが面倒なら、Dockerで通しでも動かせます。

```bash
docker compose up --build   # → http://localhost:8080
```

なお、LLMの既定はローカルのOllamaです。Geminiに切り替えるには
`LLM_PROVIDER=gemini`と`GEMINI_API_KEY`を設定してください。
**ローカルのqwen3は画像を読めないので、画像添付を試すときはGeminiが要ります。**

### 直したら確認する

```bash
cd backend && go test ./...
cd web && npm test && npm run build
```

## 環境変数

設定できる値の一覧です。本番で必須のものは「説明」に明記しています。

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
| `GEMINI_DEEP_MODEL` | `GEMINI_MODEL` | `thinking`モード用 |
| `GEMINI_PAID_TIER` | `false` | Gemini有料枠を確認した場合だけ`true`にする |
| `GEMINI_FREE_TIER_APPROVED` | `false` | 非公開WikiをGemini無料枠へ送る組織承認。2026-08-08のWASA会議で代表・PMが承認 |
| `GEMINI_MIN_INTERVAL` | 4 | Goバックエンド全体でGeminiリクエスト間に空ける秒数 |
| `GEMINI_MAX_RETRIES` | 2 | 短時間の429、503、通信失敗時の追加試行回数。日次上限は再試行しない |
| `VITE_WIKI_URL` | 本Wiki | プロフィールメニューから開くWiki |
| `CLAUDE_MODEL` | `claude-opus-5` | 費用優先なら `claude-sonnet-5` |
| `DATA_DIR` | `data` | index.json と toc.md の置き場所（ローカル） |
| `INDEX_GCS` | (なし) | 索引をCloud Storageから読む場合の場所（例: `gs://wasa-chat-index`）。設定すると`DATA_DIR`より優先し、読めなければ起動しない |
| `SPA_DIR` | (なし) | 指定するとビルド済みSPAも同じサーバーから配る |

## 現在の規模

いまWASA Chatが検索対象にしているデータの量です。

| 項目 | 実測値 |
|---|---|
| Wiki実記事 | 114ページ |
| 公式サイト | 500ページ |
| フライトシミュレータのガイド | 32ページ |
| 索引全体 | **646ページ / 1,012チャンク / 735,264字** |
| Wiki添付画像 | 67枚（本文参照57箇所） |

ファイルとしては`data/index.json`が3.3MB、`data/toc.md`が73KBです。

## ライセンス

コードとWikiの内容では、扱いが違うので注意してください。

- コードは[MIT License](LICENSE)で公開しています
- **Wikiの内容と取得データはWASA鳥人間プロジェクトに帰属し、MIT Licenseの対象に含めません**
