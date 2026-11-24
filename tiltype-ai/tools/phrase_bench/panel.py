"""Фиксирует тестовые курсоры и пороги до поиска фраз. Правый контекст хранит отдельно."""

import gzip
import hashlib
import json
import random
import re
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CORPUS = ROOT / ".cache/tiltype-ai-variants/document-context/expanded-training"
OUT = CORPUS.parent / "phrase-source-bench"
LANGS = ("ru", "kk", "en")
GENRES = ("letter", "instruction", "article")
MODES = ("space", "typed", "afterTab")
WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*")


def read(path):
    """Читает локальный JSON в UTF-8."""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path, value):
    """Сохраняет воспроизводимый JSON атомарной заменой."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf8")
    tmp.replace(path)


def documents(split):
    """Возвращает авторские письма и исходные отложенные статьи и инструкции."""
    for index, versions in enumerate(read(HERE / "letters.json")[split]):
        for lang, (before, after) in zip(LANGS, versions, strict=True):
            yield (
                lang,
                "letter",
                f"{split}-letter-{index}",
                before + " " + after,
                len(before) + 1 if index < 4 else -1,
            )
    with gzip.open(CORPUS / (split + ".jsonl.gz"), "rt", encoding="utf8") as stream:
        for doc in map(json.loads, stream):
            genre = {
                "gnome-instructions": "instruction",
                "ordered-pages": "article",
            }.get(doc["source"])
            if genre:
                yield doc["language"], genre, doc["id"], doc["text"], -1


def panel(split):
    """Отбирает уникальные позиции равномерно по документам, жанрам и сценариям."""
    rng = random.Random(72813 if split == "development" else 91826)
    groups = defaultdict(dict)
    anchors = defaultdict(list)
    for lang, genre, doc, text, anchor in documents(split):
        points = []
        for sentence in re.finditer(r"[^.!?…\n]+", text):
            words = list(WORD.finditer(sentence[0]))
            for i in range(1, len(words) - 1):
                left, one, two = words[i - 1 : i + 2]
                if (
                    sentence[0][left.end() : one.start()] != " "
                    or sentence[0][one.end() : two.start()] != " "
                ):
                    continue
                cursor = sentence.start() + one.start()
                if len(one[0]) < 2 and cursor != anchor:
                    continue
                point = (doc, text, sentence.start(), cursor, left[0], one[0], two[0])
                if cursor == anchor:
                    anchors[lang, genre].append(point)
                else:
                    points.append(point)
        rng.shuffle(points)
        if points:
            groups[lang, genre][doc] = points
    inputs = []
    labels = {}
    for lang in LANGS:
        for gi, genre in enumerate(GENRES):
            group = groups[lang, genre]
            keys = list(group)
            rng.shuffle(keys)
            selected = [("space", p, True) for p in anchors[lang, genre]]
            if genre == "letter" and len(selected) != 4:
                raise ValueError("Missing paired letter anchors")
            modes = [
                m
                for j, m in enumerate(MODES)
                for _ in range(33 + int(j == gi) - sum(x[0] == m for x in selected))
            ]
            rng.shuffle(modes)
            offset = 0
            for mode in modes:
                while not group[keys[offset % len(keys)]]:
                    offset += 1
                    if not any(group.values()):
                        raise ValueError("Insufficient positions")
                point = group[keys[offset % len(keys)]].pop()
                offset += 1
                selected.append((mode, point, False))
            typed_count = 0
            for mode, (
                doc,
                text,
                start,
                cursor,
                prev,
                word,
                second,
            ), paired in selected:
                typed = ""
                if mode == "typed":
                    typed = word[: min(1 + typed_count % 3, len(word) - 1)]
                    typed_count += 1
                key = f"{lang}/{genre}/{doc}/{cursor}"
                inputs.append(
                    {
                        "id": key,
                        "lang": lang,
                        "genre": genre,
                        "doc": doc,
                        "mode": mode,
                        "history": text[:start],
                        "before": text[start:cursor],
                        "typed": typed,
                        "accepted": prev if mode == "afterTab" else "",
                        "paired": paired,
                    }
                )
                labels[key] = {
                    "pair": (word + " " + second).lower(),
                    "future": text[cursor : cursor + 180],
                }
    assert len(inputs) == len(labels) == 900
    return inputs, labels


def main():
    """Закрепляет обе панели, доли сценариев и критерий продолжения эксперимента."""
    OUT.mkdir(exist_ok=True)
    docs = []
    manifest = {"pairPoolGatePP": 10, "poolLimit": 20, "visibleLimit": 3, "sha256": {}}
    for split in ("development", "test"):
        rows, labels = panel(split)
        docs.append({(r["lang"], r["genre"], r["doc"]) for r in rows})
        for name, data in (("inputs", rows), ("labels", labels)):
            target = OUT / f"{split}-{name}.json"
            save(target, data)
            manifest["sha256"][target.name] = hashlib.sha256(
                target.read_bytes()
            ).hexdigest()
    assert not docs[0] & docs[1]
    save(OUT / "protocol.json", manifest)


if __name__ == "__main__":
    main()
