"""Проверяет корпус перед обучением и совместимость расширенной модели со старыми весами.

Проверки читают готовые артефакты, повторно вычисляют отпечатки и проверяют
порядок разбиения, равные квоты языков и выходные вероятности до обучения.
"""

import gzip
import hashlib
import json
import re
import unittest
from collections import Counter

import torch
from prepare import OUT, WORD, records, signature, spans
from tokenizers import Tokenizer
from train_corpus import PER_LANGUAGE, TOKENIZER, initial_model


class CorpusAudit(unittest.TestCase):
    """Проверяет фактические обучающие и отложенные записи без запуска оптимизатора."""

    def test_corpus(self):
        """Исключает повторы документов и длинные пересечения с обучением."""
        manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf8"))
        held = set()
        ids = set()
        texts = set()
        for split in ("development", "test", "train"):
            path = OUT / (split + ".jsonl.gz")
            digest = hashlib.sha256()
            with gzip.open(path, "rb") as stream:
                for chunk in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(chunk)
            self.assertEqual(digest.hexdigest(), manifest["uncompressedSha256"][split])
            for doc in records(path):
                key = doc["language"], doc["source"], doc["id"]
                self.assertNotIn(key, ids)
                ids.add(key)
                words = WORD.findall(doc["text"].casefold())
                text = doc["language"], signature(" ".join(words))
                self.assertNotIn(text, texts)
                texts.add(text)
                fragments = (signature(fragment) for fragment in spans(words))
                if split == "train":
                    self.assertFalse(any(fragment in held for fragment in fragments))
                else:
                    held.update(fragments)

    def test_sampling(self):
        """Проверяет языковые квоты фактического набора окон."""
        totals = Counter()
        for group, n in json.loads((OUT / "sample.json").read_text()).items():
            totals[group.split("/")[0]] += n
        self.assertEqual(totals, dict.fromkeys(("ru", "kk", "en"), PER_LANGUAGE))

    def test_initial_widths(self):
        """Обе ширины начинают с одинаковых вероятностей исходной GRU."""
        tok = Tokenizer.from_file(str(TOKENIZER))
        ids = torch.tensor([[4, 253, 58, 6789, 88, 3999]])
        with torch.inference_mode():
            outputs = []
            for width in (192, 256):
                model = initial_model(width, tok)
                features, _ = model.recurrent(model.embedding(ids))
                outputs.append(model.output.log_prob(features[:, -1]))
            torch.testing.assert_close(*outputs, atol=0.00002, rtol=0.00001)


def check_predictions():
    """Сверяет сохранённые примеры JS с моделью PyTorch на тех же курсорах."""
    from subword_data import PAD, token_id
    from subword_model import PhrasePredictor, SubwordModel

    tok = Tokenizer.from_file(str(TOKENIZER))
    panel = json.loads((OUT / "development-cursors.json").read_text(encoding="utf8"))
    checked = 0
    for width in (192, 256):
        model = SubwordModel(tok.get_vocab_size(), token_id(tok, PAD), width)
        model.load_state_dict(torch.load(OUT / f"gru-{width}.pt", weights_only=True))
        engine = PhrasePredictor(model, tok)
        for condition in ("context", "local"):
            path = OUT / f"development-{width}-{condition}.json"
            examples = json.loads(path.read_text(encoding="utf8"))["examples"]
            for key, sample in examples.items():
                lang, genre, length = key.split("/")
                row = next(
                    r
                    for r in panel
                    if r["doc"] == sample["doc"]
                    and r["before"] == sample["before"]
                    and r["genre"] == genre
                    and r["long"] == (length == "long")
                    and r["lang"] == lang
                )
                history = tuple(
                    " ".join(WORD.findall(s.lower()))
                    for s in re.split(r"\n+|(?<=[.!?…])\s+", row["history"])
                    if s.strip()
                )
                actual = engine.suggest(
                    " ".join(WORD.findall(row["before"].lower())),
                    lang,
                    history if condition == "context" else (),
                )
                if actual != sample["options"]:
                    raise AssertionError(
                        (width, condition, key, actual, sample["options"])
                    )
                checked += 1
    return checked


if __name__ == "__main__":
    unittest.main()
