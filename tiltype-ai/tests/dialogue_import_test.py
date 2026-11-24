"""Проверяет очистку и изоляцию контрольных фраз при импорте диалогов.

Использует небольшой локальный набор, подменяя внешние источники и
отложенные данные, чтобы проверка не обращалась к сети.
"""

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from import_dialogues import clean_runs, import_language  # noqa: E402
from sentence_data import sentence_alphabet  # noqa: E402


class DialogueImportTest(unittest.TestCase):
    """Проверяет текст на границе между импортом и обучением."""

    def test_skips_duplicate_private_and_held_out_runs(self) -> None:
        """Проверяет защиту от утечки через разные регистр и пунктуацию."""
        messages = [
            "Could you send the files? I will look today.",
            "COULD YOU SEND THE FILES.",
            "My address is friend@example.com",
            "See https://example.com for more details.",
            "Please use my number 123-456-7890.",
        ]
        with (
            TemporaryDirectory() as folder,
            patch("import_dialogues.openassistant_messages", return_value=iter(messages)),
            patch("import_dialogues.taskmaster_messages", return_value=iter(["We can discuss this tomorrow"])),
            patch("import_dialogues.held_out_runs", return_value=iter(["i will look today"])),
            patch("import_dialogues.sentence_id", return_value=1),
        ):
            directory = Path(folder)
            stats = import_language("en", directory)
            runs = [json.loads(line) for line in (directory / "en.jsonl").read_text(encoding="utf8").splitlines()]
        self.assertEqual(runs, ["could you send the files", "we can discuss this tomorrow"])
        self.assertEqual(stats["OpenAssistant"], {"messages": 5, "runs": 1, "words": 5})

    def test_russian_only_excerpt_is_excluded_from_kazakh_import(self) -> None:
        """Проверяет, что короткие фрагменты другого языка не попадают в KSC2."""
        allowed = sentence_alphabet("kk")
        self.assertEqual(list(clean_runs("Мы уже отправили письмо", "kk", allowed)), [])
        self.assertEqual(list(clean_runs("Біз хат жібердік", "kk", allowed)), [["біз", "хат", "жібердік"]])


if __name__ == "__main__":
    unittest.main()
