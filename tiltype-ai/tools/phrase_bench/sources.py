"""Находит точные пары слов в обучающих текстах и в уже написанной части документа.

Счётчики корпуса ограничены ключами запросов панели. Ожидаемые ответы не
передаются поиску. Порядок выбора и лимиты одинаковы для всех трёх языков.
"""

import gzip
import itertools
import json
from collections import Counter, defaultdict
from math import log1p

from panel import CORPUS, WORD

GENRE_SOURCES = {
    "letter": {"oasst-training-threads", "ordered-turn-training"},
    "instruction": {"gnome-instructions"},
    "article": {"ordered-pages", "kazakh-extra-articles"},
}


def terms(text):
    """Нормализует только регистр, сохраняя реальные словоформы."""
    return WORD.findall(text.lower())


def keys(row):
    """Определяет ключи поиска из последних слов и видимой части нового слова."""
    words = terms(row["before"])
    return [("suffix", tuple(words[-n:])) for n in (2, 1) if len(words) >= n] + (
        [("typed", row["typed"].lower())] if row["typed"] else []
    )


class CorpusIndex:
    """Считает продолжения из train по общему контексту и по происхождению текста."""

    def __init__(self, rows):
        required = defaultdict(set)
        for row in rows:
            required[row["lang"]].update(keys(row))
        self.index = defaultdict(Counter)
        with gzip.open(CORPUS / "train.jsonl.gz", "rt", encoding="utf8") as stream:
            for line in stream:
                doc = json.loads(line)
                self._add(doc, required[doc["language"]])

    def _add(self, doc, requested):
        text = doc["text"].lower()
        words = list(WORD.finditer(text))
        for i in range(len(words) - 1):
            word, following = words[i : i + 2]
            if not text[word.end() : following.start()].isspace():
                continue
            if "\n" in text[word.end() : following.start()]:
                continue
            first = word[0]
            search: list[tuple[str, str | tuple[str, ...]]] = [
                ("typed", first[:n]) for n in range(1, min(len(first), 3) + 1)
            ]
            for length in (1, 2):
                if i < length:
                    break
                gap = text[words[i - length].end() : words[i - length + 1].start()]
                if not gap.isspace() or "\n" in gap:
                    break
                search.append(("suffix", tuple(w[0] for w in words[i - length : i])))
            for key in search:
                if key in requested:
                    self.index[doc["language"], key, doc["source"]][
                        (first, following[0])
                    ] += 1

    def candidates(self, row):
        """Ранжирует пары по длине совпавшего контекста, жанру и частоте."""
        priorities = {}
        for kind, value in keys(row):
            counts = Counter()
            for source in sorted(TRAIN_SOURCES):
                bucket = self.index.get((row["lang"], (kind, value), source))
                if bucket:
                    weight = 3 if source in GENRE_SOURCES[row["genre"]] else 1
                    for pair, n in bucket.items():
                        if pair[0].startswith(row["typed"].lower()):
                            counts[pair] += n * weight
            depth = len(value) if kind == "suffix" else 0
            for pair, count in counts.most_common(20):
                priorities[pair] = max(priorities.get(pair, (0, 0)), (depth, count))
        return [
            " ".join(p)
            for p in sorted(
                priorities, key=lambda p: (-priorities[p][0], -priorities[p][1], p)
            )[:20]
        ]


TRAIN_SOURCES = set.union(*GENRE_SOURCES.values()) | {"ksc2-utterance"}


def document_candidates(row):
    """Предлагает пары слева от курсора с учётом соседних слов, частоты и давности."""
    text = (row["history"] + row["before"])[-4096:].lower()
    tokens = list(WORD.finditer(text))
    prefix = row["typed"].lower()
    local = terms(row["before"])[-8:]
    freq = Counter()
    scores = {}
    for i, (a, b) in enumerate(itertools.pairwise(tokens)):
        gap = text[a.end() : b.start()]
        if not a[0].startswith(prefix) or not gap.isspace() or "\n" in gap:
            continue
        pair = a[0] + " " + b[0]
        prior = [w[0] for w in tokens[max(0, i - 8) : i]]
        suffix = 0
        for left, right in zip(reversed(prior), reversed(local)):
            if left != right:
                break
            suffix += 1
        freq[pair] += 1
        score = (
            4 * min(3, suffix)
            + len(set(prior) & set(local)) * 0.3
            + b.end() / max(1, len(text))
        )
        scores[pair] = max(scores.get(pair, 0), score)
    return sorted(scores, key=lambda s: (-scores[s] - log1p(freq[s]), s))[:20]


def merge(sources, limit=20):
    """Чередует источники, оставляя первый вариант плагина на прежнем месте."""
    pool = []
    for position in range(max(map(len, sources), default=0)):
        for source in sources:
            if position < len(source):
                candidate = source[position].strip().lower()
                if candidate and candidate not in pool:
                    pool.append(candidate)
                    if len(pool) == limit:
                        return pool
    return pool
