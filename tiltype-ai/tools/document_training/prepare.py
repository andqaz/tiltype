"""Собирает связные обучающие документы и независимые реплики из локальных архивов.

Сохраняет происхождение, порядок абзацев и прежние границы контрольных выборок.
Длинные дословные пересечения с отложенными документами исключаются до обучения.
"""

import gzip
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".cache"
BASE = CACHE / "tiltype-ai-variants/document-context"
BAL = BASE / "balanced-generator"
OUT = BASE / "expanded-training"
WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*")
BASES = ("ordered-pages", "legal-pages", "conversation-pages", "gnome-instructions")


def records(path):
    """Читает сжатый JSONL, сохраняя границы исходных записей."""
    with gzip.open(path, "rt", encoding="utf8") as stream:
        yield from map(json.loads, stream)


def signature(text):
    """Возвращает компактный стабильный ключ нормализованного фрагмента."""
    return hashlib.blake2b(text.encode(), digest_size=12).digest()


def spans(words):
    """Индексирует непрерывные последовательности из двенадцати слов."""
    return (" ".join(words[i : i + 12]) for i in range(len(words) - 11))


def source_rows():
    """Назначает документы источника одной выборке, изолируя проверочные архивы."""
    for source in BASES:
        path = (BAL if source == "gnome-instructions" else BASE) / (
            source + ".jsonl.gz"
        )
        for row in records(path):
            key = row["language"] + ":" + row["id"]
            fold = row.get("partition", hashlib.sha256(key.encode()).digest()[0] % 10)
            split = "train" if fold < 7 else "development" if fold < 9 else "test"
            # Исходные тестовые акты и контрольные диалоги используются только для оценки.
            if split == "train" and source in ("legal-pages", "conversation-pages"):
                split = "quarantine"
            yield split, source, row
    for path in sorted(BASE.glob("*confirmation-pages.jsonl.gz")):
        for row in records(path):
            yield "quarantine", path.stem, row
    for source, directory in (
        ("ordered-turn-training", BASE),
        ("oasst-training-threads", BAL),
        ("kazakh-extra-articles", BAL),
    ):
        for row in records(directory / (source + ".jsonl.gz")):
            yield "train", source, row


def main():
    """Записывает отдельные архивы и манифест с объёмами и контрольными суммами."""
    OUT.mkdir(exist_ok=True)
    partitions = sorted(source_rows(), key=lambda item: item[0] == "train")
    blocked = set()
    held_text = set()
    seen = set()
    stats = defaultdict(Counter)
    dropped = Counter()
    with ExitStack() as stack:
        outputs = {
            s: stack.enter_context(
                gzip.open(OUT / (s + ".tmp.gz"), "wt", encoding="utf8")
            )
            for s in ("train", "development", "test")
        }

        def write(split, source, row):
            lang = row["language"]
            text = unicodedata.normalize("NFC", row["text"]).strip()
            words = WORD.findall(text.casefold())
            if len(words) < 4:
                return
            key = signature(" ".join(words))
            if split != "train":
                blocked.update(map(signature, spans(words)))
                held_text.add(key)
            if split == "quarantine":
                return
            if (lang, key) in seen or (
                split == "train"
                and (
                    key in held_text
                    or any(signature(s) in blocked for s in spans(words))
                )
            ):
                dropped[source] += 1
                return
            seen.add((lang, key))
            record = dict(row, text=text, source=source)
            outputs[split].write(
                json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            group = stats[f"{split}/{lang}/{source}"]
            group["records"] += 1
            group["words"] += len(words)

        for split, source, row in partitions:
            write(split, source, row)
        # Реплики KSC2 самостоятельны. Историю между ними строить нельзя.
        with (CACHE / "dialogue-corpora/kk.jsonl").open(encoding="utf8") as stream:
            for line in stream:
                text = json.loads(line)
                write(
                    "train",
                    "ksc2-utterance",
                    {"language": "kk", "id": signature(text).hex(), "text": text},
                )
    hashes = {}
    for split in outputs:
        path = OUT / (split + ".jsonl.gz")
        (OUT / (split + ".tmp.gz")).replace(path)
        with gzip.GzipFile(filename=path, mode="rb") as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1 << 20), b""):
                assert isinstance(chunk, bytes)
                digest.update(chunk)
            hashes[split] = digest.hexdigest()
    manifest = {
        "groups": stats,
        "excluded": dropped,
        "uncompressedSha256": hashes,
        "attribution": [
            "tiltype-ai/DIALOGUE-CORPORA.md",
            str(BAL / "gnome-attribution.json"),
        ],
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8"
    )


if __name__ == "__main__":
    main()
