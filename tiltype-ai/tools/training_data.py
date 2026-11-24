"""Готовит выборку для нейронного прогноза по корпусам TilType.

Использует разбиение исходного проекта, чтобы отложенные предложения
не участвовали в обучении ни одной из сравниваемых моделей.
"""

import re
import sys
from array import array
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import chain
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from build_predictions import (  # noqa: E402
    ALPHABETS, HOLDOUT_PERIOD, KAZAKH_EXTRA_CORPUS, WIKIPEDIA_CORPORA,
    corpus_sentences, kaznerd_sentences, leipzig_sentences, sentence_id,
    tatoeba_sentences, word_runs,
)

CONTEXT_SIZE = 6
UNKNOWN_BUCKETS = 512


@dataclass(frozen=True)
class TrainingBudget:
    """Определяет объём выборки и ёмкость выходного словаря для обучения."""

    vocabulary: int
    positions: int
    general_sentences: int
    conversation_sentences: int
    kazakh_news_sentences: int


TRAINING_BUDGETS = {
    "compact": TrainingBudget(8_192, 900_000, 90_000, 150_000, 60_000),
    "expanded": TrainingBudget(16_384, 2_400_000, 180_000, 315_000, 105_000),
    "conversation": TrainingBudget(16_384, 3_600_000, 180_000, 720_000, 160_000),
}


def unknown_bucket(word: str) -> int:
    """Уплотняет незнакомые словоформы по устойчивому хэшу окончания."""
    value = 2_166_136_261
    for letter in word[-3:]:
        value = ((value ^ ord(letter)) * 16_777_619) & 0xFFFFFFFF
    return value % UNKNOWN_BUCKETS


def collect_runs(language: str, budget: TrainingBudget) -> list[list[str]]:
    """Выбирает фразы из разных источников, удаляя дубликаты и контрольные данные."""
    alphabet = f"[{ALPHABETS[language]}]+"
    allowed = re.compile(rf"{alphabet}(?:['-]{alphabet})*")
    wikipedia = leipzig_sentences(WIKIPEDIA_CORPORA[language])
    if language == "kk":
        wikipedia = chain(wikipedia, leipzig_sentences(KAZAKH_EXTRA_CORPUS))
    sources = [
        (corpus_sentences(language), budget.general_sentences),
        (wikipedia, budget.general_sentences),
        (tatoeba_sentences(language), budget.conversation_sentences),
    ]
    if language == "kk":
        sources.append((kaznerd_sentences(), budget.kazakh_news_sentences))

    seen: set[int] = set()
    runs = []
    for source, quota in sources:
        selected = 0
        for sentence in source:
            identifier = sentence_id(sentence)
            if identifier % HOLDOUT_PERIOD == 0 or identifier in seen:
                continue
            seen.add(identifier)
            usable = [run for run in word_runs(sentence, allowed) if len(run) > 1]
            if not usable:
                continue
            runs.extend(usable)
            selected += 1
            if selected == quota:
                break
    return runs


def prepare(language: str, seed: int, budget: TrainingBudget) -> tuple[list[str], torch.Tensor]:
    """Возвращает словарь выхода и строки из предшествующих токенов и цели."""
    runs = collect_runs(language, budget)
    counts = Counter(word.lower() for run in runs for word in run[1:])
    vocabulary = sorted(counts, key=lambda word: (-counts[word], word))[:budget.vocabulary]
    return vocabulary, encode_runs(runs, vocabulary, seed, budget.positions)


def encode_runs(runs: Iterable[list[str]], vocabulary: list[str], seed: int, limit: int,
                context_size: int = CONTEXT_SIZE) -> torch.Tensor:
    """Кодирует контексты и цели, сохраняя порядок заданного выходного словаря."""
    indices = {word: index for index, word in enumerate(vocabulary)}
    encoded = array("H")
    for run in runs:
        history = [0] * context_size
        for index, surface in enumerate(run):
            word = surface.lower()
            target = indices.get(word)
            if index and target is not None:
                encoded.extend(history)
                encoded.append(target)
            token = target + 1 if target is not None else len(vocabulary) + 1 + unknown_bucket(word)
            history = history[1:] + [token]
    if not encoded:
        raise ValueError("No eligible training positions")
    rows = torch.frombuffer(encoded, dtype=torch.uint16).reshape(-1, context_size + 1).to(torch.int32)
    if rows.shape[0] > limit:
        sample = torch.randperm(rows.shape[0], generator=torch.Generator().manual_seed(seed))
        rows = rows[sample[:limit]]
    return rows
