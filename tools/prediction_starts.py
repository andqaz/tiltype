"""Отбирает продолжения первых слов предложения для обучаемых моделей TilType.

Получает очищенные последовательности от build_predictions.py и возвращает
отдельные ключи словаря с признаком начала предложения.
"""

from collections import Counter, defaultdict

MAX_START_CONTEXT = 6
BASE_START_CONTEXT = 5
MIN_START_OCCURRENCES = 4
SINGLE_WORD_MIN_SHARE = 0.18
PHRASE_MIN_SHARE = 0.24
EXPANDED_MIN_OCCURRENCES = 3
EXPANDED_SINGLE_WORD_SHARE = 0.15
EXPANDED_PHRASE_SHARE = 0.20


def count_starts(words: list[str], counts: defaultdict[str, Counter[str]]) -> None:
    """Учитывает продолжения начальных фрагментов длиной до шести слов."""
    for width, continuation in enumerate(words[1:MAX_START_CONTEXT + 1], 1):
        prefix = " ".join(words[:width]).lower()
        counts[prefix][continuation] += 1


def select_starts(counts: defaultdict[str, Counter[str]], *, expanded: bool = False) -> dict[str, str]:
    """Отбирает основные или расширенные начальные контексты с префиксом ^."""
    minimum = EXPANDED_MIN_OCCURRENCES if expanded else MIN_START_OCCURRENCES
    single_share = EXPANDED_SINGLE_WORD_SHARE if expanded else SINGLE_WORD_MIN_SHARE
    phrase_share = EXPANDED_PHRASE_SHARE if expanded else PHRASE_MIN_SHARE
    predictions: dict[str, str] = {}
    for prefix, continuations in counts.items():
        spaces = prefix.count(" ")
        if not expanded and spaces >= BASE_START_CONTEXT:
            continue
        word = min(continuations, key=lambda item: (-continuations[item], item))
        count = continuations[word]
        if count >= minimum and count / continuations.total() >= (phrase_share if spaces else single_share):
            predictions["^" + prefix] = word
    return predictions
