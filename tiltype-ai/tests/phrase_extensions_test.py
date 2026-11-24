"""Проверяет порог второго слова и отделение контрольных предложений."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from build_phrase_extensions import collect_extensions  # noqa: E402


class PhraseExtensionsTest(unittest.TestCase):
    """Проверяет условия пригодности продолжения."""

    def test_sentence_end_counts_against_extension(self) -> None:
        """Отклоняет слово, если эта позиция часто совпадает с концом фразы."""
        continued = [[name, "пришлите", "обновлённый", "отчёт"] for name in "саша маша лена вера света".split()]
        ended = [["коллеги", "пришлите", "обновлённый"], ["друзья", "пришлите", "обновлённый"]]
        key = "+пришлите обновлённый"
        self.assertEqual(collect_extensions(continued, set())[key], "отчёт")
        self.assertNotIn(key, collect_extensions(continued + ended, set()))
        self.assertNotIn(key, collect_extensions(continued, {" ".join(continued[0])}))


if __name__ == "__main__":
    unittest.main()
