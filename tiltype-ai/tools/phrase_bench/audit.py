"""Проверяет разбиение документов, границы слов и воспроизводимость стенда.

Использует зафиксированные входы и обучающий корпус для проверки утечек,
а также сверяет отчёт с исходными списками без повторного поиска кандидатов.
"""

import gzip
import hashlib
import json
import unittest
from collections import Counter

from evaluate import hits
from panel import CORPUS, GENRES, HERE, LANGS, MODES, OUT, ROOT, WORD, read
from sources import document_candidates, merge


class BenchAudit(unittest.TestCase):
    """Проверки фиксированных панелей и лимита источников до выпуска отчёта."""

    def test_panels(self):
        """Каждый сценарий и жанр имеет равный вес, документы между панелями различны."""
        protocol = read(OUT / "protocol.json")
        docs = []
        for split in ("development", "test"):
            for name in ("inputs", "labels"):
                file = OUT / f"{split}-{name}.json"
                self.assertEqual(
                    hashlib.sha256(file.read_bytes()).hexdigest(),
                    protocol["sha256"][file.name],
                )
            rows = read(OUT / f"{split}-inputs.json")
            labels = read(OUT / f"{split}-labels.json")
            self.assertEqual(set(labels), {r["id"] for r in rows})
            docs.append({(r["lang"], r["genre"], r["doc"]) for r in rows})
            for lang in LANGS:
                group = [r for r in rows if r["lang"] == lang]
                self.assertEqual(
                    Counter(r["genre"] for r in group), dict.fromkeys(GENRES, 100)
                )
                self.assertEqual(
                    Counter(r["mode"] for r in group), dict.fromkeys(MODES, 100)
                )
                for r in group:
                    self.assertNotIn("future", r)
                    self.assertTrue(
                        labels[r["id"]]["pair"].startswith(r["typed"].lower())
                    )
                    if r["mode"] == "afterTab":
                        self.assertTrue(r["before"].endswith(r["accepted"] + " "))
        self.assertFalse(docs[0] & docs[1])
        self.assertEqual(
            hashlib.sha256(
                (ROOT / "dist/tiltype-ai-unified.plugin").read_bytes()
            ).hexdigest(),
            protocol["packageSHA256"],
        )

    def test_letters_not_in_training(self):
        """Проверяет отсутствие общих 12-словных отрывков между письмами и обучением."""

        def passages(text):
            words = WORD.findall(text.casefold())
            return (" ".join(words[i : i + 12]) for i in range(len(words) - 11))

        letters = read(HERE / "letters.json")
        blocked = {
            s
            for groups in letters.values()
            for translations in groups
            for parts in translations
            for s in passages(" ".join(parts))
        }
        with gzip.open(CORPUS / "train.jsonl.gz", "rt", encoding="utf8") as stream:
            for row in map(json.loads, stream):
                self.assertFalse(
                    any(s in blocked for s in passages(row["text"])), row["id"]
                )

    def test_outputs(self):
        """Сверяет каждую выданную пару и все показатели основного решения."""
        rows = read(OUT / "development-inputs.json")
        labels = read(OUT / "development-labels.json")
        candidates = read(OUT / "development-candidates.json")
        scores = read(OUT / "development-scores.json")["groups"]
        for lang in LANGS:
            raw = Counter()
            for r in (r for r in rows if r["lang"] == lang):
                item = candidates[r["id"]]
                pool = item["pool"]
                self.assertEqual(pool, merge(list(item["sources"].values())))
                self.assertLessEqual(len(pool), 20)
                self.assertEqual(len(pool), len(set(pool)))
                self.assertTrue(all(s.startswith(r["typed"].lower()) for s in pool))
                pair = labels[r["id"]]["pair"]
                for k, items in (
                    ("first", pool[:1]),
                    ("visible", pool[:3]),
                    ("pool", pool),
                    ("base_pool", item["sources"]["plugin"]),
                ):
                    raw[k] += hits(items, pair)
            self.assertTrue(all(n == scores[lang][k] for k, n in raw.items()))
        self.assertFalse(hits(["жұмыс кестесіне"], "жұмыс кестесі"))
        self.assertNotIn(
            "first second",
            document_candidates(
                {"history": "first. ", "before": "second ", "typed": ""}
            ),
        )


if __name__ == "__main__":
    unittest.main()
