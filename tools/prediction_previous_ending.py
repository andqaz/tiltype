"""Отбирает продолжения по последнему слову и окончанию предпоследнего.

Сборщик передаёт очищенные фрагменты обучающих предложений. Результат входит
в таблицу резервных контекстов, которую читает движок TilType.
"""

from collections import Counter, defaultdict
from collections.abc import Iterable

MARKER = "="
ENDING_LENGTH = 3
MIN_COUNT = 6
MIN_PERCENT = 42
MAX_ENTRIES = 60_000


def previous_ending_predictions(runs: Iterable[list[str]]) -> dict[str, str]:
    """Возвращает до 60 000 подтверждённых продолжений в формате резервной таблицы."""
    counts: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for run in runs:
        for previous, last, target in zip(run, run[1:], run[2:]):
            if len(previous) > ENDING_LENGTH:
                key = MARKER + previous[-ENDING_LENGTH:] + " " + last
                counts[key][target] += 1

    entries: list[tuple[int, float, str, str]] = []
    for context, votes in counts.items():
        word, count = min(votes.items(), key=lambda choice: (-choice[1], choice[0]))
        total = votes.total()
        if count >= MIN_COUNT and count * 100 >= MIN_PERCENT * total:
            entries.append((count, count / total, context, word))
    entries.sort(key=lambda item: (-item[0], -item[1], item[2]))
    return {context: word for _, _, context, word in entries[:MAX_ENTRIES]}
