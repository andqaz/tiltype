"""Готовит фиксированные курсоры и индексы матриц для проверки JS-моделей.

Берёт позиции разных жанров из отложенных документов и запускает каждую
конфигурацию в новом процессе Node.js с одинаковым текстом перед курсором.
"""

import argparse
import json
import random
import re
import struct
import subprocess
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path

import torch
from prepare import BAL, OUT, ROOT, WORD, records

LANGUAGES = ("ru", "kk", "en")
GENRES = ("ordered-pages", "legal-pages", "conversation-pages", "gnome-instructions")


def positions(split):
    """Отбирает по 50 курсоров на язык и жанр, чередуя документы и длины."""
    rng = random.Random(932582)
    pools = defaultdict(dict)
    for row in records(OUT / (split + ".jsonl.gz")):
        lengths = defaultdict(list)
        for sentence in re.finditer(r"[^\n.!?…]+", row["text"]):
            words = list(WORD.finditer(sentence[0]))
            for i in range(1, len(words) - 2):
                offset = words[i].start()
                if sentence[0][offset - 1] == " ":
                    lengths[i >= 7].append(
                        (sentence.start(), sentence.start() + offset)
                    )
        for long, offsets in lengths.items():
            rng.shuffle(offsets)
            pools[row["language"], row["source"], long][row["id"]] = (
                row["text"],
                offsets,
            )
    panel = []
    for lang in LANGUAGES:
        for source in GENRES:
            for long in (False, True):
                docs = list(pools[lang, source, long].items())
                rng.shuffle(docs)
                count = 0
                while count < 25 and any(values[1] for _, values in docs):
                    for key, (text, values) in docs:
                        if not values or count == 25:
                            continue
                        start, cursor = values.pop()
                        panel.append(
                            {
                                "lang": lang,
                                "genre": source,
                                "long": long,
                                "doc": key,
                                "history": text[max(0, start - 4096) : start],
                                "before": text[start:cursor][-600:],
                                "future": text[cursor : cursor + 160].lower(),
                            }
                        )
                        count += 1
    return panel


def weight_layout(checkpoint):
    """Проверяет соответствие исходных матриц смещениям архива без дублирования весов."""
    layout = {}
    weights = torch.load(checkpoint, weights_only=True)
    with checkpoint.open("rb") as source, zipfile.ZipFile(checkpoint) as archive:
        for i, (key, matrix) in enumerate(weights.items()):
            item = next(
                info
                for info in archive.infolist()
                if info.filename.endswith(f"/data/{i}")
            )
            source.seek(item.header_offset + 26)
            name, extra = struct.unpack("<HH", source.read(4))
            offset = item.header_offset + 30 + name + extra
            source.seek(offset)
            if item.compress_type or matrix.numpy().tobytes() != source.read(
                item.file_size
            ):
                raise ValueError(f"Unsupported weight storage for {key}")
            layout[key] = {"shape": list(matrix.shape), "offset": offset}
    return layout


def main():
    """Сравнивает модели на одной панели и сохраняет результаты по языкам."""
    parser = argparse.ArgumentParser()
    parser.add_argument("split", choices=["development", "test"])
    parser.add_argument(
        "modes",
        nargs="+",
        choices=["dictionary", "phrases", "seed", "old", "192", "256"],
    )
    args = parser.parse_args()
    panel = OUT / (args.split + "-cursors.json")
    panel.write_text(
        json.dumps(positions(args.split), ensure_ascii=False), encoding="utf8"
    )
    with tempfile.TemporaryDirectory(dir=OUT) as directory:
        with zipfile.ZipFile(ROOT / "dist/tiltype-ai-unified.plugin") as package:
            package.extractall(directory)
        for mode in args.modes:
            if mode not in ("dictionary", "phrases"):
                weights = (
                    BAL / "cell-balanced.pt"
                    if mode == "old"
                    else BAL.parents[1] / "subword-phrase-model-4epochs/models/model.pt"
                    if mode == "seed"
                    else OUT / f"gru-{mode}.pt"
                )
                (OUT / f"layout-{mode}.json").write_text(
                    json.dumps(weight_layout(weights))
                )
            conditions = (
                ("context", "local") if mode in ("192", "256") else ("context",)
            )
            for condition in conditions:
                subprocess.run(
                    [
                        "node",
                        str(Path(__file__).with_name("evaluate.cjs")),
                        str(panel),
                        directory,
                        mode,
                        condition,
                    ],
                    check=True,
                )


if __name__ == "__main__":
    main()
