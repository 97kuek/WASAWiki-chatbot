#!/bin/sh
#
# 索引（data/index.json と data/toc.md）を Cloud Storage へ差し替える。
#
#   sh tools/publish-index.sh            差し替えて、本番へ即時反映する
#   sh tools/publish-index.sh --no-apply 差し替えるだけ（次の起動から反映される）
#
# 索引をコンテナイメージへ焼き込んでいた頃は、資料を1文字直すだけでも
# イメージの再ビルドとpushとデプロイが必要だった。ここを分けたので、
# **コードを変えていないなら、この1コマンドだけで済む。**
#
# 逆に、コードを変えたときは従来どおりイメージのデプロイが要る（docs/04）。
#
set -eu

bucket="gs://wasa-chat-index"
service="wasa-chat-api"
region="asia-northeast1"

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

for file in data/index.json data/toc.md; do
  [ -f "$file" ] || { echo "$file がありません。python rebuild.py を先に実行してください" >&2; exit 1; }
done

# 壊れた索引を本番へ上げると、全部の質問に「資料が見つかりません」と
# 答え続ける状態になる。上げる前に、読める形かどうかを確認する
python3 - <<'PY' || exit 1
import json, sys
from pathlib import Path
try:
    pages = json.loads(Path("data/index.json").read_text(encoding="utf-8"))["pages"]
except Exception as error:
    sys.exit(f"index.json を読めません: {error}")
if len(pages) < 100:
    sys.exit(f"ページ数が{len(pages)}件しかありません。取得が途中で失敗していないか確認してください")
chunks = sum(len(p["chunks"]) for p in pages)
print(f"確認: {len(pages)}ページ / {chunks}チャンク")
PY

echo "差し替え先: $bucket"
gcloud storage cp data/index.json data/toc.md "$bucket/"

if [ "${1:-}" = "--no-apply" ]; then
  echo
  echo "差し替えました。動いているインスタンスは古い索引を持ったままです。"
  echo "次の起動（しばらく使われないと止まる）から反映されます。"
  exit 0
fi

# 起動中のインスタンスは索引をメモリに持っているため、差し替えただけでは
# 変わらない。環境変数を1つ動かして新しいリビジョンへ入れ替える。
# イメージは作り直さないので数十秒で終わる
echo
echo "本番へ反映します（イメージの再ビルドはしません）"
gcloud run services update "$service" \
  --region "$region" \
  --update-env-vars "INDEX_PUBLISHED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --quiet

echo
curl -fsS "$(gcloud run services describe "$service" --region "$region" --format='value(status.url)')/health"
echo
