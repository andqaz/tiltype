"""Готовит последовательности слов внутри предложений для TilType AI.

Сохраняет контекст через запятые и другие внутренние знаки. На границе
предложения либо смене алфавита начинается новая последовательность.
"""

import json
import re
from collections.abc import Iterable, Iterator
from itertools import chain
from pathlib import Path

from training_data import ALPHABETS

# training_data подключает каталог общих инструментов проекта.
# isort: split
from build_predictions import (
    HOLDOUT_PERIOD,
    corpus_sentences,
    kaznerd_sentences,
    sentence_id,
    tatoeba_sentences,
)

SENTENCE_CONTEXT_SIZE = 24
WORD = re.compile(r"[^\W\d_]+(?:['-][^\W\d_]+)*")
SENTENCE_BOUNDARY = re.compile(r"[.!?…\r\n]")


def sentence_runs(sentence: str, allowed: re.Pattern[str]) -> Iterator[list[str]]:
    """Выделяет непрерывные по алфавиту фрагменты одного предложения."""
    for part in SENTENCE_BOUNDARY.split(sentence.lower().replace("’", "'")):
        words: list[str] = []
        for word in WORD.findall(part):
            if allowed.fullmatch(word):
                words.append(word)
            else:
                if len(words) > 1:
                    yield words
                words = []
        if len(words) > 1:
            yield words


def sentence_alphabet(language: str) -> re.Pattern[str]:
    """Компилирует допустимый алфавит для разбора предложений одного языка."""
    alphabet = ALPHABETS[language]
    return re.compile(rf"[{alphabet}]+(?:['-][{alphabet}]+)*")


def dialogue_sentences(language: str, directory: Path) -> Iterator[list[str]]:
    """Читает очищенные последовательности, подготовленные импортом диалогов."""
    with (directory / f"{language}.jsonl").open(encoding="utf8") as source:
        for line in source:
            yield json.loads(line).split()


def training_sentences(language: str) -> Iterable[list[str]]:
    """Возвращает обучающие фрагменты из разговорных и письменных корпусов."""
    allowed = sentence_alphabet(language)
    sources = chain(tatoeba_sentences(language), kaznerd_sentences() if language == "kk" else (), corpus_sentences(language))
    seen: set[int] = set()
    for sentence in sources:
        identifier = sentence_id(sentence)
        if identifier % HOLDOUT_PERIOD == 0 or identifier in seen:
            continue
        seen.add(identifier)
        yield from sentence_runs(sentence, allowed)
