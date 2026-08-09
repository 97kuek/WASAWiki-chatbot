#!/bin/sh
#
# 週に一度の更新確認をmacOSへ登録する（保守者のMacで1回だけ実行する）。
#
#   sh tools/install-check-updates.sh          登録する
#   sh tools/install-check-updates.sh --remove  登録を消す
#
# リポジトリの場所は人によって違うので、plistはここで組み立てる。
# LaunchAgent（LaunchDaemonではない）にしているのは、通知を出す osascript が
# 利用者のGUIセッションでしか動かないためである。
#
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
label="com.wasa.chat.check-updates"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "登録を消しました。"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$repo/tools/check-updates.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$repo</string>
  <!-- 毎週月曜9時。眠っていた場合は、起きた直後に一度だけ実行される -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>$repo/dump/check-updates.stderr.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"

echo "登録しました: $plist"
echo "毎週月曜9時に更新を確認し、変更があったときだけ通知します。"
echo
echo "今すぐ試す: launchctl kickstart gui/$(id -u)/$label"
echo "登録を消す: sh tools/install-check-updates.sh --remove"
