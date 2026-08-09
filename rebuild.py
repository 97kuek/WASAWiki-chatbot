"""Wikiと公式サイトの取得から索引の検査までを、一つのコマンドで実行する。

    python rebuild.py
    python rebuild.py --skip-eval  # 評価だけ省く
    python rebuild.py --dry-run    # 実行内容だけ確認する

各取得スクリプトが持つ1秒間隔は変更しない。途中で失敗したら後続処理を止め、
古い取得結果と新しい取得結果を混ぜた索引をデプロイしない。
"""

from __future__ import annotations

import argparse
import subprocess
import sys


STEPS = (
    ("Wikiを取得", "dump_wiki.py"),
    ("公式サイトを取得", "dump_site.py"),
    ("検索索引を作成", "build_index.py"),
    ("目次を作成", "build_toc.py"),
    ("検索精度を検査", "eval/retrieval_eval.py"),
)


def selected_steps(skip_eval: bool) -> tuple[tuple[str, str], ...]:
    return STEPS[:-1] if skip_eval else STEPS


def main() -> int:
    parser = argparse.ArgumentParser(description="WASA Chatの資料を一括更新します")
    parser.add_argument("--skip-eval", action="store_true", help="検索精度の検査を省きます")
    parser.add_argument("--dry-run", action="store_true", help="実行するコマンドだけ表示します")
    args = parser.parse_args()

    steps = selected_steps(args.skip_eval)
    for number, (label, script) in enumerate(steps, 1):
        command = [sys.executable, script]
        print(f"[{number}/{len(steps)}] {label}: {' '.join(command)}", flush=True)
        if not args.dry_run:
            subprocess.run(command, check=True)
    if args.dry_run:
        print("上の5処理を実行します（今回は確認だけで、ファイルを変更していません）。")
    else:
        print("更新処理が完了しました。差分を確認してからデプロイしてください。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"更新を中止しました（終了コード {error.returncode}）", file=sys.stderr)
        raise SystemExit(error.returncode) from error
