#!/bin/sh
#
# 公開元（Wiki・公式サイト・フライトシミュレータのガイド）が変わったかを確認し、
# 変わっていたらmacOSの通知を出す。launchdから週に一度呼ばれることを想定している。
#
# **取得もデプロイもしない。** 通知するだけである。
# Wikiの誤編集がそのまま本番の回答になる事故を避けるため、
# 内容を見て取り込むかどうかは人が決める（docs/04「なぜ完全自動にしないのか」）。
#
# 手で試すとき:  sh tools/check-updates.sh
#
set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo" || exit 1

python="$repo/.venv/bin/python"
log="$repo/dump/check-updates.log"   # dump/ は .gitignore 済み

notify() {
  # launchdから出す通知。osascriptはGUIセッションで動く必要があるため、
  # LaunchDaemonではなくLaunchAgentとして登録すること
  /usr/bin/osascript -e "display notification \"$2\" with title \"WASA Chat\" subtitle \"$1\"" 2>/dev/null
}

if [ ! -x "$python" ]; then
  echo "$(date '+%F %T') .venv が見つかりません: $python" >>"$log"
  notify "更新確認に失敗" "仮想環境が見つかりません"
  exit 1
fi

output=$("$python" check_updates.py 2>&1)
status=$?

{
  echo "----- $(date '+%F %T') (終了コード $status)"
  echo "$output"
} >>"$log"

# ログが際限なく伸びないよう、直近1000行だけ残す
if [ -f "$log" ]; then
  tail -n 1000 "$log" >"$log.tmp" && mv "$log.tmp" "$log"
fi

case "$status" in
  0) exit 0 ;;  # 変更なし。通知しない（毎週の無意味な通知は無視されるようになる）
  2)
    # 「Wiki: 追加 0 / 更新 3 / 削除 0」のような行だけを通知本文にする
    summary=$(echo "$output" | grep -E '追加 [0-9]+' | tr '\n' ' ')
    notify "資料が更新されています" "$summary"
    exit 0
    ;;
  *)
    notify "更新確認に失敗しました" "$(echo "$output" | tail -n 1)"
    exit "$status"
    ;;
esac
