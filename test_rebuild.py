import unittest

import rebuild


class RebuildTest(unittest.TestCase):
    def test_skip_eval_only_removes_last_step(self) -> None:
        self.assertEqual(len(rebuild.selected_steps(False)), 5)
        self.assertEqual(len(rebuild.selected_steps(True)), 4)
        self.assertEqual(rebuild.selected_steps(True)[-1][1], "build_toc.py")


if __name__ == "__main__":
    unittest.main()
