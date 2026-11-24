"""Проверяет подготовку и декодирование подсловных продолжений TilType.

Использует локальные фразы и фиксированные оценки, чтобы результат
не зависел от обученных весов и качества тестового корпуса.
"""

import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from subword_data import END, PAD, VOCABULARY_SIZE, token_id, train_tokenizer  # noqa: E402
from subword_model import PhrasePredictor, SubwordModel  # noqa: E402


class SubwordModelTest(unittest.TestCase):
    """Проверяет ключевые условия для корректного вывода фразы."""

    def test_tokenizer_preserves_unseen_kazakh_word_form(self) -> None:
        """Собирает новую словоформу из подслов без готового словарного класса."""
        tokenizer = train_tokenizer({"kk": ["құжаттарды жаңа архивке апарғанымызды тіркедік"] * 8})
        inflected = "құжаттарға"
        self.assertNotIn("▁" + inflected, tokenizer.get_vocab())
        self.assertEqual(tokenizer.decode(tokenizer.encode(inflected).ids), inflected)

    def test_beam_ranks_complete_multiword_continuation(self) -> None:
        """Возвращает одну цельную фразу после подтверждения границы последнего слова."""
        tokenizer = train_tokenizer({"en": ["please check the details carefully"] * 8})
        predictor = PhrasePredictor(SubwordModel(VOCABULARY_SIZE, token_id(tokenizer, PAD)), tokenizer)
        steps = tokenizer.encode("check the details").ids + [token_id(tokenizer, END)]
        self.assertEqual(len(steps), 4)

        def next_tokens(tokens: torch.Tensor, state: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
            """Выдаёт единственную допустимую ветку с предсказуемым весом."""
            index = 0 if state is None else int(state[0, 0, 0]) + 1
            logits = torch.full((len(tokens), tokenizer.get_vocab_size()), -torch.inf)
            logits[:, steps[index]] = math.log(0.85) if index == 0 else math.log(0.97)
            return torch.full((1, len(tokens), 1), index), logits

        with patch.object(predictor, "next_tokens", side_effect=next_tokens):
            self.assertEqual(predictor.suggest("please", "en"), ["check the details"])

    def test_uncertain_extension_does_not_displace_the_best_word(self) -> None:
        """Сохраняет лучший первый вариант и скрывает слабый конец фразы."""
        candidates = {"check": -1.0, "check tomorrow": -6.0, "read": -1.3, "read carefully": -1.8}
        self.assertEqual(PhrasePredictor.rank_completions(candidates), ["check", "read carefully"])


if __name__ == "__main__":
    unittest.main()
