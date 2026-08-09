import unittest

import rebuild


class RebuildTest(unittest.TestCase):
    def test_skip_eval_only_removes_last_step(self) -> None:
        """--skip-eval は検索検査だけを外す。取得元が増えても崩れないよう、
        件数を直に書かずに関係で確かめる。"""
        full = rebuild.selected_steps(False)
        skipped = rebuild.selected_steps(True)
        self.assertEqual(len(skipped), len(full) - 1)
        self.assertEqual(full[-1][1], "eval/retrieval_eval.py")
        self.assertEqual(skipped[-1][1], "build_toc.py")
        self.assertEqual(full[:-1], skipped)

    def test_every_source_is_fetched_before_indexing(self) -> None:
        """取得は索引作成より先。順序が崩れると古いデータで索引を作ってしまう。"""
        scripts = [script for _, script in rebuild.selected_steps(False)]
        for fetcher in ("dump_wiki.py", "dump_site.py", "dump_fee.py"):
            self.assertIn(fetcher, scripts)
            self.assertLess(scripts.index(fetcher), scripts.index("build_index.py"))


if __name__ == "__main__":
    unittest.main()
