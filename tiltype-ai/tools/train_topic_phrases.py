"""Обучает компактные тематические таблицы продолжений на документах train.

Для пары слов слева сохраняет продолжения, подтверждённые несколькими
записями. Отложенные документы используются только для исключения повторов.
"""

import csv
import gzip
import hashlib
import json
import re
import tarfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRAIN = (
    ROOT
    / ".cache/tiltype-ai-variants/document-context/expanded-training/train.jsonl.gz"
)
OUTPUT = ROOT / "plugin/models"
LANGUAGES = ("ru", "kk", "en")
WORDS = re.compile(r"[^\W\d_]+", re.UNICODE)
SEGMENT = re.compile(r"[^\w \t’'-]+")
LIMIT = 650


def training_texts():
    """Читает train и исключает из новостей совпадения с отложенными документами."""
    with gzip.open(TRAIN, "rt", encoding="utf8") as stream:
        for doc in map(json.loads, stream):
            yield doc["language"], doc["text"].lower()
    blocked = defaultdict(set)
    for split in ("development", "test"):
        with gzip.open(
            TRAIN.with_name(split + ".jsonl.gz"), "rt", encoding="utf8"
        ) as stream:
            for doc in map(json.loads, stream):
                words = WORDS.findall(doc["text"].lower())
                blocked[doc["language"]].update(
                    tuple(words[j : j + 6]) for j in range(len(words) - 5)
                )
    archives = {
        "ru": "rus_news_2024_100K",
        "en": "eng_news_2024_100K",
        "kk": "kaz_news_2020_30K",
    }
    for lang, name in archives.items():
        with tarfile.open(ROOT / ".cache" / (name + ".tar.gz")) as archive:
            stream = archive.extractfile(f"{name}/{name}-sentences.txt")
            if stream is None:
                raise ValueError(name)
            for line in stream:
                sentence = line.decode("utf8").partition("\t")[2].strip().lower()
                words = WORDS.findall(sentence)
                if len(words) >= 6 and not any(
                    tuple(words[j : j + 6]) in blocked[lang]
                    for j in range(len(words) - 5)
                ):
                    yield lang, sentence


def train():
    """Записывает по одному JSON на язык, ограничивая размер каждой темы."""
    with (
        Path(__file__).with_name("topic-seeds.tsv").open(encoding="utf-8-sig") as stream
    ):
        topics = list(csv.DictReader(stream, delimiter="\t"))
    roots = {lang: defaultdict(list) for lang in LANGUAGES}
    for lang in LANGUAGES:
        for i, topic in enumerate(topics):
            for root in topic[lang].split():
                roots[lang][root[:3]].append((root, i))
    counts = defaultdict(Counter)
    seen = set()
    for lang, text in training_texts():
        digest = (lang, hashlib.sha256(text.encode()).digest())
        if digest in seen:
            continue
        seen.add(digest)
        found = defaultdict(set)
        for segment in SEGMENT.split(text):
            words = WORDS.findall(segment)
            for j, word in enumerate(words):
                for root, i in roots[lang].get(word[:3], ()):
                    if word.startswith(root):
                        for k in range(max(0, j - 3), min(j + 1, len(words) - 3)):
                            found[i].add(tuple(words[k : k + 4]))
                        for k in range(max(0, j - 2), min(j + 1, len(words) - 2)):
                            found[i].add(tuple(words[k : k + 3]))
        for i, grams in found.items():
            counts[lang, i].update(grams)
    OUTPUT.mkdir(exist_ok=True)
    for lang in LANGUAGES:
        entries = defaultdict(list)
        sizes = {}
        for i, topic in enumerate(topics):
            rows = sorted(
                ((n, gram) for gram, n in counts[lang, i].items() if n >= 2),
                key=lambda row: (-row[0], row[1]),
            )
            rows = [
                row
                for length in (3, 4)
                for row in [v for v in rows if len(v[1]) == length][:LIMIT]
            ]
            sizes[topic["topic"]] = len(rows)
            for n, gram in rows:
                entries[" ".join(gram[:-2])].append([i, " ".join(gram[-2:]), n])
        data = {"roots": [t[lang].split() for t in topics], "entries": entries}
        (OUTPUT / f"{lang}-topics.json").write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf8"
        )
        print(lang, sizes, flush=True)


if __name__ == "__main__":
    train()
