"""Извлекает продолжения из переписки и ищет подтверждение фразы в левом контексте.

Используется только экспериментальным стендом. Границы предложений и абзацев
ограничивают совпадения. Поиск не получает авторское продолжение.
"""

import csv
import re
from collections import Counter, defaultdict

from panel import HERE, read
from sources import terms


def documents():
    """Читает зафиксированные официальные письма и авторские рабочие примеры."""
    yield from read(HERE / "official_letters.json")
    with (HERE / "workplace_letters.tsv").open(encoding="utf8") as stream:
        for i, pair in enumerate(csv.DictReader(stream, delimiter="\t")):
            for lang, text in pair.items():
                yield {
                    "lang": lang,
                    "text": text,
                    "id": f"{lang}-office-{i}",
                    "origin": "authored",
                }


def occurrences(text):
    """Возвращает пару последовательных слов и слова перед ней в пределах фразы."""
    for segment in re.split(r"[^\w\-’' \t]+", text.lower()):
        words = terms(segment)
        for i in range(len(words) - 1):
            yield tuple(words[max(0, i - 2) : i]), " ".join(words[i : i + 2])


def evidence(left, previous, typed):
    """Оценивает совпавший суффикс и учитывает отдельно длину набранного слова."""
    depth = 0
    for a, b in zip(reversed(left), reversed(previous)):
        if a != b:
            break
        depth += 1
    return 2 * depth + min(3, len(typed)) if depth or len(typed) >= 2 else 0


class Correspondence:
    """Хранит частоты продолжений в письмах с раздельными индексами по языку."""

    def __init__(self, docs):
        self.counts = defaultdict(Counter)
        for doc in docs:
            self.counts[doc["lang"]].update(occurrences(doc["text"]))

    def candidates(self, row):
        """Для писем возвращает не более 20 совпадений по левому контексту и префиксу."""
        if row["genre"] != "letter":
            return []
        scores = {}
        previous = terms(row["before"])[-2:]
        typed = row["typed"].lower()
        for (left, pair), count in self.counts[row["lang"]].items():
            if pair.startswith(typed):
                strength = evidence(left, previous, typed)
                if strength:
                    scores[pair] = max(scores.get(pair, (0, 0)), (strength, count))
        return sorted(scores, key=lambda p: (-scores[p][0], -scores[p][1], p))[:20]


def supported_document_phrase(row, existing, *, use_context=True, use_prefix=True):
    """Выбирает для повышения одну уже найденную пару при повторе контекста или префикса."""
    previous = terms(row["before"])[-2:] if use_context else []
    typed = row["typed"].lower()
    scores = Counter()
    for left, pair in occurrences((row["history"] + row["before"])[-4096:]):
        if pair in existing and pair.startswith(typed):
            scores[pair] = max(
                scores[pair], evidence(left, previous, typed if use_prefix else "")
            )
    return (
        max(existing, key=lambda p: scores[p], default="")
        if any(scores.values())
        else ""
    )
