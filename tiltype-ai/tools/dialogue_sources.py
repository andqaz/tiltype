"""Читает реплики из зафиксированных выпусков внешних корпусов TilType AI.

Taskmaster и OpenAssistant читаются из локальных архивов. У копии KSC2
запрашивается только столбец расшифровок Parquet, без звуковых дорожек.
"""

import gzip
import json
import re
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from zipfile import ZipFile

KSC2_MIRROR = "diaslmb/KSC2"
KSC2_REVISION = "916e65e49f4659c144c618c479fb9f035ea82b89"
KSC2_SHARDS = 99
TASKMASTER_FILE = re.compile(
    r"/(?:TM-1-2019/(?:self|woz)-dialogs\.json|TM-2-2020/data/[^/]+\.json|"
    r"TM-[34]-20(?:20|24)/data/data_\d+\.json)$"
)
OASST_REJECT_LABELS = ("spam", "lang_mismatch", "pii", "not_appropriate", "hate_speech", "sexual_content")


def taskmaster_messages(directory: Path) -> Iterator[str]:
    """Возвращает отдельные англоязычные реплики Taskmaster 1–4 из ZIP."""
    with ZipFile(directory / "taskmaster.zip") as archive:
        names = sorted(name for name in archive.namelist() if TASKMASTER_FILE.search(name))
        if not names:
            raise ValueError("Taskmaster ZIP contains no dialogue files")
        for name in names:
            with archive.open(name) as stream:
                for conversation in json.load(stream):
                    for turn in conversation["utterances"]:
                        yield turn["text"]


def openassistant_messages(directory: Path, language: str) -> Iterator[str]:
    """Читает проверенные человеком, несинтетические реплики выбранного языка."""
    with gzip.open(directory / "oasst1-ready.jsonl.gz", "rt", encoding="utf8") as stream:
        for line in stream:
            row = json.loads(line)
            if row["lang"] != language or row["deleted"] or row["synthetic"] or row.get("review_result") is not True:
                continue
            labels = row["labels"] or {}
            if any((labels.get(label) or {}).get("value", 0) >= 0.5 for label in OASST_REJECT_LABELS):
                continue
            yield row["text"]


def matreshka_messages(directory: Path) -> Iterator[str]:
    """Возвращает русскоязычные реплики обучающей части синтетических диалогов."""
    from pyarrow.parquet import ParquetFile

    file = ParquetFile(directory / "matreshka-train.parquet")
    for batch in file.iter_batches(columns=["dialog"]):
        for conversation in batch.column(0).to_pylist():
            if conversation:
                yield from conversation


def read_ksc2_shard(url: str) -> list[str]:
    """Читает текст одного шарда через диапазоны HTTP, повторяя временные сбои."""
    import fsspec
    from aiohttp import ClientError
    from pyarrow.parquet import ParquetFile

    for attempt in range(3):
        try:
            with fsspec.open(url, "rb", block_size=65_536, cache_type="none") as source:
                return ParquetFile(source).read(columns=["text"])["text"].to_pylist()
        except (OSError, ClientError) as error:
            if attempt == 2:
                raise RuntimeError(f"Cannot read KSC2 transcript shard {url}") from error
            time.sleep(2 ** attempt)
    raise RuntimeError("KSC2 retry loop exited without reading a shard")


def ksc2_messages() -> Iterator[str]:
    """Читает текстовые колонки 99 шардов KSC2 в стабильном порядке."""
    root = f"https://huggingface.co/datasets/{KSC2_MIRROR}/resolve/{KSC2_REVISION}/data"
    urls = [f"{root}/train-{index:05d}-of-{KSC2_SHARDS:05d}.parquet" for index in range(KSC2_SHARDS)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for messages in pool.map(read_ksc2_shard, urls):
            yield from messages
